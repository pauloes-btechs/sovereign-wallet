import { describe, expect, it } from 'vitest';
import { APP_LOCK_STORAGE_KEY, AppLock } from '../flows/appLock.js';
import {
  BIOMETRIC_GATE_SERVICE,
  NATIVE_SERVICE_PREFIX,
  createNativeBiometricGate,
  createNativeBiometricPrompt,
  createNativeSecureStorage,
} from './secureStorage.js';
import type { KeychainAdapter } from './secureStorage.js';

class FakeKeychain implements KeychainAdapter {
  readonly plain = new Map<string, string>();
  readonly biometric = new Map<string, string>();
  biometry: string | null = 'FaceID';
  /** Next prompt outcomes: true = pass, false = cancel (rejects). */
  readonly prompts: boolean[] = [];
  readonly promptReasons: string[] = [];
  refuseWrites = false;

  setItem(service: string, _account: string, value: string): Promise<boolean> {
    if (this.refuseWrites) return Promise.resolve(false);
    this.plain.set(service, value);
    return Promise.resolve(true);
  }
  getItem(service: string): Promise<string | null> {
    return Promise.resolve(this.plain.get(service) ?? null);
  }
  removeItem(service: string): Promise<void> {
    this.plain.delete(service);
    this.biometric.delete(service);
    return Promise.resolve();
  }
  setBiometricItem(service: string, value: string): Promise<boolean> {
    this.biometric.set(service, value);
    return Promise.resolve(true);
  }
  getBiometricItem(service: string, prompt: string): Promise<string | null> {
    const value = this.biometric.get(service);
    if (value === undefined) return Promise.resolve(null);
    this.promptReasons.push(prompt);
    const pass = this.prompts.shift() ?? false;
    return pass ? Promise.resolve(value) : Promise.reject(new Error('User canceled'));
  }
  biometryType(): Promise<string | null> {
    return Promise.resolve(this.biometry);
  }
}

const random = (n: number): Uint8Array => new Uint8Array(n).fill(9);

describe('native secure storage', () => {
  it('stores each key in its own keystore service and reports device-keystore protection', async () => {
    const keychain = new FakeKeychain();
    const storage = createNativeSecureStorage(keychain);
    expect(storage.protection).toBe('device-keystore');
    await storage.setItem('sovereign.app-lock.v1', '{"x":1}');
    expect(keychain.plain.get(`${NATIVE_SERVICE_PREFIX}sovereign.app-lock.v1`)).toBe('{"x":1}');
    expect(await storage.getItem('sovereign.app-lock.v1')).toBe('{"x":1}');
    expect(await storage.getItem('missing')).toBeNull();
    await storage.removeItem('sovereign.app-lock.v1');
    expect(await storage.getItem('sovereign.app-lock.v1')).toBeNull();
  });

  it('throws when the keystore refuses a write', async () => {
    const keychain = new FakeKeychain();
    keychain.refuseWrites = true;
    await expect(createNativeSecureStorage(keychain).setItem('a', 'b')).rejects.toThrow(/refused/);
  });
});

describe('native biometric gate', () => {
  it('fails without enrolled biometrics, never prompting', async () => {
    const keychain = new FakeKeychain();
    keychain.biometry = null;
    const gate = createNativeBiometricGate(keychain, random);
    expect(await gate.create('Turn on biometric unlock')).toBe(false);
    expect(await gate.verify('Unlock')).toBe('failed');
    expect(await createNativeBiometricPrompt(gate)('Unlock')).toBe(false);
    expect(keychain.promptReasons).toEqual([]);
  });

  it('create makes the gate and checks it once; verify then passes or fails with the prompt', async () => {
    const keychain = new FakeKeychain();
    const gate = createNativeBiometricGate(keychain, random);
    keychain.prompts.push(true);
    expect(await gate.create('Turn on biometric unlock')).toBe(true);
    expect(keychain.biometric.has(BIOMETRIC_GATE_SERVICE)).toBe(true);
    keychain.prompts.push(false);
    expect(await gate.verify('Unlock Sovereign Wallet')).toBe('failed');
    keychain.prompts.push(true);
    expect(await createNativeBiometricPrompt(gate)('Authorize')).toBe(true);
    expect(keychain.promptReasons).toEqual(['Turn on biometric unlock', 'Unlock Sovereign Wallet', 'Authorize']);
  });

  it('never re-creates an invalidated gate: a changed enrollment reports gate-missing (no PIN bypass)', async () => {
    const keychain = new FakeKeychain();
    const gate = createNativeBiometricGate(keychain, random);
    keychain.prompts.push(true);
    await gate.create('first');
    keychain.biometric.clear(); // iOS drops BIOMETRY_CURRENT_SET items on re-enrollment
    keychain.prompts.push(true, true); // a newly enrolled finger would pass any prompt
    expect(await gate.verify('again')).toBe('gate-missing');
    expect(await createNativeBiometricPrompt(gate)('authorize')).toBe(false);
    expect(keychain.biometric.has(BIOMETRIC_GATE_SERVICE)).toBe(false);
  });

  it('a prompt on a never-created gate does not create one', async () => {
    const keychain = new FakeKeychain();
    const gate = createNativeBiometricGate(keychain, random);
    keychain.prompts.push(true);
    expect(await createNativeBiometricPrompt(gate)('Unlock')).toBe(false);
    expect(keychain.biometric.size).toBe(0);
  });

  it('remove deletes the gate', async () => {
    const keychain = new FakeKeychain();
    const gate = createNativeBiometricGate(keychain, random);
    keychain.prompts.push(true);
    await gate.create('on');
    await gate.remove();
    expect(keychain.biometric.size).toBe(0);
  });
});

