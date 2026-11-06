import { describe, expect, it } from 'vitest';
import {
  APP_LOCK_STORAGE_KEY,
  AppLock,
  BACKUP_RECORD_STORAGE_KEY,
  BackupRecordStore,
  FREE_PIN_ATTEMPTS,
  PIN_BACKOFF_MS,
  backoffAfter,
  browserPreviewSecureStorage,
  constantTimeEqual,
  memorySecureStorage,
  normalizePhrase,
  pinFormatProblem,
} from './appLock.js';
import type { PinKdfParams, PreviewKeyValueStorage } from './appLock.js';
import type { SecureStoragePort } from './platform.js';

/** Cheap scrypt parameters so tests run fast; production uses DEFAULT_PIN_KDF. */
const FAST_KDF: PinKdfParams = { algorithm: 'scrypt', N: 16, r: 1, p: 1, dkLen: 32 };

function fixedRandom(seed: number): (n: number) => Uint8Array {
  return (n) => Uint8Array.from({ length: n }, (_, i) => (seed + i) & 0xff);
}

function makeLock(options: {
  storage?: SecureStoragePort;
  biometric?: (reason: string) => Promise<boolean>;
  timeout?: number;
  clock?: { t: number };
} = {}) {
  const clock = options.clock ?? { t: 1_000_000 };
  const storage = options.storage ?? memorySecureStorage();
  const lock = new AppLock({
    storage,
    authenticateBiometric: options.biometric,
    lockTimeoutSeconds: () => options.timeout ?? 300,
    now: () => clock.t,
    kdf: FAST_KDF,
    randomBytes: fixedRandom(7),
  });
  return { lock, storage, clock };
}

describe('PIN rules', () => {
  it('accepts 6–12 digits and refuses weak or malformed PINs', () => {
    expect(pinFormatProblem('482913')).toBeNull();
    expect(pinFormatProblem('48291375')).toBeNull();
    expect(pinFormatProblem('12345')).toMatch(/6 to 12 digits/);
    expect(pinFormatProblem('1234567890123')).toMatch(/6 to 12 digits/);
    expect(pinFormatProblem('48a913')).toMatch(/digits only/);
    expect(pinFormatProblem('111111')).toMatch(/repeated/);
    expect(pinFormatProblem('123456')).toMatch(/straight run/);
    expect(pinFormatProblem('987654')).toMatch(/straight run/);
  });

  it('backs off only after the free attempts, then grows and caps', () => {
    for (let i = 0; i < FREE_PIN_ATTEMPTS; i++) expect(backoffAfter(i)).toBe(0);
    expect(backoffAfter(FREE_PIN_ATTEMPTS)).toBe(PIN_BACKOFF_MS[0]);
    expect(backoffAfter(FREE_PIN_ATTEMPTS + 1)).toBe(PIN_BACKOFF_MS[1]);
    expect(backoffAfter(100)).toBe(PIN_BACKOFF_MS[PIN_BACKOFF_MS.length - 1]);
  });

  it('compares in constant time over the full length', () => {
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
    expect(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0))).toBe(false);
  });
});

