// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::Manager;

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

// ——— platform keyring (macOS Keychain / Windows Credential Manager / Secret
// Service). Holds ONLY the database encryption key for SQLCipher-at-rest
// storage; the WebView reaches it through these commands, never the FS. ———

#[derive(Serialize)]
pub struct PasswordReply {
    pub password: Option<String>,
}

fn keyring_entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| format!("keyring entry: {e}"))
}

#[tauri::command]
fn keyring_get_password(service: String, account: String) -> Result<PasswordReply, String> {
    let entry = keyring_entry(&service, &account)?;
    match entry.get_password() {
        Ok(password) => Ok(PasswordReply { password: Some(password) }),
        // A missing entry is a normal "no key yet", not an error.
        Err(keyring::Error::NoEntry) => Ok(PasswordReply { password: None }),
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

#[tauri::command]
fn keyring_set_password(service: String, account: String, password: String) -> Result<(), String> {
    let entry = keyring_entry(&service, &account)?;
    entry
        .set_password(&password)
        .map_err(|e| format!("keyring write failed: {e}"))
}

#[tauri::command]
fn keyring_delete_password(service: String, account: String) -> Result<(), String> {
    delete_keyring_password(&service, &account)
}

/// Core of `keyring_delete_password`, kept command-free so tests verify the
/// production idempotency mapping directly.
fn delete_keyring_password(service: &str, account: &str) -> Result<(), String> {
    let entry = keyring_entry(service, account)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Idempotent delete, mirroring the TS KeyringStore contract: keyring
        // v3 reports NoEntry for an absent credential (observed on macOS CI).
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete failed: {e}")),
    }
}

// ——— SQLCipher-at-rest key/value database. The connection applies the key
// pragma BEFORE any other statement and VERIFIES SQLCipher is actually
// engaged (cipher_version) — a driver without SQLCipher fails to open, never
// silently writes plaintext. ———

const KV_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)";

