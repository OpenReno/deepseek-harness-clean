//! App-wide error type. Each variant is a thin wrapper over the underlying
//! crate's error so the frontend receives a stable shape.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("tauri error: {0}")]
    Tauri(#[from] tauri::Error),

    #[error("path not allowed: {0}")]
    PathNotAllowed(String),

    #[error("binary not allowed: {0}")]
    BinaryNotAllowed(String),

    #[error("host not ready: {0}")]
    HostNotReady(String),

    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// Stable string code sent to the frontend for typed error handling.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Io(_) => "io",
            AppError::Keyring(_) => "keyring",
            AppError::Http(_) => "http",
            AppError::Serde(_) => "serde",
            AppError::Tauri(_) => "tauri",
            AppError::PathNotAllowed(_) => "path_not_allowed",
            AppError::BinaryNotAllowed(_) => "binary_not_allowed",
            AppError::HostNotReady(_) => "host_not_ready",
            AppError::Other(_) => "other",
        }
    }
}

/// Serialize for the frontend as `{ code, message }`.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
