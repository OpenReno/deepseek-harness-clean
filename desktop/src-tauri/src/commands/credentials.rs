//! OS keyring access. Service name: `ai.deepseek.harness.desktop`.
//!
//! Frontend uses these instead of writing secrets to disk. The Node host's
//! `~/.dsh/.credentials.yaml` is the fallback when keyring is unavailable.

use keyring::Entry;
use serde::Deserialize;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "ai.deepseek.harness.desktop";

#[derive(Debug, Deserialize)]
pub struct CredentialArgs {
    pub key: String,
    pub value: Option<String>,
}

fn entry(key: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, key).map_err(AppError::from)
}

#[tauri::command]
pub async fn credentials_get(
args: CredentialArgs,
) -> AppResult<String> {
    let e = entry(&args.key)?;
    e.get_password().map_err(AppError::from)
}

#[tauri::command]
pub async fn credentials_set(
args: CredentialArgs,
) -> AppResult<()> {
    let e = entry(&args.key)?;
    let value = args
        .value
        .ok_or_else(|| AppError::Other("credentials_set: missing value".into()))?;
    e.set_password(&value).map_err(AppError::from)
}

#[tauri::command]
pub async fn credentials_delete(
args: CredentialArgs,
) -> AppResult<()> {
    let e = entry(&args.key)?;
    e.delete_credential().map_err(AppError::from)
}