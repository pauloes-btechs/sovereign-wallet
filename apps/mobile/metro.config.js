const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration (React Native bundler).
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
