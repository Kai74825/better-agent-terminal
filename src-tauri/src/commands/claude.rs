// claude.* — first cut of the Phase 2 sidecar surface.
//
// These commands forward to the Node sidecar over JSON-RPC. The actual
// Claude/agent logic lives in node-sidecar/src/server.mjs (and will grow
// as we move @anthropic-ai/claude-agent-sdk callsites out of the Electron
// main process). The Rust side is intentionally thin: pick a method name,
// pass through params, and return whatever the sidecar returns.
//
// MVP commands:
//   claude_ping            — round-trip probe used by tests.
//   claude_auth_status     — returns null until accounts are wired through.
//   claude_account_list    — returns [].
//
// Each one resolves the SpawnConfig from the AppHandle so the bridge can
// find both `node` on PATH and the bundled sidecar script. Failures bubble
// up as { message } strings to the renderer.

use crate::sidecar::{BridgeError, SidecarState, resolve_spawn_config};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, State};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

fn call(
    app: &AppHandle,
    state: &SidecarState,
    method: &str,
    params: Value,
) -> Result<Value, BridgeError> {
    let cfg = resolve_spawn_config(app)?;
    state.call(&cfg, method, params, DEFAULT_TIMEOUT)
}

#[tauri::command]
pub fn claude_ping(
    app: AppHandle,
    state: State<'_, SidecarState>,
    payload: Option<Value>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "ping", payload.unwrap_or(Value::Null))
}

#[tauri::command]
pub fn claude_auth_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.authStatus", Value::Null)
}

#[tauri::command]
pub fn claude_account_list(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call(&app, &state, "claude.accountList", Value::Null)
}
