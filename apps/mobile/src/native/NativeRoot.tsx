/**
 * Native root — what index.js registers on iOS and Android. It wraps the
 * shared `App` entry with the device services implemented in this folder
 * (Keychain/Keystore storage and the biometric prompt), so the lock and
 * security screens run on the real keystore. The web preview imports `App`
 * directly and never loads this file or react-native-keychain.
 *
 * Services the host passes in `platform` win over these, so a native shell
 * can still override any of them.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import App from '../App.js';
import type { NativeAppProps } from '../App.js';
import { defaultRandomBytes } from '../flows/appLock.js';
import type { PlatformServices } from '../flows/platform.js';
import { reactNativeKeychainAdapter } from './keychainAdapter.js';
import { createNativeBiometricPrompt, createNativeSecureStorage } from './secureStorage.js';

export function createNativePlatformServices(): PlatformServices {
  return {
    secureStorage: createNativeSecureStorage(reactNativeKeychainAdapter),
    authenticateBiometric: createNativeBiometricPrompt(reactNativeKeychainAdapter, defaultRandomBytes),
  };
}

export default function NativeRoot(props: NativeAppProps): ReactNode {
  const platform = useMemo<PlatformServices>(
    () => ({ ...createNativePlatformServices(), ...props.platform }),
    [props.platform],
  );
  return <App {...props} platform={platform} />;
}
