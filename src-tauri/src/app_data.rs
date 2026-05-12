use std::path::PathBuf;
use tauri::AppHandle;

pub const TAURI_DATA_DIR_ENV: &str = "BAT_TAURI_DATA_DIR";

// Pin storage to the Electron build's userData directory so a user keeps
// their accounts/snippets/terminal-history when migrating between the
// Electron and Tauri packages. Tauri's default app_data_dir() resolves to
// the bundle identifier (com.tonyq.better-agent-terminal), which would
// split data between the two builds.
const ELECTRON_PRODUCT_NAME: &str = "BetterAgentTerminal";

pub fn app_data_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var(TAURI_DATA_DIR_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    electron_user_data_dir().ok_or_else(|| "could not resolve Electron userData dir".to_string())
}

pub fn app_data_dir_opt(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).ok()
}

fn electron_user_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(ELECTRON_PRODUCT_NAME),
        );
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")?;
        return Some(PathBuf::from(appdata).join(ELECTRON_PRODUCT_NAME));
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            return Some(PathBuf::from(xdg).join(ELECTRON_PRODUCT_NAME));
        }
        let home = std::env::var_os("HOME")?;
        return Some(
            PathBuf::from(home)
                .join(".config")
                .join(ELECTRON_PRODUCT_NAME),
        );
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}
