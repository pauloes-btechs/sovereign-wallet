import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openNodeSqliteDatabase, type EncryptedDatabase } from '@sovereign/secure-store';
import type { PaymentIntent } from './intent.js';
import { SqlitePaymentIntentStore } from './store-sqlite.js';

let root: string;
let db: EncryptedDatabase;
let reopenedDb: EncryptedDatabase;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sovereign-payments-sqlite-'));
  db = await openNodeSqliteDatabase('payments-test', root);
  reopenedDb = await openNodeSqliteDatabase('payments-test', root);
});

function anIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    intentId: '44444444-4444-4444-8444-444444444444',
    kind: 'lightning-invoice',
    payload: { invoice: 'lnbc1test' },
    maxFeeSat: 1_000,
    state: 'authorized',
    attempts: [],
    ...overrides,
  };
}

describe('SqlitePaymentIntentStore (node:sqlite backend)', () => {
  it('persists and returns an intent by id', async () => {
    const store = new SqlitePaymentIntentStore(db);
    const i = anIntent();
    await store.save(i);
    await expect(store.get(i.intentId)).resolves.toEqual(i);
  });

  it('returns undefined for an unknown intent id', async () => {
    const store = new SqlitePaymentIntentStore(db);
    await expect(store.get('nope')).resolves.toBeUndefined();
  });

  it('snapshots on write: mutating the saved object does not alter the store', async () => {
    const store = new SqlitePaymentIntentStore(db);
    const i = anIntent();
    await store.save(i);
    i.state = 'settled';
    i.attempts.push({ at: new Date().toISOString(), result: 'timeout' });
    await expect(store.get(i.intentId)).resolves.toEqual(anIntent());
  });

  it('snapshots on read: mutating the returned object does not corrupt the store', async () => {
    const store = new SqlitePaymentIntentStore(db);
    await store.save(anIntent());
    const first = await store.get('44444444-4444-4444-8444-444444444444');
    if (!first) throw new Error('expected intent');
    first.state = 'failed';
    await expect(store.get('44444444-4444-4444-8444-444444444444')).resolves.toEqual(anIntent());
  });

  it('lists every persisted intent', async () => {
    const store = new SqlitePaymentIntentStore(db);
    await store.save(anIntent({ intentId: 'a1', state: 'in-flight' }));
    await store.save(anIntent({ intentId: 'a2', state: 'settled' }));
    // The db persists across tests in this file, so assert containment of the
    // ids this test saved (and that every listed entry deserializes).
    const ids = (await store.listAll()).map((i) => i.intentId);
    expect(ids).toContain('a1');
    expect(ids).toContain('a2');
  });

  it('persists across reopen — the restart boundary recoverInterrupted() depends on', async () => {
    const store = new SqlitePaymentIntentStore(db);
    await store.save(anIntent({ intentId: 'd1', state: 'in-flight' }));
    // New store over a NEW database handle on the same file = post-restart view.
    const fresh = new SqlitePaymentIntentStore(reopenedDb);
    const recovered = await fresh.get('d1');
    expect(recovered?.state).toBe('in-flight');
  });

  it('surfaces corrupt persisted intent loudly instead of silently dropping it', async () => {
    await db.set('intent:corrupt-1', 'not-json{');
    const store = new SqlitePaymentIntentStore(db);
    await expect(store.get('corrupt-1')).rejects.toThrow();
    await expect(store.listAll()).rejects.toThrow();
  });
});
