/**
 * Mobile wallet preferences — a typed, versioned schema with defaults and
 * validation, behind a small store port (load / get / set / subscribe).
 *
 * Storage is pluggable (`PreferencesBackend`):
 * - `memoryPreferencesBackend`  — tests.
 * - `webPreferencesBackend`     — the react-native-web preview (localStorage,
 *   every access wrapped: private windows and blocked storage throw).
 * - `NativePreferencesBackend`  — the slot the native shell fills (e.g. an
 *   AsyncStorage/MMKV adapter). Interface only: no native dependency ships
 *   in this package yet, so native builds have no persisted preferences.
 *
 * Preferences are NOT secrets: nothing here may hold keys, phrases, pairing
 * phrases, PINs or macaroons. Those belong in the platform keystore.
 *
 * A stored preference says what the user asked for; whether the active
 * backend can honour it is a separate question answered by
 * `capabilities.ts`. Screens show both.
 */

/** Bump when the stored shape changes, and add a migration below. */
export const PREFERENCES_SCHEMA_VERSION = 1;

export type Denomination = 'sats' | 'btc';
export type ThemePreference = 'dark' | 'system';
/** Relative on-chain fee preference; the backend maps it to a rate or target. */
export type OnchainFeePreference = 'economy' | 'normal' | 'priority';

export interface Preferences {
  /** How amounts are displayed and entered. */
  readonly denomination: Denomination;
  /** Privacy mode: amounts are masked everywhere until revealed. */
  readonly hideBalances: boolean;
  /** Haptic feedback on confirmations (needs a native haptics module). */
  readonly haptics: boolean;
  readonly theme: ThemePreference;
  /** Expiry requested for new Lightning invoices, in seconds. */
  readonly invoiceExpirySeconds: number;
  readonly onchainFeePreference: OnchainFeePreference;
  /**
   * Maximum Lightning fee as a proportion of the amount, in parts per
   * million (5000 ppm = 0.5%). The effective cap is the larger of this and
   * `maxLightningFeeSat` — see `lightningFeeCapSat`.
   */
  readonly maxLightningFeePpm: number;
  /** Absolute floor of the Lightning fee cap, in sats (small payments). */
  readonly maxLightningFeeSat: number;
  /** How long a payment attempt may run before it is reported as unresolved. */
  readonly paymentTimeoutSeconds: number;
  /** Lock the app after this long in the background; 0 = immediately. */
  readonly lockTimeoutSeconds: LockTimeoutSeconds;
  /** ISO 4217 code for an optional fiat reference value; null = off. */
  readonly fiatCurrency: FiatCurrency | null;
}

export const LOCK_TIMEOUT_CHOICES = [0, 60, 300, 900, 3600] as const;
export type LockTimeoutSeconds = (typeof LOCK_TIMEOUT_CHOICES)[number];

export const FIAT_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'MXN', 'BRL'] as const;
export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

/** Bounds for the numeric fields (inclusive). Exported so settings screens show them. */
export const PREFERENCE_BOUNDS = {
  invoiceExpirySeconds: { min: 60, max: 7 * 24 * 3600 },
  maxLightningFeePpm: { min: 0, max: 50_000 },
  maxLightningFeeSat: { min: 0, max: 100_000 },
  paymentTimeoutSeconds: { min: 10, max: 600 },
} as const;

/** Defaults match desktop where desktop has a value (fee cap 0.5%, min 10 sats). */
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  denomination: 'sats',
  hideBalances: false,
  haptics: true,
  theme: 'dark',
  invoiceExpirySeconds: 3600,
  onchainFeePreference: 'normal',
  maxLightningFeePpm: 5000,
  maxLightningFeeSat: 10,
  paymentTimeoutSeconds: 60,
  lockTimeoutSeconds: 300,
  fiatCurrency: null,
});

export type PreferenceKey = keyof Preferences;

export class PreferenceValidationError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = 'PreferenceValidationError';
  }
}

