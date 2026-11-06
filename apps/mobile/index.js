/**
 * RN entry point — registered by the native shells (apps/mobile/ios,
 * apps/mobile/android). `NativeRoot` wraps the shared `App` with the device
 * services implemented in src/native (Keychain/Keystore storage, biometric
 * prompt). The web preview mounts `App` directly and never loads src/native.
 */
import { AppRegistry } from 'react-native';
import { name as appName } from './app.json';
import NativeRoot from './src/native/NativeRoot';

AppRegistry.registerComponent(appName, () => NativeRoot);
