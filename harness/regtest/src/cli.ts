import { spawn, type ChildProcess } from 'node:child_process';

import {
  BITCOIND,
  bootstrapHarness,
  BTCD_FILTER_PORT,
  HARNESS_DATA_DIR,
} from './harness.js';

/**
 * Regtest harness bootstrap.
 *
 * 1. Optionally starts the host-side btcd BIP157 filter server (when
 *    SOVEREIGN_BTCD_BIN is set) — it follows bitcoind's chain over P2P and
 *    serves compact filters on 127.0.0.1:18555 for the Neutrino sidecar test.
 * 2. Runs the idempotent bootstrap (bitcoind wallet, seed chain, node wallets).
 *
 * The process exits after bootstrap; the spawned btcd stays alive for the
 * integration suite.
 */

const btcdBin = process.env['SOVEREIGN_BTCD_BIN'];
let btcdChild: ChildProcess | undefined;

if (btcdBin !== undefined && btcdBin !== '') {
  btcdChild = spawn(
    btcdBin,
    [
      '--regtest',
      `--connect=127.0.0.1:${BITCOIND.p2pPort}`,
      `--listen=0.0.0.0:${BTCD_FILTER_PORT}`,
      `--datadir=${HARNESS_DATA_DIR}/btcd`,
      `--logdir=${HARNESS_DATA_DIR}/btcd-log`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  // Surface spawn failures loudly — a missing binary is a config error, not a
  // silent skip of the Neutrino filter source.
  btcdChild.on('error', (err) => {
    console.error(`[harness] btcd spawn failed: ${err.message}`);
    process.exitCode = 1;
  });
  btcdChild.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[harness] btcd exited early with code ${code}${signal ? ` (${signal})` : ''}`);
      process.exitCode = 1;
    }
  });
} else {
  console.error('[harness] SOVEREIGN_BTCD_BIN not set — assuming a filter server is already running.');
}

const status = await bootstrapHarness();
console.log(JSON.stringify(status, null, 2));
console.error(`[harness] bootstrap complete${btcdChild ? ' (btcd running in background)' : ''}`);
