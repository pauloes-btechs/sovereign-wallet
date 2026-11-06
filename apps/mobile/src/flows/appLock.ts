/**
 * App lock — PIN, biometric unlock and automatic locking — plus the local
 * backup record, both kept in the platform's secure storage.
 *
 * Pure TypeScript (no react-native imports): screens subscribe with
 * `useSyncExternalStore(lock.subscribe, lock.getSnapshot)`.
 *
 * Security design
 * - The PIN is never stored. What is stored (one JSON record under
 *   `APP_LOCK_STORAGE_KEY` in `SecureStoragePort`) is a scrypt hash of the
 *   PIN with a random 16-byte salt and the KDF parameters used, so the
 *   parameters can be raised later without breaking old records.
 * - Hashes are compared in constant time.
 * - Failed attempts and the lockout deadline are written to the same record
 *   BEFORE the result is returned, so killing the app does not reset the
 *   backoff. After `FREE_PIN_ATTEMPTS` misses each further miss waits
 *   longer (30 s, 1 min, 5 min, 15 min, then 1 h each). Nothing is ever
 *   wiped: a wallet must not be destroyed by a mistyped PIN.
 * - The app locks on launch whenever a PIN is set, and when it returns to
 *   the foreground after the lock-timeout preference has passed (0 = on
 *   every trip to the background).
 * - Biometric unlock is offered only when the host provides
 *   `authenticateBiometric`; turning it on requires a successful prompt
 *   first. Biometrics never replace the PIN: removing or changing the PIN
 *   always asks for the current PIN.
 * - Storage failures fail closed: if the record cannot be read the app
 *   stays covered and says why.
 *
 * What the lock does NOT do: it does not encrypt wallet data (the wallet's
 * own storage and password do that) and, in the web preview, the record
 * lives in browser storage, which is not secure — the UI says so.
 */

import { scryptAsync } from '@noble/hashes/scrypt';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { SecureStorageProtection, SecureStoragePort } from './platform.js';

// ——— secure storage implementations (non-native) ———

/** Session-only storage for tests and hosts without a keystore. */
export function memorySecureStorage(
  protection: SecureStorageProtection = 'memory',
): SecureStoragePort & { readonly dump: () => ReadonlyMap<string, string> } {
  const items = new Map<string, string>();
  return {
    protection,
    getItem: (key) => Promise.resolve(items.get(key) ?? null),
    setItem: (key, value) => {
      items.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      items.delete(key);
      return Promise.resolve();
    },
    dump: () => new Map(items),
  };
}

/** The subset of the DOM Storage API the preview store uses. */
export interface PreviewKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const BROWSER_PREVIEW_STORAGE_PREFIX = 'sovereign.mobile.preview-secure.';

/**
 * Web-preview "secure" storage: browser localStorage, labelled
 * `browser-preview`. It is NOT secure (any script on the page and anyone
 * with the browser profile can read it); it exists so the lock flows can be
 * exercised in the preview. Every access is wrapped: storage can throw.
 */
export function browserPreviewSecureStorage(
  resolveStorage: () => PreviewKeyValueStorage | null,
  /** Keeps separate wallets (e.g. the preview's two modes) from sharing items. */
  namespace = '',
): SecureStoragePort {
  const prefix = BROWSER_PREVIEW_STORAGE_PREFIX + (namespace === '' ? '' : `${namespace}.`);
  const run = <T,>(what: string, fn: (storage: PreviewKeyValueStorage) => T): Promise<T> => {
    try {
      const storage = resolveStorage();
      if (storage === null) throw new Error('Browser storage is not available');
      return Promise.resolve(fn(storage));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(`Browser storage could not be ${what}`));
    }
  };
  return {
    protection: 'browser-preview',
    getItem: (key) => run('read', (s) => s.getItem(prefix + key)),
    setItem: (key, value) => run('written', (s) => s.setItem(prefix + key, value)),
    removeItem: (key) => run('written', (s) => s.removeItem(prefix + key)),
  };
}

