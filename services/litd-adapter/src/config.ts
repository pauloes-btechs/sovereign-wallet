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
import { createServer } from 'node:net';

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
  /**
   * Bake a disk super macaroon at startup (litrpc admin surface auth for
   * session management — LNC session create/list/revoke). litd bakes it
   * once its sub-servers start; the file lives in the lit dir.
   */
  readonly superMacaroon?: { readonly bake: 'read-write' | 'read-only' };
  /** Extra LND flags, already prefixed with `lnd.`, appended to lit.conf. */
  readonly extraLndArgs?: readonly string[];
  /** Extra sub-server conf lines, already prefixed `loop.` or `pool.`, plus
   * litd's sub-server mode gates (`loop-mode=`, `pool-mode=`), appended to
   * lit.conf. The mode gates do NOT default to `integrated` — without an
   * explicit `loop-mode=integrated`/`pool-mode=integrated` the bundled
   * loopd/poold never start, so the wallet-facing gRPC mux answers every
   * Loop/Pool RPC with "unknown service" (verified against the pinned
   * v0.17.8 binary: synced chain, no registration, forever). Regtest/signet
   * suites pin the Loop swap server and Pool auctioneer to a dead loopback
   * endpoint so the daemon never contacts the real mainnet operators
   * (spec: autonomous runs stay on regtest/signet with offline operators). */
  readonly extraSubServerArgs?: readonly string[];
}

export interface ResolvedLitdConfig {
  /** Full argv for the litd process. */
  readonly args: readonly string[];
  /** Secret-bearing lit.conf lines (also written to disk at 0600). */
  readonly confLines: readonly string[];
  readonly confPath: string;
  readonly litDir: string;
  /** TLS cert presented by the wallet-facing gRPC endpoint. Integrated: the
   * embedded LND's (`<lnddir>/tls.cert`); remote: litd's own proxy cert. */
  readonly tlsCertPath: string;
  /** Admin macaroon path. Integrated: inside the lnd dir. Remote: as given. */
  readonly adminMacaroonPath: string;
  /** Baked super macaroon path, when requested via superMacaroon. */
  readonly superMacaroonPath?: string;
  readonly rpcHost: '127.0.0.1';
  readonly rpcPort: number;
  /**
   * tapd asset surface (integrated mode only): litd's bundled Taproot
   * Assets sub-server serves its gRPC through litd's proxy mux
   * (`httpslisten`) with litd's TLS, authenticated by tapd's OWN admin
   * macaroon (tapd permissions, rooted at the shared LND root key).
   * Undefined in remote mode — a remote litd would need its own tapd
   * configured upstream (not this sidecar's job).
   */
  readonly tapd?: ResolvedTapdEndpoint;
}

/** The tapd asset RPC endpoint exposed by an integrated litd. */
export interface ResolvedTapdEndpoint {
  readonly rpcHost: '127.0.0.1';
  /** The litd proxy port (the `httpslisten` UI port). */
  readonly rpcPort: number;
  /** litd's own TLS cert — the proxy presents it, not the embedded LND's. */
  readonly tlsCertPath: string;
  /** tapd's admin macaroon, pinned under the lit dir. */
  readonly macaroonPath: string;
}

export const DEFAULT_RPC_PORT = 10_009;
export const DEFAULT_UI_PORT = 8443;

/**
 * Ask the kernel for a free loopback port (bind 127.0.0.1:0, read, release).
 * Launching on a kernel-assigned port avoids colliding with anything already
 * listening on the litd/LND default ports — a user's own LND on 10009, or a
 * regtest harness's host port mapping in CI.
 */
