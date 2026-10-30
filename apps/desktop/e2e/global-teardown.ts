import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BOOTSTRAP_FILE, type E2eBootstrap } from './bootstrap-path.js';

/**
 * Stops the daemon harness (which stops waved and removes the temp data
 * dir) using the PID it recorded in the bootstrap file, then removes the
 * file. Tolerates a harness that already died.
 */
export default async function globalTeardown(): Promise<void> {
  let bootstrap: E2eBootstrap | undefined;
  try {
    bootstrap = JSON.parse(await readFile(BOOTSTRAP_FILE, 'utf8')) as E2eBootstrap;
  } catch {
    return; // never healthy — nothing to stop
  }
  try {
    process.kill(bootstrap.pid, 'SIGTERM');
  } catch {
    // already gone — fine
  }
  await rm(dirname(BOOTSTRAP_FILE), { recursive: true, force: true }).catch(() => undefined);
}
