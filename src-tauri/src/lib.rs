// Tauri shell entrypoint for Better Agent Terminal.
//
// This file is intentionally small: the Electron preload still owns most of
// the host surface during the migration. Each new command lands here behind
// a strongly typed signature, and the renderer reaches it via the
// host-api adapter (src/host-api.ts). See plans/tauri-migration-plan.md.

mod commands;

use commands::{settings, shell as shell_cmd};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            settings::settings_load,
            settings::settings_save,
            shell_cmd::shell_open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running better-agent-terminal");
}
