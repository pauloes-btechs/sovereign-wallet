import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Mobile test config: React Native screens run headless through
 * react-native-web (aliased over `react-native`) in jsdom. The harness
 * `./simulated-client` export points at a TS source file, which vite
 * transforms directly.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'react-native': 'react-native-web',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
