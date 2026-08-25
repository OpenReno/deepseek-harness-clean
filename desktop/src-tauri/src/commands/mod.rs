//! OS-level Tauri commands. Each module is one capability.
//!
//! IMPORTANT: nothing here is business logic. Settings, MCP, skills, plugins,
//! sessions, LLM, tools are all served by the Node host on 127.0.0.1:3080.
//! These commands are only what the host cannot do cross-platform.

pub mod app_meta;
pub mod crash;
pub mod credentials;
pub mod deeplink;
pub mod dialog;
pub mod fs;
pub mod http_client;
pub mod shell;
pub mod updater;
