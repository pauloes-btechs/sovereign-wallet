import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

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
  // btcd must NOT inherit this process's stdio: on a successful bootstrap
  // exit, the CI step runner waits for the step's stdout/stderr pipes to
  // reach EOF, and an inheriting background child holds them open forever —
  // observed as a 30-minute silent hang in run 41133175673 (the step's
  // output finished at 21:45:14 but the job was cancelled at its timeout).
  // Redirect btcd's output to a log file instead, and run it detached in its
  // own process group so the runner's group cleanup cannot reap it before the
  // integration suite (a later step) uses it.
  mkdirSync(join(HARNESS_DATA_DIR, 'btcd-log'), { recursive: true });
  const btcdLogFd = openSync(join(HARNESS_DATA_DIR, 'btcd-log', 'stdout.log'), 'a');
  btcdChild = spawn(
    btcdBin,
    [
      '--regtest',
      `--connect=127.0.0.1:${BITCOIND.p2pPort}`,
      `--listen=0.0.0.0:${BTCD_FILTER_PORT}`,
      `--datadir=${HARNESS_DATA_DIR}/btcd`,
      `--logdir=${HARNESS_DATA_DIR}/btcd-log`,
    ],
    { stdio: ['ignore', btcdLogFd, btcdLogFd], detached: true },
  );
  btcdChild.unref();
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