describe('AppLock hashing and storage', () => {
  it('stores only a salted scrypt hash, never the PIN', async () => {
    const storage = memorySecureStorage();
    const { lock } = makeLock({ storage });
    await lock.load();
    expect(lock.getSnapshot().status).toBe('off');
    expect(await lock.setPin('482913')).toEqual({ ok: true });
    const raw = storage.dump().get(APP_LOCK_STORAGE_KEY) ?? '';
    expect(raw).not.toContain('482913');
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toMatchObject({
      version: 1,
      pin: { kdf: FAST_KDF, salt: expect.stringMatching(/^[0-9a-f]{32}$/), hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      biometric: false,
      failedAttempts: 0,
      lockedUntil: null,
    });
    expect(lock.getSnapshot()).toMatchObject({ status: 'unlocked', pinSet: true });
  });

  it('two PINs with different salts hash differently', async () => {
    const a = memorySecureStorage();
    const b = memorySecureStorage();
    const lockA = new AppLock({ storage: a, lockTimeoutSeconds: () => 0, kdf: FAST_KDF, randomBytes: fixedRandom(1) });
    const lockB = new AppLock({ storage: b, lockTimeoutSeconds: () => 0, kdf: FAST_KDF, randomBytes: fixedRandom(2) });
    await lockA.load();
    await lockB.load();
    await lockA.setPin('482913');
    await lockB.setPin('482913');
    expect(a.dump().get(APP_LOCK_STORAGE_KEY)).not.toEqual(b.dump().get(APP_LOCK_STORAGE_KEY));
  });

  it('locks on launch when a PIN exists, and unlocks with the right PIN only', async () => {
    const storage = memorySecureStorage();
    const first = makeLock({ storage });
    await first.lock.load();
    await first.lock.setPin('482913');

    const relaunch = makeLock({ storage });
    await relaunch.lock.load();
    expect(relaunch.lock.getSnapshot()).toMatchObject({ status: 'locked', lockReason: 'launch' });
    const wrong = await relaunch.lock.unlockWithPin('000001');
    expect(wrong).toMatchObject({ ok: false, reason: 'wrong-pin' });
    expect(relaunch.lock.getSnapshot().status).toBe('locked');
    expect(await relaunch.lock.unlockWithPin('482913')).toEqual({ ok: true });
    expect(relaunch.lock.getSnapshot()).toMatchObject({ status: 'unlocked', failedAttempts: 0 });
  });

  it('changes and removes the PIN only with the current PIN', async () => {
    const storage = memorySecureStorage();
    const { lock } = makeLock({ storage });
    await lock.load();
    await lock.setPin('482913');
    expect(await lock.setPin('550919')).toMatchObject({ ok: false, reason: 'pin-already-set' });
    expect(await lock.changePin('000001', '550919')).toMatchObject({ ok: false, reason: 'wrong-pin' });
    expect(await lock.changePin('482913', '111111')).toMatchObject({ ok: false, reason: 'invalid-pin' });
    expect(await lock.changePin('482913', '550919')).toEqual({ ok: true });
    lock.lockNow();
    expect(await lock.unlockWithPin('482913')).toMatchObject({ ok: false });
    expect(await lock.unlockWithPin('550919')).toEqual({ ok: true });
    expect(await lock.removePin('482913')).toMatchObject({ ok: false, reason: 'wrong-pin' });
    expect(await lock.removePin('550919')).toEqual({ ok: true });
    expect(storage.dump().has(APP_LOCK_STORAGE_KEY)).toBe(false);
    expect(lock.getSnapshot()).toMatchObject({ status: 'off', pinSet: false });
  });

  it('fails closed when the record is unreadable', async () => {
    const storage = memorySecureStorage();
    await storage.setItem(APP_LOCK_STORAGE_KEY, '{"version":1,"pin":{}}');
    const { lock } = makeLock({ storage });
    await lock.load();
    expect(lock.getSnapshot().status).toBe('error');
    expect(lock.getSnapshot().error).toMatch(/could not be read/);

    const throwing: SecureStoragePort = {
      getItem: () => Promise.reject(new Error('keystore unavailable')),
      setItem: () => Promise.resolve(),
      removeItem: () => Promise.resolve(),
    };
    const broken = makeLock({ storage: throwing });
    await broken.lock.load();
    expect(broken.lock.getSnapshot()).toMatchObject({ status: 'error' });
    expect(broken.lock.getSnapshot().error).toMatch(/keystore unavailable/);
  });

  it('reports a write failure instead of claiming the PIN was set', async () => {
    const failing: SecureStoragePort = {
      getItem: () => Promise.resolve(null),
      setItem: () => Promise.reject(new Error('disk full')),
      removeItem: () => Promise.resolve(),
    };
    const { lock } = makeLock({ storage: failing });
    await lock.load();
    expect(await lock.setPin('482913')).toMatchObject({ ok: false, reason: 'storage-error' });
    expect(lock.getSnapshot()).toMatchObject({ status: 'off', pinSet: false });
  });
});

describe('AppLock attempts and backoff', () => {
  it('starts a wait after the free attempts, persists it across restarts, and resets on success', async () => {
    const storage = memorySecureStorage();
    const clock = { t: 5_000_000 };
    const { lock } = makeLock({ storage, clock });
    await lock.load();
    await lock.setPin('482913');
    lock.lockNow();

    for (let i = 1; i < FREE_PIN_ATTEMPTS; i++) {
      const result = await lock.unlockWithPin('000001');
      expect(result).toMatchObject({ ok: false, reason: 'wrong-pin' });
      expect(result.ok ? undefined : result.retryAt).toBeUndefined();
    }
    const fifth = await lock.unlockWithPin('000001');
    expect(fifth).toMatchObject({ ok: false, reason: 'wrong-pin', retryAt: clock.t + (PIN_BACKOFF_MS[0] ?? 0) });

    // Even the right PIN is refused during the wait — and not hashed.
    expect(await lock.unlockWithPin('482913')).toMatchObject({ ok: false, reason: 'locked-out' });

    // A restart does not reset the counter.
    const relaunch = makeLock({ storage, clock });
    await relaunch.lock.load();
    expect(relaunch.lock.getSnapshot()).toMatchObject({ failedAttempts: FREE_PIN_ATTEMPTS, status: 'locked' });
    expect(await relaunch.lock.unlockWithPin('482913')).toMatchObject({ ok: false, reason: 'locked-out' });

    clock.t += PIN_BACKOFF_MS[0] ?? 0;
    // Another miss after the wait doubles it.
    const sixth = await relaunch.lock.unlockWithPin('000001');
    expect(sixth).toMatchObject({ ok: false, retryAt: clock.t + (PIN_BACKOFF_MS[1] ?? 0) });
    clock.t += PIN_BACKOFF_MS[1] ?? 0;
    expect(await relaunch.lock.unlockWithPin('482913')).toEqual({ ok: true });
    expect(relaunch.lock.getSnapshot()).toMatchObject({ failedAttempts: 0, lockedUntil: null, status: 'unlocked' });
  });
});

describe('AppLock timeout locking', () => {
  it('locks after the timeout in the background, not before', async () => {
    const clock = { t: 0 };
    const { lock } = makeLock({ timeout: 60, clock });
    await lock.load();
    await lock.setPin('482913');
    lock.noteBackground(10_000);
    lock.noteForeground(10_000 + 59_000);
    expect(lock.getSnapshot().status).toBe('unlocked');
    lock.noteBackground(100_000);
    lock.noteForeground(100_000 + 60_000);
    expect(lock.getSnapshot()).toMatchObject({ status: 'locked', lockReason: 'timeout' });
  });

  it('timeout 0 locks on every return from the background', async () => {
    const { lock } = makeLock({ timeout: 0 });
    await lock.load();
    await lock.setPin('482913');
    lock.noteBackground(1);
    lock.noteForeground(1);
    expect(lock.getSnapshot().status).toBe('locked');
  });

  it('never locks without a PIN', async () => {
    const { lock } = makeLock({ timeout: 0 });
    await lock.load();
    lock.noteBackground(1);
    lock.noteForeground(5_000);
    lock.lockNow();
    expect(lock.getSnapshot().status).toBe('off');
  });
});

describe('AppLock biometric gating', () => {
  it('is unavailable without a host prompt', async () => {
    const { lock } = makeLock();
    await lock.load();
    await lock.setPin('482913');
    expect(lock.getSnapshot().biometricAvailable).toBe(false);
    expect(await lock.setBiometricEnabled(true)).toMatchObject({ ok: false, reason: 'biometric-unavailable' });
    lock.lockNow();
    expect(await lock.unlockWithBiometric()).toBe(false);
    expect(lock.getSnapshot().status).toBe('locked');
  });

  it('needs a PIN, a successful prompt to turn on, and then unlocks', async () => {
    const answers: boolean[] = [];
    const reasons: string[] = [];
    const biometric = (reason: string): Promise<boolean> => {
      reasons.push(reason);
      return Promise.resolve(answers.shift() ?? false);
    };
    const storage = memorySecureStorage();
    const { lock } = makeLock({ biometric, storage });
    await lock.load();
    expect(await lock.setBiometricEnabled(true)).toMatchObject({ ok: false, reason: 'no-pin' });
    await lock.setPin('482913');

    answers.push(false);
    expect(await lock.setBiometricEnabled(true)).toMatchObject({ ok: false, reason: 'biometric-failed' });
    expect(lock.getSnapshot().biometricEnabled).toBe(false);

    answers.push(true);
    expect(await lock.setBiometricEnabled(true)).toEqual({ ok: true });
    expect(lock.getSnapshot().biometricEnabled).toBe(true);
    expect(JSON.parse(storage.dump().get(APP_LOCK_STORAGE_KEY) ?? '{}')).toMatchObject({ biometric: true });

    lock.lockNow();
    answers.push(false); // cancelled prompt
    expect(await lock.unlockWithBiometric()).toBe(false);
    expect(lock.getSnapshot().status).toBe('locked');
    answers.push(true);
    expect(await lock.unlockWithBiometric()).toBe(true);
    expect(lock.getSnapshot().status).toBe('unlocked');
    expect(reasons).toContain('Turn on biometric unlock');

    // Removing the PIN turns biometrics off with it.
    await lock.removePin('482913');
    expect(lock.getSnapshot()).toMatchObject({ biometricEnabled: false, pinSet: false });
  });

  it('a throwing prompt counts as a failed check', async () => {
    const { lock } = makeLock({ biometric: () => Promise.reject(new Error('cancelled')) });
    await lock.load();
    await lock.setPin('482913');
    expect(await lock.setBiometricEnabled(true)).toMatchObject({ ok: false, reason: 'biometric-failed' });
  });
});

describe('secure storage implementations', () => {
  it('browser preview storage is labelled and prefixed', async () => {
    const backing = new Map<string, string>();
    const local: PreviewKeyValueStorage = {
      getItem: (k) => backing.get(k) ?? null,
      setItem: (k, v) => {
        backing.set(k, v);
      },
      removeItem: (k) => {
        backing.delete(k);
      },
    };
    const storage = browserPreviewSecureStorage(() => local);
    expect(storage.protection).toBe('browser-preview');
    await storage.setItem('a', '1');
    expect([...backing.keys()]).toEqual(['sovereign.mobile.preview-secure.a']);
    expect(await storage.getItem('a')).toBe('1');
    await storage.removeItem('a');
    expect(await storage.getItem('a')).toBeNull();
    const blocked = browserPreviewSecureStorage(() => null);
    await expect(blocked.getItem('a')).rejects.toThrow(/not available/);
  });
});

describe('BackupRecordStore', () => {
  it('records a verifier, never the phrase, and checks a written copy', async () => {
    const storage = memorySecureStorage();
    const words = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
    const store = new BackupRecordStore({ storage, kdf: FAST_KDF, randomBytes: fixedRandom(3), now: () => Date.UTC(2026, 10, 5) });
    await store.load();
    expect(store.getSnapshot()).toEqual({ status: 'none' });
    expect(await store.check(words.join(' '))).toBeNull();

    await store.record('verified-at-creation', words);
    const raw = storage.dump().get(BACKUP_RECORD_STORAGE_KEY) ?? '';
    for (const word of words) expect(raw).not.toContain(word);
    expect(store.getSnapshot()).toMatchObject({
      status: 'recorded',
      record: { kind: 'verified-at-creation', at: '2026-11-05T00:00:00.000Z', lastCheckedAt: null },
    });

    expect(await store.check(words.slice(0, 11).concat('zoo').join(' '))).toBe(false);
    expect(await store.check(`  ${words.join('   ').toUpperCase()} `)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ record: { lastCheckedAt: '2026-11-05T00:00:00.000Z' } });

    const reloaded = new BackupRecordStore({ storage, kdf: FAST_KDF });
    await reloaded.load();
    expect(reloaded.getSnapshot()).toMatchObject({ status: 'recorded' });
    expect(await reloaded.check(words.join(' '))).toBe(true);
  });

  it('normalizes phrases', () => {
    expect(normalizePhrase('  Alpha\n beta   GAMMA ')).toBe('alpha beta gamma');
  });
});
