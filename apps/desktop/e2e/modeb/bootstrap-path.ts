import os from 'node:os';
import path from 'node:path';

/**
 * Rendezvous path for the Mode B e2e daemon harness. start-app.mjs spawns
 * daemon-harness.mjs with this path; the harness writes the bridge
 * bootstrap + its own PID here; the spec and globalTeardown read it.
 */
export const MODEB_BOOTSTRAP_FILE =
  process.env.E2E_MODEB_BOOTSTRAP_FILE ?? path.join(os.tmpdir(), 'sovereign-modeb-e2e-bootstrap.json');

export interface ModeBE2eBootstrap {
  /** Loopback bridge URL the vite proxy targets (fixed port). */
  bridgeUrl: string;
  bridgeToken: string;
  /** Peer identity the specs open a channel to (harness lnd-alice). */
  peerPubkey: string;
  /** Host:port the sidecar dials from the HOST network. */
  peerHost: string;
  dataDir: string;
  pid: number;
}
