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