/** Plain-language description of where secrets live, for security screens. */
export function describeSecureStorage(protection: SecureStorageProtection | undefined): string {
  switch (protection) {
    case 'device-keystore':
      return 'Stored in the iOS Keychain or Android Keystore on this device, never synced.';
    case 'browser-preview':
      return 'Browser storage — not secure, preview only. Anyone with access to this browser profile can read it.';
    case 'memory':
    case undefined:
      return 'Kept in memory for this session only; it is gone when the app restarts.';
  }
}

// ——— KDF ———

export interface PinKdfParams {
  readonly algorithm: 'scrypt';
  /** CPU/memory cost (power of two). */
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly dkLen: number;
}

/**
 * 2^15 × r=8 ≈ 32 MiB per hash: slow enough to make each guess costly,
 * fast enough (about a second in pure JS on a phone) to unlock with. The
 * real defence for a short PIN is that the record sits in the device
 * keystore and guesses through the app are rate-limited.
 */
export const DEFAULT_PIN_KDF: PinKdfParams = Object.freeze({ algorithm: 'scrypt', N: 2 ** 15, r: 8, p: 1, dkLen: 32 });

export type RandomBytes = (length: number) => Uint8Array;

/**
 * Salt source: the platform CSPRNG when present. Hermes may lack
 * `crypto.getRandomValues`; a salt only has to be unique, not secret, so the
 * fallback mixes time and Math.random — documented, not hidden.
 */
export const defaultRandomBytes: RandomBytes = (length) => {
  const out = new Uint8Array(length);
  const cryptoLike: unknown = Reflect.get(globalThis, 'crypto');
  const getRandomValues: unknown =
    typeof cryptoLike === 'object' && cryptoLike !== null ? Reflect.get(cryptoLike, 'getRandomValues') : undefined;
  if (typeof getRandomValues === 'function') {
    getRandomValues.call(cryptoLike, out);
    return out;
  }
  let seed = Date.now();
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345 + Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    out[i] = seed & 0xff;
  }
  return out;
};

async function deriveHash(secret: string, salt: Uint8Array, kdf: PinKdfParams): Promise<Uint8Array> {
  return scryptAsync(secret, salt, { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: kdf.dkLen, asyncTick: 20 });
}

/** Constant-time comparison of two byte arrays. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

interface SecretVerifier {
  readonly kdf: PinKdfParams;
  /** Hex. */
  readonly salt: string;
  /** Hex. */
  readonly hash: string;
}

async function makeVerifier(secret: string, kdf: PinKdfParams, random: RandomBytes): Promise<SecretVerifier> {
  const salt = random(16);
  const hash = await deriveHash(secret, salt, kdf);
  return { kdf, salt: bytesToHex(salt), hash: bytesToHex(hash) };
}

async function checkVerifier(secret: string, verifier: SecretVerifier): Promise<boolean> {
  const hash = await deriveHash(secret, hexToBytes(verifier.salt), verifier.kdf);
  return constantTimeEqual(hash, hexToBytes(verifier.hash));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HEX = /^[0-9a-f]*$/;

function readKdf(value: unknown): PinKdfParams | null {
  if (!isRecord(value) || value.algorithm !== 'scrypt') return null;
  const { N, r, p, dkLen } = value;
  if (typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number' || typeof dkLen !== 'number') return null;
  if (!Number.isInteger(Math.log2(N)) || N < 2 || r < 1 || p < 1 || dkLen < 16) return null;
  return { algorithm: 'scrypt', N, r, p, dkLen };
}

function readVerifier(value: unknown): SecretVerifier | null {
  if (!isRecord(value)) return null;
  const kdf = readKdf(value.kdf);
  const { salt, hash } = value;
  if (kdf === null || typeof salt !== 'string' || typeof hash !== 'string') return null;
  if (!HEX.test(salt) || !HEX.test(hash) || salt.length === 0 || hash.length !== kdf.dkLen * 2) return null;
  return { kdf, salt, hash };
}

// ——— PIN rules ———

export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 12;

/** Why a new PIN is refused; null when it is acceptable. */
export function pinFormatProblem(pin: string): string | null {
  if (!/^[0-9]+$/.test(pin)) return 'A PIN uses digits only.';
  if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    return `A PIN has ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits.`;
  }
  if (/^(\d)\1+$/.test(pin)) return 'Choose a PIN that is not one digit repeated.';
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - (digits[i] ?? 0));
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) {
    return 'Choose a PIN that is not a straight run of digits.';
  }
  return null;
}

