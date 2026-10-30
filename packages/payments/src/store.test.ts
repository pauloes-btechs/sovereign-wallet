import { describe, expect, it } from 'vitest';
import { InMemoryPaymentIntentStore } from './store.js';
import type { PaymentIntent } from './intent.js';

function anIntent(): PaymentIntent {
  return {
    intentId: '33333333-3333-4333-8333-333333333333',
    kind: 'lightning-invoice',
    payload: { invoice: 'lnbc1...' },
    maxFeeSat: 1_000,
    state: 'authorized',
    attempts: [],
  };
}

describe('InMemoryPaymentIntentStore', () => {
  it('persists and returns an intent by id', async () => {
    const store = new InMemoryPaymentIntentStore();
    const i = anIntent();
    await store.save(i);
    await expect(store.get(i.intentId)).resolves.toEqual(i);
  });

  it('returns undefined for an unknown intent id', async () => {
    const store = new InMemoryPaymentIntentStore();
    await expect(store.get('nope')).resolves.toBeUndefined();
  });

  it('snapshots on write: mutating the saved object does not alter the store', async () => {
    const store = new InMemoryPaymentIntentStore();
    const i = anIntent();
    await store.save(i);
    i.state = 'settled';
    await expect(store.get(i.intentId)).resolves.toMatchObject({ state: 'authorized' });
  });

  it('snapshots on read: mutating a read result does not corrupt the store', async () => {
    const store = new InMemoryPaymentIntentStore();
    const i = anIntent();
    await store.save(i);
    const got = await store.get(i.intentId);
    expect(got?.state).toBe('authorized');
    if (got) {
      got.state = 'failed';
    }
    await expect(store.get(i.intentId)).resolves.toMatchObject({ state: 'authorized' });
  });

  it('listAll returns every persisted intent', async () => {
    const store = new InMemoryPaymentIntentStore();
    const a = anIntent();
    const b = { ...anIntent(), intentId: '44444444-4444-4444-8444-444444444444' };
    await store.save(a);
    await store.save(b);
    const all = await store.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((i) => i.intentId).sort()).toEqual([a.intentId, b.intentId].sort());
  });
});
