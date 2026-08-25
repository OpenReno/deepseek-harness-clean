//! App metadata: version + per-user config directory.

use tauri::Manager;

use crate::error::AppResult;

#[tauri::command]
pub async fn app_version(app: tauri::AppHandle) -> AppResult<String> {
    Ok(app.package_info().version.to_string())
}

#[tauri::command]
pub async fn app_config_dir(app: tauri::AppHandle) -> AppResult<String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| crate::error::AppError::Other(format!("config dir: {e}")))?;
    Ok(dir.display().to_string())
}