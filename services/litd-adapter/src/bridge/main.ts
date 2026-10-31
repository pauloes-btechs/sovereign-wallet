/**
 * litd-bridge — desktop bridge process entry point.
 *
 * Runs beside the Tauri shell: launches (or attaches to) litd, probes wallet
 * phase, and serves the loopback HTTP/JSON bridge the webview consumes. The
 * rendezvous contract is the bootstrap file written at 0600:
 *
 *   { bridgePort, token, rpcPort, uiPort, network, launched }
 *
 * The shell reads it, passes the token to the webview, and the UI talks to
 * http://127.0.0.1:<bridgePort> with `Authorization: Bearer <token>`.
 *
 * Usage:
 *   tsx main.ts --dataDir=/path --network=regtest --launch \
 *     --litdBinary=/path/to/litd --backend=neutrino
 *   tsx main.ts --dataDir=/path --assume-running --backend=remote-lnd \
 *     --remoteRpcServer=host:port --remoteMacaroon=/path/admin.macaroon \
 *     --remoteTlsCert=/path/tls.cert
 */
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { buildLitdConfig, pickFreeLoopbackPort, type LitdBackendOptions, type LitdNetwork } from '../config.js';
import { launchLitdSidecar, type LaunchedLitd } from '../launcher.js';
import { LitdBridgeSession, createRealBridgeDeps } from './session.js';
import { createLitdBridgeServer } from './server.js';

interface BridgeArgs {
  readonly dataDir: string;
  readonly network: LitdNetwork;
  readonly bridgePort?: number;
  readonly rpcPort?: number;
  readonly uiPort?: number;
  readonly backend: LitdBackendOptions;
  readonly litdBinary?: string;
  readonly launch: boolean;
  readonly assumeRunning: boolean;
  readonly bootstrapPath?: string;
}

