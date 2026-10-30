/**
 * INTEGRATION TEST — wallet data persistence across a simulated app upgrade,
 * driven end-to-end against the REAL waved daemon (wavelength v0.2.0).
 *
 * Release-blocking acceptance ("Upgrade/uninstall leaves wallet data intact"):
 * 1. Boot "app v1": waved through the same lifecycle engine the Tauri app
 *    uses, against an in-test Esplora stub; create a wallet through the REAL
 *    WavedGatewayClient (the transport the desktop webview runs).
 * 2. Simulate an upgrade: stop the daemon, boot "app v2" (a fresh lifecycle
 *    instance over the SAME data dir — exactly what a new app version does).
 * 3. The wallet must survive: walletState reports `locked` (never `none`,
 *    which would drive the UI into creating a second wallet), and unlock
 *    yields the SAME identity pubkey.
 * 4. Uninstall semantics: the wallet's data dir is the ONLY state. A fresh
 *    data dir behaves like a fresh install (`none`), proving no state leaked
 *    outside the data dir that an uninstall-and-reinstall would lose or keep.
 *
 * Skips when the binary has not been fetched yet
 * (`node scripts/fetch-waved.mjs --triple=<host>` installs it).
 */
import { access, constants, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SidecarLifecycle } from './index.js';
import { createNodeChildProcessRuntime } from './runtimes/node.js';
import type { HealthProbe } from './types.js';
import { WavedGatewayClient } from '@sovereign/wavelength-adapter';

const BINARIES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../apps/desktop/src-tauri/binaries',
);

function hostTriple(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  switch (process.platform) {
    case 'linux':
      return `${arch}-unknown-linux-gnu`;
    case 'darwin':
      return `${arch}-apple-darwin`;
    case 'win32':
      return 'x86_64-pc-windows-msvc';
    default:
      return 'unknown';
  }
}

