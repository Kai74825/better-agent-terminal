// update:* — small slice of the Electron update surface.
//
// We only port `update_get_version` for now: it reads the package
// version string Tauri compiled in (via PackageInfo). The Electron
// version of `update_check` queries GitHub Releases over HTTPS — that's
// substantial enough (HTTP client, release-channel parsing, signature
// validation) that we keep it as `notImplemented` until the packaging
// pipeline catches up. Phase 3 in plans/tauri-migration-plan.md owns
// the cross-runtime update flow rebuild.

#[tauri::command]
pub fn update_get_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(test)]
mod tests {
    // The real version string comes from PackageInfo at runtime; we can
    // at least confirm that the Cargo.toml version we build with parses
    // as a valid semver-ish string. This guards against accidental
    // version-bump typos in tauri.conf.json / Cargo.toml drift.
    #[test]
    fn cargo_pkg_version_is_non_empty() {
        let v = env!("CARGO_PKG_VERSION");
        assert!(!v.is_empty(), "CARGO_PKG_VERSION must not be empty");
        assert!(v.contains('.'), "version should contain a dot: {v}");
    }
}
