// notification:* — in-memory notification center.
//
// The Electron host pumps notifications in from the agent managers
// (claude/codex/openai). The Tauri MVP doesn't have those wired up
// yet, so the store starts empty and stays that way until the agent
// sidecar lands. We still surface the full read API (list,
// markRead, markAllRead, clear, focusEntry, focusLatestUnread,
// onUpdate) so the renderer's notification-store.ts can subscribe
// without crashing during startup.
//
// State is process-local on purpose: the Electron impl
// (electron/notification-center.ts) does the same thing — entries
// are not persisted across launches. Once agents land we'll have a
// `notification_add` command (or an internal helper) that the
// agent sidecar calls.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

const MAX_ENTRIES: usize = 50;

// Mirror src/stores/notification-store.ts NotificationEntry. The
// renderer-side interface is the source of truth — bumping fields
// here means bumping the TypeScript interface too.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct NotificationEntry {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "windowId")]
    pub window_id: Option<String>,
    #[serde(rename = "profileId")]
    pub profile_id: Option<String>,
    #[serde(rename = "workspaceName")]
    pub workspace_name: String,
    pub cwd: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub timestamp: i64,
    pub read: bool,
    #[serde(rename = "agentKind", skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<String>,
}

#[derive(Default)]
pub struct NotificationState {
    inner: Mutex<Vec<NotificationEntry>>,
}

impl NotificationState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<NotificationEntry>> {
        // Mutex poisoning here would mean a previous handler panicked
        // mid-update; we recover by treating that as "empty store"
        // rather than propagating the poison into every subsequent
        // call. The renderer can re-fetch via list() to resync.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct FocusResult {
    pub id: String,
    #[serde(rename = "windowId")]
    pub window_id: String,
}

#[tauri::command]
pub fn notification_list(state: State<'_, NotificationState>) -> Vec<NotificationEntry> {
    state.lock().clone()
}

#[tauri::command]
pub fn notification_mark_read(
    app: AppHandle,
    state: State<'_, NotificationState>,
    id: String,
) -> bool {
    let updated = {
        let mut entries = state.lock();
        if let Some(e) = entries.iter_mut().find(|e| e.id == id) {
            if e.read {
                false
            } else {
                e.read = true;
                true
            }
        } else {
            false
        }
    };
    if updated {
        emit_update(&app, &state);
    }
    updated
}

#[tauri::command]
pub fn notification_mark_all_read(
    app: AppHandle,
    state: State<'_, NotificationState>,
) -> bool {
    let mut changed = false;
    {
        let mut entries = state.lock();
        for e in entries.iter_mut() {
            if !e.read {
                e.read = true;
                changed = true;
            }
        }
    }
    if changed {
        emit_update(&app, &state);
    }
    true
}

#[tauri::command]
pub fn notification_mark_window_read(
    app: AppHandle,
    state: State<'_, NotificationState>,
) -> bool {
    // Single-window MVP — same effect as markAllRead. Once we have
    // multiple windows we'll resolve the calling window's id and
    // narrow this filter.
    notification_mark_all_read(app, state)
}

#[tauri::command]
pub fn notification_clear(
    app: AppHandle,
    state: State<'_, NotificationState>,
) -> bool {
    let cleared = {
        let mut entries = state.lock();
        if entries.is_empty() {
            false
        } else {
            entries.clear();
            true
        }
    };
    if cleared {
        emit_update(&app, &state);
    }
    true
}

#[tauri::command]
pub fn notification_focus_latest_unread(
    state: State<'_, NotificationState>,
) -> Option<FocusResult> {
    let entries = state.lock();
    for e in entries.iter() {
        if !e.read {
            if let Some(window_id) = &e.window_id {
                return Some(FocusResult {
                    id: e.id.clone(),
                    window_id: window_id.clone(),
                });
            }
        }
    }
    None
}

#[tauri::command]
pub fn notification_focus_entry(
    state: State<'_, NotificationState>,
    id: String,
) -> Option<FocusResult> {
    let entries = state.lock();
    let entry = entries.iter().find(|e| e.id == id)?;
    let window_id = entry.window_id.clone()?;
    Some(FocusResult { id: entry.id.clone(), window_id })
}

// Internal helper — push the current entry list to all listeners.
// Renderer subscribes via `listen("notification:update", ...)`.
fn emit_update(app: &AppHandle, state: &State<'_, NotificationState>) {
    let entries = state.lock().clone();
    let _ = app.emit("notification:update", entries);
}

// Helper used by the (future) agent sidecar to push a new entry.
// We expose it on `NotificationState` so the eventual claude/codex/
// openai modules can call it directly without re-parsing JSON.
#[allow(dead_code)]
pub fn add_entry(app: &AppHandle, state: &NotificationState, entry: NotificationEntry) {
    {
        let mut entries = state.lock();
        // Mirror the Electron behaviour: replace any existing entry
        // for the same workspace key (lowercased path on Windows).
        let key = normalize_workspace_key(&entry.cwd);
        entries.retain(|e| normalize_workspace_key(&e.cwd) != key);
        entries.insert(0, entry);
        if entries.len() > MAX_ENTRIES {
            entries.truncate(MAX_ENTRIES);
        }
    }
    let snapshot = state.lock().clone();
    let _ = app.emit("notification:update", snapshot);
}