describe('app lock over the native gate', () => {
  const FAST_KDF = { algorithm: 'scrypt' as const, N: 16, r: 1, p: 1, dkLen: 32 };

  it('an enrollment change turns biometric unlock off (persisted) and requires the PIN', async () => {
    const keychain = new FakeKeychain();
    const storage = createNativeSecureStorage(keychain);
    const make = (): AppLock =>
      new AppLock({
        storage,
        biometricGate: createNativeBiometricGate(keychain, random),
        lockTimeoutSeconds: () => 0,
        kdf: FAST_KDF,
      });
    const lock = make();
    await lock.load();
    await lock.setPin('482913');
    expect(await lock.setBiometricEnabled(true)).toMatchObject({ ok: false, reason: 'invalid-pin' });
    keychain.prompts.push(true);
    expect(await lock.setBiometricEnabled(true, '482913')).toEqual({ ok: true });
    expect(JSON.parse((await storage.getItem(APP_LOCK_STORAGE_KEY)) ?? '{}')).toMatchObject({ biometric: true, biometricGate: true });

    lock.lockNow();
    keychain.prompts.push(true);
    expect(await lock.unlockWithBiometric()).toBe(true);

    // Someone adds their finger: the OS invalidates the gate.
    lock.lockNow();
    keychain.biometric.clear();
    keychain.prompts.push(true, true);
    expect(await lock.unlockWithBiometric()).toBe(false);
    expect(lock.getSnapshot()).toMatchObject({ status: 'locked', biometricEnabled: false });
    expect(lock.getSnapshot().error).toMatch(/turned off/);
    expect(keychain.biometric.has(BIOMETRIC_GATE_SERVICE)).toBe(false); // not re-created
    expect(JSON.parse((await storage.getItem(APP_LOCK_STORAGE_KEY)) ?? '{}')).toMatchObject({ biometric: false, biometricGate: false });

    // A restart keeps it off; the PIN unlocks.
    const restarted = make();
    await restarted.load();
    expect(await restarted.unlockWithBiometric()).toBe(false);
    expect(keychain.biometric.size).toBe(0);
    expect(await restarted.unlockWithPin('482913')).toEqual({ ok: true });
  });

  it('a record that says biometric is on without a created gate needs it turned on again', async () => {
    const keychain = new FakeKeychain();
    const storage = createNativeSecureStorage(keychain);
    const plain = new AppLock({ storage, lockTimeoutSeconds: () => 0, kdf: FAST_KDF, authenticateBiometric: () => Promise.resolve(true) });
    await plain.load();
    await plain.setPin('482913');
    await plain.setBiometricEnabled(true, '482913'); // record: biometric on, no gate
    const native = new AppLock({ storage, biometricGate: createNativeBiometricGate(keychain, random), lockTimeoutSeconds: () => 0, kdf: FAST_KDF });
    await native.load();
    keychain.prompts.push(true);
    expect(await native.unlockWithBiometric()).toBe(false);
    expect(native.getSnapshot().biometricEnabled).toBe(false);
    expect(keychain.biometric.size).toBe(0);
  });
});
