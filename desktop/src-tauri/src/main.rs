// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Logging is wired by tauri-plugin-log inside dsh_desktop_lib::run(); any
    // log::info!/warn!/error! call in our code (host.rs, state.rs, etc.) flows
    // through the same plugin to its per-user log file. We do NOT install a
    // global subscriber here — doing so would race tauri-plugin-log's own
    // initialization and panic with "attempted to set a logger after the
    // logging system was already initialized".
    dsh_desktop_lib::run()
}
