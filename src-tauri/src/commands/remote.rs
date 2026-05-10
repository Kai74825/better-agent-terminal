// remote.* — cross-machine server / client. Forwards to the Node sidecar.
//
// All 8 methods stubbed in the sidecar today; real implementations land
// in Phase 3 alongside the mDNS + TLS pin work.

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
pub async fn remote_start_server(
    app: AppHandle,
    state: State<'_, SidecarState>,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "remote.startServer",
        json!({ "options": options.unwrap_or(Value::Null) }),
    )
    .await
}

#[tauri::command]
pub async fn remote_stop_server(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "remote.stopServer", Value::Null).await
}

#[tauri::command]
pub async fn remote_server_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "remote.serverStatus", Value::Null).await
}

#[tauri::command]
pub async fn remote_connect(
    app: AppHandle,
    state: State<'_, SidecarState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
    label: Option<String>,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "remote.connect",
        json!({ "host": host, "port": port, "token": token, "fingerprint": fingerprint, "label": label }),
    )
    .await
}

#[tauri::command]
pub async fn remote_disconnect(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "remote.disconnect", Value::Null).await
}

#[tauri::command]
pub async fn remote_client_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_blocking(app, state, "remote.clientStatus", Value::Null).await
}

#[tauri::command]
pub async fn remote_test_connection(
    app: AppHandle,
    state: State<'_, SidecarState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "remote.testConnection",
        json!({ "host": host, "port": port, "token": token, "fingerprint": fingerprint }),
    )
    .await
}

#[tauri::command]
pub async fn remote_list_profiles(
    app: AppHandle,
    state: State<'_, SidecarState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
) -> Result<Value, BridgeError> {
    call_blocking(
        app,
        state,
        "remote.listProfiles",
        json!({ "host": host, "port": port, "token": token, "fingerprint": fingerprint }),
    )
    .await
}
