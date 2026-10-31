/**
 * Desktop payment-intent persistence + engine assembly.
 *
 * The spec's locked rule: intent persisted BEFORE dispatch, reconcile on
 * recovery, never blind re-dispatch. The shared PaymentEngine enforces the
 * transitions; the store is chosen by runtime:
 *
 *  - Packaged Tauri app: SQLCipher-at-rest SQLite keyed by the platform
 *    keyring (packages/secure-store) — the production path.
 *  - Plain-browser dev/e2e: the daemon boots externally and Tauri IPC is
 *    unavailable, so intents persist to localStorage. Dev-only, honestly
 *    labeled; corruption surfaces loudly instead of dropping payments.
 */
import {
  PaymentEngine,
  SqlitePaymentIntentStore,
  type PaymentIntent,
  type PaymentIntentStore,
} from '@sovereign/payments';
import { TauriKeyringStore, openSecureDatabase } from '@sovereign/secure-store';
import type { TauriInvoke } from '@sovereign/secure-store';
import {
  WavelengthPaymentDispatcher,
  SDK_PIN,
} from '@sovereign/wavelength-adapter';
import type { WavelengthClient } from '@sovereign/wavelength-adapter';

const STORAGE_KEY = 'sovereign.payment-intents.v1';

/** Dev/e2e browser PaymentIntentStore. Snapshot semantics: the engine
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
    const parsed: unknown = JSON.parse(raw); // corrupt blob throws — never silently dropped
    if (!Array.isArray(parsed)) throw new Error('corrupt payment-intent storage (not an array)');
    return parsed as PaymentIntent[];
  }
}

/**
 * Production desktop store: SQLCipher-at-rest SQLite with the database key
 * in the platform keyring (macOS Keychain / Windows Credential Manager /
 * Secret Service) via Tauri commands implemented in src-tauri.
 */
export async function createDurablePaymentIntentStore(
  tauriInvoke: TauriInvoke,
): Promise<PaymentIntentStore> {
  const keyring = new TauriKeyringStore(tauriInvoke);
  const db = await openSecureDatabase({
    profile: 'mode-a',
    keyring,
    tauriInvoke,
  });
  return new SqlitePaymentIntentStore(db);
}

/** Engine over the gateway client: gateway-dispatcher + durable local store. */
export function createPaymentEngine(
  client: WavelengthClient,
  store: PaymentIntentStore = new BrowserPaymentIntentStore(),
): PaymentEngine {
  return new PaymentEngine({
    store,
    dispatcher: new WavelengthPaymentDispatcher({ client, sdkPin: SDK_PIN }),
    newId: () => crypto.randomUUID(),
  });
}