pub fn normalize_workspace_key(cwd: &str) -> String {
    let normalized = cwd.trim().replace('\\', "/").trim_end_matches('/').to_string();
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        // Windows drive letter — case-insensitive comparison.
        normalized.to_lowercase()
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str, cwd: &str, read: bool) -> NotificationEntry {
        NotificationEntry {
            id: id.into(),
            session_id: "s1".into(),
            window_id: Some("main".into()),
            profile_id: None,
            workspace_name: "ws".into(),
            cwd: cwd.into(),
            reason: "completed".into(),
            result: None,
            error: None,
            timestamp: 0,
            read,
            agent_kind: None,
        }
    }

    #[test]
    fn fresh_state_is_empty() {
        let s = NotificationState::default();
        assert!(s.lock().is_empty());
    }

    #[test]
    fn normalize_workspace_key_matches_electron() {
        // Trailing slashes are dropped, backslashes are folded to
        // forward slashes, drive letter is lowercased on Windows.
        assert_eq!(normalize_workspace_key("C:\\Users\\Me"), "c:/users/me");
        assert_eq!(normalize_workspace_key("C:/Users/Me/"), "c:/users/me");
        assert_eq!(normalize_workspace_key("/home/me/repo/"), "/home/me/repo");
        // No drive letter: case is preserved (Linux/macOS are
        // case-sensitive, so collapsing to lowercase would over-merge).
        assert_eq!(normalize_workspace_key("/Home/Me"), "/Home/Me");
    }

    #[test]
    fn entry_serializes_camel_case() {
        // Renderer-side interface uses sessionId / windowId / etc.
        // The serde rename has to land or the renderer reads
        // undefined.
        let e = sample_entry("n1", "/repo", false);
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"sessionId\":\"s1\""));
        assert!(json.contains("\"windowId\":\"main\""));
        assert!(json.contains("\"workspaceName\":\"ws\""));
        // Optional fields with None should be omitted entirely.
        assert!(!json.contains("\"result\":"));
        assert!(!json.contains("\"error\":"));
        assert!(!json.contains("\"agentKind\":"));
    }

    // We can't construct an AppHandle in unit tests, so the state
    // mutation logic is exercised through small wrapper helpers
    // that don't touch the emitter.

    fn raw_mark_read(state: &NotificationState, id: &str) -> bool {
        let mut entries = state.lock();
        match entries.iter_mut().find(|e| e.id == id) {
            Some(e) if !e.read => { e.read = true; true }
            _ => false,
        }
    }

    fn raw_mark_all_read(state: &NotificationState) -> bool {
        let mut entries = state.lock();
        let mut changed = false;
        for e in entries.iter_mut() {
            if !e.read { e.read = true; changed = true; }
        }
        changed
    }

    fn raw_clear(state: &NotificationState) -> bool {
        let mut entries = state.lock();
        if entries.is_empty() { false } else { entries.clear(); true }
    }

    fn raw_add(state: &NotificationState, entry: NotificationEntry) {
        let mut entries = state.lock();
        let key = normalize_workspace_key(&entry.cwd);
        entries.retain(|e| normalize_workspace_key(&e.cwd) != key);
        entries.insert(0, entry);
        if entries.len() > MAX_ENTRIES { entries.truncate(MAX_ENTRIES); }
    }

    #[test]
    fn mark_read_only_returns_true_when_changed() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("n1", "/repo", false));
        assert!(raw_mark_read(&state, "n1"));
        // Already read — second call should be a no-op.
        assert!(!raw_mark_read(&state, "n1"));
        // Missing id — also no-op.
        assert!(!raw_mark_read(&state, "missing"));
    }

    #[test]
    fn mark_all_read_returns_true_only_when_anything_changed() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("a", "/r1", false));
        raw_add(&state, sample_entry("b", "/r2", true));
        assert!(raw_mark_all_read(&state));
        // Now everything is read, so a second call reports no change.
        assert!(!raw_mark_all_read(&state));
        let entries = state.lock();
        assert!(entries.iter().all(|e| e.read));
    }

    #[test]
    fn clear_returns_false_when_already_empty() {
        let state = NotificationState::default();
        assert!(!raw_clear(&state));
        raw_add(&state, sample_entry("a", "/r1", false));
        assert!(raw_clear(&state));
        assert!(state.lock().is_empty());
    }

    #[test]
    fn add_dedupes_by_workspace_key() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("a", "C:/repo", false));
        // Same workspace by case-insensitive key — should replace
        // the existing entry rather than accumulate two.
        raw_add(&state, sample_entry("b", "c:\\repo\\", false));
        let entries = state.lock();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "b");
    }

    #[test]
    fn add_caps_at_max_entries() {
        let state = NotificationState::default();
        for i in 0..(MAX_ENTRIES + 10) {
            raw_add(
                &state,
                sample_entry(&format!("n{i}"), &format!("/repo/{i}"), false),
            );
        }
        assert_eq!(state.lock().len(), MAX_ENTRIES);
        // Newest entry sits at the front.
        assert_eq!(state.lock()[0].id, format!("n{}", MAX_ENTRIES + 9));
    }

    #[test]
    fn focus_latest_unread_skips_read_and_windowless() {
        let state = NotificationState::default();
        // Add a read entry with a windowId — should be skipped.
        raw_add(&state, sample_entry("read", "/r1", true));
        // Add an unread entry but windowId = None — should be skipped.
        let mut wl = sample_entry("no-window", "/r2", false);
        wl.window_id = None;
        raw_add(&state, wl);
        // Add an unread entry with a windowId — this is the match.
        raw_add(&state, sample_entry("hit", "/r3", false));

        // We can't call notification_focus_latest_unread directly
        // without a State, so reproduce the logic here.
        let entries = state.lock();
        let mut found: Option<FocusResult> = None;
        for e in entries.iter() {
            if !e.read {
                if let Some(w) = &e.window_id {
                    found = Some(FocusResult { id: e.id.clone(), window_id: w.clone() });
                    break;
                }
            }
        }
        assert_eq!(found.unwrap().id, "hit");
    }
}
