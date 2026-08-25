//! Auto-update via `tauri-plugin-updater`. We only expose `check` to the
//! frontend; install/apply runs through the plugin's own UI flow.

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::error::{AppError, AppResult};
use serde::Serialize;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub available_version: Option<String>,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn updater_check(app: AppHandle) -> AppResult<UpdateInfo> {
    let updater = app.updater().map_err(|e| AppError::Other(format!("updater: {e}")))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            current_version: update.current_version.clone(),
            available_version: Some(update.version.clone()),
            notes: update.body.clone(),
        }),
        Ok(None) => Ok(UpdateInfo {
            current_version: app.package_info().version.to_string(),
            available_version: None,
            notes: None,
        }),
        Err(e) => Err(AppError::Other(format!("update check: {e}"))),
    }
}