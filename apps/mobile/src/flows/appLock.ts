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
 *   `biometricGate` (native keystore gate) or `authenticateBiometric`;
 *   turning it on requires the PIN and then a successful prompt. Only that
 *   step creates the keystore gate, and the record notes it. A gate that has
 *   gone missing (biometric enrollment changed on the phone) turns biometric
 *   unlock off — persisted — and the PIN is required. Biometrics never
 *   replace the PIN: removing or changing the PIN always asks for it.
 * - The wall clock can be changed by whoever holds the phone. A stored wait
 *   is clamped to the wait that was actually imposed (so setting the clock
 *   back cannot stretch it), a monotonic clock keeps an in-session wait
 *   running when the wall clock jumps forward, and a negative time in the
 *   background counts as the lock timeout having passed.
 * - PIN checks run one at a time (queued) and each re-reads the stored
 *   record after hashing, so parallel guesses are each counted.
 * - Storage failures fail closed: if the record cannot be read the app
 *   stays covered and says why.
 *
 * What the lock does NOT do: it does not encrypt wallet data (the wallet's
 * own storage and password do that) and, in the web preview, the record
 * lives in browser storage, which is not secure — the UI says so.
 */

import { scryptAsync } from '@noble/hashes/scrypt';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { BiometricGate, SecureStorageProtection, SecureStoragePort } from './platform.js';

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
  /**
   * True once `setBiometricEnabled(true)` (with the PIN) created the
   * keystore gate. Biometric unlock through a gate needs this; older
   * records without it must turn biometric unlock on again.
   */
  readonly biometricGate: boolean;
  readonly failedAttempts: number;
  /** Epoch ms before which no PIN is checked; null = no wait. */
  readonly lockedUntil: number | null;
  /** The wait imposed when `lockedUntil` was set (ms); bounds what the wall clock can stretch. */
  readonly lockWaitMs: number | null;
}

/** The longest wait the backoff ever imposes. */
export const MAX_PIN_BACKOFF_MS = Math.max(...PIN_BACKOFF_MS);

function parseStoredLock(raw: string): StoredLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The app lock record is unreadable.');
  }
  if (!isRecord(parsed) || parsed.version !== 1) throw new Error('The app lock record has an unknown format.');
  const pin = readVerifier(parsed.pin);
  const { biometric, biometricGate, failedAttempts, lockedUntil, lockWaitMs } = parsed;
  if (
    pin === null ||
    typeof biometric !== 'boolean' ||
    !(biometricGate === undefined || typeof biometricGate === 'boolean') ||
    typeof failedAttempts !== 'number' ||
    !Number.isInteger(failedAttempts) ||
    failedAttempts < 0 ||
    !(lockedUntil === null || (typeof lockedUntil === 'number' && Number.isFinite(lockedUntil))) ||
    !(lockWaitMs === undefined || lockWaitMs === null || (typeof lockWaitMs === 'number' && lockWaitMs >= 0))
  ) {
    throw new Error('The app lock record is damaged.');
  }
  return {
    version: 1,
    pin,
    biometric,
    biometricGate: biometricGate ?? false,
    failedAttempts,
    lockedUntil,
    lockWaitMs: lockWaitMs ?? null,
  };
}

/**
 * The wait still owed at `at` by the stored deadline, never more than the
 * wait that was imposed (nor the longest backoff): moving the wall clock
 * back cannot stretch a lockout into hours, and a damaged deadline far in
 * the future cannot lock the owner out for good.
 */
function storedWaitMs(record: StoredLock, at: number): number {
  if (record.lockedUntil === null) return 0;
  const cap = Math.min(record.lockWaitMs ?? MAX_PIN_BACKOFF_MS, MAX_PIN_BACKOFF_MS);
  return Math.min(Math.max(0, record.lockedUntil - at), cap);
}

