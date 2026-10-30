import type { PaymentIntent } from './intent.js';

/**
 * Persistence port for payment intents. The engine writes through this at
 * EVERY state transition — the persist-before-dispatch invariant depends on
 * `save` completing before the network call is attempted. A production
 * implementation backs this with SQLCipher-at-rest SQLite; tests use
 * `InMemoryPaymentIntentStore`.
 */
export interface PaymentIntentStore {
  save(intent: Readonly<PaymentIntent>): Promise<void>;
  /** Resolves undefined when no intent with this id is persisted. */
  get(intentId: string): Promise<PaymentIntent | undefined>;
  listAll(): Promise<PaymentIntent[]>;
}

/**
 * Snapshot semantics on both write and read: callers may mutate their own
 * copies freely without corrupting persisted state. Intents are stored as
 * JSON clones — payloads must be JSON-serializable, which the real store
 * requires anyway.
 */
export class InMemoryPaymentIntentStore implements PaymentIntentStore {
  private readonly intents = new Map<string, PaymentIntent>();

  async save(intent: Readonly<PaymentIntent>): Promise<void> {
    this.intents.set(intent.intentId, cloneIntent(intent));
  }

  async get(intentId: string): Promise<PaymentIntent | undefined> {
    const intent = this.intents.get(intentId);
    return intent === undefined ? undefined : cloneIntent(intent);
  }

  async listAll(): Promise<PaymentIntent[]> {
    return [...this.intents.values()].map(cloneIntent);
  }
}

function cloneIntent(intent: Readonly<PaymentIntent>): PaymentIntent {
  return JSON.parse(JSON.stringify(intent)) as PaymentIntent;
}