// ——— attempts and backoff ———

/** Misses allowed before waits begin. */
export const FREE_PIN_ATTEMPTS = 5;
/** Wait after each miss beyond the free ones; the last value repeats. */
export const PIN_BACKOFF_MS: readonly number[] = [30_000, 60_000, 300_000, 900_000, 3_600_000];

/** How long to wait after `failedAttempts` consecutive misses (0 = no wait). */
export function backoffAfter(failedAttempts: number): number {
  if (failedAttempts < FREE_PIN_ATTEMPTS) return 0;
  const index = Math.min(failedAttempts - FREE_PIN_ATTEMPTS, PIN_BACKOFF_MS.length - 1);
  return PIN_BACKOFF_MS[index] ?? 0;
}

// ——— stored record ———

export const APP_LOCK_STORAGE_KEY = 'sovereign.app-lock.v1';

interface StoredLock {
  readonly version: 1;
  readonly pin: SecretVerifier;
  readonly biometric: boolean;
  readonly failedAttempts: number;
  /** Epoch ms before which no PIN is checked; null = no wait. */
  readonly lockedUntil: number | null;
}

function parseStoredLock(raw: string): StoredLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The app lock record is unreadable.');
  }
  if (!isRecord(parsed) || parsed.version !== 1) throw new Error('The app lock record has an unknown format.');
  const pin = readVerifier(parsed.pin);
  const { biometric, failedAttempts, lockedUntil } = parsed;
  if (
    pin === null ||
    typeof biometric !== 'boolean' ||
    typeof failedAttempts !== 'number' ||
    !Number.isInteger(failedAttempts) ||
    failedAttempts < 0 ||
    !(lockedUntil === null || typeof lockedUntil === 'number')
  ) {
    throw new Error('The app lock record is damaged.');
  }
  return { version: 1, pin, biometric, failedAttempts, lockedUntil };
}

// ——— the lock ———

export type AppLockStatus =
  /** Reading the record; the app stays covered. */
  | 'loading'
  /** The record could not be read; the app stays covered (fail closed). */
  | 'error'
  /** No PIN set. */
  | 'off'
  | 'locked'
  | 'unlocked';

export interface AppLockSnapshot {
  readonly status: AppLockStatus;
  readonly pinSet: boolean;
  readonly biometricEnabled: boolean;
  /** The host can show a biometric prompt (`authenticateBiometric` exists). */
  readonly biometricAvailable: boolean;
  readonly failedAttempts: number;
  readonly lockedUntil: number | null;
  /** A PIN is being hashed or the record written. */
  readonly busy: boolean;
  /** Why the app is covered, or the last storage failure. */
  readonly error: string | null;
  readonly protection: SecureStorageProtection;
  /** Why the app last locked; null while unlocked or off. */
  readonly lockReason: 'launch' | 'timeout' | 'manual' | null;
}

export type PinResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'wrong-pin'
        | 'locked-out'
        | 'invalid-pin'
        | 'no-pin'
        | 'pin-already-set'
        | 'biometric-unavailable'
        | 'biometric-failed'
        | 'storage-error';
      readonly message: string;
      /** For `locked-out` and a `wrong-pin` that started a wait: when the next try is allowed. */
      readonly retryAt?: number;
    };

