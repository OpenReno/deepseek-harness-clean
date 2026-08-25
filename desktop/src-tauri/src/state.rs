//! Shared state for the desktop shell.
//!
//! Holds the paths Tauri needs at runtime (config dir, crash log path) plus
//! the optional handle to the spawned Node host child process so we can kill
//! it on window close.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// Allowlisted filesystem roots. Anything outside these is rejected by
/// `commands::fs` regardless of what the frontend asks for.
pub const FS_ALLOWLIST: &[&str] = &[
    "config_dir", // Tauri app config dir (per-user)
    "dsh_home",   // $DSH_HOME (typically ~/.dsh)
    "agents_home" // ~/.agents (junction target for skills)
];

pub struct AppState {
    pub config_dir: PathBuf,
    pub dsh_home: PathBuf,
    pub agents_home: PathBuf,
    pub crash_log_path: PathBuf,
    pub http: reqwest::Client,
    /// Handle to the spawned Node host child. Set by `host::spawn_and_wait`.
    host_child: Arc<Mutex<Option<tokio::process::Child>>>,
}

impl AppState {
    pub fn new(app: &AppHandle) -> AppResult<Self> {
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| AppError::Other(format!("config dir: {e}")))?;
        std::fs::create_dir_all(&config_dir)?;

        // DSH_HOME defaults to ~/.dsh (matches upstream convention).
        let dsh_home = std::env::var("DSH_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .unwrap_or_else(|_| ".".to_string());
                PathBuf::from(home).join(".dsh")
            });
        let _ = std::fs::create_dir_all(&dsh_home);

        let agents_home = dsh_home
            .parent()
            .map(|p| p.join(".agents"))
            .unwrap_or_else(|| PathBuf::from("~/.agents"));
        let _ = std::fs::create_dir_all(&agents_home);

        let crash_log_path = config_dir.join("crash.log");

        let http = reqwest::Client::builder()
            .user_agent(concat!("dsh-desktop/", env!("CARGO_PKG_VERSION")))
            .build()?;

        Ok(Self {
            config_dir,
            dsh_home,
            agents_home,
            crash_log_path,
            http,
            host_child: Arc::new(Mutex::new(None)),
        })
    }

    /// Resolve a relative path against one of the allowlisted roots.
    /// Returns the absolute, canonicalized path or `PathNotAllowed`.
    pub fn resolve_under_root(&self, root: &str, rel: &str) -> AppResult<PathBuf> {
        let base = match root {
            "config_dir" if FS_ALLOWLIST.contains(&"config_dir") => &self.config_dir,
            "dsh_home" if FS_ALLOWLIST.contains(&"dsh_home") => &self.dsh_home,
            "agents_home" if FS_ALLOWLIST.contains(&"agents_home") => &self.agents_home,
            other => return Err(AppError::PathNotAllowed(format!("unknown root: {other}"))),
        };
        let joined = base.join(rel);
        let canonical = std::fs::canonicalize(&joined)
            .unwrap_or_else(|_| joined.clone());
        let canonical_base = std::fs::canonicalize(base)
            .unwrap_or_else(|_| base.clone());
        if !canonical.starts_with(&canonical_base) {
            return Err(AppError::PathNotAllowed(rel.to_string()));
        }
        Ok(canonical)
    }

    /// Take ownership of the spawned Node host child (one-time move).
    pub fn install_host_child(&self, child: tokio::process::Child) {
        *self.host_child.lock() = Some(child);
    }

    /// Best-effort kill of the Node host child. Synchronous because Tauri's
    /// window-close callback isn't async.
    pub fn kill_host_blocking(&self) -> AppResult<()> {
        if let Some(mut child) = self.host_child.lock().take() {
            let _ = child.start_kill();
            // Also wait to avoid zombie
            let _ = child.wait();
        }
        Ok(())
    }

    /// Append a panic / crash record to crash.log (one JSON object per line).
    pub async fn record_crash(&self, payload: &str) -> AppResult<()> {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.crash_log_path)
            .await?;
        let line = format!("{}\n", payload);
        file.write_all(line.as_bytes()).await?;
        Ok(())
    }
}
