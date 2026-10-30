/**
 * E2E daemon harness: boots the REAL waved v0.2.0 sidecar against an
 * in-process Esplora stub, then publishes the gateway bootstrap for the
 * Playwright session (?devGateway=&devMacaroonHex=).
 *
 * Runs for the whole test invocation (spawned by playwright globalSetup,
 * killed by globalTeardown). On exit it stops the daemon child.
 *
 * Writes a JSON file (path = argv[2]) with:
 *   { "gatewayUrl": "http://127.0.0.1:PORT", "macaroonHex": "…", "dataDir": "…" }
 */
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BINARIES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src-tauri/binaries',
);

function hostTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  switch (process.platform) {
    case 'linux':
      return `${arch}-unknown-linux-gnu`;
    case 'darwin':
      return `${arch}-apple-darwin`;
    case 'win32':
      return 'x86_64-pc-windows-msvc';
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

async function wavedPath() {
  const name = process.platform === 'win32' ? `waved-${hostTriple()}.exe` : `waved-${hostTriple()}`;
  return path.join(BINARIES_DIR, name);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** Minimal Esplora stub: tip/height/header/block/scripthash — the routes the
 *  real daemon needs to sync regtest genesis (verified against waved v0.2.0). */
function startEsploraStub(port) {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const text = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.endsWith('/blocks/tip/height')) return text('805000');
    if (url.startsWith('/block-height/'))
      return text('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b');
    if (url.endsWith('/header'))
      return text(JSON.stringify({ id: '4a5e1e4b', height: 805000, time: 1700000000, previousblockhash: '4a5e1e4b' }));
    if (url.startsWith('/block/')) return text(JSON.stringify({ id: '4a5e1e4b', height: 805000 }));
    if (url.startsWith('/scripthash/')) return text('[]');
    return text('[]');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function waitHealthy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/livez`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waved /livez never became healthy within ${timeoutMs}ms`);
}

const waved = await wavedPath();
if (!(await readFile(waved).then(() => true).catch(() => false))) {
  console.error(`e2e harness: waved binary not found at ${waved} — run node scripts/fetch-waved.mjs --triple=<host>`);
  process.exit(1);
}

const esploraPort = await freePort();
const healthPort = await freePort();
const rpcPort = await freePort();
const gatewayPort = await freePort();
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sovereign-e2e-daemon-'));

const esploraServer = await startEsploraStub(esploraPort);

let daemon = null;
let exiting = false;

function startDaemon() {
  daemon = spawn(
    waved,
    [
      `--health.listen=127.0.0.1:${healthPort}`,
      `--rpc.listenaddr=127.0.0.1:${rpcPort}`,
      `--rpc.gateway.listenaddr=127.0.0.1:${gatewayPort}`,
      `--rpc.gateway.allowedorigins=http://127.0.0.1:5173`,
      `--datadir=${dataDir}`,
      '--network=regtest',
      `--wallet.esploraurl=http://127.0.0.1:${esploraPort}`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
}

async function shutdown() {
  if (exiting) return;
  exiting = true;
  if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => esploraServer.close(r));
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startDaemon();
await waitHealthy(healthPort, 30_000);

// The gateway starts listening before the admin macaroon is minted —
// poll for it instead of racing the daemon's startup order.
const macaroonPath = path.join(dataDir, 'data', 'regtest', 'admin.macaroon');
const macaroonDeadline = Date.now() + 30_000;
let macaroonHex;
for (;;) {
  try {
    macaroonHex = (await readFile(macaroonPath)).toString('hex');
    break;
  } catch (err) {
    if (Date.now() > macaroonDeadline) throw err;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const bootstrapPath = process.argv[2];
await writeFile(
  bootstrapPath,
  JSON.stringify({
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    macaroonHex,
    dataDir,
    pid: process.pid,
  }),
);

console.log(`e2e harness: waved live — gateway http://127.0.0.1:${gatewayPort}, bootstrap at ${bootstrapPath}`);

// Restart the daemon on unexpected exit so a crashed sidecar doesn't wedge
// the suite — the SAME data dir, mirroring what the Tauri lifecycle does.
daemon.on('exit', (code) => {
  if (exiting) return;
  console.error(`e2e harness: waved exited with ${code}; restarting on the same data dir`);
  setTimeout(() => {
    if (!exiting) startDaemon();
  }, 500);
});

setInterval(() => {}, 60_000); // keep the event loop alive; SIGTERM ends everything
