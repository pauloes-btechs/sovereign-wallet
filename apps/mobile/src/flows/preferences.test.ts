import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_SCHEMA_VERSION,
  PREFERENCE_KEYS,
  PreferenceValidationError,
  createPreferencesStore,
  lightningFeeCapSat,
  memoryPreferencesBackend,
  parseStoredPreferences,
  serializePreferences,
  webPreferencesBackend,
} from './preferences.js';
import type { KeyValueStorage, PreferencesBackend } from './preferences.js';

class FakeStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  throwOnRead = false;
  throwOnWrite = false;
  getItem(key: string): string | null {
    if (this.throwOnRead) throw new Error('SecurityError: storage disabled');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
}

describe('preferences schema', () => {
  it('lists every key once and defaults cover every key', () => {
    expect(new Set(PREFERENCE_KEYS).size).toBe(PREFERENCE_KEYS.length);
    expect(Object.keys(DEFAULT_PREFERENCES).sort()).toEqual([...PREFERENCE_KEYS].sort());
  });

  it('serializes with the schema version and round-trips', () => {
    const custom = { ...DEFAULT_PREFERENCES, denomination: 'btc' as const, lockTimeoutSeconds: 60 as const };
    const text = serializePreferences(custom);
    expect(JSON.parse(text).version).toBe(PREFERENCES_SCHEMA_VERSION);
    expect(parseStoredPreferences(text)).toEqual({ value: custom, issues: [] });
  });

  it('missing storage yields defaults without issues', () => {
    expect(parseStoredPreferences(null)).toEqual({ value: DEFAULT_PREFERENCES, issues: [] });
  });

  it('corrupt JSON, missing version and newer versions fall back to defaults and say so', () => {
    for (const raw of ['{nope', JSON.stringify({ values: {} }), JSON.stringify({ version: 99, values: {} })]) {
      const parsed = parseStoredPreferences(raw);
      expect(parsed.value).toEqual(DEFAULT_PREFERENCES);
      expect(parsed.issues).toHaveLength(1);
    }
  });

  it('an invalid stored field resets only that field and reports it', () => {
    const raw = JSON.stringify({
      version: 1,
      values: { denomination: 'btc', paymentTimeoutSeconds: 5, hideBalances: 'yes', extra: 1 },
    });
    const parsed = parseStoredPreferences(raw);
    expect(parsed.value.denomination).toBe('btc');
    expect(parsed.value.paymentTimeoutSeconds).toBe(DEFAULT_PREFERENCES.paymentTimeoutSeconds);
    expect(parsed.value.hideBalances).toBe(false);
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.value).not.toHaveProperty('extra');
  });

  it('fee cap is the larger of the proportional cap and the floor', () => {
    const prefs = { ...DEFAULT_PREFERENCES, maxLightningFeePpm: 5000, maxLightningFeeSat: 10 };
    expect(lightningFeeCapSat(prefs, 1_000n)).toBe(10n); // 0.5% of 1,000 = 5 → floor 10
    expect(lightningFeeCapSat(prefs, 1_000_000n)).toBe(5_000n);
  });
});

describe('preferences store', () => {
  it('persists a change and a fresh store reloads it', async () => {
    const backend = memoryPreferencesBackend();
    const store = createPreferencesStore(backend);
    await store.load();
    expect(store.getSnapshot().loaded).toBe(true);
    await store.set({ denomination: 'btc', hideBalances: true, fiatCurrency: 'EUR' });

    const reloaded = createPreferencesStore(memoryPreferencesBackend(backend.snapshot()));
    expect(reloaded.get()).toEqual(DEFAULT_PREFERENCES); // before load
    const prefs = await reloaded.load();
    expect(prefs.denomination).toBe('btc');
    expect(prefs.hideBalances).toBe(true);
    expect(prefs.fiatCurrency).toBe('EUR');
  });

  it('rejects an invalid patch entirely and leaves values unchanged', async () => {
    const store = createPreferencesStore(memoryPreferencesBackend());
    await store.load();
    await expect(store.set({ denomination: 'btc', invoiceExpirySeconds: 5 })).rejects.toBeInstanceOf(
      PreferenceValidationError,
    );
    expect(store.get()).toEqual(DEFAULT_PREFERENCES);
  });

  it('rejects unknown keys', async () => {
    const store = createPreferencesStore(memoryPreferencesBackend());
    const patch: Record<string, unknown> = { colour: 'red' };
    await expect(store.set(patch)).rejects.toThrow(/Unknown preference/);
  });

  it('notifies subscribers and keeps snapshot identity stable between changes', async () => {
    const store = createPreferencesStore(memoryPreferencesBackend());
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    await store.load();
    const snap = store.getSnapshot();
    expect(store.getSnapshot()).toBe(snap);
    await store.set({ haptics: false });
    expect(calls).toBeGreaterThanOrEqual(2);
    unsubscribe();
    await store.set({ haptics: true });
    const after = calls;
    await store.reset();
    expect(calls).toBe(after);
    expect(store.get()).toEqual(DEFAULT_PREFERENCES);
  });

  it('serializes writes so the last set wins in storage', async () => {
    const writes: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: PreferencesBackend = {
      kind: 'memory',
      read: () => Promise.resolve(null),
      write: async (s) => {
        if (writes.length === 0) await gate;
        writes.push(s);
      },
    };
    const store = createPreferencesStore(backend);
    const first = store.set({ denomination: 'btc' });
    const second = store.set({ denomination: 'sats' });
    release();
    await Promise.all([first, second]);
    expect(writes).toHaveLength(2);
    expect(parseStoredPreferences(writes[1] ?? null).value.denomination).toBe('sats');
  });
});

describe('web preferences backend', () => {
  it('reads and writes through localStorage', async () => {
    const storage = new FakeStorage();
    const store = createPreferencesStore(webPreferencesBackend(() => storage));
    await store.load();
    await store.set({ theme: 'system' });
    const reloaded = createPreferencesStore(webPreferencesBackend(() => storage));
    expect((await reloaded.load()).theme).toBe('system');
    expect(reloaded.getSnapshot().persistence).toBe('web');
  });

  it('a throwing storage never breaks the app: defaults load, writes report the error', async () => {
    const storage = new FakeStorage();
    storage.throwOnRead = true;
    storage.throwOnWrite = true;
    const store = createPreferencesStore(webPreferencesBackend(() => storage));
    expect(await store.load()).toEqual(DEFAULT_PREFERENCES);
    expect(store.getSnapshot().loadIssues[0]).toMatch(/storage disabled/);

    await store.set({ hideBalances: true });
    expect(store.get().hideBalances).toBe(true); // applies for this session
    expect(store.getSnapshot().writeError).toMatch(/QuotaExceeded/);

    storage.throwOnWrite = false;
    await store.set({ hideBalances: false });
    expect(store.getSnapshot().writeError).toBeNull();
  });

  it('storage that cannot even be resolved is handled', async () => {
    const store = createPreferencesStore(
      webPreferencesBackend(() => {
        throw new Error('localStorage access denied');
      }),
    );
    await store.load();
    expect(store.getSnapshot().loadIssues[0]).toMatch(/access denied/);
    await store.set({ denomination: 'btc' });
    expect(store.getSnapshot().writeError).toMatch(/access denied/);
  });
});
