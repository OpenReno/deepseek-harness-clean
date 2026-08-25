//! Crash log access. Each panic hook appends a JSON line to crash.log.

use serde::Deserialize;
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CrashReportArgs {
    pub payload: String,
}

#[tauri::command]
pub async fn crash_log_path(state: State<'_, AppState>) -> AppResult<String> {
    Ok(state.crash_log_path.display().to_string())
}

#[tauri::command]
pub async fn crash_report(
args: CrashReportArgs,
state: State<'_, AppState>,
) -> AppResult<()> {
    state.record_crash(&args.payload).await
}