import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryKeyringStore,
  PlaintextBackendError,
  openNodeSqliteDatabase,
  openSecureDatabase,
  type EncryptedDatabase,
  type TauriInvoke,
} from './index.js';

describe('openSecureDatabase: fail-closed discipline', () => {
  it('REFUSES the node:sqlite backend without an explicit allowPlaintext opt-in', async () => {
    await expect(
      openSecureDatabase({
        profile: 'mode-a',
        keyring: new MemoryKeyringStore(),
        devNode: { dataRoot: '/tmp/should-never-be-created' },
      }),
    ).rejects.toThrow(PlaintextBackendError);
  });

  it('refuses to open with no backend and refuses contradictory backends', async () => {
    await expect(
      openSecureDatabase({ profile: 'mode-a', keyring: new MemoryKeyringStore() }),
    ).rejects.toThrow(/no backend/);
    await expect(
      openSecureDatabase({
        profile: 'mode-a',
        keyring: new MemoryKeyringStore(),
        tauriInvoke: fakeInvoke([]),
        devNode: { dataRoot: '/tmp/x' },
      }),
    ).rejects.toThrow(/exactly one backend/);
  });
});

describe('openSecureDatabase: Tauri SQLCipher contract (scripted invoke)', () => {
  it('derives the key from the keyring and opens the DB with keyHex BEFORE any query', async () => {
    const recorded: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
    const db = await openSecureDatabase({
      profile: 'mode-a',
      keyring: new MemoryKeyringStore(),
      tauriInvoke: fakeInvoke(recorded),
    });
    expect(db.capabilities).toEqual({ backend: 'sqlcipher-tauri', encryptedAtRest: true });

    await db.set('intent:1', '{"json":true}');
    const cmds = recorded.map((c) => c.cmd);
    const openIdx = cmds.indexOf('secure_db_open');
    expect(openIdx).toBe(0);
    expect(openIdx).toBeLessThan(cmds.indexOf('secure_db_set'));
    // The open call carried 64 hex chars (the 32-byte key) — never base64, never the raw bytes.
    const openArgs = recorded[0]?.args as { keyHex?: string; profile?: string } | undefined;
    expect(openArgs?.profile).toBe('mode-a');
    expect(openArgs?.keyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * Scripted invoke standing in for the Rust side: a real in-memory K/V behind
 * the same command protocol, so the TS contract (command names, args,
 * replies, handle discipline) is pinned even without a SQLCipher build.
 */
function fakeInvoke(
  recorded: Array<{ cmd: string; args: Record<string, unknown> | undefined }>,
): TauriInvoke {
  let nextHandle = 1;
  const handles = new Map<number, Map<string, string>>();
  return <T>(cmd: string, args?: Record<string, unknown>) => {
    recorded.push({ cmd, args });
    switch (cmd) {
      case 'secure_db_open': {
        const handle = nextHandle++;
        handles.set(handle, new Map());
        return Promise.resolve({ handle } as T);
      }
      case 'secure_db_get': {
        const store = handles.get(Number(args?.['handle']))!;
        return Promise.resolve({ value: store.get(String(args?.['key'])) ?? null } as T);
      }
      case 'secure_db_set': {
        const store = handles.get(Number(args?.['handle']))!;
        store.set(String(args?.['key']), String(args?.['value']));
        return Promise.resolve({ ok: true } as T);
      }
      case 'secure_db_delete': {
        const store = handles.get(Number(args?.['handle']))!;
        store.delete(String(args?.['key']));
        return Promise.resolve({ ok: true } as T);
      }
      case 'secure_db_keys': {
        const store = handles.get(Number(args?.['handle']))!;
        const prefix = String(args?.['prefix']);
        return Promise.resolve({
          keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort(),
        } as T);
      }
      case 'secure_db_close':
        handles.delete(Number(args?.['handle']));
        return Promise.resolve({ ok: true } as T);
      default:
        return Promise.reject(new Error(`unexpected command ${cmd}`));
    }
  };
}

describe('openNodeSqliteDatabase (dev/CI backend): storage semantics', () => {
  let db: EncryptedDatabase;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sovereign-sqlite-'));
    db = await openNodeSqliteDatabase('intent-store-test', root);
  });

  it('honestly reports plaintext capabilities', () => {
    expect(db.capabilities).toEqual({
      backend: 'node-sqlite-plaintext',
      encryptedAtRest: false,
    });
  });

  it('set/get/delete/keys round-trips, including JSON and unicode values', async () => {
    const value = JSON.stringify({ intentId: 'u1', emoji: '🚀', nested: { a: 1 } });
    await db.set('intent:u1', value);
    expect(await db.get('intent:u1')).toBe(value);
    await db.set('intent:u2', '{}');
    expect((await db.keys('intent:')).sort()).toEqual(['intent:u1', 'intent:u2']);
    await db.delete('intent:u1');
    expect(await db.get('intent:u1')).toBeUndefined();
    expect(await db.get('intent:u2')).toBe('{}');
  });

  it('treats prefix wildcards in keys as literal characters (LIKE escaping)', async () => {
    await db.set('intent:100%_weird', 'v');
    expect(await db.keys('intent:100')).toEqual(['intent:100%_weird']);
    // A LIKE-unescaped wildcard would match 'intent:1...' rows it must not.
    expect(await db.keys('intent:100%')).toEqual(['intent:100%_weird']);
  });

  it('persists across reopen (same file)', async () => {
    await db.set('durable:key', 'still-here');
    await db.close();
    const reopened = await openNodeSqliteDatabase('intent-store-test', root);
    expect(await reopened.get('durable:key')).toBe('still-here');
    await reopened.close();
  });
});
