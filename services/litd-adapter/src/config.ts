/**
 * Pure litd sidecar configuration builder.
 *
 * All flag names verified against litd v0.17.8 upstream docs:
 * - Integrated mode passes LND flags with the `lnd.` prefix
 *   (docs/config-lnd-integrated.md at tag v0.17.8).
 * - Remote mode uses remote.lnd.rpcserver / macaroonpath / tlscertpath;
 *   the remote LND must run >= v0.19.0 with rpcmiddleware.enable=true
 *   (docs/config-lnd-remote.md at tag v0.17.8).
 *
 * Secrets (UI password, bitcoind RPC password) are written ONLY to the lit.conf
 * file (0600) — never to argv, where they would be visible in `ps` output.
 */

export type LitdNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

/** Backend selection. Neutrino is the desktop default (spec-locked). */
export type LitdBackendOptions =
  | {
      /** Light client — minutes-scale fresh sync via CDNSync (LND v0.21 line). */
      readonly kind: 'neutrino';
      /** Compact-filter serving peers (host:port). Required on regtest/signet. */
      readonly peers?: readonly string[];
    }
  | {
      /** User's own full bitcoind node. */
      readonly kind: 'bitcoind-rpc';
      readonly rpcHost: string;
      readonly rpcUser: string;
      /** Written to lit.conf (0600), never argv. */
      readonly rpcPass: string;
      readonly zmqRawBlock: string;
      readonly zmqRawTx: string;
    }
  | {
      /**
       * litd proxies an existing user-controlled LND. Requires the remote node
       * to run LND >= v0.19.0 with rpcmiddleware.enable=true (see
       * REMOTE_LND_REQUIREMENTS in provider.ts).
       */
      readonly kind: 'remote-lnd';
      readonly rpcServer: string;
      readonly macaroonPath: string;
      readonly tlsCertPath: string;
    };

export interface LitdSidecarOptions {
  readonly network: LitdNetwork;
  /** litd home (`--lit-dir`); lnd dir is `<dataDir>/lnd`. */
  readonly dataDir: string;
  readonly backend: LitdBackendOptions;
  /** litd unified RPC mux port, bound to loopback. Default 10009. */
  readonly rpcPort?: number;
  /** litd UI HTTPS port, bound to loopback. Default 8443. */
  readonly uiPort?: number;
  /** UI password. Generated when omitted; written to lit.conf only. */
  readonly uiPassword?: string;
  /** Extra LND flags, already prefixed with `lnd.`, appended to lit.conf. */
  readonly extraLndArgs?: readonly string[];
}

export interface ResolvedLitdConfig {
  /** Full argv for the litd process. */
  readonly args: readonly string[];
  /** Secret-bearing lit.conf lines (also written to disk at 0600). */
  readonly confLines: readonly string[];
  readonly confPath: string;
  readonly litDir: string;
  /** litd's own self-signed TLS cert (generated on first boot). */
  readonly tlsCertPath: string;
  /** Admin macaroon path. Integrated: inside the lnd dir. Remote: as given. */
  readonly adminMacaroonPath: string;
  readonly rpcHost: '127.0.0.1';
  readonly rpcPort: number;
}

export const DEFAULT_RPC_PORT = 10_009;
export const DEFAULT_UI_PORT = 8443;

const NETWORK_FLAG: Record<LitdNetwork, string> = {
  mainnet: 'mainnet',
  testnet: 'testnet',
  signet: 'signet',
  regtest: 'regtest',
};

/**
 * The single place the loopback invariant lives: every listener this launcher
 * creates binds 127.0.0.1. The unit suite fails the build if any generated
 * line ever binds a non-loopback interface.
 */
