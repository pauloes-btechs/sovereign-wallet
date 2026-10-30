import os from 'node:os';
import path from 'node:path';

/**
 * Rendezvous path for the e2e daemon harness. globalSetup spawns
 * daemon-harness.mjs with this path; the harness writes the gateway
 * bootstrap + its own PID here; the spec and globalTeardown read it.
 */
export const BOOTSTRAP_FILE =
  process.env.E2E_BOOTSTRAP_FILE ?? path.join(os.tmpdir(), 'sovereign-e2e-bootstrap.json');

export interface E2eBootstrap {
  gatewayUrl: string;
  macaroonHex: string;
  dataDir: string;
  pid: number;
}
