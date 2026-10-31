import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// services/litd-adapter/src/integration/helpers.ts -> monorepo root (4 up)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Path of the checksum-verified litd sidecar binary.
 * Default target matches scripts/fetch-sidecars.mjs on linux-x64; override
 * with SOVEREIGN_LITD_BIN on other platforms or layouts.
 */
export function sidecarBinaryPath(): string {
  const binaryPath =
    process.env['SOVEREIGN_LITD_BIN'] ??
    path.join(repoRoot, 'apps/desktop/src-tauri/binaries/litd-x86_64-unknown-linux-gnu');
  if (!existsSync(binaryPath)) {
    throw new Error(
      `litd sidecar binary not found at ${binaryPath} — run \`pnpm sidecar:fetch\` or set SOVEREIGN_LITD_BIN`,
    );
  }
  return binaryPath;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll an async probe until it resolves, or throw after the deadline with
 * the last error attached. For surfaces that become ready asynchronously —
 * litd's proxied-LND sub-server answers "lnd is not ready" until its
 * connection to the remote node is up, seconds after the TLS channel does.
 */
export async function pollUntil<T>(what: string, probe: () => Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await probe();
    } catch (err) {
      lastErr = err;
      await sleep(250);
    }
  }
  throw new Error(
    `timed out waiting for ${what}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
