// runtime_install — tauri-free managed-runtime install core.
//
// The desktop Setup UI installs managed runtimes through commands/runtime.rs
// (AppHandle-bound, desktop-only). The headless bat-server has no Setup UI and
// no AppHandle, but still needs to self-provision the codex binary so remote
// clients can run codex sessions against the host. This module factors the
// codex download / verify / extract / place logic into a function that takes a
// plain `runtimes` directory, so the headless startup (lib.rs) can call it
// directly. Versions and per-platform integrity come from runtime_catalog, the
// same single source the desktop installer and the Node sidecar read from.

use crate::runtime_catalog;
use crate::subprocess::hide_console_window;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha512};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn runtime_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.into()
    }
}

fn codex_target_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc"),
        _ => None,
    }
}

fn codex_catalog_entry() -> Option<&'static runtime_catalog::CodexPlatform> {
    runtime_catalog::codex_platform(runtime_key()?)
}

fn managed_codex_runtime_dir(runtimes: &Path) -> Option<PathBuf> {
    Some(
        runtimes
            .join("codex")
            .join(runtime_catalog::codex_version())
            .join(runtime_key()?),
    )
}

/// Final on-disk path of the managed codex binary under `runtimes`, matching the
/// layout `codex_app_server::managed_codex_candidate` resolves from at runtime.
pub fn managed_codex_cli_path(runtimes: &Path) -> Option<PathBuf> {
    Some(managed_codex_runtime_dir(runtimes)?.join(exe_name("codex")))
}

/// True when a working managed codex binary already exists under `runtimes`.
pub fn codex_is_installed(runtimes: &Path) -> bool {
    managed_codex_cli_path(runtimes)
        .map(|path| candidate_is_ready(&path, &["--version"]))
        .unwrap_or(false)
}

/// Download, verify, extract and place the catalog-pinned codex runtime under
/// `runtimes/codex/<version>/<key>/`. Idempotent: returns the existing managed
/// binary immediately if it is already present and passes `--version`.
pub fn install_codex(runtimes: &Path) -> Result<PathBuf, String> {
    let entry = codex_catalog_entry().ok_or_else(|| {
        format!(
            "Codex managed install is not available for {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let final_dir = managed_codex_runtime_dir(runtimes)
        .ok_or_else(|| "could not resolve Codex runtime dir".to_string())?;
    let final_path = managed_codex_cli_path(runtimes)
        .ok_or_else(|| "could not resolve Codex runtime path".to_string())?;
    if candidate_is_ready(&final_path, &["--version"]) {
        return Ok(final_path);
    }

    let url = format!(
        "https://registry.npmjs.org/@openai/codex/-/codex-{}.tgz",
        entry.npm_version
    );
    let archive = download_runtime_archive(&url)?;
    verify_sri_sha512(&archive, &entry.integrity)?;
    let tar = gunzip(&archive)?;
    let triple =
        codex_target_triple().ok_or_else(|| "could not resolve Codex target triple".to_string())?;
    let exe = exe_name("codex");
    let rg = exe_name("rg");
    let binary = read_first_tar_entry(
        &tar,
        &[
            format!("package/vendor/{triple}/bin/{exe}"),
            format!("package/vendor/{triple}/codex/{exe}"),
        ],
    )
    .ok_or_else(|| format!("Codex native package missing vendor/{triple}/{exe}"))?;
    let ripgrep = read_first_tar_entry(
        &tar,
        &[
            format!("package/vendor/{triple}/codex-path/{rg}"),
            format!("package/vendor/{triple}/path/{rg}"),
        ],
    )
    .ok_or_else(|| format!("Codex native package missing vendor/{triple}/{rg}"))?;

    let tmp_root = runtimes.join(".tmp").join(format!("codex-{}", install_nonce()));
    let tmp_final = tmp_root.join("final");
    let tmp_path = tmp_final.join(&exe);
    let tmp_rg = tmp_final.join("path").join(&rg);
    let _ = fs::remove_dir_all(&tmp_root);
    fs::create_dir_all(
        tmp_rg
            .parent()
            .ok_or_else(|| "invalid Codex rg path".to_string())?,
    )
    .map_err(|err| err.to_string())?;
    fs::write(&tmp_path, binary).map_err(|err| err.to_string())?;
    fs::write(&tmp_rg, ripgrep).map_err(|err| err.to_string())?;
    make_executable(&tmp_path)?;
    make_executable(&tmp_rg)?;
    if !candidate_is_ready(&tmp_path, &["--version"]) {
        let _ = fs::remove_dir_all(&tmp_root);
        return Err("installed Codex binary failed --version check".into());
    }
    replace_runtime_dir(&tmp_final, &final_dir)?;
    let _ = fs::remove_dir_all(&tmp_root);
    Ok(final_path)
}

fn candidate_is_ready(path: &Path, version_args: &[&str]) -> bool {
    path.is_file() && command_version(path, version_args).is_ok()
}

fn command_version(path: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to start {}: {err}", path.display()))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= Duration::from_secs(5) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} --version timed out", path.display()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed waiting for {}: {err}", path.display()));
            }
        }
    };
    if !status.success() {
        return Err(format!("{} exited with failure", path.display()));
    }
    Ok(String::new())
}

