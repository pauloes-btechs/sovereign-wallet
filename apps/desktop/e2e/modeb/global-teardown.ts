import { readFile, rm } from 'node:fs/promises';
import { MODEB_BOOTSTRAP_FILE, type ModeBE2eBootstrap } from './bootstrap-path.js';

/**
 * Stops the daemon harness (which stops the bridge and its litd sidecar)
 * using the PID recorded in the bootstrap file, then removes the file and
 * the temp data dir. Tolerates a harness that already died.
 */
export default async function globalTeardown(): Promise<void> {
  let bootstrap: ModeBE2eBootstrap | undefined;
  try {
    bootstrap = JSON.parse(await readFile(MODEB_BOOTSTRAP_FILE, 'utf8')) as ModeBE2eBootstrap;
  } catch {
    return; // never healthy — nothing to stop
  }
  try {
    process.kill(bootstrap.pid, 'SIGTERM');
  } catch {
    // already gone — fine
  }
  await rm(MODEB_BOOTSTRAP_FILE, { force: true }).catch(() => undefined);
  await rm(bootstrap.dataDir, { recursive: true, force: true }).catch(() => undefined);
}
