/**
 * INTEGRATION TEST against the REAL waved daemon (wavelength v0.2.0).
 *
 * This is the CI-runnable core of the Mode A sidecar proof: the pinned
 * upstream binary is booted through the same lifecycle engine the Tauri
 * app uses, health-gated on /livez, observed pre-init on /readyz, and
 * stopped cleanly. Skips when the binary has not been fetched yet
 * (`node scripts/fetch-waved.mjs --triple=<host>` installs it).
 */
import { access, constants, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SidecarLifecycle, allProbes, httpListeningProbe, httpOkProbe } from './index.js';
import { createNodeChildProcessRuntime } from './runtimes/node.js';
import { SidecarLifecycleError, type HealthProbe } from './types.js';
import { freePort, isPortCollisionBootFailure, retryOnPortCollision } from './testing/ports.js';

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

/** Live = /livez answers AND the REST gateway accepts connections (waved
 * v0.2.1 serves /livez before its gateway listens). */
function wavedProbe(healthPort: number, gatewayPort: number): HealthProbe {
  return allProbes(
    httpOkProbe(`http://127.0.0.1:${healthPort}/livez`),
    httpListeningProbe(`http://127.0.0.1:${gatewayPort}/`),
  );
}

interface WavedPorts {
  healthPort: number;
  rpcPort: number;
  gatewayPort: number;
  dataDir: string;
}

function wavedLifecycle(waved: string, { healthPort, rpcPort, gatewayPort, dataDir }: WavedPorts): SidecarLifecycle {
  // stderr tail: a boot exit reports waved's own reason, not a bare exit code.
  const runtime = createNodeChildProcessRuntime(waved, { stdio: 'ignore', stderrTailLines: 5 });
  return new SidecarLifecycle({
    runtime,
    health: wavedProbe(healthPort, gatewayPort),
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
}

describe('waved sidecar integration (real daemon)', () => {
  it('boots the real waved binary, health-gates on /livez, and stops cleanly', async () => {
    const waved = await binaryPath();
    if (!waved) {
      console.warn('waved binary not installed — skipping integration test');
      return;
    }

    const dataDir = path.join(os.tmpdir(), `waved-it-${Date.now()}`);
    // Fresh ports per attempt; retried only on a bind collision (testing/ports.ts).
    const { lifecycle, healthPort, gatewayPort } = await retryOnPortCollision(async () => {
      const healthPort = await freePort();
      const rpcPort = await freePort();
      const gatewayPort = await freePort();
      const lifecycle = wavedLifecycle(waved, { healthPort, rpcPort, gatewayPort, dataDir });
      await lifecycle.start();
      return { lifecycle, healthPort, gatewayPort };
    });
    expect(lifecycle.phase).toBe('live');

    // Liveness is really served by the daemon.
    const livez = await fetch(`http://127.0.0.1:${healthPort}/livez`);
    expect(livez.status).toBe(200);
    // ...and so is the gateway the app calls next.
    expect(await httpListeningProbe(`http://127.0.0.1:${gatewayPort}/`).isAlive()).toBe(true);

    // Readiness is a DISTINCT state: the wallet is not initialized yet
    // (fresh data dir), so /readyz reports not-ready (waved v0.2.0
    // returns 503 until InitWallet/UnlockWallet completes).
    const readyz = await fetch(`http://127.0.0.1:${healthPort}/readyz`);
    expect(readyz.status).toBe(503);

    await lifecycle.stop();
    expect(lifecycle.phase).toBe('stopped');
  }, 60_000);

  it('reports a taken listen port as a boot-exit that names the bind error (the retry condition)', async () => {
    const waved = await binaryPath();
    if (!waved) {
      console.warn('waved binary not installed — skipping integration test');
      return;
    }
    // Hold the gRPC port, as a colliding socket on a busy runner would. The
    // RPC port is never probed, so the squatter can't make a probe pass and
    // never holds a connection that would keep close() waiting; any stray
    // connection is dropped immediately anyway.
    const squatter = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const rpcPort = (squatter.address() as net.AddressInfo).port;
    const dataDir = path.join(os.tmpdir(), `waved-it-collide-${Date.now()}`);
    try {
      const lifecycle = wavedLifecycle(waved, {
        healthPort: await freePort(),
        rpcPort,
        gatewayPort: await freePort(),
        dataDir,
      });
      const error = await lifecycle.start().then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(SidecarLifecycleError);
      expect(error instanceof SidecarLifecycleError ? error.code : undefined).toBe('boot-exit');
      expect(error instanceof SidecarLifecycleError ? error.detail : undefined).toContain(`127.0.0.1:${rpcPort}`);
      expect(isPortCollisionBootFailure(error)).toBe(true);
      expect(lifecycle.phase).toBe('failed');
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