/** A monotonic clock (ms) when the runtime has one; else the wall clock. */
function defaultMonotonicNow(): number {
  const perf: unknown = Reflect.get(globalThis, 'performance');
  const now: unknown = typeof perf === 'object' && perf !== null ? Reflect.get(perf, 'now') : undefined;
  return typeof now === 'function' ? Number(now.call(perf)) : Date.now();
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
  /** The host's biometric prompt; used when there is no `biometricGate`. */
  readonly authenticateBiometric?: (reason: string) => Promise<boolean>;
  /** Keystore gate (native). Preferred over `authenticateBiometric` when present. */
  readonly biometricGate?: BiometricGate;
  /** Monotonic ms (not affected by clock changes); defaults to `performance.now`. */
  readonly monotonicNow?: () => number;
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

/** The tail of each storage's PIN-check queue: checks run strictly one after another. */
const PIN_QUEUES = new WeakMap<SecureStoragePort, Promise<void>>();

export class AppLock {
  private readonly storage: SecureStoragePort;
  private readonly authenticate: ((reason: string) => Promise<boolean>) | undefined;
  private readonly gate: BiometricGate | undefined;
  private readonly lockTimeoutSeconds: () => number;
  private readonly now: () => number;
  private readonly mono: () => number;
  private readonly kdf: PinKdfParams;
  private readonly random: RandomBytes;
  private readonly listeners = new Set<() => void>();
  private record: StoredLock | null = null;
  private backgroundAt: number | null = null;
  private backgroundMono: number | null = null;
  /** Monotonic deadline of the current wait in this session; null = none. */
  private monoDeadline: number | null = null;
  private snapshot: AppLockSnapshot;

  constructor(options: AppLockOptions) {
    this.storage = options.storage;
    this.authenticate = options.authenticateBiometric;
    this.gate = options.biometricGate;
    this.lockTimeoutSeconds = options.lockTimeoutSeconds;
    this.now = options.now ?? Date.now;
    this.mono = options.monotonicNow ?? defaultMonotonicNow;
    this.kdf = options.kdf ?? DEFAULT_PIN_KDF;
    this.random = options.randomBytes ?? defaultRandomBytes;
    this.snapshot = {
      status: 'loading',
      pinSet: false,
      biometricEnabled: false,
      biometricAvailable: this.gate !== undefined || this.authenticate !== undefined,
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
      this.record = await this.readRecord();
      this.startMonoWait(this.record);
      this.publishRecord(this.record === null ? 'off' : 'locked', this.record === null ? null : 'launch');
    } catch (error) {
      this.record = null;
      this.publish({
        status: 'error',
        error: `The app lock could not be read: ${message(error)}`,
      });
    }
  }

  /**
   * Milliseconds until a PIN may be tried again (0 = now): the stored wait
   * (clamped, see `storedWaitMs`) or, in this session, the monotonic one —
   * whichever is longer, so moving the clock either way doesn't skip it.
   */
  waitMs(at: number = this.now()): number {
    const record = this.record;
    if (record === null) return 0;
    const stored = storedWaitMs(record, at);
    const monotonic = this.monoDeadline === null ? 0 : Math.max(0, this.monoDeadline - this.mono());
    return Math.max(stored, Math.min(monotonic, MAX_PIN_BACKOFF_MS));
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
        biometricGate: false,
        failedAttempts: 0,
        lockedUntil: null,
        lockWaitMs: null,
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
      this.monoDeadline = null;
      await this.gate?.remove();
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
      this.monoDeadline = null;
      await this.gate?.remove();
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
   * Shows the biometric prompt and unlocks on success. False when
   * biometrics are off, unavailable, cancelled or failed — the PIN still
   * works. A missing keystore gate (enrollment changed) turns biometric
   * unlock off for good, until it is turned on again with the PIN.
   */
  async unlockWithBiometric(reason = 'Unlock Sovereign Wallet'): Promise<boolean> {
    const record = this.record;
    if (record === null || !record.biometric) return false;
    let passed = false;
    if (this.gate !== undefined) {
      if (!record.biometricGate) {
        await this.disableBiometric(record, 'Biometric unlock needs to be turned on again with your PIN.');
        return false;
      }
      let check: Awaited<ReturnType<BiometricGate['verify']>> = 'failed';
      try {
        check = await this.gate.verify(reason);
      } catch {
        check = 'failed';
      }
      if (check === 'gate-missing') {
        await this.disableBiometric(
          record,
          "Biometric unlock was turned off because this phone's fingerprints or face changed. Enter your PIN; you can turn biometric unlock on again in Security.",
        );
        return false;
      }
      passed = check === 'passed';
    } else if (this.authenticate !== undefined) {
      try {
        passed = await this.authenticate(reason);
      } catch {
        passed = false;
      }
    }
    if (!passed) return false;
    const latest = this.record ?? record;
    if (latest.failedAttempts !== 0 || latest.lockedUntil !== null) {
      try {
        await this.write({ ...latest, failedAttempts: 0, lockedUntil: null, lockWaitMs: null });
        this.monoDeadline = null;
      } catch (error) {
        this.publish({ error: `Unlocked, but the attempt counter could not be reset: ${message(error)}` });
      }
    }
    this.publishRecord('unlocked', null);
    return true;
  }

  /**
   * Turns biometric unlock on or off. Turning it on needs the app PIN (it
   * counts as an attempt) and then a successful prompt; only this creates
   * the keystore gate. Biometrics are a shortcut to the PIN, not a
   * replacement.
   */
  async setBiometricEnabled(enabled: boolean, pin?: string): Promise<PinResult> {
    const record = this.record;
    if (record === null) return fail('no-pin', 'Set a PIN first; biometric unlock is a shortcut to it.');
    if (!enabled) {
      return this.withBusy(async () => {
        await this.write({ ...this.requireRecord(), biometric: false, biometricGate: false });
        await this.gate?.remove();
        this.publishRecord(this.snapshot.status === 'locked' ? 'locked' : 'unlocked', this.snapshot.lockReason);
        return { ok: true };
      });
    }
    if (this.gate === undefined && this.authenticate === undefined) {
      return fail('biometric-unavailable', 'This build has no biometric prompt.');
    }
    if (pin === undefined || pin === '') {
      return fail('invalid-pin', 'Enter your PIN to turn on biometric unlock.');
    }
    const checked = await this.checkPin(pin);
    if (!checked.ok) return checked;
    let passed = false;
    try {
      passed =
        this.gate !== undefined
          ? await this.gate.create('Turn on biometric unlock')
          : this.authenticate !== undefined && (await this.authenticate('Turn on biometric unlock'));
    } catch {
      passed = false;
    }
    if (!passed) return fail('biometric-failed', 'Biometric check did not succeed, so biometric unlock stays off.');
    return this.withBusy(async () => {
      await this.write({ ...this.requireRecord(), biometric: true, biometricGate: this.gate !== undefined });
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
    this.backgroundMono = this.mono();
  }

  /**
   * The app came back at `at`: locks if the lock timeout has passed. A wall
   * clock that went backwards (negative time away) counts as timed out, and
   * the monotonic clock counts too, so neither clock change skips the lock.
   */
  noteForeground(at: number = this.now()): void {
    const since = this.backgroundAt;
    const sinceMono = this.backgroundMono;
    this.backgroundAt = null;
    this.backgroundMono = null;
    if (since === null || this.record === null || this.snapshot.status !== 'unlocked') return;
    const timeoutMs = this.lockTimeoutSeconds() * 1000;
    const away = at - since;
    const awayMono = sinceMono === null ? 0 : this.mono() - sinceMono;
    if (away < 0 || away >= timeoutMs || awayMono >= timeoutMs) this.publishRecord('locked', 'timeout');
  }

  // ——— internals ———

  /** Verifies a PIN against the record, enforcing and recording attempts — one check at a time. */
  private checkPin(pin: string): Promise<PinResult> {
    // Queued per storage, so two lock instances over the same record can't interleave either.
    const previous = PIN_QUEUES.get(this.storage) ?? Promise.resolve();
    const run = previous.then(() => this.checkPinNow(pin));
    PIN_QUEUES.set(
      this.storage,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async checkPinNow(pin: string): Promise<PinResult> {
    if (this.record === null) return fail('no-pin', 'No PIN is set.');
    const at = this.now();
    const wait = this.waitMs(at);
    if (wait > 0) {
      return fail('locked-out', `Too many wrong PINs. Try again in ${describeWait(wait)}.`, at + wait);
    }
    if (!/^[0-9]+$/.test(pin)) return fail('invalid-pin', 'Enter your PIN using digits.');
    return this.withBusy(async () => {
      const verifier = this.requireRecord().pin;
      const matches = await checkVerifier(pin, verifier);
      // Re-read after the (slow) hash: count against what is stored now.
      const latest = await this.readRecord();
      if (latest === null) {
        this.record = null;
        this.publishRecord('off', null);
        return fail('no-pin', 'No PIN is set.');
      }
      this.record = latest;
      if (latest.pin.hash !== verifier.hash || latest.pin.salt !== verifier.salt) {
        return fail('wrong-pin', 'The PIN was changed meanwhile. Enter the current PIN.');
      }
      if (matches) {
        if (latest.failedAttempts !== 0 || latest.lockedUntil !== null) {
          await this.write({ ...latest, failedAttempts: 0, lockedUntil: null, lockWaitMs: null });
        }
        this.monoDeadline = null;
        this.publishRecord(this.snapshot.status, this.snapshot.lockReason);
        return { ok: true };
      }
      const failedAttempts = latest.failedAttempts + 1;
      const delay = backoffAfter(failedAttempts);
      const now = this.now();
      const lockedUntil = delay > 0 ? now + delay : null;
      // Recorded before answering, so a restart does not reset the count.
      await this.write({ ...latest, failedAttempts, lockedUntil, lockWaitMs: delay > 0 ? delay : null });
      this.monoDeadline = delay > 0 ? this.mono() + delay : null;
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

  /** The stored record, with any stored wait clamped (see `storedWaitMs`). */
  private async readRecord(): Promise<StoredLock | null> {
    const raw = await this.storage.getItem(APP_LOCK_STORAGE_KEY);
    if (raw === null) return null;
    const record = parseStoredLock(raw);
    if (record.lockedUntil === null) return record;
    const at = this.now();
    const wait = storedWaitMs(record, at);
    return wait === 0 ? { ...record, lockedUntil: null, lockWaitMs: null } : { ...record, lockedUntil: at + wait };
  }

  /** Starts the in-session monotonic wait for a record read from storage. */
  private startMonoWait(record: StoredLock | null): void {
    const wait = record === null ? 0 : storedWaitMs(record, this.now());
    this.monoDeadline = wait > 0 ? this.mono() + wait : null;
  }

  /** Persists "biometric unlock off" after its gate went missing; the PIN is required. */
  private async disableBiometric(record: StoredLock, why: string): Promise<void> {
    try {
      await this.write({ ...(this.record ?? record), biometric: false, biometricGate: false });
      await this.gate?.remove();
      this.publishRecord(this.snapshot.status, this.snapshot.lockReason);
      this.publish({ error: why });
    } catch (error) {
      // Not persisted: still refuse biometrics for this session.
      this.record = { ...(this.record ?? record), biometric: false, biometricGate: false };
      this.publishRecord(this.snapshot.status, this.snapshot.lockReason);
      this.publish({ error: `${why} (This could not be saved: ${message(error)})` });
    }
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

/**
 * The pre-wallet-type key. Never read: a record there can't be tied to a
 * wallet, so it is removed on load (it held only a verifier, never a phrase).
 */
export const BACKUP_RECORD_STORAGE_KEY = 'sovereign.backup-record.v1';

/** Which wallet a backup record belongs to (one record per wallet type). */
export type BackupWalletType = 'wavelength' | 'remote-lnd';

/** Storage key of one wallet type's backup record. */
export function backupRecordStorageKey(walletType: BackupWalletType): string {
  return `${BACKUP_RECORD_STORAGE_KEY}.${walletType}`;
}

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

/**
 * The record proves ownership for "Forgot PIN", so it must always describe
 * the wallet that exists now: it is keyed per wallet type, cleared the
 * moment a new wallet is created (before its words are verified) and
 * replaced when a wallet is restored — an old phrase can never remove the
 * PIN of a newer wallet.
 */
export class BackupRecordStore {
  private readonly storage: SecureStoragePort;
  private readonly key: string;
  private readonly kdf: PinKdfParams;
  private readonly random: RandomBytes;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private stored: StoredBackup | null = null;
  private snapshot: BackupStoreSnapshot = { status: 'loading' };

  constructor(options: {
    storage: SecureStoragePort;
    walletType: BackupWalletType;
    kdf?: PinKdfParams;
    randomBytes?: RandomBytes;
    now?: () => number;
  }) {
    this.storage = options.storage;
    this.key = backupRecordStorageKey(options.walletType);
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
      await this.storage.removeItem(BACKUP_RECORD_STORAGE_KEY).catch(() => undefined);
      const raw = await this.storage.getItem(this.key);
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
      await this.storage.setItem(this.key, JSON.stringify(stored));
      this.stored = stored;
      this.publish();
    } catch (error) {
      // Never leave the previous wallet's record in place.
      await this.forget();
      this.set({ status: 'error', error: `The backup record could not be saved: ${message(error)}` });
    }
  }

  /** A new wallet replaces the old one: its record no longer proves anything. */
  async clear(): Promise<void> {
    await this.forget();
    this.publish();
  }

  private async forget(): Promise<void> {
    this.stored = null;
    try {
      await this.storage.removeItem(this.key);
    } catch {
      // In memory it is gone already; `check` answers null without it.
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
        await this.storage.setItem(this.key, JSON.stringify(updated));
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
