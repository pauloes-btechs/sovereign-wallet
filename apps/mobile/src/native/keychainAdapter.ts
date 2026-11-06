/**
 * The one place that imports `react-native-keychain` (native builds only —
 * reached from index.js through NativeRoot; the web preview and tests never
 * import it). Maps the small `KeychainAdapter` onto the module with the
 * strictest options that still allow the app to read its own items:
 *
 * - plain items: `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (iOS), Keystore AES-GCM
 *   (Android), no iCloud sync;
 * - the biometric gate: `BIOMETRY_CURRENT_SET` access control (iOS) and
 *   Keystore AES-GCM with user authentication (Android).
 */

import * as Keychain from 'react-native-keychain';
import type { KeychainAdapter } from './secureStorage.js';

const plainItem = {
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
  cloudSync: false,
} as const;

function promptFor(reason: string): Keychain.AuthenticationPrompt {
  return { title: reason, cancel: 'Use PIN' };
}

export const reactNativeKeychainAdapter: KeychainAdapter = {
  async setItem(service, account, value) {
    const result = await Keychain.setGenericPassword(account, value, { ...plainItem, service });
    return result !== false;
  },
  async getItem(service) {
    const result = await Keychain.getGenericPassword({ service });
    return result === false ? null : result.password;
  },
  async removeItem(service) {
    await Keychain.resetGenericPassword({ service });
  },
  async setBiometricItem(service, value, prompt) {
    const result = await Keychain.setGenericPassword('biometric-gate', value, {
      service,
      accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
      storage: Keychain.STORAGE_TYPE.AES_GCM,
      cloudSync: false,
      authenticationPrompt: promptFor(prompt),
    });
    return result !== false;
  },
  async getBiometricItem(service, prompt) {
    const result = await Keychain.getGenericPassword({
      service,
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
      authenticationPrompt: promptFor(prompt),
    });
    return result === false ? null : result.password;
  },
  async biometryType() {
    const type = await Keychain.getSupportedBiometryType();
    return type === null ? null : String(type);
  },
};
