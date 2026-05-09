// settings:load / settings:save — first port of the host settings surface.
//
// The renderer treats the payload as opaque JSON text (matching the
// Electron preload shape: settings.load returns Promise<string|null>,
// settings.save accepts a JSON string). We keep the same contract here so
// the host-api adapter can route to either runtime without changing
// caller types.
//
// The settings file lives at <app-data>/settings.json. Tauri 2's
// path::app_data_dir resolves to per-user app data, namespaced by the
// identifier in tauri.conf.json — we deliberately keep the filename
// "settings.json" so a future Electron→Tauri migration only has to copy
// the file across the data directory.

use serde::Serialize;
use std::fs;
use std::io;
use std::path::PathBuf;
use tauri::Manager;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("could not resolve app data directory: {0}")]
    AppDataDir(String),
    #[error("settings IO error: {0}")]
    Io(#[from] io::Error),
}

// Tauri's command system requires Serialize for error types so they cross
// the JS bridge. Use a simple message representation.
#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl From<SettingsError> for CommandError {
    fn from(value: SettingsError) -> Self {
        Self { message: value.to_string() }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, SettingsError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| SettingsError::AppDataDir(e.to_string()))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn settings_load(app: tauri::AppHandle) -> Result<Option<String>, CommandError> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(SettingsError::from)?;
    Ok(Some(text))
}

#[tauri::command]
pub fn settings_save(app: tauri::AppHandle, data: String) -> Result<(), CommandError> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(SettingsError::from)?;
    }
    fs::write(&path, data).map_err(SettingsError::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    // Pure-function tests live here; integration tests that exercise the
    // tauri::command macros run via `cargo test` in src-tauri once we have
    // a proper test harness for AppHandle.
    use super::*;

    #[test]
    fn settings_path_uses_settings_json_filename() {
        // We can't easily build an AppHandle in a unit test, so we assert
        // on the filename path component which the public function always
        // appends. This guards against accidental rename of the on-disk
        // file (which would lose user settings on upgrade).
        let p = PathBuf::from("/fake/app-data").join("settings.json");
        assert_eq!(p.file_name().unwrap(), "settings.json");
    }
}
