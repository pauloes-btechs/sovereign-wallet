import type { EncryptedDatabase } from '@sovereign/secure-store';
import type { PaymentIntent } from './intent.js';
import type { PaymentIntentStore } from './store.js';

const KEY_PREFIX = 'intent:';

/**
 * SQLCipher-backed intent store — the production implementation of the
 * persist-before-dispatch invariant. Takes any `EncryptedDatabase`, so the
 * same adapter runs over the Tauri SQLCipher backend (desktop) and, with the
 * explicit dev opt-in, the node:sqlite backend (tests/CI).
 *
 * Snapshot semantics match InMemoryPaymentIntentStore: writes serialize a
 * clone; reads deserialize a fresh object. A corrupt persisted intent is
 * surfaced loudly (JSON.parse throws) — never silently dropped.
 */
export class SqlitePaymentIntentStore implements PaymentIntentStore {
  constructor(private readonly db: EncryptedDatabase) {}

  async save(intent: Readonly<PaymentIntent>): Promise<void> {
    await this.db.set(KEY_PREFIX + intent.intentId, JSON.stringify(intent));
  }

  async get(intentId: string): Promise<PaymentIntent | undefined> {
    const raw = await this.db.get(KEY_PREFIX + intentId);
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as PaymentIntent;
  }

  async listAll(): Promise<PaymentIntent[]> {
    const keys = await this.db.keys(KEY_PREFIX);
    const intents = await Promise.all(
      keys.map((k) => this.db.get(k)),
    );
    return intents
      .filter((raw): raw is string => raw !== undefined)
      .map((raw) => JSON.parse(raw) as PaymentIntent);
  }
}
