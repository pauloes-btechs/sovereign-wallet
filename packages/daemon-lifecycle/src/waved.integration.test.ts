/**
 * INTEGRATION TEST against the REAL waved daemon (wavelength v0.2.0).
 *
 * This is the CI-runnable core of the Mode A sidecar proof: the pinned
 * upstream binary is booted through the same lifecycle engine the Tauri
 * app uses, health-gated on /livez, observed pre-init on /readyz, and
 * stopped cleanly. Skips when the binary has not been fetched yet
 * (`node scripts/fetch-waved.mjs --triple=<host>` installs it).
 */
import { access, constants } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SidecarLifecycle } from './index.js';
import { createNodeChildProcessRuntime } from './runtimes/node.js';
import type { HealthProbe } from './types.js';

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
  const name =
    process.platform === 'win32'
      ? `waved-${hostTriple()}.exe`
      : `waved-${hostTriple()}`;
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

describe('waved sidecar integration (real daemon)', () => {
  it('boots the real waved binary, health-gates on /livez, and stops cleanly', async () => {
    const waved = await binaryPath();
    if (!waved) {
      console.warn('waved binary not installed — skipping integration test');
      return;
    }

    const healthPort = await freePort();
    const rpcPort = await freePort();
    const gatewayPort = await freePort();
    const dataDir = path.join(os.tmpdir(), `waved-it-${Date.now()}`);

    const runtime = createNodeChildProcessRuntime(waved, { stdio: 'ignore' });
    const lifecycle = new SidecarLifecycle({
      runtime,
      health: livezProbe(healthPort),
      bootTimeoutMs: 30_000,
      healthPollIntervalMs: 250,
      maxRestarts: 0, // proof run: any crash surfaces immediately
      args: () => [
        `--health.listen=127.0.0.1:${healthPort}`,
        `--rpc.listenaddr=127.0.0.1:${rpcPort}`,
        `--rpc.gateway.listenaddr=127.0.0.1:${gatewayPort}`,
        `--datadir=${dataDir}`,
        '--network=regtest',
        // The default lwwallet backend requires an Esplora URL; an
        // UNREACHABLE loopback endpoint still lets the daemon initialize
        // and serve health (verified against waved v0.2.0) — exactly what
        // a fresh install looks like before wallet setup.
        '--wallet.esploraurl=http://127.0.0.1:1',
      ],
    });

    await lifecycle.start();
    expect(lifecycle.phase).toBe('live');

    // Liveness is really served by the daemon.
    const livez = await fetch(`http://127.0.0.1:${healthPort}/livez`);
    expect(livez.status).toBe(200);

    // Readiness is a DISTINCT state: the wallet is not initialized yet
    // (fresh data dir), so /readyz reports not-ready (waved v0.2.0
    // returns 503 until InitWallet/UnlockWallet completes).
    const readyz = await fetch(`http://127.0.0.1:${healthPort}/readyz`);
    expect(readyz.status).toBe(503);

    await lifecycle.stop();
    expect(lifecycle.phase).toBe('stopped');
  }, 60_000);
});
