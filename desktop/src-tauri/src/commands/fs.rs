//! Sandboxed filesystem access. All paths must resolve under one of the
//! three allowlisted roots (see `state::FS_ALLOWLIST`).
//!
//! `args.root` ∈ {"config_dir", "dsh_home", "agents_home"}
//! `args.path` is relative to that root.

use serde::Deserialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct FsArgs {
    pub root: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct FsWriteArgs {
    pub root: String,
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Deserialize)]
pub struct FsListArgs {
    pub root: String,
    pub path: Option<String>,
}

#[derive(serde::Serialize)]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
pub async fn fs_read(args: FsArgs, state: State<'_, AppState>) -> AppResult<String> {
    let p = state.resolve_under_root(&args.root, &args.path)?;
    tokio::fs::read_to_string(p).await.map_err(AppError::from)
}

#[tauri::command]
pub async fn fs_write(args: FsWriteArgs, state: State<'_, AppState>) -> AppResult<()> {
    let p = state.resolve_under_root(&args.root, &args.path)?;
    if let Some(parent) = p.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(p, args.contents).await.map_err(AppError::from)
}

#[tauri::command]
pub async fn fs_list(args: FsListArgs, state: State<'_, AppState>) -> AppResult<Vec<FsEntry>> {
    let rel = args.path.unwrap_or_default();
    let p = state.resolve_under_root(&args.root, &rel)?;
    let mut rd = tokio::fs::read_dir(p).await?;
    let mut out = Vec::new();
    while let Some(entry) = rd.next_entry().await? {
        let meta = entry.metadata().await?;
        out.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: meta.len(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn fs_exists(args: FsArgs, state: State<'_, AppState>) -> AppResult<bool> {
    match state.resolve_under_root(&args.root, &args.path) {
        Ok(p) => Ok(tokio::fs::try_exists(p).await.unwrap_or(false)),
        Err(AppError::PathNotAllowed(_)) => Ok(false),
        Err(e) => Err(e),
    }
}