/**
 * Node-side secure-database factory (dev/CI). Statically imports both
 * backends — this module is only reachable from the root barrel entry, so
 * the node builtins never enter a browser bundle.
 */

import { openNodeSqliteDatabase } from './db-node-sqlite.js';
import { openTauriSqlcipherDatabase } from './db-tauri-sqlcipher.js';
import {
  PlaintextBackendError,
  type EncryptedDatabase,
  type OpenSecureDatabaseOptions,
} from './encrypted-db.js';

export async function openSecureDatabase(
  options: OpenSecureDatabaseOptions,
): Promise<EncryptedDatabase> {
  if (options.tauriInvoke && options.devNode) {
    throw new Error('openSecureDatabase: pass exactly one backend (tauriInvoke or devNode).');
  }
  if (options.tauriInvoke) {
    return openTauriSqlcipherDatabase(options.profile, options.tauriInvoke, options.keyring);
  }
  if (options.devNode) {
    if (!options.allowPlaintext) throw new PlaintextBackendError('node-sqlite-plaintext');
    return openNodeSqliteDatabase(options.profile, options.devNode.dataRoot);
  }
  throw new Error('openSecureDatabase: no backend provided.');
}