fn valid_profile(profile: &str) -> bool {
    !profile.is_empty()
        && profile
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn valid_key_hex(key_hex: &str) -> bool {
    key_hex.len() == 64 && key_hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// Applies the SQLCipher key (raw 32-byte form, `x'<hex>'`) as the FIRST
/// statement on the connection, then proves the connection is encrypted.
fn apply_sqlcipher_key(conn: &Connection, key_hex: &str) -> Result<(), String> {
    if !valid_key_hex(key_hex) {
        return Err("secure_db: key must be 64 hex chars (32 raw bytes)".to_string());
    }
    // Must precede every other statement on this connection.
    conn.pragma_update(None, "key", format!("x'{key_hex}'"))
        .map_err(|e| format!("secure_db: applying key failed: {e}"))?;
    // Proof of encryption: plain SQLite has no cipher_version pragma (no row),
    // which is a HARD failure — the wallet must never fall back to plaintext.
    let mut stmt = conn
        .prepare("PRAGMA cipher_version")
        .map_err(|e| format!("secure_db: cipher probe failed: {e}"))?;
    let version: Option<String> = stmt
        .query_row([], |row| row.get(0))
        .map_err(|e| format!("secure_db: cipher probe failed: {e}"))?;
    match version {
        Some(v) if !v.is_empty() => Ok(()),
        _ => Err(
            "secure_db: SQLCipher is not active on this connection; refusing to serve data"
                .to_string(),
        ),
    }
}

fn db_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT v FROM kv WHERE k = ?1")
        .map_err(|e| e.to_string())?;
    stmt.query_row([key], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

fn db_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        [key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn db_delete(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM kv WHERE k = ?1", [key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// SQLCipher LIKE wildcards in keys are literal — escape them explicitly.
fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn db_keys(conn: &Connection, prefix: &str) -> Result<Vec<String>, String> {
    let pattern = format!("{}%", like_escape(prefix));
    let mut stmt = conn
        .prepare("SELECT k FROM kv WHERE k LIKE ?1 ESCAPE '\\' ORDER BY k")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([pattern], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())
}

/// Monotonic handle registry — closed handles are never reused, so a stale
/// WebView reference can never reach a different database.
///
/// Tauri managed state must be `Send + Sync`. rusqlite's `Connection` is
/// `Send` but not `Sync` (interior-mutable statement cache / inner handle),
/// so the registry guards the whole inner map behind a `Mutex` — one
/// command call at a time, which matches WebView command traffic.
struct DbRegistryInner {
    next_handle: u64,
    connections: HashMap<u64, Connection>,
}

struct DbRegistry(Mutex<DbRegistryInner>);

impl Default for DbRegistry {
    fn default() -> Self {
        Self(Mutex::new(DbRegistryInner { next_handle: 1, connections: HashMap::new() }))
    }
}

#[derive(Serialize)]
pub struct OpenReply {
    pub handle: u64,
}

#[tauri::command]
fn secure_db_open(
    registry: tauri::State<DbRegistry>,
    app: tauri::AppHandle,
    profile: String,
    key_hex: String,
) -> Result<OpenReply, String> {
    if !valid_profile(&profile) {
        return Err("secure_db: invalid profile name".to_string());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("secure_db: app data dir unavailable: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("secure_db: {}: {e}", dir.display()))?;
    let conn = Connection::open(dir.join(format!("{profile}.sqlite3")))
        .map_err(|e| format!("secure_db: open failed: {e}"))?;
    apply_sqlcipher_key(&conn, &key_hex)?;
    conn.execute(KV_SCHEMA, [])
        .map_err(|e| format!("secure_db: schema failed: {e}"))?;
    let mut state = registry
        .inner()
        .0
        .lock()
        .map_err(|_| "secure_db: registry poisoned".to_string())?;
    let handle = state.next_handle;
    state.next_handle += 1;
    state.connections.insert(handle, conn);
    Ok(OpenReply { handle })
}

#[derive(Serialize)]
pub struct ValueReply {
    pub value: Option<String>,
}

#[tauri::command]
fn secure_db_get(
    registry: tauri::State<DbRegistry>,
    handle: u64,
    key: String,
) -> Result<ValueReply, String> {
    let state = registry
        .inner()
        .0
        .lock()
        .map_err(|_| "secure_db: registry poisoned".to_string())?;
    let conn = state
        .connections
        .get(&handle)
        .ok_or_else(|| format!("secure_db: unknown handle {handle}"))?;
    Ok(ValueReply { value: db_get(conn, &key)? })
}

#[tauri::command]
fn secure_db_set(
    registry: tauri::State<DbRegistry>,
    handle: u64,
    key: String,
    value: String,
) -> Result<(), String> {
    let state = registry
        .inner()
        .0
        .lock()
        .map_err(|_| "secure_db: registry poisoned".to_string())?;
    let conn = state
        .connections
        .get(&handle)
        .ok_or_else(|| format!("secure_db: unknown handle {handle}"))?;
    db_set(conn, &key, &value)
}

#[tauri::command]
fn secure_db_delete(
    registry: tauri::State<DbRegistry>,
    handle: u64,
    key: String,
) -> Result<(), String> {
    let state = registry
        .inner()
        .0
        .lock()
        .map_err(|_| "secure_db: registry poisoned".to_string())?;
    let conn = state
        .connections
        .get(&handle)
        .ok_or_else(|| format!("secure_db: unknown handle {handle}"))?;
    db_delete(conn, &key)
}

#[derive(Serialize)]
pub struct KeysReply {
    pub keys: Vec<String>,
}

#[tauri::command]
fn secure_db_keys(
    registry: tauri::State<DbRegistry>,
    handle: u64,
    prefix: String,
) -> Result<KeysReply, String> {
    let state = registry
        .inner()
        .0
        .lock()
        .map_err(|_| "secure_db: registry poisoned".to_string())?;
    let conn = state
        .connections
        .get(&handle)
        .ok_or_else(|| format!("secure_db: unknown handle {handle}"))?;
    Ok(KeysReply { keys: db_keys(conn, &prefix)? })
}

#[tauri::command]
fn secure_db_close(registry: tauri::State<DbRegistry>, handle: u64) -> Result<(), String> {
    let mut state = registry
        .inner()
        .0
        .lock()
        .map_err(|_| "secure_db: registry poisoned".to_string())?;
    state.connections.remove(&handle); // dropping the Connection closes it
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_KEY: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    fn open_test_conn() -> Result<Connection, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        apply_sqlcipher_key(&conn, TEST_KEY)?;
        conn.execute(KV_SCHEMA, []).map_err(|e| e.to_string())?;
        Ok(conn)
    }

    #[test]
    fn sqlcipher_engages_and_rejects_non_hex_keys() {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string()).unwrap();
        // cipher_version must report an actual SQLCipher build.
        let mut stmt = conn.prepare("PRAGMA cipher_version").unwrap();
        let version: Option<String> = stmt.query_row([], |row| row.get(0)).unwrap();
        assert!(version.map(|v| !v.is_empty()).unwrap_or(false), "SQLCipher must be compiled in");
        // A short/odd key is refused before any pragma touches the file.
        assert!(apply_sqlcipher_key(&conn, "abcd").is_err());
        assert!(apply_sqlcipher_key(&conn, "zzzz").is_err());
    }

    #[test]
    fn kv_round_trip_with_prefix_semantics() {
        let conn = open_test_conn().unwrap();
        db_set(&conn, "intent:u1", "{\"v\":1}").unwrap();
        db_set(&conn, "intent:u2", "{}").unwrap();
        db_set(&conn, "intent:100%_weird", "v").unwrap();

        assert_eq!(db_get(&conn, "intent:u1").unwrap().as_deref(), Some("{\"v\":1}"));
        assert_eq!(db_get(&conn, "nope").unwrap(), None);

        let mut keys = db_keys(&conn, "intent:").unwrap();
        keys.sort();
        assert_eq!(keys.len(), 3);

        // Wildcards in the PREFIX are literal, not patterns.
        assert_eq!(db_keys(&conn, "intent:100%").unwrap(), vec!["intent:100%_weird"]);

        db_delete(&conn, "intent:u1").unwrap();
        assert_eq!(db_get(&conn, "intent:u1").unwrap(), None);
    }

    #[test]
    fn wrong_key_cannot_read_the_database() {
        let dir = std::env::temp_dir().join(format!("sovereign-sqlcipher-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("locked.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            apply_sqlcipher_key(&conn, TEST_KEY).unwrap();
            conn.execute(KV_SCHEMA, []).unwrap();
            db_set(&conn, "secret", "on disk encrypted").unwrap();
        }
        {
            // Reopen with a DIFFERENT valid key: data must be unreadable.
            let conn = Connection::open(&path).unwrap();
            apply_sqlcipher_key(&conn, &TEST_KEY.replace('a', "b")).unwrap();
            assert!(conn.execute(KV_SCHEMA, []).is_err(), "wrong key must not read the DB");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    // Per-platform keyring round-trip: macOS Keychain / Windows Credential
    // Manager. CI runs `cargo test` in the desktop-artifacts matrix on those
    // platforms; Linux has no secret service in CI, so it stays compile-only.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn keyring_round_trip_on_platform_store() {
        let service = format!("io.btechs.sovereign-wallet.test.{}", std::process::id());
        let account = "db-key:mode-a";
        let entry = keyring::Entry::new(&service, account).unwrap();

        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));

        entry.set_password("first-secret").unwrap();
        assert_eq!(entry.get_password().unwrap(), "first-secret");

        entry.set_password("second-secret").unwrap();
        assert_eq!(entry.get_password().unwrap(), "second-secret");

        entry.delete_credential().unwrap();
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
        // Idempotent delete — through the command's own error mapping, since
        // keyring v3 reports NoEntry (not Ok) for an absent credential.
        assert_eq!(delete_keyring_password(&service, account), Ok(()));
    }
}

fn main() {
    tauri::Builder::default()
        // Shell plugin drives the waved sidecar (Command.sidecar) from the
        // WebView; its scope is restricted to the bundled waved binary in
        // capabilities/default.json — no arbitrary process execution.
        .plugin(tauri_plugin_shell::init())
        .manage(DbRegistry::default())
        .invoke_handler(tauri::generate_handler![
            read_admin_macaroon,
            keyring_get_password,
            keyring_set_password,
            keyring_delete_password,
            secure_db_open,
            secure_db_get,
            secure_db_set,
            secure_db_delete,
            secure_db_keys,
            secure_db_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sovereign Wallet");
}
