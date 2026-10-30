// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

/// Reads the waved admin macaroon (hex) for the WebView's gateway client.
///
/// The gateway rejects every RPC without it (verified waved v0.2.0). The
/// macaroon is minted at daemon STARTUP, before wallet creation, and lives
/// at `<data_dir>/data/<network>/admin.macaroon`. Reading it in the MAIN
/// process keeps all filesystem access out of the WebView.
#[tauri::command]
fn read_admin_macaroon(data_dir: String, network: String) -> Result<String, String> {
    let path = PathBuf::from(data_dir)
        .join("data")
        .join(network)
        .join("admin.macaroon");
    std::fs::read(&path)
        .map(|bytes| bytes.iter().map(|b| format!("{:02x}", b)).collect())
        .map_err(|e| format!("admin macaroon unavailable at {}: {e}", path.display()))
}

fn main() {
    tauri::Builder::default()
        // Shell plugin drives the waved sidecar (Command.sidecar) from the
        // WebView; its scope is restricted to the bundled waved binary in
        // capabilities/default.json — no arbitrary process execution.
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![read_admin_macaroon])
        .run(tauri::generate_context!())
        .expect("error while running Sovereign Wallet");
}
