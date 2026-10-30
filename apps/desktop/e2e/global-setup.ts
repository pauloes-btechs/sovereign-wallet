import { access } from 'node:fs/promises';
import { BOOTSTRAP_FILE } from './bootstrap-path.js';

/**
 * The webServer command (start-app.mjs) boots the daemon harness and vite;
 * this setup only waits for the bootstrap file — by then the sidecar is
 * live and its gateway URL/macaroon are published for the specs.
 */
export default async function globalSetup(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await exists(BOOTSTRAP_FILE)) return;
    if (Date.now() > deadline) {
      throw new Error('daemon harness did not publish its bootstrap within 60s');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}
