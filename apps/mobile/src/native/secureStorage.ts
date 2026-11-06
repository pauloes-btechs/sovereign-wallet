/**
 * Native secure storage and biometric prompt over a small keychain adapter.
 *
 * The adapter (`keychainAdapter.ts`) is the only file that imports
 * `react-native-keychain`; this file holds the logic and is unit-tested with
 * a fake adapter. The web preview never imports anything under src/native.
 *
 * - Items: one Keychain (iOS) / Keystore-encrypted (Android) entry per key,
 *   service `sovereign.secure.<key>`, accessible only while the device is
 *   unlocked and never migrated to another device or backup.
 * - Biometric gate: there is no bare "authenticate" call in the keychain
 *   module, so a random token is kept in a separate entry whose access
 *   control requires the currently enrolled biometrics; reading it shows the
 *   system prompt. Success = the token comes back.
 * - The gate is created ONLY by `BiometricGate.create`, which the app lock
 *   calls after the app PIN was entered (turning biometric unlock on). A
 *   prompt never re-creates it: if biometric enrollment changes, iOS
 *   invalidates the entry and `verify` reports `gate-missing`; the app lock
 *   then turns biometric unlock off and asks for the PIN. Re-creating the
 *   entry on the fly would let a newly enrolled finger or face — anyone who
 *   can add one to the phone — unlock the wallet without the PIN.
 */

import type { BiometricCheck, BiometricGate, SecureStoragePort } from '../flows/platform.js';

export const NATIVE_SERVICE_PREFIX = 'sovereign.secure.';
export const BIOMETRIC_GATE_SERVICE = 'sovereign.biometric-gate';

/** What this file needs from the keychain module; built from the real one in keychainAdapter.ts. */
export interface KeychainAdapter {
  /** Stores a plain item (no user-presence prompt). */
  setItem(service: string, account: string, value: string): Promise<boolean>;
  /** Reads a plain item; null when absent. */
  getItem(service: string): Promise<string | null>;
  removeItem(service: string): Promise<void>;
  /** Stores an item that needs the enrolled biometrics to read (Android may prompt here too). */
  setBiometricItem(service: string, value: string, prompt: string): Promise<boolean>;
  /** Reads a biometric item, showing the system prompt. Null when absent; rejects on cancel/failure. */
  getBiometricItem(service: string, prompt: string): Promise<string | null>;
  /** The kind of biometrics the device offers; null when none are enrolled or supported. */
  biometryType(): Promise<string | null>;
}

export function createNativeSecureStorage(adapter: KeychainAdapter): SecureStoragePort {
  return {
    protection: 'device-keystore',
    getItem: (key) => adapter.getItem(NATIVE_SERVICE_PREFIX + key),
    setItem: async (key, value) => {
      const stored = await adapter.setItem(NATIVE_SERVICE_PREFIX + key, key, value);
      if (!stored) throw new Error('The device keystore refused to store the item.');
    },
    removeItem: (key) => adapter.removeItem(NATIVE_SERVICE_PREFIX + key),
  };
}

/** Hex token for the biometric gate (not a secret — possession proves nothing by itself). */
function gateToken(random: (n: number) => Uint8Array): string {
  return [...random(16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The biometric gate for `PlatformServices.biometricGate`. Never throws:
 * cancel, failure and missing biometrics are results.
 */
export function createNativeBiometricGate(
  adapter: KeychainAdapter,
  random: (n: number) => Uint8Array,
): BiometricGate {
  const verify = async (reason: string): Promise<BiometricCheck> => {
    try {
      if ((await adapter.biometryType()) === null) return 'failed';
      const value = await adapter.getBiometricItem(BIOMETRIC_GATE_SERVICE, reason);
      // Absent: never created, or invalidated by an enrollment change. Not re-created here.
      if (value === null) return 'gate-missing';
      return value.length > 0 ? 'passed' : 'failed';
    } catch {
      return 'failed';
    }
  };
  return {
    create: async (reason) => {
      try {
        if ((await adapter.biometryType()) === null) return false;
        await adapter.removeItem(BIOMETRIC_GATE_SERVICE);
        const created = await adapter.setBiometricItem(BIOMETRIC_GATE_SERVICE, gateToken(random), reason);
        if (!created) return false;
        return (await verify(reason)) === 'passed';
      } catch {
        return false;
      }
    },
    verify,
    remove: async () => {
      try {
        await adapter.removeItem(BIOMETRIC_GATE_SERVICE);
      } catch {
        // Nothing to undo: a leftover gate is unusable without the lock record saying so.
      }
    },
  };
}

/**
 * The plain biometric prompt for `PlatformServices.authenticateBiometric`
 * (e.g. authorizing a transfer): passes only against an existing gate and
 * never creates one. Resolves false (never throws) otherwise.
 */
export function createNativeBiometricPrompt(gate: BiometricGate): (reason: string) => Promise<boolean> {
  return async (reason) => (await gate.verify(reason)) === 'passed';
}
