// Tauri shell entrypoint for Better Agent Terminal.
//
// This file is intentionally small: the Electron preload still owns most of
// the host surface during the migration. Each new command lands here behind
// a strongly typed signature, and the renderer reaches it via the
// host-api adapter (src/host-api.ts). See plans/tauri-migration-plan.md.

mod commands;
mod path_guard;

use commands::{
    clipboard as clipboard_cmd, dialog as dialog_cmd, fs as fs_cmd, settings, shell as shell_cmd,
};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            settings::settings_load,
            settings::settings_save,
            settings::settings_get_shell_path,
            shell_cmd::shell_open_external,
            shell_cmd::shell_open_path,
            dialog_cmd::dialog_confirm,
            dialog_cmd::dialog_select_folder,
            dialog_cmd::dialog_select_files,
            dialog_cmd::dialog_select_images,
            fs_cmd::fs_read_file,
            clipboard_cmd::clipboard_write_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running better-agent-terminal");
}
