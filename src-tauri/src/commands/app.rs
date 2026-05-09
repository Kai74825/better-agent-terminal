// app:* — single-window stand-ins for the Electron multi-window
// shell. The Tauri MVP runs a single OS window, so anything that
// previously branched on windowId / windowIndex collapses to a
// constant. We still expose the full surface so renderer code that
// reads getWindowProfile() during initial render doesn't see a
// "not implemented" throw — it just gets null and the existing
// fallback path engages.
//
// Multi-window support is a Phase 3 concern (see
// plans/tauri-migration-plan.md): tauri::WebviewWindowBuilder works
// fine, but we'd also need to rebuild the per-window profile
// registry, the launch-profile flag plumbing, and the tray badge
// handling. None of that blocks the MVP.

use serde::Serialize;

// The single-window MVP always reports the same window identity.
// "main" matches Tauri's default `tauri.conf.json` window label;
// keep it in sync if the label ever changes.
const SINGLE_WINDOW_ID: &str = "main";
// The Electron renderer uses 1-indexed window numbers in the title
// bar ("[1] foo / project"). Pinning the index to 1 keeps the
// existing display logic intact.
const SINGLE_WINDOW_INDEX: u32 = 1;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct OpenNewInstanceResult {
    // Renderer reads `result?.alreadyOpen` to decide whether to
    // surface a "profile already open in this window" toast. Under
    // Tauri MVP we have one window so opening a "new instance"
    // never spawns; we report alreadyOpen=true so the renderer's
    // existing toast path trips and the user gets feedback.
    #[serde(rename = "alreadyOpen")]
    pub already_open: bool,
}

#[tauri::command]
pub fn app_get_window_id() -> String {
    SINGLE_WINDOW_ID.to_string()
}

#[tauri::command]
pub fn app_get_window_index() -> u32 {
    SINGLE_WINDOW_INDEX
}

#[tauri::command]
pub fn app_get_launch_profile() -> Option<String> {
    None
}

#[tauri::command]
pub fn app_get_window_profile() -> Option<String> {
    None
}

#[tauri::command]
pub fn app_new_window() -> String {
    // Multi-window rebuild lives in Phase 3; until then we just
    // surface the existing window's id so the renderer's "focus the
    // newly created window" code path does no harm.
    SINGLE_WINDOW_ID.to_string()
}

#[tauri::command]
pub fn app_focus_next_window() -> bool {
    // No other windows to cycle to; the renderer treats `false` as
    // "no-op" (the keyboard-shortcut callsite ignores it).
    false
}

#[tauri::command]
pub fn app_open_new_instance(_profile_id: String) -> OpenNewInstanceResult {
    OpenNewInstanceResult { already_open: true }
}

#[tauri::command]
pub fn app_set_dock_badge(_count: i64) {
    // Tauri tray badge needs a tray + per-platform icon work; tracked
    // alongside multi-window support in Phase 3.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_window_constants_are_stable() {
        // These constants are part of the renderer contract — bumping
        // them changes the title bar's window number and the
        // workspace.getDetachedId fallback, so guard them with a test.
        assert_eq!(app_get_window_id(), "main");
        assert_eq!(app_get_window_index(), 1);
        assert_eq!(app_get_launch_profile(), None);
        assert_eq!(app_get_window_profile(), None);
        assert_eq!(app_new_window(), "main");
        assert!(!app_focus_next_window());
    }

    #[test]
    fn open_new_instance_reports_already_open() {
        // Until multi-window is real, every "open profile in new
        // instance" attempt should bounce with alreadyOpen=true so
        // the renderer surfaces the existing toast instead of
        // silently doing nothing.
        let r = app_open_new_instance("profile-x".into());
        assert_eq!(r, OpenNewInstanceResult { already_open: true });
    }

    #[test]
    fn open_new_instance_serializes_camel_case() {
        // The renderer reads `result?.alreadyOpen` (camelCase). The
        // serde rename has to match exactly or the toast never fires.
        let r = app_open_new_instance("profile-x".into());
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"alreadyOpen\":true"), "got: {json}");
        assert!(!json.contains("already_open"), "snake_case leaked: {json}");
    }

    #[test]
    fn set_dock_badge_is_a_noop() {
        // No return value; we just call to confirm no panic on
        // negative / zero / large counts.
        app_set_dock_badge(0);
        app_set_dock_badge(42);
        app_set_dock_badge(-1);
    }
}
