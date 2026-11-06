import { describe, expect, it } from 'vitest';
import {
  BIOMETRIC_GATE_SERVICE,
  NATIVE_SERVICE_PREFIX,
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

describe('native biometric prompt', () => {
  it('returns false without enrolled biometrics, never prompting', async () => {
    const keychain = new FakeKeychain();
    keychain.biometry = null;
    expect(await createNativeBiometricPrompt(keychain, random)('Unlock')).toBe(false);
    expect(keychain.promptReasons).toEqual([]);
  });

  it('creates the gate on first use, then passes or fails with the prompt', async () => {
    const keychain = new FakeKeychain();
    const prompt = createNativeBiometricPrompt(keychain, random);
    keychain.prompts.push(true);
    expect(await prompt('Turn on biometric unlock')).toBe(true);
    expect(keychain.biometric.has(BIOMETRIC_GATE_SERVICE)).toBe(true);
    keychain.prompts.push(false);
    expect(await prompt('Unlock Sovereign Wallet')).toBe(false);
    expect(keychain.promptReasons).toEqual(['Turn on biometric unlock', 'Unlock Sovereign Wallet']);
  });

  it('recreates an invalidated gate (enrollment changed) and prompts again', async () => {
    const keychain = new FakeKeychain();
    const prompt = createNativeBiometricPrompt(keychain, random);
    keychain.prompts.push(true);
    await prompt('first');
    keychain.biometric.clear(); // iOS drops BIOMETRY_CURRENT_SET items on re-enrollment
    keychain.prompts.push(true);
    expect(await prompt('again')).toBe(true);
  });
});
