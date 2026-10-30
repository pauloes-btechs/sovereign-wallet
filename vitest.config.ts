import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * This config belongs to the repo root's `pnpm test` (what CI runs there).
 * Vitest resolves configs by walking up from the invoking cwd, so a package
 * without its own config (e.g. CI's waved integration job running inside
 * packages/daemon-lifecycle) would otherwise adopt this file — including the
 * mobile project, whose workspace imports need dist/ builds that job does not
 * perform. Only apply the projects layout when actually invoked at the root;
 * everywhere else, hand back the stock defaults those invocations always had.
 */
const configDir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const invokedAtRoot = process.cwd().replace(/\/$/, '') === configDir;

/**
 * Root test runner used by CI (`pnpm test`). Two projects:
 *
 *  - node: every package test that runs in plain Node (the historical root
 *    behavior — wallet-core, payments, ui copy, adapter, harness, desktop).
 *    Integration suites (services/litd-adapter/src/integration/**) are
 *    excluded: they need the Docker regtest harness and run via
 *    `pnpm test:integration` (locally and in CI).
 *  - mobile: the React Native screen tests, which need the package's own
 *    config (react-native-web alias + jsdom) and would otherwise be picked
 *    up here without it.
 */
export default defineConfig({
  test: invokedAtRoot
    ? {
        projects: [
          {
            test: {
              environment: 'node',
              include: ['**/*.test.{ts,tsx}'],
              exclude: [
                '**/node_modules/**',
                '**/dist/**',
                'apps/mobile/**',
                '**/src/integration/**',
              ],
            },
          },
          // Anchored to this file's location: vitest walks up from a package
          // cwd (e.g. CI running tests inside packages/daemon-lifecycle) and
          // resolves project paths against that cwd, not this config.
          fileURLToPath(new URL('./apps/mobile/vitest.config.ts', import.meta.url)),
        ],
      }
    : {},
});
