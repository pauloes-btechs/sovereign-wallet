// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        // Shell plugin drives the waved sidecar (Command.sidecar) from the
        // WebView; its scope is restricted to the bundled waved binary in
        // capabilities/default.json — no arbitrary process execution.
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running Sovereign Wallet");
}
