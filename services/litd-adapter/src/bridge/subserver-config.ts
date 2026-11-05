/**
 * litd sub-server launch settings for the bridge-managed sidecar.
 *
 * Without these lines the shipped app ran litd with no Loop or Pool at all:
 * litd's `loop-mode`/`pool-mode` gates default to disabled, so loopd/poold
 * never started and every Loop/Pool RPC answered "unknown service". The
 * sub-server data directories also defaulted to the shared ~/.loop and
 * ~/.pool, whose macaroon DBs are encrypted against whichever wallet created
 * them first.
 *
 * Safety boundary: on regtest the Loop swap server and the Pool auctioneer
 * point at a dead loopback endpoint unless a local server is configured
 * explicitly, so an unattended regtest run can never contact Lightning Labs'
 * real operators. On signet/testnet/mainnet the upstream defaults apply
 * unless overridden.
 */
import type { LitdNetwork } from '../config.js';

/** Unroutable on purpose: operator-dependent RPCs fail fast and classified. */
export const OFFLINE_OPERATOR = '127.0.0.1:1';

export interface SubServerOverrides {
  /** Loop swap server host:port (`loop.server.host`). */
  readonly loopServer?: string;
  /** Pool auctioneer host:port (`pool.auctionserver`). */
  readonly poolServer?: string;
  /** Extra raw lines, already prefixed `loop.`/`pool.` (validated by buildLitdConfig). */
  readonly extra?: readonly string[];
}

export interface SubServerPlan {
  readonly extraSubServerArgs: readonly string[];
  /** What the UI should say about each operator dependency. */
  readonly operators: {
    readonly loop: OperatorEndpoint;
    readonly pool: OperatorEndpoint;
  };
}

export interface OperatorEndpoint {
  /** `offline` = deliberately unreachable (regtest default). */
  readonly mode: 'offline' | 'configured' | 'upstream-default';
  readonly host?: string;
}

export function planSubServers(
  network: LitdNetwork,
  dataDir: string,
  overrides: SubServerOverrides = {},
): SubServerPlan {
  // Faraday's macaroon DB defaulted to the shared ~/.faraday too: a second
  // wallet on the same machine then fails Faraday's startup with "unable to
  // unlock macaroon DB: invalid password" (observed), so analytics never work.
  const lines = [
    'loop-mode=integrated',
    'pool-mode=integrated',
    `loop.datadir=${dataDir}/loop`,
    `pool.basedir=${dataDir}/pool`,
    `faraday.faradaydir=${dataDir}/faraday`,
  ];

  const endpoint = (configured: string | undefined): OperatorEndpoint => {
    if (configured !== undefined && configured !== '') return { mode: 'configured', host: configured };
    if (network === 'regtest') return { mode: 'offline', host: OFFLINE_OPERATOR };
    return { mode: 'upstream-default' };
  };
  const loop = endpoint(overrides.loopServer);
  const pool = endpoint(overrides.poolServer);
  if (loop.host !== undefined) lines.push(`loop.server.host=${loop.host}`);
  if (pool.host !== undefined) lines.push(`pool.auctionserver=${pool.host}`);
  lines.push(...(overrides.extra ?? []));

  return { extraSubServerArgs: lines, operators: { loop, pool } };
}
