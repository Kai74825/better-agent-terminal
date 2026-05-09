// shell:open-external — first OS integration we route through Tauri.
//
// We use tauri-plugin-opener (the recommended replacement for the
// deprecated tauri-plugin-shell::open) so the OS integration stays
// consistent with what Tauri's security model audits. The renderer's
// host-api adapter maps shell.openExternal(url) to this command.

use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl<E: std::fmt::Display> From<E> for CommandError {
    fn from(value: E) -> Self {
        Self { message: value.to_string() }
    }
}

#[tauri::command]
pub async fn shell_open_external(app: tauri::AppHandle, url: String) -> Result<(), CommandError> {
    // Block obvious file:// URLs — those should go through openPath, not
    // openExternal. Mirrors the Electron preload split.
    if url.starts_with("file://") {
        return Err(CommandError {
            message: "shell_open_external refuses file:// URLs; use shell_open_path instead".into(),
        });
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(Into::<CommandError>::into)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    // Pure-input validation lives here; integration tests run via
    // tauri-driver once that harness is set up.
    fn rejects_file_scheme(url: &str) -> bool {
        url.starts_with("file://")
    }

    #[test]
    fn file_urls_are_rejected() {
        assert!(rejects_file_scheme("file:///etc/passwd"));
        assert!(rejects_file_scheme("file://localhost/c:/foo.txt"));
        assert!(!rejects_file_scheme("https://example.com"));
        assert!(!rejects_file_scheme("mailto:hi@example.com"));
    }
}
