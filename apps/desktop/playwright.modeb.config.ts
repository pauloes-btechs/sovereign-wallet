import { defineConfig } from '@playwright/test';
import { MODEB_BOOTSTRAP_FILE } from './e2e/modeb/bootstrap-path.js';

/**
 * Desktop Mode B e2e. The REAL chain runs for the whole invocation: the
 * compose regtest stack (bitcoind + 2×LND + litd, booted by CI or locally),
 * a fresh litd sidecar binary launched by the REAL bridge process
 * (daemon-harness.mjs, spawned by start-app.mjs, killed by globalTeardown
 * via the PID recorded in the bootstrap file), and the vite dev server in
 * plain-browser mode on port 5174, proxying /modeb to the loopback bridge —
 * the SAME session code the packaged app runs, minus the Tauri shell.
 *
 * Run: pnpm --filter @sovereign/desktop test:e2e:modeb
 * Precondition: docker compose -f harness/regtest/docker-compose.yml up -d --wait
 * (the daemon harness seeds chain + node wallets itself).
 */

/** Rendezvous path lives in e2e/modeb/bootstrap-path.ts. */
export { MODEB_BOOTSTRAP_FILE };

export default defineConfig({
  testDir: './e2e/modeb',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  globalSetup: './e2e/modeb/global-setup.ts',
  globalTeardown: './e2e/modeb/global-teardown.ts',
  // One worker, ordered tests: the flows share one wallet and one channel.
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/modeb/start-app.mjs',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 360_000,
  },
});