function fail(message: string): never {
  process.stderr.write(`litd-bridge: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): BridgeArgs {
  let dataDir: string | undefined;
  let network: LitdNetwork = 'regtest';
  let bridgePort: number | undefined;
  let rpcPort: number | undefined;
  let uiPort: number | undefined;
  let litdBinary: string | undefined;
  let launch = false;
  let assumeRunning = false;
  let bootstrapPath: string | undefined;
  let backendKind: 'neutrino' | 'bitcoind-rpc' | 'remote-lnd' = 'neutrino';
  let neutrinoPeer: string | undefined;
  let remoteRpcServer: string | undefined;
  let remoteMacaroon: string | undefined;
  let remoteTlsCert: string | undefined;
  let bitcoindRpcHost = '';
  let bitcoindRpcUser = '';
  let bitcoindRpcPass = '';
  let bitcoindZmqBlock = '';
  let bitcoindZmqTx = '';

  for (const arg of argv) {
    const [rawKey, ...rest] = arg.replace(/^--/, '').split('=');
    const value = rest.join('=');
    const key = rawKey ?? '';
    switch (key) {
      case 'dataDir': dataDir = value; break;
      case 'network':
        if (value === 'mainnet' || value === 'testnet' || value === 'signet' || value === 'regtest') {
          network = value;
        } else {
          fail(`unsupported network: ${value}`);
        }
        break;
      case 'port': bridgePort = Number(value); break;
      case 'rpcPort': rpcPort = Number(value); break;
      case 'uiPort': uiPort = Number(value); break;
      case 'litdBinary': litdBinary = value; break;
      case 'launch': launch = true; break;
      case 'assume-running': assumeRunning = true; break;
      case 'bootstrap': bootstrapPath = value; break;
      case 'peer': neutrinoPeer = value; break;
      case 'backend':
        if (value === 'neutrino' || value === 'bitcoind-rpc' || value === 'remote-lnd') {
          backendKind = value;
        } else {
          fail(`unsupported backend: ${value}`);
        }
        break;
      case 'remoteRpcServer': remoteRpcServer = value; break;
      case 'remoteMacaroon': remoteMacaroon = value; break;
      case 'remoteTlsCert': remoteTlsCert = value; break;
      case 'bitcoindRpcHost': bitcoindRpcHost = value; break;
      case 'bitcoindRpcUser': bitcoindRpcUser = value; break;
      case 'bitcoindRpcPass': bitcoindRpcPass = value; break;
      case 'bitcoindZmqBlock': bitcoindZmqBlock = value; break;
      case 'bitcoindZmqTx': bitcoindZmqTx = value; break;
      default:
        break;
    }
  }

  if (dataDir === undefined) {
    fail('--dataDir is required');
  }
  if (launch && !assumeRunning && litdBinary === undefined) {
    fail('--litdBinary is required with --launch');
  }
  if (launch && assumeRunning) {
    fail('choose --launch (start a sidecar) or --assume-running (attach), not both');
  }
  const backend: LitdBackendOptions =
    backendKind === 'remote-lnd'
      ? {
          kind: 'remote-lnd',
          rpcServer: remoteRpcServer ?? '',
          macaroonPath: remoteMacaroon ?? '',
          tlsCertPath: remoteTlsCert ?? '',
        }
      : backendKind === 'bitcoind-rpc'
        ? {
            kind: 'bitcoind-rpc',
            rpcHost: bitcoindRpcHost,
            rpcUser: bitcoindRpcUser,
            rpcPass: bitcoindRpcPass,
            zmqRawBlock: bitcoindZmqBlock,
            zmqRawTx: bitcoindZmqTx,
          }
        : { kind: 'neutrino', peers: neutrinoPeer === undefined ? undefined : [neutrinoPeer] };
  if (backend.kind === 'remote-lnd' && (backend.rpcServer === '' || backend.macaroonPath === '' || backend.tlsCertPath === '')) {
    fail('remote-lnd requires --remoteRpcServer, --remoteMacaroon and --remoteTlsCert');
  }
  if (backend.kind === 'bitcoind-rpc' && (backend.rpcPass === '' || backend.zmqRawBlock === '' || backend.zmqRawTx === '')) {
    fail('bitcoind-rpc requires --bitcoindRpcHost/User/Pass and ZMQ endpoints');
  }
  return { dataDir, network, bridgePort, rpcPort, uiPort, backend, litdBinary, launch, assumeRunning, bootstrapPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string) => process.stderr.write(`${line}\n`);

  const token = randomBytes(32).toString('hex');
  const bridgePort = args.bridgePort ?? (await pickFreeLoopbackPort());

  let launched: LaunchedLitd | undefined;
  const config = buildLitdConfig({
    network: args.network,
    dataDir: args.dataDir,
    backend: args.backend,
    rpcPort: args.rpcPort,
    uiPort: args.uiPort,
  });

  if (args.launch) {
    log(`launching litd sidecar (network: ${args.network})`);
    launched = await launchLitdSidecar({
      binaryPath: args.litdBinary ?? 'litd',
      options: {
        network: args.network,
        dataDir: args.dataDir,
        backend: args.backend,
        rpcPort: args.rpcPort,
        uiPort: args.uiPort,
      },
      onLog: log,
    });
  } else {
    log(`attaching to running litd at 127.0.0.1:${config.rpcPort}`);
  }

  const resolvedConfig = launched?.config ?? config;

  const session = new LitdBridgeSession(
    await createRealBridgeDeps({
      connectionOptions: {
        rpcHost: resolvedConfig.rpcHost,
        rpcPort: resolvedConfig.rpcPort,
        tlsCertPath: resolvedConfig.tlsCertPath,
        macaroonPath: resolvedConfig.adminMacaroonPath,
      },
      faraday: {
        rpcPort: resolvedConfig.rpcPort,
        tlsCertPath: resolvedConfig.tlsCertPath,
        macaroonGlobDir: path.dirname(resolvedConfig.adminMacaroonPath),
      },
    }),
  );

  const server = createLitdBridgeServer({ session, token, onLog: log });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(bridgePort, '127.0.0.1', () => resolve());
  });

  const bootstrapPath = args.bootstrapPath ?? path.join(args.dataDir, 'bridge', 'bootstrap.json');
  const bootstrap = {
    bridgePort,
    token,
    rpcPort: resolvedConfig.rpcPort,
    uiPort: args.uiPort ?? 8443,
    network: args.network,
    launched: args.launch,
  };
  await mkdir(path.dirname(bootstrapPath), { recursive: true });
  await writeFile(bootstrapPath, JSON.stringify(bootstrap, null, 2));
  await chmod(bootstrapPath, 0o600);

  log(`litd-bridge listening on 127.0.0.1:${bridgePort} (bootstrap: ${bootstrapPath})`);

  const shutdown = async (signal: string) => {
    log(`received ${signal} — shutting down bridge`);
    server.close();
    if (launched !== undefined) {
      await launched.stop(5_000);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err: unknown) => {
  process.stderr.write(`litd-bridge failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
