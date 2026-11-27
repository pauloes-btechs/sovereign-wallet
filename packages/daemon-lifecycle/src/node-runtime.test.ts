/**
 * Node runtime + port-collision retry — unit tests over REAL subprocesses
 * (the stub waved daemon), no waved binary needed, so they run in `pnpm test`.
 *
 * Regression for CI run 45876662543: waved exited 1 at boot because a port
 * picked by freePort() was taken before it bound, and the lifecycle error
 * said only "process exited with code 1". The runtime now reports the
 * daemon's stderr tail, and the integration tests retry ONLY that cause.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SidecarLifecycle, SidecarLifecycleError, httpOkProbe } from './index.js';
import { createNodeChildProcessRuntime } from './runtimes/node.js';
import { freePort, isPortCollisionBootFailure, retryOnPortCollision } from './testing/ports.js';

const STUB_PATH = fileURLToPath(new URL('./testing/stub-waved.mjs', import.meta.url));

function stubLifecycle(args: string[], healthPort: number, stderrTailLines: number): SidecarLifecycle {
  return new SidecarLifecycle({
    runtime: createNodeChildProcessRuntime(process.execPath, { stdio: 'ignore', stderrTailLines }),
    health: httpOkProbe(`http://127.0.0.1:${healthPort}/livez`),
    bootTimeoutMs: 10_000,
    healthPollIntervalMs: 50,
    maxRestarts: 0,
    args: () => [STUB_PATH, ...args],
  });
}

async function startError(lifecycle: SidecarLifecycle): Promise<unknown> {
  return lifecycle.start().then(
    () => undefined,
    (err: unknown) => err,
  );
}

describe('node runtime stderr tail', () => {
  it('puts the daemon stderr in the boot-exit detail', async () => {
    // No --port: the stub prints its reason to stderr and exits 78.
    const lifecycle = stubLifecycle([], await freePort(), 5);
    const error = await startError(lifecycle);
    expect(error).toBeInstanceOf(SidecarLifecycleError);
    const detail = error instanceof SidecarLifecycleError ? error.detail : undefined;
    expect(detail).toContain('process exited with code 78');
    expect(detail).toContain('stub-waved: --port=N required');
    expect(lifecycle.snapshot().lastExit?.stderrTail).toBe('stub-waved: --port=N required');
  });

  it('captures nothing by default, keeping the old detail', async () => {
    const error = await startError(stubLifecycle([], await freePort(), 0));
    expect(error instanceof SidecarLifecycleError ? error.detail : undefined).toBe('process exited with code 78');
  });

  it('still stops a live daemon cleanly while capturing stderr', async () => {
    const port = await freePort();
    const lifecycle = stubLifecycle([`--port=${port}`], port, 5);
    await lifecycle.start();
    expect(lifecycle.phase).toBe('live');
    await lifecycle.stop();
    expect(lifecycle.phase).toBe('stopped');
  });
});

describe('retryOnPortCollision', () => {
  const collision = new SidecarLifecycleError(
    'boot-exit',
    'process exited with code 1; stderr: daemon gateway listen: listen tcp 127.0.0.1:41234: bind: address already in use',
  );

  it('recognises only a boot-exit that names a taken address', () => {
    expect(isPortCollisionBootFailure(collision)).toBe(true);
    expect(isPortCollisionBootFailure(new SidecarLifecycleError('boot-exit', 'process exited with code 1'))).toBe(false);
    expect(isPortCollisionBootFailure(new SidecarLifecycleError('boot-timeout', 'address already in use'))).toBe(false);
    expect(isPortCollisionBootFailure(new Error('address already in use'))).toBe(false);
  });

  it('retries a port collision and returns the next attempt', async () => {
    const attempts: number[] = [];
    const retried: number[] = [];
    const result = await retryOnPortCollision(
      async (n) => {
        attempts.push(n);
        if (n === 1) throw collision;
        return 'live';
      },
      { onRetry: (_error, n) => retried.push(n) },
    );
    expect(result).toBe('live');
    expect(attempts).toEqual([1, 2]);
    expect(retried).toEqual([1]);
  });

  it('does not retry any other boot failure', async () => {
    let calls = 0;
    const other = new SidecarLifecycleError('boot-exit', 'process exited with code 1; stderr: wallet db locked');
    await expect(
      retryOnPortCollision(async () => {
        calls += 1;
        throw other;
      }),
    ).rejects.toBe(other);
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts collisions and surfaces the last one', async () => {
    let calls = 0;
    await expect(
      retryOnPortCollision(
        async () => {
          calls += 1;
          throw collision;
        },
        { maxAttempts: 3 },
      ),
    ).rejects.toBe(collision);
    expect(calls).toBe(3);
  });
});
