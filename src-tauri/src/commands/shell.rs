// shell:open-external — first OS integration we route through Tauri.
//
// We rely on tauri-plugin-shell rather than calling out to opener crates
// directly so the OS integration stays consistent with what Tauri's
// security model audits. The renderer's host-api adapter maps
// shell.openExternal(url) to this command.

use serde::Serialize;
use tauri_plugin_shell::ShellExt;

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
    app.shell()
        .open(url, None)
        .map_err(Into::<CommandError>::into)?;
    Ok(())
}
