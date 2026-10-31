/**
 * Mode B e2e app server: boots the daemon harness (compose regtest stack +
 * real litd sidecar via the bridge), then starts vite on port 5174 with a
 * same-origin proxy to the bridge (/modeb) — the bridge sends no CORS
 * headers, so a direct cross-origin fetch from the app would be blocked.
 *
 * Playwright's webServer runs this script; globalTeardown stops the harness
 * via the PID in the bootstrap file and Playwright stops vite.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep in sync with bootstrap-path.ts (plain-node script cannot import it).
const MODEB_BOOTSTRAP_FILE =
  process.env.E2E_MODEB_BOOTSTRAP_FILE ?? path.join(os.tmpdir(), 'sovereign-modeb-e2e-bootstrap.json');

const e2eDir = path.dirname(fileURLToPath(import.meta.url));

const harness = spawn(process.execPath, [path.join(e2eDir, 'daemon-harness.mjs')], {
  stdio: 'inherit',
});

let _bootstrap;
const deadline = Date.now() + 300_000;
for (;;) {
  try {
    _bootstrap = JSON.parse(readFileSync(MODEB_BOOTSTRAP_FILE, 'utf8'));
    break;
  } catch {
    if (harness.exitCode !== null) throw new Error(`daemon harness exited early with code ${harness.exitCode}`);
    if (Date.now() > deadline) throw new Error('modeb daemon harness did not become healthy within 300s');
    await new Promise((r) => setTimeout(r, 500));
  }
}

const vite = spawn(
  'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', '5174', '--strictPort'],
  {
    stdio: 'inherit',
    // The vite config turns this into the same-origin /modeb proxy.
    env: { ...process.env, E2E_MODEB_BRIDGE_URL: 'http://127.0.0.1:8791' },
  },
);

function die(signal) {
  if (harness.exitCode === null) harness.kill(signal);
  if (vite.exitCode === null) vite.kill(signal);
}
process.on('SIGTERM', () => die('SIGTERM'));
process.on('SIGINT', () => die('SIGINT'));
for (const child of [harness, vite]) {
  child.on('exit', (code) => {
    if (code !== null && code !== 0) process.exitCode = code;
  });
}

// Keep this process alive; Playwright SIGTERMs the webServer when done.
setInterval(() => {}, 60_000);