async function binaryPath(): Promise<string | undefined> {
  const name = process.platform === 'win32' ? `waved-${hostTriple()}.exe` : `waved-${hostTriple()}`;
  const candidate = path.join(BINARIES_DIR, name);
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function livezProbe(port: number): HealthProbe {
  return {
    isAlive: async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/livez`);
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Minimal Esplora stub: the routes waved v0.2.0 actually polls after an
 * unlock (verified on the wire this session). The tip poller needs
 * /blocks/tip/height then /block-height/<tip> → hash, then block header
 * and scripthash queries; empty histories answer them.
 */
class EsploraStub {
  private server: http.Server | undefined;
  readonly requests: string[] = [];

  async start(): Promise<number> {
    const port = await freePort();
    this.server = http.createServer((req, res) => {
      const url = (req.url ?? '').split('?')[0] ?? '';
      this.requests.push(url);
      const text = (body: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (url.endsWith('/blocks/tip/height')) return text('805000');
      if (url.startsWith('/block-height/')) return text('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b');
      if (url.endsWith('/header')) return text(JSON.stringify({ id: '4a5e1e4b', height: 805000, time: 1700000000, previousblockhash: '4a5e1e4b' }));
      if (url.startsWith('/block/')) return text(JSON.stringify({ id: '4a5e1e4b', height: 805000 }));
      if (url.startsWith('/scripthash/')) return text('[]');
      return text('[]');
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    return port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

interface Booted {
  lifecycle: SidecarLifecycle;
  gateway: WavedGatewayClient;
  stop: () => Promise<void>;
}

/** Hex-encode the admin macaroon the daemon mints at startup. */
async function adminMacaroonHex(dataDir: string): Promise<string> {
  const mac = await readFile(path.join(dataDir, 'data', 'regtest', 'admin.macaroon'));
  return Buffer.from(mac).toString('hex');
}

const disposables: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const dispose of disposables.reverse()) await dispose();
});

async function bootApp(waved: string, dataDir: string, esploraUrl: string, label: string): Promise<Booted> {
  const healthPort = await freePort();
  const rpcPort = await freePort();
  const gatewayPort = await freePort();
  const runtime = createNodeChildProcessRuntime(waved, { stdio: 'ignore' });
  const lifecycle = new SidecarLifecycle({
    runtime,
    health: livezProbe(healthPort),
    bootTimeoutMs: 30_000,
    healthPollIntervalMs: 250,
    maxRestarts: 0,
    args: () => [
      `--health.listen=127.0.0.1:${healthPort}`,
      `--rpc.listenaddr=127.0.0.1:${rpcPort}`,
      `--rpc.gateway.listenaddr=127.0.0.1:${gatewayPort}`,
      `--datadir=${dataDir}`,
      '--network=regtest',
      `--wallet.esploraurl=${esploraUrl}`,
    ],
  });
  await lifecycle.start();
  expect(lifecycle.phase, `${label}: sidecar should be live`).toBe('live');
  // The gateway rejects every call without the admin macaroon (verified
  // v0.2.0: "expected 1 macaroon, got 0"), minted at daemon startup.
  const gateway = new WavedGatewayClient({
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    macaroonHex: await adminMacaroonHex(dataDir),
  });
  const stop = async (): Promise<void> => {
    await gateway.dispose();
    await lifecycle.stop();
  };
  disposables.push(stop);
  return { lifecycle, gateway, stop };
}

describe('waved wallet persistence across a simulated upgrade (real daemon)', () => {
  it('keeps the created wallet usable after the daemon is replaced by a new app version', async () => {
    const waved = await binaryPath();
    if (!waved) {
      console.warn('waved binary not installed — skipping persistence integration test');
      return;
    }

    const esplora = new EsploraStub();
    const esploraUrl = `http://127.0.0.1:${await esplora.start()}`;
    disposables.push(() => esplora.stop());

    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'waved-persist-it-'));
    disposables.push(() => rm(dataDir, { recursive: true, force: true }));
    const walletPassword = 'correct horse battery staple';

    // ---- App v1: fresh install, create a wallet through the real gateway.
    const v1 = await bootApp(waved, dataDir, esploraUrl, 'v1 boot');
    const info1 = await v1.gateway.getInfo();
    expect(info1.walletState).toBe('none');

    const created = await v1.gateway.createWallet({ password: walletPassword });
    expect(created.mnemonic).toHaveLength(24);
    const identity1 = created.identityPubKey;
    // 33-byte compressed secp256k1 key: `02` + 32 bytes hex (verified wire shape).
    expect(identity1).toMatch(/^02[0-9a-f]{64}$/);

    // CREATE implies an unlocked session (verified: an unlock call right
    // after create fails `FailedPrecondition: wallet is not locked`); the
    // wallet is immediately READY against the stub Esplora.
    const readyInfo = await v1.gateway.getInfo();
    expect(readyInfo.walletState).toBe('ready');

    await v1.stop();

    // The data dir is where wallet state lives (the sidecar's only writable path).
    const files = await readdir(dataDir, { recursive: true });
    expect(files.some((f) => f.endsWith('.db'))).toBe(true);

    // ---- App v2: an upgraded app boots the daemon over the SAME data dir.
    const v2 = await bootApp(waved, dataDir, esploraUrl, 'v2 boot (upgrade)');
    const info2 = await v2.gateway.getInfo();
    // The wallet EXISTS: 'locked', never 'none' — 'none' would push the UI
    // into onboarding-over-data, the exact failure this test pins.
    expect(info2.walletState).toBe('locked');
    expect(info2.network).toBe('regtest');

    const unlocked = await v2.gateway.unlockWallet({ password: walletPassword });
    expect(unlocked.identityPubKey).toBe(identity1);

    // The gateway serves wallet operations for the restored wallet.
    const balance = await v2.gateway.getWireBalance();
    expect(balance.totalConfirmedSat).toBe(0);
    expect(balance.assetBalances).toEqual([]);

    await v2.stop();

    // ---- Uninstall semantics: with the data dir gone, a new install is new.
    await rm(dataDir, { recursive: true, force: true });
    const freshDir = await mkdtemp(path.join(os.tmpdir(), 'waved-persist-fresh-'));
    disposables.push(() => rm(freshDir, { recursive: true, force: true }));
    const v3 = await bootApp(waved, freshDir, esploraUrl, 'v3 boot (fresh install)');
    const info3 = await v3.gateway.getInfo();
    expect(info3.walletState).toBe('none');
    await v3.stop();

    // The wallet's Esplora traffic flowed only to the app-configured endpoint.
    expect(esplora.requests.some((u) => u.includes('/blocks/tip/height'))).toBe(true);
  }, 120_000);
});
