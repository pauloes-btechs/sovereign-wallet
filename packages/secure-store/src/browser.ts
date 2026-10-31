/**
 * Browser-safe entry for the desktop WebView. Every module re-exported here
 * is free of static node-builtin imports — the desktop bundle must never
 * pull in node:fs, node:crypto, node:sqlite, or Buffer. The node-only
 * adapters (FileKeyringStore, openNodeSqliteDatabase, the dev backend
 * factory) remain on the root barrel entry, which is where node/dev/CI
 * consumers import from.
 */

import { openTauriSqlcipherDatabase } from './db-tauri-sqlcipher.js';
import type { KeyringStore } from './keyring.js';
import type { TauriInvoke } from './keyring-tauri.js';
import type { EncryptedDatabase } from './encrypted-db.js';

export { MemoryKeyringStore, type KeyringStore } from './keyring.js';
export { TauriKeyringStore, type TauriInvoke } from './keyring-tauri.js';
export {
  DatabaseKeyService,
  CorruptKeyError,
  KEYRING_SERVICE,
  databaseKeyAccount,
} from './db-key.js';
export {
  PlaintextBackendError,
  type EncryptedDatabase,
  type DatabaseCapabilities,
} from './encrypted-db.js';
export { openTauriSqlcipherDatabase } from './db-tauri-sqlcipher.js';

/** Desktop production factory: the only secure backend a WebView can host is
 * the Tauri SQLCipher command protocol. There is no dev/plaintext option on
 * this entry by construction. */
export async function openSecureDatabase(options: {
  profile: string;
  keyring: KeyringStore;
  tauriInvoke: TauriInvoke;
}): Promise<EncryptedDatabase> {
  return openTauriSqlcipherDatabase(options.profile, options.tauriInvoke, options.keyring);
}
