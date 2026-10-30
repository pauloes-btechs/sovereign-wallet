import { defineConfig } from 'vitest/config';

/**
 * Root test runner used by CI (`pnpm test`). Two projects:
 *
 *  - node: every package test that runs in plain Node (the historical root
 *    behavior — wallet-core, payments, ui copy, adapter, harness, desktop).
 *  - mobile: the React Native screen tests, which need the package's own
 *    config (react-native-web alias + jsdom) and would otherwise be picked
 *    up here without it.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          environment: 'node',
          include: ['**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**', 'apps/mobile/**'],
        },
      },
      './apps/mobile/vitest.config.ts',
    ],
  },
});
