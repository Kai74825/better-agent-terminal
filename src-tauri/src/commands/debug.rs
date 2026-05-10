// debug:* — renderer logging surface.
//
// Electron exposes `debug.log(...args)` over `ipcRenderer.send('debug:log',
// ...args)` so the main process can persist the message to disk via the
// shared logger. Under Tauri, we just print to stderr / stdout for now
// (which the OS's terminal or the launching shell collects). A future
// follow-up can route this into a dedicated log file under
// <app-data>/logs/, matching the userData/debug.log location.
//
// `isDebugMode` is exposed synchronously from the JS side, not through a
// command — the adapter reads BAT_DEBUG out of process.env at startup.
// This file only handles the runtime log call.

use serde_json::Value;

#[tauri::command]
pub fn debug_log(args: Vec<Value>) {
    // Stringify each arg so non-string payloads ({ … }, arrays, numbers)
    // still produce readable output.
    let parts: Vec<String> = args
        .into_iter()
        .map(|v| match v {
            Value::String(s) => s,
            other => other.to_string(),
        })
        .collect();
    eprintln!("[renderer] {}", parts.join(" "));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The command body is a side-effecting print; we can at least cover
    // the Value→String formatting branch so future refactors don't
    // regress how nested objects render.
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
}