export function buildLitdConfig(options: LitdSidecarOptions): ResolvedLitdConfig {
  const rpcPort = options.rpcPort ?? DEFAULT_RPC_PORT;
  const uiPort = options.uiPort ?? DEFAULT_UI_PORT;
  const litDir = options.dataDir;
  const lndDir = `${litDir}/lnd`;
  const tlsCertPath = `${litDir}/tls.cert`;
  const confPath = `${litDir}/lit.conf`;

  const publicLines: string[] = [];
  const secretLines: string[] = [];

  // --- litd top-level surface (loopback only) ---
  publicLines.push('rpclisten=127.0.0.1:' + rpcPort);
  publicLines.push('httpslisten=127.0.0.1:' + uiPort);
  publicLines.push(`tlscertpath=${tlsCertPath}`);
  publicLines.push(`tlskeypath=${litDir}/tls.key`);
  publicLines.push('tlsextraip=127.0.0.1');

  let adminMacaroonPath: string;

  if (options.backend.kind === 'remote-lnd') {
    // Remote mode: litd starts no local lnd — it proxies the user's node.
    // The remote node's network governs; do not pass network or lnd.* flags.
    publicLines.push('lnd-mode=remote');
    publicLines.push(`remote.lnd.rpcserver=${options.backend.rpcServer}`);
    publicLines.push(`remote.lnd.macaroonpath=${options.backend.macaroonPath}`);
    publicLines.push(`remote.lnd.tlscertpath=${options.backend.tlsCertPath}`);
    adminMacaroonPath = options.backend.macaroonPath;
  } else {
    // Integrated mode: lnd runs in-process, flags prefixed with `lnd.`.
    publicLines.push('lnd-mode=integrated');
    publicLines.push(`network=${options.network}`);
    publicLines.push(`lnd.lnddir=${lndDir}`);
    // In-process lnd keeps its own listeners loopback-only; the wallet-facing
    // surface is the litd mux above.
    publicLines.push('lnd.listen=127.0.0.1:0');
    publicLines.push('lnd.norest=true');
    publicLines.push('lnd.tlsextraip=127.0.0.1');
    adminMacaroonPath = `${lndDir}/data/chain/bitcoin/${NETWORK_FLAG[options.network]}/admin.macaroon`;

    if (options.backend.kind === 'neutrino') {
      publicLines.push('lnd.bitcoin.active=true');
      publicLines.push(`lnd.bitcoin.${NETWORK_FLAG[options.network]}=true`);
      publicLines.push('lnd.bitcoin.node=neutrino');
      publicLines.push('lnd.neutrino.active=true');
      for (const peer of options.backend.peers ?? []) {
        publicLines.push(`lnd.neutrino.connect=${peer}`);
      }
    } else {
      // bitcoind-rpc: the user's own full node.
      publicLines.push('lnd.bitcoin.active=true');
      publicLines.push(`lnd.bitcoin.${NETWORK_FLAG[options.network]}=true`);
      publicLines.push('lnd.bitcoin.node=bitcoind');
      publicLines.push(`lnd.bitcoind.rpchost=${options.backend.rpcHost}`);
      publicLines.push(`lnd.bitcoind.rpcuser=${options.backend.rpcUser}`);
      secretLines.push(`lnd.bitcoind.rpcpass=${options.backend.rpcPass}`);
      publicLines.push(`lnd.bitcoind.zmqpubrawblock=${options.backend.zmqRawBlock}`);
      publicLines.push(`lnd.bitcoind.zmqpubrawtx=${options.backend.zmqRawTx}`);
    }
  }

  const uiPassword = options.uiPassword ?? generateUiPassword();
  secretLines.push(`uipassword=${uiPassword}`);

  for (const extra of options.extraLndArgs ?? []) {
    if (!extra.startsWith('lnd.')) {
      throw new Error(`extraLndArgs entries must be prefixed with "lnd." (got: ${extra})`);
    }
    publicLines.push(extra);
  }

  return {
    args: [`--lit-dir=${litDir}`],
    confLines: [...publicLines, ...secretLines],
    confPath,
    litDir,
    tlsCertPath,
    adminMacaroonPath,
    rpcHost: '127.0.0.1',
    rpcPort,
  };
}

/** Random UI password for the local-only litd UI (not a user-facing secret). */
export function generateUiPassword(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Guards the loopback invariant over the full generated config. Exported so
 * tests (and any future caller) assert against one canonical rule.
 */
export function assertLoopbackOnly(config: ResolvedLitdConfig): void {
  const forbidden = /=\s*(0\.0\.0\.0(?!\.)|\[::\]|::0)/;
  for (const line of config.confLines) {
    if (forbidden.test(line)) {
      throw new Error(`loopback invariant violated by config line: ${line}`);
    }
  }
  for (const arg of config.args) {
    if (arg.includes('0.0.0.0')) {
      throw new Error(`loopback invariant violated by arg: ${arg}`);
    }
  }
}
