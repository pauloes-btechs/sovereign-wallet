/**
 * litd sidecar launcher — spawns the checksum-verified litd binary, feeds it a
 * 0600 lit.conf, and gates readiness on the gRPC channel coming up.
 *
 * Failure is loud: an early daemon exit rejects with the captured log tail
 * (never swallowed), and stop() escalates SIGTERM -> SIGKILL on deadline.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';

import { assertLoopbackOnly, buildLitdConfig, pickFreeLoopbackPort } from './config.js';
import { connectionOptionsFromConfig, probeRpcReady, waitForServices } from './client.js';
import type { LitdSidecarOptions, ResolvedLitdConfig } from './config.js';

// Sized so litd's startup errors survive the readiness canary's ~4 req/s
// INF request-log spam for a full 60s readiness window.
const LOG_TAIL_LINES = 800;

export interface LaunchLitdOptions {
  /** Path to the checksum-verified litd binary (see scripts/fetch-sidecars.mjs). */
  readonly binaryPath: string;
  readonly options: LitdSidecarOptions;
  readonly readyTimeoutMs?: number;
  /** Observe daemon output (diagnostics; stderr+stdout interleaved). */
  readonly onLog?: (line: string) => void;
}

export interface LaunchedLitd {
  readonly config: ResolvedLitdConfig;
  readonly child: ChildProcess;
  /** SIGTERM, then SIGKILL after the grace period. Idempotent. */
  stop(graceMs?: number): Promise<void>;
}

/** Ring buffer of the last N daemon log lines, for actionable failures. */
class LogTail {
  private readonly lines: string[] = [];
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > LOG_TAIL_LINES) {
      this.lines.shift();
    }
  }
  dump(): string {
    return this.lines.join('\n');
  }
}

export async function launchLitdSidecar(launch: LaunchLitdOptions): Promise<LaunchedLitd> {
  // Launch on a kernel-assigned port unless the caller pinned one. The
  // config-builder default (10009) is only a fallback for callers that
  // generate config without launching: binding a fixed default here collides
  // with anything already listening on it — a user's own LND, or the regtest
  // harness's docker port mapping for lnd-alice in CI (both observed).
  // Free-pick BOTH serving ports when unpinned: rpcPort is the wallet-facing
  // gRPC in integrated mode (lnd.rpclisten); uiPort is litd's proxy/UI port —
  // the wallet-facing gRPC in remote mode. Kernel-assigned ports avoid
  // colliding with anything already listening on the defaults.
  const options: LitdSidecarOptions = {
    ...launch.options,
    rpcPort: launch.options.rpcPort ?? await pickFreeLoopbackPort(),
    uiPort: launch.options.uiPort ?? await pickFreeLoopbackPort(),
  };
  const config = buildLitdConfig(options);
  assertLoopbackOnly(config);

  await mkdir(launch.options.dataDir, { recursive: true });
  // 0600: the conf carries the UI password and (optionally) bitcoind RPC pass.
  await writeFile(config.confPath, config.confLines.join('\n') + '\n', { mode: 0o600 });

  const logs = new LogTail();
  const child = spawn(launch.binaryPath, [...config.args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let earlyExitError: Error | undefined;
  const earlyExit = new Promise<never>((_resolve, reject) => {
    child.on('exit', (code, signal) => {
      earlyExitError = new Error(
        `litd exited before becoming ready (code=${code ?? 'null'} signal=${signal ?? 'null'})` +
          `\n--- litd log tail ---\n${logs.dump()}`,
      );
      reject(earlyExitError);
    });
    child.on('error', (err) => {
      earlyExitError = new Error(`litd could not be spawned: ${err.message}`);
      reject(earlyExitError);
    });
  });
  // Handle the branch nobody is awaiting (rejection windows between races);
  // real consumers re-await earlyExit and still receive the error.
  earlyExit.catch(() => {});

  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '') {
        logs.push(line);
        launch.onLog?.(line);
      }
    }
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);

  const readyTimeoutMs = launch.readyTimeoutMs ?? 60_000;
  const ready = (async () => {
    // litd generates its TLS cert on first boot; probe needs it to exist.
    await waitForFile(config.tlsCertPath, readyTimeoutMs, earlyExit);
    await probeRpcReady(config, readyTimeoutMs);
    // Sub-servers register AFTER the listener opens — without this gate the
    // first wallet call races startup and fails with "waiting to start".
    await waitForServices(
      connectionOptionsFromConfig(config),
      options.backend.kind === 'remote-lnd' ? 'lightning' : 'unlocker',
      readyTimeoutMs,
    );
  })();

  try {
    await Promise.race([ready, earlyExit]);
  } catch (err) {
    // Never leave a half-started daemon behind, and never fail blind: attach
    // the captured log tail so readiness/timeout failures diagnose themselves.
    await forceKill(child);
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n--- litd log tail ---\n${logs.dump()}`,
    );
  }
  if (earlyExitError !== undefined) {
    // earlyExit settled first and ready resolved concurrently — belt and braces.
    await forceKill(child);
    throw earlyExitError;
  }

  let stopped = false;
  return {
    config,
    child,
    stop: (graceMs = 10_000) => {
      if (stopped) {
        return Promise.resolve();
      }
      stopped = true;
      return gracefulStop(child, graceMs);
    },
  };
}

async function waitForFile(path: string, timeoutMs: number, earlyExit: Promise<never>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readFile(path);
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${path} to appear`);
      }
      // A 250ms tick, interrupted (rethrown) if the daemon dies early.
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
        earlyExit,
      ]);
    }
  }
}

async function gracefulStop(child: ChildProcess, graceMs: number): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once('exit', () => resolve());
    }
  });
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function forceKill(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}
