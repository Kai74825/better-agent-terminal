// debug:* — renderer logging surface.
//
// Electron exposes `debug.log(...args)` over `ipcRenderer.send('debug:log',
// ...args)` so the main process can persist the message to disk via the
// shared logger. Under Tauri, we mirror that with a best-effort append to
// <app-data>/logs/debug.log and still print to stderr for dev sessions.
//
// `isDebugMode` is exposed synchronously from the JS side, not through a
// command — the adapter reads BAT_DEBUG out of process.env at startup.
// This file only handles the runtime log call.

use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[tauri::command]
pub async fn debug_log(app: tauri::AppHandle, args: Vec<Value>) {
    let message = format_args(args);
    eprintln!("[renderer] {message}");
    let path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("logs").join("debug.log"));
    if let Some(path) = path {
        let line = debug_log_line(&message);
        let _ = tauri::async_runtime::spawn_blocking(move || append_log_line(&path, &line)).await;
    }
}

fn format_args(args: Vec<Value>) -> String {
    let parts: Vec<String> = args
        .into_iter()
        .map(|v| match v {
            Value::String(s) => s,
            other => other.to_string(),
        })
        .collect();
    parts.join(" ")
}

fn debug_log_line(message: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{millis} [renderer] {message}\n")
}

fn append_log_line(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn strings_pass_through_untouched() {
        assert_eq!(
            format_args(vec![json!("hello"), json!("world")]),
            "hello world"
        );
    }

    #[test]
    fn non_strings_serialize_as_json_text() {
        assert_eq!(
            format_args(vec![json!(42), json!({"a": 1})]),
            r#"42 {"a":1}"#
        );
        assert_eq!(format_args(vec![json!([1, 2, 3])]), "[1,2,3]");
        assert_eq!(format_args(vec![json!(null), json!(true)]), "null true");
    }

    #[test]
    fn appends_renderer_log_line_to_file() {
        let path: PathBuf = std::env::temp_dir().join(format!(
            "bat-debug-log-{}-{}.log",
            std::process::id(),
            "append"
        ));
        let _ = fs::remove_file(&path);

        append_log_line(&path, "1 [renderer] hello\n").unwrap();
        append_log_line(&path, "2 [renderer] world\n").unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert_eq!(raw, "1 [renderer] hello\n2 [renderer] world\n");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn log_line_has_renderer_prefix() {
        let line = debug_log_line("hello");
        assert!(line.contains(" [renderer] hello\n"));
    }
}
