/**
 * DatabaseKeyService — derives the at-rest encryption key for a database
 * profile from the platform keyring. Keys are 32 random bytes (SQLCipher's
 * raw-key size), stored base64url-encoded. A corrupt stored key is a tamper
 * signal: the service throws instead of silently re-keying (a silent re-key
 * orphans the existing database with no explanation).
 */
import type { KeyringStore } from './keyring.js';
import { base64UrlToBytes, bytesToBase64Url } from './encoding.js';

export const KEYRING_SERVICE = 'io.btechs.sovereign-wallet';

export function databaseKeyAccount(profile: string): string {
  if (!/^[a-z0-9-]+$/.test(profile)) {
    throw new Error(`Invalid database profile name: ${JSON.stringify(profile)}`);
  }
  return `db-key:${profile}`;
}

export class CorruptKeyError extends Error {
  constructor(profile: string) {
    super(
      `Keyring entry for database profile "${profile}" exists but is not a valid 32-byte key. Refusing to re-key (the existing database would become unreadable). Resolve the keyring entry manually.`,
    );
    this.name = 'CorruptKeyError';
  }
}

const BASE64URL = /^[A-Za-z0-9_-]{43}$/;

export class DatabaseKeyService {
  constructor(private readonly keyring: KeyringStore) {}

  async getOrCreateKey(profile: string): Promise<Uint8Array> {
    const account = databaseKeyAccount(profile);
    const existing = await this.keyring.getPassword(KEYRING_SERVICE, account);
    if (existing !== undefined) {
      if (!BASE64URL.test(existing)) throw new CorruptKeyError(profile);
      const key = base64UrlToBytes(existing);
      if (key.length !== 32) throw new CorruptKeyError(profile);
      return key;
    }
    // WebCrypto's getRandomValues is the one RNG available in every runtime
    // we ship (Node 22 and the desktop WebView).
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await this.keyring.setPassword(KEYRING_SERVICE, account, bytesToBase64Url(key));
    return key;
  }
}
