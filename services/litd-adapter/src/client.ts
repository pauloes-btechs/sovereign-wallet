/**
 * gRPC client factory for the local litd sidecar (and remote-litd mux).
 *
 * Desktop RPC is loopback-bound TLS with macaroon call credentials — the
 * protobuf-ts clients are generated from the LND protos pinned to litd
 * v0.17.8 (packages/litd-proto). No grpc-web anywhere on this path.
 */
import { CallCredentials, ChannelCredentials, Client, Metadata } from '@grpc/grpc-js';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { GenSeedRequest, GetInfoRequest, LightningClient, RouterClient, WalletUnlockerClient } from '@sovereign/litd-proto';
import { readFile } from 'node:fs/promises';

import type { ResolvedLitdConfig } from './config.js';

export interface LitdConnectionOptions {
  readonly rpcHost: string;
  readonly rpcPort: number;
  readonly tlsCertPath: string;
  /** Admin macaroon file path (read as hex for the `macaroon` gRPC header). */
  /** Path to a macaroon file. Omit for the WalletUnlocker surface, which
   * serves BEFORE wallet init — no macaroon exists until InitWallet mints
   * one, so unlocker clients must never require it. */
  readonly macaroonPath?: string;
  /** Overrides macaroonPath when the macaroon is already in memory (hex). */
  readonly macaroonHex?: string;
}

export function connectionOptionsFromConfig(config: ResolvedLitdConfig): LitdConnectionOptions {
  return {
    rpcHost: config.rpcHost,
    rpcPort: config.rpcPort,
    tlsCertPath: config.tlsCertPath,
    macaroonPath: config.adminMacaroonPath,
  };
}

export async function readMacaroonHex(options: LitdConnectionOptions): Promise<string | undefined> {
  if (options.macaroonHex !== undefined) {
    return options.macaroonHex;
  }
  if (options.macaroonPath === undefined) {
    return undefined;
  }
  return (await readFile(options.macaroonPath)).toString('hex');
}

function macaroonCallCredentials(macaroonHex: string): CallCredentials {
  return CallCredentials.createFromMetadataGenerator((_options, callback) => {
    const metadata = new Metadata();
    metadata.add('macaroon', macaroonHex);
    callback(null, metadata);
  });
}

export async function createLitdTransport(options: LitdConnectionOptions): Promise<GrpcTransport> {
  const rootCert = await readFile(options.tlsCertPath);
  let channelCredentials = ChannelCredentials.createSsl(rootCert);
  const macaroonHex = await readMacaroonHex(options);
  if (macaroonHex !== undefined) {
    channelCredentials = channelCredentials.compose(macaroonCallCredentials(macaroonHex));
  }
  return new GrpcTransport({
    host: `${options.rpcHost}:${options.rpcPort}`,
    channelCredentials,
  });
}

export async function createLightningClient(options: LitdConnectionOptions): Promise<LightningClient> {
  // Every Lightning RPC needs the macaroon — without it lnd answers
  // "permission denied", which is a config error, not a transient state.
  if (options.macaroonHex === undefined && options.macaroonPath === undefined) {
    throw new Error('Lightning client requires a macaroon: set macaroonPath or macaroonHex');
  }
  return new LightningClient(await createLitdTransport(options));
}

/** Router client for SendPaymentV2 payment streams (same macaroon rules). */
export async function createRouterClient(options: LitdConnectionOptions): Promise<RouterClient> {
  if (options.macaroonHex === undefined && options.macaroonPath === undefined) {
    throw new Error('Router client requires a macaroon: set macaroonPath or macaroonHex');
  }
  return new RouterClient(await createLitdTransport(options));
}

/** Connection options for a pre-init wallet: no macaroon exists yet, so
 * never attach one (the Unlocker serves before InitWallet mints any). */
function withoutMacaroon(options: LitdConnectionOptions): LitdConnectionOptions {
  return { ...options, macaroonPath: undefined, macaroonHex: undefined };
}

export async function createWalletUnlockerClient(options: LitdConnectionOptions): Promise<WalletUnlockerClient> {
  return new WalletUnlockerClient(await createLitdTransport(withoutMacaroon(options)));
}

/**
 * Probe until the litd gRPC endpoint accepts connections (TLS + HTTP/2
 * handshake). Independent of wallet state: before InitWallet only the
 * WalletUnlocker service answers, but the channel comes up the same way.
 */
export function probeRpcReady(
  options: Pick<LitdConnectionOptions, 'rpcHost' | 'rpcPort' | 'tlsCertPath'>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    readFile(options.tlsCertPath)
      .then((rootCert) => {
        const client = new Client(`${options.rpcHost}:${options.rpcPort}`, ChannelCredentials.createSsl(rootCert));
        // grpc-js deadlines are epoch milliseconds; callers pass a timeout.
        client.waitForReady(Date.now() + timeoutMs, (err?: Error) => {
          client.close();
          if (err) {
            reject(new Error(`litd RPC not ready within deadline: ${err.message}`));
          } else {
            resolve();
          }
        });
      })
      .catch(reject);
  });
}

/** Errors that prove a service is REGISTERED and legitimately refusing —
 * positive evidence the RPC surface is up (used by waitForServices to
 * distinguish "not started yet" from "up but rejecting this call"). */
const SERVICE_UP_EVIDENCE = /already unlocked|wallet locked/i;

/**
 * Wait until litd's RPC services actually serve. The TLS channel accepts
 * connections seconds before the sub-servers register, and calls in that
 * window fail with transient startup errors ("waiting to start, RPC
 * services not available", dropped connections) whose text varies by which
 * layer drops the call — so the gate resolves only on positive evidence:
 * the canary call SUCCEEDS, or fails with an error that proves the service
 * is up and legitimately refusing (e.g. "wallet already unlocked" means
 * the Unlocker registered, served, and retired because a wallet exists).
 * Everything else — including unknown transport errors — retries until
 * the deadline, and the timeout carries the last error for diagnosis.
 */
export async function waitForServices(
  options: LitdConnectionOptions,
  surface: 'unlocker' | 'lightning',
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    const outcome = await canaryCall(options, surface).then(
      () => 'serving' as const,
      (err: unknown) => {
        lastErr = err instanceof Error ? err.message : String(err);
        return SERVICE_UP_EVIDENCE.test(lastErr) ? ('serving' as const) : ('starting' as const);
      },
    );
    if (outcome === 'serving') {
      return;
    }
    await sleep(250);
  }
  throw new Error(`litd RPC services not serving within ${timeoutMs}ms: ${lastErr}`);
}

/** One canary call on the given surface. Throws when services are down.
 * Closes the underlying transport (the generated client has no close()). */
async function canaryCall(options: LitdConnectionOptions, surface: 'unlocker' | 'lightning'): Promise<void> {
  // Unlocker canary: pre-init surface — same no-macaroon rule as the
  // factory, since the admin macaroon is minted only by InitWallet.
  const transport = await createLitdTransport(
    surface === 'unlocker' ? withoutMacaroon(options) : options,
  );
  try {
    if (surface === 'unlocker') {
      await new WalletUnlockerClient(transport).genSeed(GenSeedRequest.create({})).response;
      return;
    }
    await new LightningClient(transport).getInfo(GetInfoRequest.create({})).response;
  } finally {
    transport.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
