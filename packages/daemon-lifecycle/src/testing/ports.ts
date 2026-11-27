/**
 * Port helpers for the real-daemon integration tests (test-only; excluded
 * from the build).
 *
 * `freePort()` is check-then-use: it binds port 0, reads the port, and
 * releases it before the daemon binds it. In that window the kernel can hand
 * the same port to anything else on the runner, including the outbound
 * sockets the daemon and the test themselves open (Esplora polling, gateway
 * calls) and the other waved test file running in parallel. When that
 * happens waved exits 1 at boot with
 * `daemon gateway listen: listen tcp 127.0.0.1:N: bind: address already in use`
 * (observed on CI run 45876662543, 2026-11-26). That is a harness collision,
 * not a wallet bug, so the boot is retried on fresh ports. Every other boot
 * failure still fails the test on the first attempt.
 */
import net from 'node:net';
import { SidecarLifecycleError } from '../types.js';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** True only for a boot-exit whose captured stderr says a listen address was taken. */
export function isPortCollisionBootFailure(error: unknown): boolean {
  return (
    error instanceof SidecarLifecycleError &&
    error.code === 'boot-exit' &&
    /address already in use/i.test(error.detail ?? '')
  );
}

/**
 * Run `attempt` (which must allocate its own fresh ports each call), retrying
 * up to `maxAttempts` times total ONLY when it fails with a port collision.
 * `onRetry` lets the caller log the collision so retries stay visible.
 */
export async function retryOnPortCollision<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  { maxAttempts = 3, onRetry }: { maxAttempts?: number; onRetry?: (error: SidecarLifecycleError, attemptNumber: number) => void } = {},
): Promise<T> {
  for (let n = 1; ; n += 1) {
    try {
      return await attempt(n);
    } catch (error) {
      if (n >= maxAttempts || !isPortCollisionBootFailure(error)) throw error;
      if (error instanceof SidecarLifecycleError) onRetry?.(error, n);
    }
  }
}
