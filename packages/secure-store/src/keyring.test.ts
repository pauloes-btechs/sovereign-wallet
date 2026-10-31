import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CorruptKeyError,
  DatabaseKeyService,
  FileKeyringStore,
  KEYRING_SERVICE,
  MemoryKeyringStore,
  TauriKeyringStore,
  databaseKeyAccount,
  type KeyringStore,
} from './index.js';

const SERVICE = KEYRING_SERVICE;
const DIR = await mkdtemp(path.join(tmpdir(), 'sovereign-keyring-'));

/** Shared round-trip contract: every KeyringStore must satisfy these. */
function assertKeyringContract(name: string, make: () => KeyringStore): void {
  it(`${name}: store → get → overwrite → get → delete → get`, async () => {
    const store = make();
    const account = databaseKeyAccount('round-trip');

    expect(await store.getPassword(SERVICE, account)).toBeUndefined();

    await store.setPassword(SERVICE, account, 'first-secret');
    expect(await store.getPassword(SERVICE, account)).toBe('first-secret');

    await store.setPassword(SERVICE, account, 'second-secret');
    expect(await store.getPassword(SERVICE, account)).toBe('second-secret');

    await store.deletePassword(SERVICE, account);
    expect(await store.getPassword(SERVICE, account)).toBeUndefined();
    // Idempotent delete.
    await expect(store.deletePassword(SERVICE, account)).resolves.toBeUndefined();
  });

  it(`${name}: isolates profiles (a deleted/overwritten key never leaks across accounts)`, async () => {
    const store = make();
    const a = databaseKeyAccount('profile-a');
    const b = databaseKeyAccount('profile-b');

    await store.setPassword(SERVICE, a, 'key-a');
    await store.setPassword(SERVICE, b, 'key-b');
    await store.deletePassword(SERVICE, a);

    expect(await store.getPassword(SERVICE, a)).toBeUndefined();
    expect(await store.getPassword(SERVICE, b)).toBe('key-b');
  });
}

describe('keyring round-trip: MemoryKeyringStore', () => {
  assertKeyringContract('memory', () => new MemoryKeyringStore());
});

describe('keyring round-trip: FileKeyringStore', () => {
  assertKeyringContract('file', () => new FileKeyringStore(DIR, { acknowledgePlaintext: true }));

  it('refuses construction without the explicit plaintext acknowledgment', () => {
    expect(() => new FileKeyringStore(DIR, { acknowledgePlaintext: false })).toThrow(
      /acknowledgePlaintext/,
    );
  });

  it('writes 0600 files (dev fallback discipline) and refuses path escapes', async () => {
    const store = new FileKeyringStore(DIR, { acknowledgePlaintext: true });
    const account = databaseKeyAccount('mode-a');
    await store.setPassword(SERVICE, account, 'x'.repeat(64));
    const file = path.join(DIR, 'keyring', SERVICE, encodeURIComponent(account));
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await expect(store.getPassword(SERVICE, '../escape')).rejects.toThrow(
      /Invalid keyring component/,
    );
  });
});

describe('keyring round-trip: TauriKeyringStore (scripted invoke, contract-pinned)', () => {
  interface RecordedCall {
    cmd: string;
    args: Record<string, unknown> | undefined;
  }
  const calls: RecordedCall[] = [];
  const backing = new Map<string, string>();

  function makeStore(): TauriKeyringStore {
    return new TauriKeyringStore(<T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const key = `${args?.['service']}\u0000${args?.['account']}`;
      switch (cmd) {
        case 'keyring_get_password':
          return Promise.resolve({ password: backing.get(key) ?? null } as T);
        case 'keyring_set_password':
          backing.set(key, String(args?.['password']));
          return Promise.resolve({} as T);
        case 'keyring_delete_password':
          backing.delete(key);
          return Promise.resolve({} as T);
        default:
          return Promise.reject(new Error(`unexpected command ${cmd}`));
      }
    });
  }

  assertKeyringContract('tauri', makeStore);

  it('sends exactly the service/account/password fields per command', async () => {
    calls.length = 0;
    backing.clear();
    const store = makeStore();
    const account = databaseKeyAccount('contract');
    await store.setPassword(SERVICE, account, 'v1');
    expect(calls[0]).toEqual({
      cmd: 'keyring_set_password',
      args: { service: SERVICE, account, password: 'v1' },
    });
    await store.getPassword(SERVICE, account);
    expect(calls[1]).toEqual({ cmd: 'keyring_get_password', args: { service: SERVICE, account } });
  });
});

describe('DatabaseKeyService', () => {
  it('creates a 32-byte key on first use and returns the SAME key thereafter', async () => {
    const keyring = new MemoryKeyringStore();
    const service = new DatabaseKeyService(keyring);
    const first = await service.getOrCreateKey('mode-a');
    expect(first).toHaveLength(32);
    const second = await service.getOrCreateKey('mode-a');
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    // Distinct profiles get distinct keys.
    const other = await service.getOrCreateKey('mode-b');
    expect(Buffer.from(other).equals(Buffer.from(first))).toBe(false);
  });

  it('refuses to re-key on a corrupt keyring entry (tamper signal, typed error)', async () => {
    const keyring = new MemoryKeyringStore();
    await keyring.setPassword(SERVICE, databaseKeyAccount('mode-a'), 'not-a-key');
    const service = new DatabaseKeyService(keyring);
    await expect(service.getOrCreateKey('mode-a')).rejects.toThrow(CorruptKeyError);
    // And it did NOT overwrite the entry in the process.
    expect(await keyring.getPassword(SERVICE, databaseKeyAccount('mode-a'))).toBe('not-a-key');
  });

  it('rejects invalid profile names before touching the keyring', async () => {
    const keyring = new MemoryKeyringStore();
    const service = new DatabaseKeyService(keyring);
    await expect(service.getOrCreateKey('../escape')).rejects.toThrow(/Invalid database profile/);
  });
});
