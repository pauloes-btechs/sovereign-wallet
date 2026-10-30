/**
 * E2E app server: boots the daemon harness (real waved + Esplora stub),
 * then starts vite with a proxy to the daemon's gateway so the browser
 * talks to it SAME-ORIGIN — the waved gateway sends no CORS headers, so a
 * direct cross-origin fetch from :5173 is blocked by the browser.
 *
 * Playwright's webServer runs this script; globalTeardown stops the
 * harness via the PID in the bootstrap file and Playwright stops vite.
 */
import { spawn } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep in sync with bootstrap-path.ts (plain-node scripts cannot import it).
const BOOTSTRAP_FILE = process.env.E2E_BOOTSTRAP_FILE ?? path.join(os.tmpdir(), 'sovereign-e2e-bootstrap.json');

const e2eDir = path.dirname(fileURLToPath(import.meta.url));

const waved = path.resolve(e2eDir, '../src-tauri/binaries', wavedName());
try {
  await access(waved, constants.X_OK);
} catch {
  console.error(`e2e: waved binary not found at ${waved} — run: node scripts/fetch-waved.mjs --triple=<host>`);
  process.exit(1);
}

const harness = spawn(process.execPath, [path.join(e2eDir, 'daemon-harness.mjs'), BOOTSTRAP_FILE], {
  stdio: 'inherit',
});

const deadline = Date.now() + 60_000;
let bootstrap;
for (;;) {
  try {
    bootstrap = JSON.parse(await readFile(BOOTSTRAP_FILE, 'utf8'));
    break;
  } catch {
    if (Date.now() > deadline) throw new Error('daemon harness did not become healthy within 60s');
    if (harness.exitCode !== null) throw new Error(`daemon harness exited early with code ${harness.exitCode}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  stdio: 'inherit',
  env: { ...process.env, E2E_GATEWAY_URL: bootstrap.gatewayUrl },
});

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

function wavedName() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const triple =
    process.platform === 'linux'
      ? `${arch}-unknown-linux-gnu`
      : process.platform === 'darwin'
        ? `${arch}-apple-darwin`
        : 'x86_64-pc-windows-msvc';
  return process.platform === 'win32' ? `waved-${triple}.exe` : `waved-${triple}`;
}
