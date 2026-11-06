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
 * - Biometric prompt: there is no bare "authenticate" call in the keychain
 *   module, so a random token is kept in a separate entry whose access
 *   control requires the currently enrolled biometrics; reading it shows the
 *   system prompt. Success = the token comes back. If enrollment changes, iOS
 *   invalidates that entry: the read finds nothing, the entry is recreated,
 *   and the prompt is shown once more.
 */

import type { SecureStoragePort } from '../flows/platform.js';

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
 * The biometric prompt for `PlatformServices.authenticateBiometric`.
 * Resolves false (never throws) on cancel, failure or no biometrics.
 */
export function createNativeBiometricPrompt(
  adapter: KeychainAdapter,
  random: (n: number) => Uint8Array,
): (reason: string) => Promise<boolean> {
  return async (reason) => {
    try {
      if ((await adapter.biometryType()) === null) return false;
      let value = await adapter.getBiometricItem(BIOMETRIC_GATE_SERVICE, reason);
      if (value === null) {
        // First use, or iOS invalidated the entry after an enrollment change.
        await adapter.removeItem(BIOMETRIC_GATE_SERVICE);
        const created = await adapter.setBiometricItem(BIOMETRIC_GATE_SERVICE, gateToken(random), reason);
        if (!created) return false;
        value = await adapter.getBiometricItem(BIOMETRIC_GATE_SERVICE, reason);
      }
      return value !== null && value.length > 0;
    } catch {
      return false;
    }
  };
}
