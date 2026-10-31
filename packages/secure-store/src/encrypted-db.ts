/**
 * EncryptedDatabase — a tiny key/value database port whose opening path is
 * fail-closed about encryption at rest. Two backends:
 *
 *  - Tauri SQLCipher (production desktop): the Rust side applies PRAGMA key
 *    (raw 32-byte key from the platform keyring) BEFORE any other statement;
 *    `encryptedAtRest: true`.
 *  - node:sqlite (dev/CI): the built-in driver has no encryption support, so
 *    `encryptedAtRest: false` and the factory REFUSES to open it unless the
 *    caller passes an explicit dev opt-in — a plaintext database must never
 *    exist by accident.
 */
import type { TauriInvoke } from './keyring-tauri.js';
import type { KeyringStore } from './keyring.js';

export interface DatabaseCapabilities {
  readonly backend: 'sqlcipher-tauri' | 'node-sqlite-plaintext';
  readonly encryptedAtRest: boolean;
}

export interface EncryptedDatabase {
  readonly capabilities: DatabaseCapabilities;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** All keys sharing `prefix`, ordered lexicographically. */
  keys(prefix: string): Promise<string[]>;
  close(): Promise<void>;
}

export class PlaintextBackendError extends Error {
  constructor(backend: string) {
    super(
      `Backend "${backend}" cannot enforce encryption at rest. Refusing to open it without an explicit { allowPlaintext: true } dev opt-in — plaintext storage must never happen by accident.`,
    );
    this.name = 'PlaintextBackendError';
  }
}

export interface OpenSecureDatabaseOptions {
  /** Database namespace (also names the keyring account). `[a-z0-9-]+`. */
  profile: string;
  /** Platform keyring; supplies the database encryption key. */
  keyring: KeyringStore;
  /** Production desktop backend (Rust SQLCipher). Mutually exclusive with devNode. */
  tauriInvoke?: TauriInvoke;
  /** Dev/CI backend (node:sqlite). Requires allowPlaintext. */
  devNode?: { /** Directory for the sqlite file. */ dataRoot: string };
  /** Explicit dev/CI opt-in to a plaintext-capable backend. */
  allowPlaintext?: boolean;
}

export async function openSecureDatabase(
  options: OpenSecureDatabaseOptions,
): Promise<EncryptedDatabase> {
  if (options.tauriInvoke && options.devNode) {
    throw new Error('openSecureDatabase: pass exactly one backend (tauriInvoke or devNode).');
  }
  if (options.tauriInvoke) {
    const { openTauriSqlcipherDatabase } = await import('./db-tauri-sqlcipher.js');
    return openTauriSqlcipherDatabase(options.profile, options.tauriInvoke, options.keyring);
  }
  if (options.devNode) {
    if (!options.allowPlaintext) throw new PlaintextBackendError('node-sqlite-plaintext');
    const { openNodeSqliteDatabase } = await import('./db-node-sqlite.js');
    return openNodeSqliteDatabase(options.profile, options.devNode.dataRoot);
  }
  throw new Error('openSecureDatabase: no backend provided.');
}