// ——— validation ———

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const ok = <T,>(value: T): Checked<T> => ({ ok: true, value });
const bad = <T,>(message: string): Checked<T> => ({ ok: false, message });

function oneOf<T extends string | number>(choices: readonly T[], what: string): (value: unknown) => Checked<T> {
  return (value) => {
    const hit = choices.find((c) => c === value);
    return hit !== undefined ? ok(hit) : bad(`${what} must be one of ${choices.join(', ')}.`);
  };
}

function bool(what: string): (value: unknown) => Checked<boolean> {
  return (value) => (typeof value === 'boolean' ? ok(value) : bad(`${what} must be on or off.`));
}

function intIn(bounds: { min: number; max: number }, what: string): (value: unknown) => Checked<number> {
  return (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max
      ? ok(value)
      : bad(`${what} must be a whole number from ${bounds.min} to ${bounds.max}.`);
}

const VALIDATORS: { readonly [K in PreferenceKey]: (value: unknown) => Checked<Preferences[K]> } = {
  denomination: oneOf<Denomination>(['sats', 'btc'], 'Denomination'),
  hideBalances: bool('Hide balances'),
  haptics: bool('Haptic feedback'),
  theme: oneOf<ThemePreference>(['dark', 'system'], 'Appearance'),
  invoiceExpirySeconds: intIn(PREFERENCE_BOUNDS.invoiceExpirySeconds, 'Invoice expiry (seconds)'),
  onchainFeePreference: oneOf<OnchainFeePreference>(['economy', 'normal', 'priority'], 'On-chain fee preference'),
  maxLightningFeePpm: intIn(PREFERENCE_BOUNDS.maxLightningFeePpm, 'Maximum Lightning fee (ppm)'),
  maxLightningFeeSat: intIn(PREFERENCE_BOUNDS.maxLightningFeeSat, 'Minimum Lightning fee cap (sats)'),
  paymentTimeoutSeconds: intIn(PREFERENCE_BOUNDS.paymentTimeoutSeconds, 'Payment timeout (seconds)'),
  lockTimeoutSeconds: oneOf<LockTimeoutSeconds>(LOCK_TIMEOUT_CHOICES, 'Lock timeout (seconds)'),
  fiatCurrency: (value) =>
    value === null ? ok(null) : oneOf<FiatCurrency>(FIAT_CURRENCIES, 'Fiat currency')(value),
};

/** Every preference key, in schema order. */
export const PREFERENCE_KEYS: readonly PreferenceKey[] = [
  'denomination',
  'hideBalances',
  'haptics',
  'theme',
  'invoiceExpirySeconds',
  'onchainFeePreference',
  'maxLightningFeePpm',
  'maxLightningFeeSat',
  'paymentTimeoutSeconds',
  'lockTimeoutSeconds',
  'fiatCurrency',
];

export function isPreferenceKey(key: string): key is PreferenceKey {
  return PREFERENCE_KEYS.some((k) => k === key);
}

/** Assembles a frozen Preferences object field by field (no casts). */
function buildPreferences(read: <K extends PreferenceKey>(key: K) => Preferences[K]): Preferences {
  return Object.freeze({
    denomination: read('denomination'),
    hideBalances: read('hideBalances'),
    haptics: read('haptics'),
    theme: read('theme'),
    invoiceExpirySeconds: read('invoiceExpirySeconds'),
    onchainFeePreference: read('onchainFeePreference'),
    maxLightningFeePpm: read('maxLightningFeePpm'),
    maxLightningFeeSat: read('maxLightningFeeSat'),
    paymentTimeoutSeconds: read('paymentTimeoutSeconds'),
    lockTimeoutSeconds: read('lockTimeoutSeconds'),
    fiatCurrency: read('fiatCurrency'),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates one value for one key; returns the typed value or throws. */
export function validatePreference<K extends PreferenceKey>(key: K, value: unknown): Preferences[K] {
  const checked = VALIDATORS[key](value);
  if (!checked.ok) throw new PreferenceValidationError(key, checked.message);
  return checked.value;
}

/**
 * Lenient whole-object validation for data read back from storage: every
 * invalid or missing field falls back to its default and is reported, so a
 * corrupt field never takes the others down with it. Unknown keys are dropped.
 */
export function sanitizePreferences(input: unknown): { value: Preferences; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(input)) {
    return { value: DEFAULT_PREFERENCES, issues: ['Stored preferences were not an object; defaults used.'] };
  }
  const value = buildPreferences((key) => {
    if (!(key in input)) return DEFAULT_PREFERENCES[key];
    const checked = VALIDATORS[key](input[key]);
    if (checked.ok) return checked.value;
    issues.push(`${checked.message} Reset to the default.`);
    return DEFAULT_PREFERENCES[key];
  });
  return { value, issues };
}

// ——— versioned storage format ———

interface StoredPreferences {
  readonly version: number;
  readonly values: unknown;
}

/**
 * Migrations from version N to N+1, keyed by N. Version 1 is the first
 * schema; add `1: (v1) => v2` here when version 2 lands.
 */
const MIGRATIONS: Readonly<Record<number, (values: unknown) => unknown>> = {};

export function serializePreferences(preferences: Preferences): string {
  const stored: StoredPreferences = { version: PREFERENCES_SCHEMA_VERSION, values: preferences };
  return JSON.stringify(stored);
}

/** Parses stored text (any older version is migrated forward). Never throws. */
export function parseStoredPreferences(raw: string | null): { value: Preferences; issues: string[] } {
  if (raw === null || raw === '') return { value: DEFAULT_PREFERENCES, issues: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: DEFAULT_PREFERENCES, issues: ['Stored preferences could not be read; defaults used.'] };
  }
  if (!isRecord(parsed) || typeof parsed.version !== 'number' || !Number.isInteger(parsed.version)) {
    return { value: DEFAULT_PREFERENCES, issues: ['Stored preferences had no version; defaults used.'] };
  }
  if (parsed.version > PREFERENCES_SCHEMA_VERSION) {
    return {
      value: DEFAULT_PREFERENCES,
      issues: [
        `Stored preferences are from a newer app version (schema ${parsed.version}); defaults used until you change a setting.`,
      ],
    };
  }
  let values: unknown = parsed.values;
  for (let v = parsed.version; v < PREFERENCES_SCHEMA_VERSION; v += 1) {
    const migrate = MIGRATIONS[v];
    if (migrate === undefined) {
      return {
        value: DEFAULT_PREFERENCES,
        issues: [`No migration from preferences schema ${v}; defaults used.`],
      };
    }
    values = migrate(values);
  }
  return sanitizePreferences(values);
}

/** The effective Lightning fee cap for an amount: max(ppm × amount, floor). */
export function lightningFeeCapSat(preferences: Preferences, amountSat: bigint): bigint {
  const proportional = (amountSat * BigInt(preferences.maxLightningFeePpm)) / 1_000_000n;
  const floor = BigInt(preferences.maxLightningFeeSat);
  return proportional > floor ? proportional : floor;
}

// ——— storage backends ———

/** Where serialized preferences live. Both methods may reject. */
export interface PreferencesBackend {
  readonly kind: 'memory' | 'web' | 'native';
  read(): Promise<string | null>;
  write(serialized: string): Promise<void>;
}

/**
 * The native slot. A native shell supplies an implementation backed by its
 * storage module (AsyncStorage, MMKV, …). Nothing in this package provides
 * one yet — see docs/MOBILE_PARITY_MATRIX.md, "Remaining gaps".
 */
export interface NativePreferencesBackend extends PreferencesBackend {
  readonly kind: 'native';
}

export function memoryPreferencesBackend(initial: string | null = null): PreferencesBackend & {
  /** Test observability: the last serialized write. */
  readonly snapshot: () => string | null;
} {
  let stored = initial;
  return {
    kind: 'memory',
    read: () => Promise.resolve(stored),
    write: (serialized) => {
      stored = serialized;
      return Promise.resolve();
    },
    snapshot: () => stored,
  };
}

/** The subset of the DOM `Storage` API this backend uses. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const WEB_PREFERENCES_KEY = 'sovereign.mobile.preferences';

/**
 * localStorage-backed preferences for the web preview. `resolveStorage` is a
 * function because merely touching `window.localStorage` throws in some
 * privacy modes; it is called inside the try for every access.
 */
export function webPreferencesBackend(
  resolveStorage: () => KeyValueStorage | null,
  key: string = WEB_PREFERENCES_KEY,
): PreferencesBackend {
  return {
    kind: 'web',
    read: () => {
      try {
        return Promise.resolve(resolveStorage()?.getItem(key) ?? null);
      } catch (error) {
        return Promise.reject(asError(error, 'Browser storage could not be read'));
      }
    },
    write: (serialized) => {
      try {
        const storage = resolveStorage();
        if (storage === null) throw new Error('Browser storage is not available');
        storage.setItem(key, serialized);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(asError(error, 'Browser storage could not be written'));
      }
    },
  };
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

// ——— the store ———

export interface PreferencesSnapshot {
  readonly preferences: Preferences;
  /** False until `load()` settles; screens may show defaults meanwhile. */
  readonly loaded: boolean;
  /** Where values are kept, so settings can say whether changes survive a restart. */
  readonly persistence: PreferencesBackend['kind'];
  /** Problems found reading storage (fields reset to defaults). */
  readonly loadIssues: readonly string[];
  /** The last write failure; the in-memory value still applies this session. */
  readonly writeError: string | null;
}

export interface PreferencesStore {
  load(): Promise<Preferences>;
  /** Current snapshot (stable identity until something changes). */
  getSnapshot(): PreferencesSnapshot;
  get(): Preferences;
  /** Validates every field strictly (throws PreferenceValidationError), applies, persists. */
  set(patch: Partial<Preferences>): Promise<Preferences>;
  reset(): Promise<Preferences>;
  subscribe(listener: () => void): () => void;
}

export function createPreferencesStore(backend: PreferencesBackend): PreferencesStore {
  let snapshot: PreferencesSnapshot = {
    preferences: DEFAULT_PREFERENCES,
    loaded: false,
    persistence: backend.kind,
    loadIssues: [],
    writeError: null,
  };
  const listeners = new Set<() => void>();
  // Writes are serialized so the last `set` always wins on disk.
  let writeChain: Promise<void> = Promise.resolve();

  const publish = (next: Partial<PreferencesSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  const persist = (preferences: Preferences): Promise<void> => {
    writeChain = writeChain.then(async () => {
      try {
        await backend.write(serializePreferences(preferences));
        if (snapshot.writeError !== null) publish({ writeError: null });
      } catch (error) {
        publish({ writeError: error instanceof Error ? error.message : String(error) });
      }
    });
    return writeChain;
  };

  return {
    async load() {
      try {
        const { value, issues } = parseStoredPreferences(await backend.read());
        publish({ preferences: value, loaded: true, loadIssues: issues });
      } catch (error) {
        publish({
          loaded: true,
          loadIssues: [
            `${error instanceof Error ? error.message : String(error)}; defaults used.`,
          ],
        });
      }
      return snapshot.preferences;
    },
    getSnapshot: () => snapshot,
    get: () => snapshot.preferences,
    async set(patch) {
      for (const key of Object.keys(patch)) {
        if (!isPreferenceKey(key)) {
          throw new PreferenceValidationError(key, `Unknown preference '${key}'.`);
        }
      }
      const current = snapshot.preferences;
      // Strict: any invalid field rejects the whole patch before anything applies.
      const preferences = buildPreferences((key) =>
        patch[key] === undefined && !(key in patch) ? current[key] : validatePreference(key, patch[key]),
      );
      publish({ preferences });
      await persist(preferences);
      return preferences;
    },
    async reset() {
      publish({ preferences: DEFAULT_PREFERENCES });
      await persist(DEFAULT_PREFERENCES);
      return DEFAULT_PREFERENCES;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
