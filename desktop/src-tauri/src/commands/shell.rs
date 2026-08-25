//! Whitelisted subprocess spawn. Only known binaries may be invoked; arguments
//! are passed through to the OS caller's discretion but are NOT sanitized.
//!
//! The whitelist is intentionally conservative (git, code editors). Anything
//! not on this list returns `BinaryNotAllowed`.

use serde::Deserialize;
use std::process::Stdio;
use tokio::process::Command;

use crate::error::{AppError, AppResult};

const ALLOWLIST: &[&str] = &[
    "git", "code", "code.cmd", "code-insiders", "code-insiders.cmd",
    "open", "xdg-open", "notepad.exe", "explorer.exe", "cmd.exe",
];

#[derive(Debug, Deserialize)]
pub struct ShellSpawnArgs {
    pub binary: String,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ShellSpawnResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub async fn shell_spawn(args: ShellSpawnArgs) -> AppResult<ShellSpawnResult> {
    let bin_name = std::path::Path::new(&args.binary)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&args.binary)
        .to_string();
    if !ALLOWLIST.iter().any(|w| *w == bin_name) {
        return Err(AppError::BinaryNotAllowed(args.binary));
    }

    let mut c = Command::new(&args.binary);
    if let Some(a) = args.args {
        c.args(a);
    }
    if let Some(cwd) = args.cwd {
        c.current_dir(cwd);
    }
    c.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = c.output().await.map_err(AppError::from)?;
    Ok(ShellSpawnResult {
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}