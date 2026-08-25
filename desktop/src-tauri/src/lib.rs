//! Thin Tauri shell for DeepSeek Harness.
//!
//! Responsibilities (OS layer ONLY — never business logic):
//!   1. Spawn the bundled Node host (`node dsh-runtime/bin.js web`) on port 3080
//!   2. Register 9 OS-level IPC commands (credentials, dialog, fs, shell, deeplink,
//!      http, app_meta, crash, updater)
//!   3. Show the WebView2 window once the Node host port is ready
//!
//! Everything else — settings, MCP, skills, plugins, sessions, LLM, tools — is
//! served by the upstream Node host. The Rust side has zero business logic.

mod commands;
mod error;
mod host;
mod state;

use tauri::Manager;

use crate::state::AppState;

/// Tauri builder entry. Called from `main.rs`.
pub fn run() {
    tauri::Builder::default()
        // Single-instance: focus existing window when user re-launches.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            log::info!("setup hook entered");
            // 1. Build shared state (paths + reqwest client)
            let app_state = AppState::new(app.handle())?;
            app.manage(app_state);
            log::info!("AppState initialized");

            // 2. Spawn the Node host and wait for port 3080. Use Tauri-managed
            //    async runtime (lives for the app's lifetime, drives the
            //    WebView event loop too). A manually-built tokio runtime here
            //    would be dropped when this `FnOnce` closure completes, killing
            //    the spawned task before its first poll.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                log::info!("host-spawn task started");
                if let Err(err) = host::spawn_and_wait(&handle).await {
                    log::error!("failed to start node host: {err:?}");
                    // Surface a crash log so the user can diagnose
                    if let Some(state) = handle.try_state::<AppState>() {
                        let _ = state.record_crash(&format!("host spawn failed: {err:?}")).await;
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // On window close, ask the OS to terminate the Node child too.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    let _ = state.kill_host_blocking();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 9 OS-level commands
            commands::credentials::credentials_get,
            commands::credentials::credentials_set,
            commands::credentials::credentials_delete,
            commands::dialog::dialog_open,
            commands::dialog::dialog_save,
            commands::dialog::dialog_message,
            commands::fs::fs_read,
            commands::fs::fs_write,
            commands::fs::fs_list,
            commands::fs::fs_exists,
            commands::shell::shell_spawn,
            commands::deeplink::deeplink_parse,
            commands::deeplink::deeplink_import,
            commands::http_client::http_request,
            commands::http_client::http_request_stream,
            commands::app_meta::app_version,
            commands::app_meta::app_config_dir,
            commands::crash::crash_log_path,
            commands::crash::crash_report,
            commands::updater::updater_check,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