export function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close();
        reject(new Error('kernel assigned no TCP port for the loopback listener'));
        return;
      }
      server.close(() => resolve(addr.port));
    });
  });
}

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
  // NOTE: litd's own config has NO `rpclisten` option (verified against the
  // pinned binary's --help and its config-load error). The wallet-facing
  // gRPC listener belongs to the embedded LND (`lnd.rpclisten` in
  // integrated mode) or to litd's TLS proxy (`httpslisten`, remote mode).
  publicLines.push('httpslisten=127.0.0.1:' + uiPort);
  publicLines.push(`tlscertpath=${tlsCertPath}`);
  publicLines.push(`tlskeypath=${litDir}/tls.key`);
  publicLines.push('tlsextraip=127.0.0.1');

  let adminMacaroonPath: string;
  // TLS cert presented by the wallet-facing gRPC endpoint, and the port it
  // serves on — mode-dependent, resolved below.
  let rpcTlsCertPath: string;
  let servingRpcPort: number;
  // The tapd asset surface — resolved in integrated mode only.
  let tapdEndpoint: ResolvedTapdEndpoint | undefined;

  // litd's own network must match the backend's: in remote mode lndclient's
  // compatibility check compares litd's configured network against the remote
  // node's actual network and fails with "network mismatch" when they differ
  // (litd defaults to mainnet when no network is set). Verified against the
  // pinned v0.17.8 startup path (setupFullLNDClient → NewLndServices).
  publicLines.push(`network=${options.network}`);

  // Autopilot has no Loop server addresses on regtest/signet, so its start()
  // aborts — in BOTH modes (integrated: before the embedded LND launches;
  // remote: before the Lit sub-server starts). Verified against the pinned
  // v0.17.8 binary in both modes. Disable it on those networks.
  if (options.network === 'regtest' || options.network === 'signet') {
    publicLines.push('autopilot.disable=true');
  }

  if (options.backend.kind === 'remote-lnd') {
    // Remote mode: litd starts no local lnd — it proxies the user's node.
    // The remote node's network governs; pass no lnd.* flags.
    publicLines.push('lnd-mode=remote');
    publicLines.push(`remote.lnd.rpcserver=${options.backend.rpcServer}`);
    publicLines.push(`remote.lnd.macaroonpath=${options.backend.macaroonPath}`);
    publicLines.push(`remote.lnd.tlscertpath=${options.backend.tlsCertPath}`);
    adminMacaroonPath = options.backend.macaroonPath;
    // litd's remote-mode proxy serves the LND API on its own TLS listener
    // (httpslisten), presenting litd's certificate.
    rpcTlsCertPath = tlsCertPath;
    servingRpcPort = uiPort;
  } else {
    // Integrated mode: lnd runs in-process, flags prefixed with `lnd.`.
    publicLines.push('lnd-mode=integrated');
    publicLines.push(`lnd.lnddir=${lndDir}`);
    // The embedded LND serves the raw wallet gRPC (LND protos, LND
    // macaroons, LND TLS) on its own listener — the surface the compose
    // harness exposes and the pinned-protobuf clients speak.
    publicLines.push(`lnd.rpclisten=127.0.0.1:${rpcPort}`);
    // In-process lnd keeps its other listeners loopback-only.
    publicLines.push('lnd.listen=127.0.0.1:0');
    publicLines.push('lnd.norest=true');
    publicLines.push('lnd.tlsextraip=127.0.0.1');
    adminMacaroonPath = `${lndDir}/data/chain/bitcoin/${NETWORK_FLAG[options.network]}/admin.macaroon`;
    // LND defaults its TLS to <lnddir>/tls.cert — the root cert the gRPC
    // client pins.
    rpcTlsCertPath = `${lndDir}/tls.cert`;
    servingRpcPort = rpcPort;

    // The integrated tapd sub-server: pin its data dir under the lit dir
    // (upstream defaults to ~/.tapd — OUTSIDE the lit dir, so asset state
    // would be lost on restore/relocate) and its macaroon path with it.
    // tapd inherits the network from litd (litd sets
    // TaprootAssets.ChainConf.Network itself); no network key is emitted.
    const tapdDir = `${litDir}/tapd`;
    const tapdMacaroonPath = `${tapdDir}/${NETWORK_FLAG[options.network]}/admin.macaroon`;
    publicLines.push(`taproot-assets.tapddir=${tapdDir}`);
    publicLines.push(`taproot-assets.macaroonpath=${tapdMacaroonPath}`);
    tapdEndpoint = {
      rpcHost: '127.0.0.1',
      rpcPort: uiPort,
      tlsCertPath, // litd's own proxy cert, NOT the embedded LND's
      macaroonPath: tapdMacaroonPath,
    };

    if (options.backend.kind === 'neutrino') {
      publicLines.push('lnd.bitcoin.active=true');
      publicLines.push(`lnd.bitcoin.${NETWORK_FLAG[options.network]}=true`);
      // bitcoin.node=neutrino alone selects the Neutrino backend — lnd has
      // no `neutrino.active` option (the embedded v0.21.5 parser rejects
      // it as unknown; verified via local launch).
      publicLines.push('lnd.bitcoin.node=neutrino');
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

  // Disk super macaroon: session administration (LNC create/revoke) runs
  // through the litd proxy and needs a macaroon the admin side can read.
  let superMacaroonPath: string | undefined;
  if (options.superMacaroon) {
    superMacaroonPath = `${litDir}/super.macaroon`;
    publicLines.push(`bake-super-macaroon=${options.superMacaroon.bake}`);
    publicLines.push(`super-macaroon-path=${superMacaroonPath}`);
  }

  for (const extra of options.extraLndArgs ?? []) {
    if (!extra.startsWith('lnd.')) {
      throw new Error(`extraLndArgs entries must be prefixed with "lnd." (got: ${extra})`);
    }
    publicLines.push(extra);
  }

  for (const extra of options.extraSubServerArgs ?? []) {
    const modeGate = /^loop-mode=|^pool-mode=/.test(extra);
    if (!modeGate && !extra.startsWith('loop.') && !extra.startsWith('pool.')) {
      throw new Error(
        `extraSubServerArgs entries must be prefixed with "loop.", "pool.", "loop-mode=", or "pool-mode=" (got: ${extra})`,
      );
    }
    publicLines.push(extra);
  }

  return {
    args: [`--lit-dir=${litDir}`],
    confLines: [...publicLines, ...secretLines],
    confPath,
    litDir,
    tlsCertPath: rpcTlsCertPath,
    adminMacaroonPath,
    rpcHost: '127.0.0.1',
    rpcPort: servingRpcPort,
    superMacaroonPath,
    tapd: tapdEndpoint,
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
