/**
 * gRPC client factory for the local litd sidecar (and remote-litd mux).
 *
 * Desktop RPC is loopback-bound TLS with macaroon call credentials — the
 * protobuf-ts clients are generated from the LND protos pinned to litd
 * v0.17.8 (packages/litd-proto). No grpc-web anywhere on this path.
 */
import { CallCredentials, ChannelCredentials, Client, Metadata } from '@grpc/grpc-js';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { LightningClient, WalletUnlockerClient } from '@sovereign/litd-proto';
import { readFile } from 'node:fs/promises';

import type { ResolvedLitdConfig } from './config.js';

export interface LitdConnectionOptions {
  readonly rpcHost: string;
  readonly rpcPort: number;
  readonly tlsCertPath: string;
  /** Admin macaroon file path (read as hex for the `macaroon` gRPC header). */
  readonly macaroonPath: string;
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

export async function readMacaroonHex(options: LitdConnectionOptions): Promise<string> {
  if (options.macaroonHex !== undefined) {
    return options.macaroonHex;
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
  const macaroonHex = await readMacaroonHex(options);
  const channelCredentials = ChannelCredentials.createSsl(rootCert).compose(
    macaroonCallCredentials(macaroonHex),
  );
  return new GrpcTransport({
    host: `${options.rpcHost}:${options.rpcPort}`,
    channelCredentials,
  });
}

export async function createLightningClient(options: LitdConnectionOptions): Promise<LightningClient> {
  return new LightningClient(await createLitdTransport(options));
}

export async function createWalletUnlockerClient(options: LitdConnectionOptions): Promise<WalletUnlockerClient> {
  return new WalletUnlockerClient(await createLitdTransport(options));
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
