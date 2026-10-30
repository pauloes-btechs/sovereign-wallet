/**
 * Desktop payment-intent persistence + engine assembly.
 *
 * The spec's locked rule: intent persisted BEFORE dispatch, reconcile on
 * recovery, never blind re-dispatch. The shared PaymentEngine enforces the
 * transitions; this module provides the browser-side durable store (localStorage
 * — SQLCipher-backed storage arrives with the desktop persistence work) and
 * assembles the engine over the Wavelength gateway dispatcher.
 */
import { PaymentEngine, type PaymentIntent, type PaymentIntentStore } from '@sovereign/payments';
import {
  WavelengthPaymentDispatcher,
  SDK_PIN,
} from '@sovereign/wavelength-adapter';
import type { WavelengthClient } from '@sovereign/wavelength-adapter';

const STORAGE_KEY = 'sovereign.payment-intents.v1';

/** localStorage-backed PaymentIntentStore. Snapshot semantics: the engine
 *  treats intents as immutable, so whole-blob JSON writes are correct here. */
export class BrowserPaymentIntentStore implements PaymentIntentStore {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>;

  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage) {
    this.storage = storage;
  }

  async save(intent: Readonly<PaymentIntent>): Promise<void> {
    const all = await this.listAll();
    const next = [...all.filter((i) => i.intentId !== intent.intentId), intent];
    this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  async get(intentId: string): Promise<PaymentIntent | undefined> {
    return (await this.listAll()).find((i) => i.intentId === intentId);
  }

  async listAll(): Promise<PaymentIntent[]> {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PaymentIntent[]) : [];
    } catch {
      // Corrupt blob: treat as empty rather than crash-looping the wallet.
      return [];
    }
  }
}

/** Engine over the gateway client: gateway-dispatcher + durable local store. */
export function createPaymentEngine(client: WavelengthClient): PaymentEngine {
  return new PaymentEngine({
    store: new BrowserPaymentIntentStore(),
    dispatcher: new WavelengthPaymentDispatcher({ client, sdkPin: SDK_PIN }),
    newId: () => crypto.randomUUID(),
  });
}
