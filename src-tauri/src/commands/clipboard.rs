// clipboard:writeText — first slice of the clipboard surface.
//
// Electron preload exposes:
//   clipboard.writeText(text)  -> Promise<boolean>     ✅ ported here
//   clipboard.saveImage()      -> Promise<string|null> ⏳ pending (needs raw bytes)
//   clipboard.writeImage(file) -> Promise<boolean>     ⏳ pending (needs raw bytes)
//
// We're starting with text because it's the only one that doesn't need a
// raw-image bridge across the JS↔Rust boundary; image ports will reuse the
// same plugin once we've wired the data-URL path.

use serde::Serialize;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

#[tauri::command]
pub fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<bool, CommandError> {
    app.clipboard()
        .write_text(text)
        .map(|_| true)
        .map_err(|e| CommandError {
            message: e.to_string(),
        })
}

#[cfg(test)]
mod tests {
    // The plugin owns OS clipboard access, which is impractical to unit
    // test. We at least verify our error wrapping is well-formed.
    use super::CommandError;
    use serde_json::json;

    #[test]
    fn command_error_serializes_message() {
        let err = CommandError {
            message: "boom".into(),
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v, json!({ "message": "boom" }));
    }
}
