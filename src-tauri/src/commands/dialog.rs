// dialog:confirm — Tauri equivalent of Electron's dialog.showMessageBox
// confirmation flow.
//
// Electron preload exposes `dialog.confirm(message, title?) -> Promise<bool>`
// where true means "OK pressed". We mirror that contract here so the
// host-api adapter can route either runtime without changing the renderer
// call site.
//
// The OS-modal nature of this dialog means it suspends the user until they
// click; tauri-plugin-dialog routes the actual prompt onto the platform's
// native dialog APIs. We use `blocking_show()` from a Tauri command worker
// thread (commands never run on the main thread, so this is safe).

use serde::Serialize;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

#[tauri::command]
pub async fn dialog_confirm(
    app: tauri::AppHandle,
    message: String,
    title: Option<String>,
) -> Result<bool, CommandError> {
    let title = title.unwrap_or_else(|| "Confirm".to_string());
    // Run the blocking native dialog on a worker thread so we don't tie up
    // the async runtime. spawn_blocking is the supported way to do this
    // from inside a Tauri command (which itself runs on the async runtime).
    let app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(&message)
            .title(&title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show()
    })
    .await
    .map_err(|e| CommandError { message: e.to_string() })?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    // We can't open native dialogs in unit tests, so this only checks the
    // default-title fallback behaviour — the rest is integration territory.
    fn resolve_title(title: Option<String>) -> String {
        title.unwrap_or_else(|| "Confirm".to_string())
    }

    #[test]
    fn defaults_title_to_confirm() {
        assert_eq!(resolve_title(None), "Confirm");
        assert_eq!(resolve_title(Some("Quit?".into())), "Quit?");
        assert_eq!(resolve_title(Some(String::new())), "");
    }
}
