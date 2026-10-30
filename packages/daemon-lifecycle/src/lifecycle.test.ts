/**
 * Sidecar lifecycle tests — REAL subprocesses (stub waved daemon mimicking
 * wavelength v0.2.0 health semantics) over REAL HTTP health probes. The
 * engine is exercised through its public surface exactly as the Tauri
 * runtime adapter will drive it.
 *
 * Crash/kill/timeout semantics are real: SIGTERM exits, crashes, late
 * boots, and stop-during-boot races all run for real.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SidecarLifecycle } from './index.js';
import type { HealthProbe, SidecarExit, SidecarPhase, SidecarRuntime } from './types.js';

const STUB_PATH = fileURLToPath(new URL('./testing/stub-waved.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const children = new Set<ChildProcess>();

afterAll(() => {
  for (const child of children) {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
    }
  }
});

/** Ephemeral TCP port (best-effort uniqueness — standard test-harness pick). */
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

/** Node child-process runtime with late-exit replay (an exit observed before
 *  a listener subscribes is delivered to the first subscriber). */
function createNodeRuntime(): { runtime: SidecarRuntime; lastChild: () => ChildProcess | undefined } {
  let latest: ChildProcess | undefined;
  return {
    lastChild: () => latest,
    runtime: {
      displayName: 'stub-waved',
      spawn(args: string[]) {
        const child = spawn(process.execPath, [STUB_PATH, ...args], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.stderr?.on('data', (chunk) => {
          process.stdout.write(`[stub-waved stderr] ${chunk}`);
        });
        latest = child;
        children.add(child);
        const listeners = new Set<(exit: SidecarExit) => void>();
        let lastExit: SidecarExit | null = null;
        const deliver = (exit: SidecarExit): void => {
          lastExit = exit;
          for (const listener of listeners) listener(exit);
        };
        child.on('exit', (code, signal) => deliver({ code, signal: signal ?? null }));
        child.on('error', (error: NodeJS.ErrnoException) => {
          if (child.exitCode == null && child.signalCode == null) {
            deliver({ code: null, signal: null, spawnError: error.message });
          }
        });
        return Promise.resolve({
          pid: child.pid ?? -1,
          kill: async () => {
            child.kill();
          },
          onExit(listener) {
            listeners.add(listener);
            if (lastExit) listener(lastExit);
            return () => listeners.delete(listener);
          },
        });
      },
    },
  };
}

/** Real HTTP probe against the stub's /livez endpoint. */
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

const BASE_OPTIONS = { healthPollIntervalMs: 50, bootTimeoutMs: 4000, killGraceMs: 1000 };

async function waitForPhase(lifecycle: SidecarLifecycle, phase: SidecarPhase, timeoutMs = 10000): Promise<void> {
  if (lifecycle.phase === phase) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for phase ${phase}, last phase=${lifecycle.phase}`));
    }, timeoutMs);
    const off = lifecycle.onPhase((current) => {
      if (current === phase) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SidecarLifecycle', () => {
  it('reaches live through a real health-gated boot', async () => {
    const port = await freePort();
    const { runtime } = createNodeRuntime();
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      runtime,
      health: livezProbe(port),
      args: () => [`--port=${port}`],
    });

    expect(lifecycle.phase).toBe('idle');
    await lifecycle.start();
    expect(lifecycle.phase).toBe('live');

    // The daemon is genuinely serving.
    const response = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(response.ok).toBe(true);

    await lifecycle.stop();
  });

  it('stops cleanly and is idempotent; the process is really gone', async () => {
    const port = await freePort();
    const { runtime, lastChild } = createNodeRuntime();
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      runtime,
      health: livezProbe(port),
      args: () => [`--port=${port}`],
    });

    await lifecycle.start();
    const child = lastChild();
    expect(child?.exitCode).toBeNull(); // null while running

    await lifecycle.stop();
    expect(lifecycle.phase).toBe('stopped');
    await eventually(() => child?.exitCode != null, 3000);
    expect(child?.exitCode).toBe(0); // SIGTERM → stub's clean shutdown

    await expect(lifecycle.stop()).resolves.toBeUndefined(); // idempotent
    expect(lifecycle.phase).toBe('stopped');
  });

  it('stop() from idle resolves immediately in the stopped phase', async () => {
    const port = await freePort();
    const { runtime } = createNodeRuntime();
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      runtime,
      health: livezProbe(port),
      args: () => [`--port=${port}`],
    });
    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(lifecycle.phase).toBe('stopped');
  });

  it('restarts automatically after a crash and reaches live with a new process', async () => {
    const port = await freePort();
    const { runtime, lastChild } = createNodeRuntime();
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      bootTimeoutMs: 8000,
      maxRestarts: 3,
      restartBackoffMs: () => 60,
      runtime,
      health: livezProbe(port),
      args: () => [`--port=${port}`, '--crash-after=700'],
    });

    await lifecycle.start();
    const firstPid = lastChild()?.pid;
    await waitForPhase(lifecycle, 'live'); // first life
    await waitForPhase(lifecycle, 'restarting'); // crash observed
    await waitForPhase(lifecycle, 'live'); // restarted

    expect(lifecycle.restarts).toBe(1);
    expect(lastChild()?.pid).not.toBe(firstPid);

    await lifecycle.stop();
  });

  it('caps total crash-restarts and lands on failed for a crash-looping daemon', async () => {
    const port = await freePort();
    const { runtime } = createNodeRuntime();
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      bootTimeoutMs: 8000,
      maxRestarts: 1,
      restartBackoffMs: () => 40,
      runtime,
      health: livezProbe(port),
      args: () => [`--port=${port}`, '--crash-after=500'],
    });

    await lifecycle.start();
    // maxRestarts=1: crash → 1 auto-restart → crashes again → cap spent → failed.
    await waitForPhase(lifecycle, 'failed', 15000);
    expect(lifecycle.restarts).toBe(2);
    await lifecycle.stop();
    expect(lifecycle.phase).toBe('stopped');
  });

  it('surfaces a daemon that dies during boot as boot-exit without retries', async () => {
    const port = await freePort();
    const { runtime } = createNodeRuntime();
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      maxRestarts: 3,
      restartBackoffMs: () => 60,
      runtime,
      health: livezProbe(port),
      args: () => [`--port=${port}`, '--exit-after=0'],
    });

    await expect(lifecycle.start()).rejects.toMatchObject({
      name: 'SidecarLifecycleError',
      code: 'boot-exit',
    });
    expect(lifecycle.phase).toBe('failed');
  });

  it('rejects with boot-timeout and kills the stale process when health never passes', async () => {
    const port = await freePort();
    const { runtime, lastChild } = createNodeRuntime();
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      bootTimeoutMs: 400,
      runtime,
      health: livezProbe(port),
      args: () => [`--port=${port}`, '--never-live'],
    });

    await expect(lifecycle.start()).rejects.toMatchObject({
      name: 'SidecarLifecycleError',
      code: 'boot-timeout',
    });
    expect(lifecycle.phase).toBe('failed');
    await eventually(() => lastChild()?.exitCode != null, 3000); // stale child killed
    await lifecycle.stop();
  });

  it('stop() during boot cancels it: start() rejects boot-interrupted-by-stop, phase lands on stopped', async () => {
    const port = await freePort();
    const { runtime, lastChild } = createNodeRuntime();
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      bootTimeoutMs: 10000,
      runtime,
      health: livezProbe(port),
      args: () => [`--port=${port}`, '--never-live'],
    });

    // Attach the rejection expectation BEFORE any await: start() rejects as
    // soon as stop() bumps the generation, and a rejection observed while no
    // handler is attached fails the vitest run as an unhandled error.
    const startPromise = lifecycle.start();
    const startRejected = expect(startPromise).rejects.toMatchObject({
      name: 'SidecarLifecycleError',
      code: 'boot-interrupted-by-stop',
    });
    await waitForPhase(lifecycle, 'starting');
    await new Promise((resolve) => setTimeout(resolve, 150));
    await lifecycle.stop();

    await startRejected;
    expect(lifecycle.phase).toBe('stopped');
    await eventually(() => lastChild()?.exitCode != null, 3000);
  });

  it('rejects already-started while live', async () => {
    const port = await freePort();
    const { runtime } = createNodeRuntime();
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      runtime,
      health: livezProbe(port),
      args: () => [`--port=${port}`],
    });

    await lifecycle.start();
    await expect(lifecycle.start()).rejects.toMatchObject({
      name: 'SidecarLifecycleError',
      code: 'already-started',
    });
    await lifecycle.stop();
  });

  it('reports boot-exit when the runtime cannot spawn the binary at all', async () => {
    const port = await freePort();
    const failingRuntime: SidecarRuntime = {
      displayName: 'missing-binary',
      spawn: () => Promise.reject(new Error('ENOENT: no such binary')),
    };
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      runtime: failingRuntime,
      health: livezProbe(port),
      args: () => [`--port=${port}`],
    });

    await expect(lifecycle.start()).rejects.toMatchObject({
      name: 'SidecarLifecycleError',
      code: 'boot-exit',
    });
    expect(lifecycle.phase).toBe('failed');
    expect(lifecycle.snapshot().lastExit?.spawnError).toContain('ENOENT');
  });

  it('surfaces a kill that never terminates the process as stop-timeout', async () => {
    const port = await freePort();
    const zombieRuntime: SidecarRuntime = {
      displayName: 'zombie',
      spawn: () =>
        Promise.resolve({
          pid: 424242,
          kill: async () => undefined, // resolves but the process never exits
          onExit: () => () => undefined,
        }),
    };
    const alwaysAliveProbe: HealthProbe = { isAlive: async () => true };
    const lifecycle = new SidecarLifecycle({
      ...BASE_OPTIONS,
      killGraceMs: 150,
      runtime: zombieRuntime,
      health: alwaysAliveProbe,
      args: () => [`--port=${port}`],
    });

    await lifecycle.start(); // boots healthy instantly (probe is a stub)
    expect(lifecycle.phase).toBe('live');
    await expect(lifecycle.stop()).rejects.toMatchObject({
      name: 'SidecarLifecycleError',
      code: 'stop-timeout',
    });
  });
});

/** Poll-until-true helper. */
async function eventually(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met before timeout');
}
