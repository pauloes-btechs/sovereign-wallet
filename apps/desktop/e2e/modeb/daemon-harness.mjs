/**
 * Mode B e2e daemon harness.
 *
 * Boots the REAL regtest stack (compose containers via bootstrapHarness),
 * then launches the REAL bridge process (`litd-adapter/dist/bridge/main.js`)
 * in --launch mode: the bridge itself spawns a fresh litd sidecar binary in
 * Neutrino mode against the harness btcd filter server. This is the exact
 * process chain the packaged desktop app runs, minus the Tauri shell.
 *
 * Rendezvous: writes the Mode B bootstrap JSON (bridge URL + token + peer
 * identity + own PID) for the Playwright config, specs, and teardown.
 *
 * Preconditions:
 * - compose stack up (CI boots it; locally: docker compose -f
 *   harness/regtest/docker-compose.yml up -d --wait)
 * - adapter built (pnpm build) and litd sidecar fetched (pnpm sidecar:fetch)
 * - SOVEREIGN_BTCD_BIN set when btcd is not on PATH (CI passes go env GOPATH)
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
// modeb → e2e → desktop → apps → repo root. Four ups — three lands in apps/.
const repoRoot = path.resolve(e2eDir, '../../../..');

// Keep in sync with bootstrap-path.ts (plain-node script cannot import it).
const MODEB_BOOTSTRAP_FILE =
  process.env.E2E_MODEB_BOOTSTRAP_FILE ?? path.join(os.tmpdir(), 'sovereign-modeb-e2e-bootstrap.json');

const BRIDGE_PORT = 8791;
const BOOTSTRAP_DEADLINE_MS = 180_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(message) {
  process.stderr.write(`modeb-harness: ${message}\n`);
  process.exit(1);
}

// The harness CLI (built by the workspace build) does two things this
// sidecar needs: it starts the host-side btcd BIP157 filter server (Neutrino
// cannot sync from bitcoind directly) and bootstraps the regtest chain +
// node wallets. The CLI exits after bootstrap; btcd stays alive detached.
const HARNESS_CLI = path.join(repoRoot, 'harness/regtest/dist/cli.js');
if (!existsSync(HARNESS_CLI)) {
  fail(`harness CLI not built at ${HARNESS_CLI} — run: pnpm build`);
}

process.stderr.write('modeb-harness: booting regtest harness (btcd + seed + node wallets)\n');
// btcd is started once per job: the CI seed step (and any local bootstrap)
// leaves a detached filter server listening on 18555. A second CLI run with
// SOVEREIGN_BTCD_BIN set spawns a duplicate btcd that dies on the busy port
// and fails the bootstrap — so probe first and only hand the CLI the binary
// when no server is listening. Without the env var the CLI assumes a running
// filter server, which is exactly the reuse case.
function filterServerReachable(port, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
// Keep in sync with harness.ts BTCD_FILTER_PORT (plain .mjs cannot import it).
const BTCD_FILTER_PORT = 18555;
const cliEnv = { ...process.env };
if (await filterServerReachable(BTCD_FILTER_PORT)) {
  delete cliEnv.SOVEREIGN_BTCD_BIN;
  process.stderr.write('modeb-harness: filter server already listening — reusing it\n');
}
try {
  execFileSync(process.execPath, [HARNESS_CLI], { stdio: 'inherit', timeout: 300_000, env: cliEnv });
} catch (err) {
  fail(`harness bootstrap failed: ${err}`);
}
const { getNodeInfo, ALICE } = await import('@sovereign/harness-regtest');
const alice = await getNodeInfo(ALICE);

const litdBinary =
  process.env.SOVEREIGN_LITD_BIN ??
  path.join(repoRoot, 'apps/desktop/src-tauri/binaries/litd-x86_64-unknown-linux-gnu');
if (!existsSync(litdBinary)) {
  fail(`litd sidecar binary not found at ${litdBinary} — run: pnpm sidecar:fetch`);
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sovereign-modeb-e2e-'));
const bridgeBootstrapPath = path.join(dataDir, 'bridge-bootstrap.json');
const bridge = spawn(
  process.execPath,
  [
    path.join(repoRoot, 'services/litd-adapter/dist/bridge/main.js'),
    '--launch',
    `--litdBinary=${litdBinary}`,
    `--dataDir=${dataDir}`,
    '--backend=neutrino',
    // Harness btcd (BIP157 filter server) published on loopback.
    '--peer=127.0.0.1:18555',
    `--port=${BRIDGE_PORT}`,
    `--bootstrap=${bridgeBootstrapPath}`,
  ],
  { stdio: 'inherit' },
);
bridge.on('exit', (code) => {
  if (code !== null && code !== 0 && code !== 143) {
    process.stderr.write(`modeb-harness: bridge exited early with code ${code}\n`);
  }
});

let bridgeBootstrap;
{
  const deadline = Date.now() + BOOTSTRAP_DEADLINE_MS;
  for (;;) {
    try {
      bridgeBootstrap = JSON.parse(readFileSync(bridgeBootstrapPath, 'utf8'));
      break;
    } catch {
      if (bridge.exitCode !== null) {
        fail(`bridge process exited with code ${bridge.exitCode} before writing its bootstrap`);
      }
      if (Date.now() > deadline) fail('bridge did not write its bootstrap within 180s');
      await sleep(500);
    }
  }
}

const bridgeUrl = `http://127.0.0.1:${bridgeBootstrap.bridgePort}`;
const bridgeToken = bridgeBootstrap.token;

// The bridge is listening; wait for the wallet-phase probe to answer (the
// fresh sidecar's TLS cert and RPC are settling during the first seconds).
{
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await fetch(`${bridgeUrl}/state`, {
        headers: { authorization: `Bearer ${bridgeToken}` },
      });
      if (response.ok) {
        const state = (await response.json()) ?? {};
        process.stderr.write(`modeb-harness: bridge ready (phase: ${state.phase ?? '?'})\n`);
        break;
      }
      process.stderr.write(`modeb-harness: /state returned ${response.status}\n`);
    } catch (err) {
      process.stderr.write(`modeb-harness: /state probe failed: ${err}\n`);
    }
    if (Date.now() > deadline) fail('bridge /state never answered within 120s');
    await sleep(1000);
  }
}

writeFileSync(
  MODEB_BOOTSTRAP_FILE,
  JSON.stringify({
    bridgeUrl,
    bridgeToken,
    peerPubkey: alice.identityPubkey,
    // The sidecar runs host-side; it dials alice's published P2P on loopback.
    peerHost: '127.0.0.1:19735',
    dataDir,
    pid: process.pid,
  }),
);
process.stderr.write(`modeb-harness: bootstrap written to ${MODEB_BOOTSTRAP_FILE}\n`);

function die(signal) {
  if (bridge.exitCode === null) bridge.kill(signal);
}
process.on('SIGTERM', () => die('SIGTERM'));
process.on('SIGINT', () => die('SIGINT'));

// Keep this process alive; start-app.mjs / teardown SIGTERM it.
setInterval(() => {}, 60_000);
