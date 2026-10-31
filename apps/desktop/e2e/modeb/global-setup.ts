import { access } from 'node:fs/promises';
import { MODEB_BOOTSTRAP_FILE } from './bootstrap-path.js';

/**
 * The webServer command (start-app.mjs) boots the daemon harness and vite;
 * this setup only waits for the bootstrap file — by then the bridge is
 * live with its fresh litd sidecar and its URL/token are published.
 */
export default async function globalSetup(): Promise<void> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    if (await exists(MODEB_BOOTSTRAP_FILE)) return;
    if (Date.now() > deadline) {
      throw new Error('modeb daemon harness did not publish its bootstrap within 300s');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}