fn download_runtime_archive(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("better-agent-terminal-runtime-installer")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client.get(url).send().map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "download failed: {url} -> HTTP {}",
            response.status()
        ));
    }
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|err| err.to_string())
}

fn verify_sri_sha512(bytes: &[u8], integrity: &str) -> Result<(), String> {
    let expected = integrity
        .strip_prefix("sha512-")
        .ok_or_else(|| "missing runtime package sha512 integrity".to_string())?;
    let actual = B64.encode(Sha512::digest(bytes));
    if actual != expected {
        return Err("runtime package integrity mismatch".into());
    }
    Ok(())
}

fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = GzDecoder::new(bytes);
    let mut decoded = Vec::new();
    decoder
        .read_to_end(&mut decoded)
        .map_err(|err| err.to_string())?;
    Ok(decoded)
}

fn read_first_tar_entry(tar: &[u8], wanted_names: &[String]) -> Option<Vec<u8>> {
    wanted_names
        .iter()
        .find_map(|wanted_name| read_tar_entry(tar, wanted_name))
}

fn read_tar_entry(tar: &[u8], wanted_name: &str) -> Option<Vec<u8>> {
    let mut offset = 0usize;
    while offset + 512 <= tar.len() {
        let header = &tar[offset..offset + 512];
        if header.iter().all(|byte| *byte == 0) {
            return None;
        }
        let name = tar_string(&header[0..100]);
        let prefix = tar_string(&header[345..500]);
        let full_name = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let size_text = tar_string(&header[124..136]);
        let size = usize::from_str_radix(size_text.trim().trim_matches('\0'), 8).ok()?;
        offset += 512;
        if offset + size > tar.len() {
            return None;
        }
        if full_name == wanted_name {
            return Some(tar[offset..offset + size].to_vec());
        }
        offset += size.div_ceil(512) * 512;
    }
    None
}

fn tar_string(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).to_string()
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn replace_runtime_dir(tmp_final: &Path, final_dir: &Path) -> Result<(), String> {
    let parent = final_dir
        .parent()
        .ok_or_else(|| "invalid runtime parent".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let name = final_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("runtime");
    let backup = parent.join(format!(".{name}.backup-{}", install_nonce()));
    let mut had_existing = false;
    if final_dir.exists() {
        fs::rename(final_dir, &backup).map_err(|err| err.to_string())?;
        had_existing = true;
    }
    match fs::rename(tmp_final, final_dir) {
        Ok(()) => {
            if had_existing {
                let _ = fs::remove_dir_all(&backup);
            }
            Ok(())
        }
        Err(err) => {
            if had_existing {
                let _ = fs::rename(&backup, final_dir);
            }
            Err(err.to_string())
        }
    }
}

fn install_nonce() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{}-{millis}", std::process::id())
}
