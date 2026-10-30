import { defineConfig } from '@playwright/test';
import { BOOTSTRAP_FILE } from './e2e/bootstrap-path.js';

/**
 * Desktop Mode A e2e. The REAL waved sidecar runs for the whole invocation
 * (daemon-harness.mjs, spawned by globalSetup, killed by globalTeardown via
 * the PID recorded in the bootstrap file); the app under test is the vite
 * dev server in plain-browser mode, pointed at the sidecar's loopback
 * gateway via URL params — the SAME session code the packaged app runs,
 * minus the Tauri shell.
 */

/** Rendezvous path lives in e2e/bootstrap-path.ts — shared by setup,
 *  teardown, and the specs. */
export { BOOTSTRAP_FILE };

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/start-app.mjs',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
});
