// openai.* — forwards to the Node sidecar.
//
// Mirrors the Electron preload contract: 5 methods (getApiKeyStatus,
// setApiKey, clearApiKey, listSessions, compactNow). All stubbed in the
// sidecar today; real impls land when the OpenAI agent manager moves
// over.

use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, BridgeError, SidecarState};
use serde_json::{json, Value};
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
    let sink = app_handle_emit_sink(app.clone());
    state.call_with_emit(&cfg, Some(sink), method, params, DEFAULT_TIMEOUT)
}

async fn call_blocking(
    app: AppHandle,
    state: State<'_, SidecarState>,
    method: &'static str,
    params: Value,
) -> Result<Value, BridgeError> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || call(&app, &state, method, params))
        .await
        .map_err(|err| BridgeError {
            message: format!("{method} worker failed: {err}"),
        })?
}

#[tauri::command]
pub async fn openai_get_api_key_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "openai.getApiKeyStatus", Value::Null).await
}

#[tauri::command]
pub async fn openai_set_api_key(
    app: AppHandle,
    state: State<'_, SidecarState>,
    api_key: String,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "openai.setApiKey", json!({ "apiKey": api_key })).await
}

#[tauri::command]
pub async fn openai_clear_api_key(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "openai.clearApiKey", Value::Null).await
}

#[tauri::command]
pub async fn openai_list_sessions(
    app: AppHandle,
    state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "openai.listSessions", json!({ "cwd": cwd })).await
}

#[tauri::command]
pub async fn openai_compact_now(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "openai.compactNow",
        json!({ "sessionId": session_id }),
    )
    .await
}
