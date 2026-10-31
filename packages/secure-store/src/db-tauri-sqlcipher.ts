/**
 * Tauri SQLCipher backend (production desktop). The Rust side opens the
 * database, applies the SQLCipher key pragma FIRST (raw 32-byte key from the
 * platform keyring), and serves get/set/delete/keys commands over a
 * Mutex<Connection>. The TS side pins that contract — including the
 * key-before-any-query ordering — in tests with a scripted invoke.
 */
import { DatabaseKeyService } from './db-key.js';
import { bytesToHex } from './encoding.js';
import type { DatabaseCapabilities, EncryptedDatabase } from './encrypted-db.js';
import type { KeyringStore } from './keyring.js';
import type { TauriInvoke } from './keyring-tauri.js';

type OpenReply = { handle: number };
type GetReply = { value: string | null };
type KeysReply = { keys: string[] };
type OkReply = { ok: true };

export async function openTauriSqlcipherDatabase(
  profile: string,
  invoke: TauriInvoke,
  keyring: KeyringStore,
): Promise<EncryptedDatabase> {
  const key = await new DatabaseKeyService(keyring).getOrCreateKey(profile);
  // Key material crosses the bridge as 64 hex chars; the Rust side applies it
  // as PRAGMA key = "x'<hex>'" before any other statement on the connection.
  const { handle } = await invoke<OpenReply>('secure_db_open', {
    profile,
    keyHex: bytesToHex(key),
  });

  const capabilities: DatabaseCapabilities = {
    backend: 'sqlcipher-tauri',
    encryptedAtRest: true,
  };

  return {
    capabilities,
    async get(key_: string): Promise<string | undefined> {
      const reply = await invoke<GetReply>('secure_db_get', { handle, key: key_ });
      return reply.value ?? undefined;
    },
    async set(key_: string, value: string): Promise<void> {
      await invoke<OkReply>('secure_db_set', { handle, key: key_, value });
    },
    async delete(key_: string): Promise<void> {
      await invoke<OkReply>('secure_db_delete', { handle, key: key_ });
    },
    async keys(prefix: string): Promise<string[]> {
      const reply = await invoke<KeysReply>('secure_db_keys', { handle, prefix });
      return reply.keys;
    },
    async close(): Promise<void> {
      await invoke<OkReply>('secure_db_close', { handle });
    },
  };
}