export interface AppLockOptions {
  readonly storage: SecureStoragePort;
  /** The host's biometric prompt; absent = biometric unlock unavailable. */
  readonly authenticateBiometric?: (reason: string) => Promise<boolean>;
  /** Current lock-timeout preference, in seconds (read at each foreground). */
  readonly lockTimeoutSeconds: () => number;
  readonly now?: () => number;
  readonly kdf?: PinKdfParams;
  readonly randomBytes?: RandomBytes;
}

const fail = (reason: Exclude<PinResult, { ok: true }>['reason'], message: string, retryAt?: number): PinResult =>
  retryAt === undefined ? { ok: false, reason, message } : { ok: false, reason, message, retryAt };

function describeWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export class AppLock {
  private readonly storage: SecureStoragePort;
  private readonly authenticate: ((reason: string) => Promise<boolean>) | undefined;
  private readonly lockTimeoutSeconds: () => number;
  private readonly now: () => number;
  private readonly kdf: PinKdfParams;
  private readonly random: RandomBytes;
  private readonly listeners = new Set<() => void>();
  private record: StoredLock | null = null;
  private backgroundAt: number | null = null;
  private snapshot: AppLockSnapshot;

  constructor(options: AppLockOptions) {
    this.storage = options.storage;
    this.authenticate = options.authenticateBiometric;
    this.lockTimeoutSeconds = options.lockTimeoutSeconds;
    this.now = options.now ?? Date.now;
    this.kdf = options.kdf ?? DEFAULT_PIN_KDF;
    this.random = options.randomBytes ?? defaultRandomBytes;
    this.snapshot = {
      status: 'loading',
      pinSet: false,
      biometricEnabled: false,
      biometricAvailable: this.authenticate !== undefined,
      failedAttempts: 0,
      lockedUntil: null,
      busy: false,
      error: null,
      protection: options.storage.protection ?? 'memory',
      lockReason: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AppLockSnapshot => this.snapshot;

  /** Reads the record; with a PIN set the app starts locked. Never throws. */
  async load(): Promise<void> {
    this.publish({ status: 'loading', error: null });
    try {
      const raw = await this.storage.getItem(APP_LOCK_STORAGE_KEY);
      this.record = raw === null ? null : parseStoredLock(raw);
      this.publishRecord(this.record === null ? 'off' : 'locked', this.record === null ? null : 'launch');
    } catch (error) {
      this.record = null;
      this.publish({
        status: 'error',
        error: `The app lock could not be read: ${message(error)}`,
      });
    }
  }

  /** Seconds until a PIN may be tried again (0 = now). */
  waitMs(at: number = this.now()): number {
    const until = this.record?.lockedUntil ?? null;
    return until === null ? 0 : Math.max(0, until - at);
  }

  // ——— PIN lifecycle ———

  async setPin(pin: string): Promise<PinResult> {
    if (this.record !== null) return fail('pin-already-set', 'A PIN is already set. Change it instead.');
    const problem = pinFormatProblem(pin);
    if (problem !== null) return fail('invalid-pin', problem);
    return this.withBusy(async () => {
      const record: StoredLock = {
        version: 1,
        pin: await makeVerifier(pin, this.kdf, this.random),
        biometric: false,
        failedAttempts: 0,
        lockedUntil: null,
      };
      await this.write(record);
      this.publishRecord('unlocked', null);
      return { ok: true };
    });
  }

  async changePin(current: string, next: string): Promise<PinResult> {
    const problem = pinFormatProblem(next);
    if (problem !== null) return fail('invalid-pin', problem);
    const checked = await this.checkPin(current);
    if (!checked.ok) return checked;
    return this.withBusy(async () => {
      const prior = this.requireRecord();
      await this.write({ ...prior, pin: await makeVerifier(next, this.kdf, this.random) });
      this.publishRecord('unlocked', null);
      return { ok: true };
    });
  }

  /** Removes the PIN (and biometric unlock with it) after checking the current PIN. */
  async removePin(current: string): Promise<PinResult> {
    const checked = await this.checkPin(current);
    if (!checked.ok) return checked;
    return this.withBusy(async () => {
      await this.storage.removeItem(APP_LOCK_STORAGE_KEY);
      this.record = null;
      this.publishRecord('off', null);
      return { ok: true };
    });
  }

  /**
   * Forgotten PIN: removes the PIN after the caller has proven ownership of
   * the wallet another way — the everyday wallet's recovery phrase checked
   * against `BackupRecordStore.check`. Never call it without that proof.
   */
  async removePinWithRecoveryProof(proof: { readonly recoveryPhraseChecked: true }): Promise<PinResult> {
    if (!proof.recoveryPhraseChecked) return fail('wrong-pin', 'The recovery phrase was not checked.');
    if (this.record === null) return fail('no-pin', 'No PIN is set.');
    return this.withBusy(async () => {
      await this.storage.removeItem(APP_LOCK_STORAGE_KEY);
      this.record = null;
      this.publishRecord('off', null);
      return { ok: true };
    });
  }

  /** Re-authentication for a sensitive action while unlocked (counts as an attempt). */
  verifyPin(pin: string): Promise<PinResult> {
    return this.checkPin(pin);
  }

  // ——— unlocking ———

  async unlockWithPin(pin: string): Promise<PinResult> {
    const checked = await this.checkPin(pin);
    if (checked.ok) this.publishRecord('unlocked', null);
    return checked;
  }

  /**
   * Shows the host's biometric prompt and unlocks on success. False when
   * biometrics are off, unavailable, cancelled or failed — the PIN still works.
   */
  async unlockWithBiometric(reason = 'Unlock Sovereign Wallet'): Promise<boolean> {
    const record = this.record;
    if (record === null || !record.biometric || this.authenticate === undefined) return false;
    let passed = false;
    try {
      passed = await this.authenticate(reason);
    } catch {
      passed = false;
    }
    if (!passed) return false;
    if (record.failedAttempts !== 0 || record.lockedUntil !== null) {
      try {
        await this.write({ ...record, failedAttempts: 0, lockedUntil: null });
      } catch (error) {
        this.publish({ error: `Unlocked, but the attempt counter could not be reset: ${message(error)}` });
      }
    }
    this.publishRecord('unlocked', null);
    return true;
  }

  /**
   * Turns biometric unlock on (after a successful prompt, so it is known to
   * work) or off. Needs a PIN: biometrics are a shortcut to it, not a
   * replacement.
   */
  async setBiometricEnabled(enabled: boolean): Promise<PinResult> {
    const record = this.record;
    if (record === null) return fail('no-pin', 'Set a PIN first; biometric unlock is a shortcut to it.');
    if (enabled) {
      if (this.authenticate === undefined) {
        return fail('biometric-unavailable', 'This build has no biometric prompt.');
      }
      let passed = false;
      try {
        passed = await this.authenticate('Turn on biometric unlock');
      } catch {
        passed = false;
      }
      if (!passed) return fail('biometric-failed', 'Biometric check did not succeed, so biometric unlock stays off.');
    }
    return this.withBusy(async () => {
      await this.write({ ...record, biometric: enabled });
      this.publishRecord(this.snapshot.status === 'locked' ? 'locked' : 'unlocked', this.snapshot.lockReason);
      return { ok: true };
    });
  }

  // ——— automatic locking ———

  /** Locks now (the "Lock now" control). No-op without a PIN. */
  lockNow(): void {
    if (this.record === null || this.snapshot.status !== 'unlocked') return;
    this.publishRecord('locked', 'manual');
  }

  /** The app went to the background at `at`. */
  noteBackground(at: number = this.now()): void {
    this.backgroundAt = at;
  }

  /** The app came back at `at`: locks if the lock timeout has passed. */
  noteForeground(at: number = this.now()): void {
    const since = this.backgroundAt;
    this.backgroundAt = null;
    if (since === null || this.record === null || this.snapshot.status !== 'unlocked') return;
    if (at - since >= this.lockTimeoutSeconds() * 1000) this.publishRecord('locked', 'timeout');
  }

  // ——— internals ———

  /** Verifies a PIN against the record, enforcing and recording attempts. */
  private async checkPin(pin: string): Promise<PinResult> {
    const record = this.record;
    if (record === null) return fail('no-pin', 'No PIN is set.');
    const at = this.now();
    const wait = this.waitMs(at);
    if (wait > 0) {
      return fail('locked-out', `Too many wrong PINs. Try again in ${describeWait(wait)}.`, at + wait);
    }
    if (!/^[0-9]+$/.test(pin)) return fail('invalid-pin', 'Enter your PIN using digits.');
    return this.withBusy(async () => {
      const matches = await checkVerifier(pin, record.pin);
      if (matches) {
        if (record.failedAttempts !== 0 || record.lockedUntil !== null) {
          await this.write({ ...record, failedAttempts: 0, lockedUntil: null });
        }
        this.publishRecord(this.snapshot.status, this.snapshot.lockReason);
        return { ok: true };
      }
      const failedAttempts = record.failedAttempts + 1;
      const delay = backoffAfter(failedAttempts);
      const lockedUntil = delay > 0 ? this.now() + delay : null;
      // Recorded before answering, so a restart does not reset the count.
      await this.write({ ...record, failedAttempts, lockedUntil });
      this.publishRecord(this.snapshot.status, this.snapshot.lockReason);
      const left = FREE_PIN_ATTEMPTS - failedAttempts;
      if (lockedUntil !== null) {
        return fail('wrong-pin', `Wrong PIN. Try again in ${describeWait(delay)}.`, lockedUntil);
      }
      return fail(
        'wrong-pin',
        left === 1 ? 'Wrong PIN. One more miss starts a wait.' : `Wrong PIN. ${left} tries before a wait.`,
      );
    });
  }

  private requireRecord(): StoredLock {
    if (this.record === null) throw new Error('No PIN is set.');
    return this.record;
  }

  private async write(record: StoredLock): Promise<void> {
    await this.storage.setItem(APP_LOCK_STORAGE_KEY, JSON.stringify(record));
    this.record = record;
  }

  private async withBusy(work: () => Promise<PinResult>): Promise<PinResult> {
    this.publish({ busy: true, error: null });
    try {
      return await work();
    } catch (error) {
      const text = `The app lock could not be saved: ${message(error)}`;
      this.publish({ error: text });
      return fail('storage-error', text);
    } finally {
      this.publish({ busy: false });
    }
  }

  private publishRecord(status: AppLockStatus, lockReason: AppLockSnapshot['lockReason']): void {
    const record = this.record;
    this.publish({
      status,
      lockReason: status === 'locked' ? lockReason : null,
      pinSet: record !== null,
      biometricEnabled: record?.biometric ?? false,
      failedAttempts: record?.failedAttempts ?? 0,
      lockedUntil: record?.lockedUntil ?? null,
    });
  }

  private publish(next: Partial<AppLockSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
}

// ——— backup record ———

export const BACKUP_RECORD_STORAGE_KEY = 'sovereign.backup-record.v1';

/**
 * How this device knows the recovery phrase was backed up:
 * - `verified-at-creation`: every word was re-entered when the wallet was made;
 * - `restored`: the wallet was restored from the phrase on this device.
 * With it, a scrypt verifier of the normalized phrase (random salt) so the
 * user can later check a written copy. The phrase itself is never stored;
 * a 12/24-word phrase has 128–256 bits of entropy, so its slow salted hash
 * cannot be reversed or guessed.
 */
export interface BackupRecord {
  readonly kind: 'verified-at-creation' | 'restored';
  /** ISO-8601 UTC. */
  readonly at: string;
  /** Last successful check of a written copy (ISO-8601 UTC); null = never. */
  readonly lastCheckedAt: string | null;
}

interface StoredBackup extends BackupRecord {
  readonly version: 1;
  readonly verifier: SecretVerifier;
}

/** Lower-case words joined by single spaces — how phrases are compared. */
export function normalizePhrase(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(' ');
}

export type BackupStoreSnapshot =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: string }
  | { readonly status: 'none' }
  | { readonly status: 'recorded'; readonly record: BackupRecord };

export class BackupRecordStore {
  private readonly storage: SecureStoragePort;
  private readonly kdf: PinKdfParams;
  private readonly random: RandomBytes;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private stored: StoredBackup | null = null;
  private snapshot: BackupStoreSnapshot = { status: 'loading' };

  constructor(options: {
    storage: SecureStoragePort;
    kdf?: PinKdfParams;
    randomBytes?: RandomBytes;
    now?: () => number;
  }) {
    this.storage = options.storage;
    this.kdf = options.kdf ?? DEFAULT_PIN_KDF;
    this.random = options.randomBytes ?? defaultRandomBytes;
    this.now = options.now ?? Date.now;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): BackupStoreSnapshot => this.snapshot;

  get protection(): SecureStorageProtection {
    return this.storage.protection ?? 'memory';
  }

  async load(): Promise<void> {
    try {
      const raw = await this.storage.getItem(BACKUP_RECORD_STORAGE_KEY);
      this.stored = raw === null ? null : parseStoredBackup(raw);
      this.publish();
    } catch (error) {
      this.set({ status: 'error', error: `The backup record could not be read: ${message(error)}` });
    }
  }

  /** Records a completed backup (or restore) with a verifier of the phrase. */
  async record(kind: BackupRecord['kind'], words: readonly string[]): Promise<void> {
    const phrase = normalizePhrase(words.join(' '));
    try {
      const verifier = await makeVerifier(phrase, this.kdf, this.random);
      const stored: StoredBackup = {
        version: 1,
        kind,
        at: new Date(this.now()).toISOString(),
        lastCheckedAt: null,
        verifier,
      };
      await this.storage.setItem(BACKUP_RECORD_STORAGE_KEY, JSON.stringify(stored));
      this.stored = stored;
      this.publish();
    } catch (error) {
      this.set({ status: 'error', error: `The backup record could not be saved: ${message(error)}` });
    }
  }

  /** Checks a written copy against the verifier. Null = nothing recorded to check against. */
  async check(phraseText: string): Promise<boolean | null> {
    const stored = this.stored;
    if (stored === null) return null;
    const matches = await checkVerifier(normalizePhrase(phraseText), stored.verifier);
    if (matches) {
      const updated: StoredBackup = { ...stored, lastCheckedAt: new Date(this.now()).toISOString() };
      try {
        await this.storage.setItem(BACKUP_RECORD_STORAGE_KEY, JSON.stringify(updated));
        this.stored = updated;
      } catch {
        // The check itself succeeded; only the timestamp was not saved.
        this.stored = updated;
      }
      this.publish();
    }
    return matches;
  }

  private publish(): void {
    const stored = this.stored;
    this.set(
      stored === null
        ? { status: 'none' }
        : { status: 'recorded', record: { kind: stored.kind, at: stored.at, lastCheckedAt: stored.lastCheckedAt } },
    );
  }

  private set(snapshot: BackupStoreSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function parseStoredBackup(raw: string): StoredBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('it is unreadable');
  }
  if (!isRecord(parsed) || parsed.version !== 1) throw new Error('it has an unknown format');
  const verifier = readVerifier(parsed.verifier);
  const { kind, at, lastCheckedAt } = parsed;
  if (
    verifier === null ||
    (kind !== 'verified-at-creation' && kind !== 'restored') ||
    typeof at !== 'string' ||
    !(lastCheckedAt === null || typeof lastCheckedAt === 'string')
  ) {
    throw new Error('it is damaged');
  }
  return { version: 1, kind, at, lastCheckedAt, verifier };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
