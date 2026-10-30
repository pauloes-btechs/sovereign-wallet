import http from 'node:http';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  CallCredentials,
  ChannelCredentials,
  Client,
  Metadata,
} from '@grpc/grpc-js';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import {
  GenSeedRequest,
  GetInfoRequest,
  LightningClient,
  InitWalletRequest,
  UnlockWalletRequest,
  WalletUnlockerClient,
} from '@sovereign/litd-proto';

/**
 * Regtest harness helpers. REGTEST ONLY — every function here would be
 * dangerous against a real chain (throwaway credentials, generous mining,
 * fixed passwords). Guard rails live in the tests that use them.
 */

const thisFile = fileURLToPath(import.meta.url);
// dist/harness.js -> package root (harness/regtest)
const PACKAGE_ROOT = path.resolve(path.dirname(thisFile), '..');
export const HARNESS_ROOT = process.env['SOVEREIGN_HARNESS_DIR'] ?? PACKAGE_ROOT;

export const HARNESS_DATA_DIR = path.join(HARNESS_ROOT, 'data');

export const BITCOIND = {
  host: '127.0.0.1',
  rpcPort: 18443,
  p2pPort: 18444,
  user: 'regtest',
  pass: 'regtest',
} as const;

/** Host port of the pinned host-side btcd filter server (BIP157). */
export const BTCD_FILTER_PORT = 18555;

/** Host-published P2P port of lnd-alice (compose maps 19735 -> 9735). */
export const ALICE_P2P_PORT = 19735;

export const HARNESS_WALLET_PASSWORD = 'harness-regtest-password';

export interface HarnessNode {
  readonly name: string;
  readonly rpcHost: string;
  readonly rpcPort: number;
  /** lnd datadir on the host (TLS cert + macaroons land here). */
  readonly dataDir: string;
}

function node(name: string, rpcPort: number): HarnessNode {
  return { name, rpcHost: '127.0.0.1', rpcPort, dataDir: path.join(HARNESS_DATA_DIR, name) };
}

/** Full-node LND — remote-LND test target (rpcmiddleware enabled). */
export const ALICE: HarnessNode = node('lnd-alice', 10009);
/** Second full-node LND — channel/Loop peer. */
export const BOB: HarnessNode = node('lnd-bob', 10010);
/** litd container's embedded LND datadir (integrated mode, bitcoind backend). */
export const LITD: HarnessNode = node('litd-lnd', 10011);

export const HARNESS_NODES: readonly HarnessNode[] = [ALICE, BOB, LITD];

export function tlsCertPath(n: HarnessNode): string {
  return path.join(n.dataDir, 'tls.cert');
}

export function adminMacaroonPath(n: HarnessNode): string {
  return path.join(n.dataDir, 'data', 'chain', 'bitcoin', 'regtest', 'admin.macaroon');
}

// ---------------------------------------------------------------------------
// bitcoind RPC
// ---------------------------------------------------------------------------

function bitcoinRpcRequest<T>(method: string, params: unknown[]): Promise<T> {
  const payload = JSON.stringify({ jsonrpc: '1.0', id: 'harness', method, params });
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        host: BITCOIND.host,
        port: BITCOIND.rpcPort,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Basic ${Buffer.from(`${BITCOIND.user}:${BITCOIND.pass}`).toString('base64')}`,
        },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              result?: T;
              error?: { message: string } | null;
            };
            if (body.error) {
              reject(new Error(`bitcoin RPC ${method} failed: ${body.error.message}`));
            } else {
              resolve(body.result as T);
            }
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`bitcoin RPC ${method} timed out`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export interface BlockchainInfo {
  blocks: number;
  chain: string;
}

export function getBlockchainInfo(): Promise<BlockchainInfo> {
  return bitcoinRpcRequest<BlockchainInfo>('getblockchaininfo', []);
}

export async function waitForBitcoinReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await getBlockchainInfo();
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`bitcoind not reachable on ${BITCOIND.host}:${BITCOIND.rpcPort} within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export async function ensureBitcoinWallet(name: string): Promise<void> {
  const wallets = await bitcoinRpcRequest<string[]>('listwallets', []);
  if (!wallets.includes(name)) {
    // createwallet takes the wallet name as a positional string arg —
    // named-style object params make bitcoind reject the call.
    await bitcoinRpcRequest('createwallet', [name]);
  }
}

/** Mines `count` regtest blocks to a fresh harness-wallet address. */
export async function mineBlocks(count: number): Promise<string[]> {
  const address = await bitcoinRpcRequest<string>('getnewaddress', []);
  return bitcoinRpcRequest<string[]>('generatetoaddress', [count, address]);
}

/** Fresh address owned by the bitcoind harness wallet. */
export async function getNewAddress(): Promise<string> {
  return bitcoinRpcRequest<string>('getnewaddress', []);
}

/** Sends from the bitcoind harness wallet; returns the txid. */
export async function bitcoinSendTo(address: string, amountBtc: number): Promise<string> {
  return bitcoinRpcRequest<string>('sendtoaddress', [address, amountBtc]);
}

/**
 * Waits until `txid` is present in bitcoind's mempool. A wallet-side
 * broadcast (litd → btcd relay → bitcoind) lands asynchronously after
 * SendCoins returns, so callers must wait before mining or the tx misses
 * the generated blocks and the wallet's funds stay unconfirmed.
 */
export async function waitForTxInMempool(txid: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mempool = await bitcoinRpcRequest<string[]>('getrawmempool', []);
    if (mempool.includes(txid)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`txid ${txid} not in bitcoind mempool within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Seeds the chain so coinbase outputs are mature and spendable
 * (100-block coinbase maturity + headroom).
 */
export async function seedChain(minHeight = 110): Promise<number> {
  const info = await getBlockchainInfo();
  if (info.blocks < minHeight) {
    await mineBlocks(minHeight - info.blocks);
  }
  return getBlockchainInfo().then((i) => i.blocks);
}

// ---------------------------------------------------------------------------
// Harness-node gRPC (TLS + macaroon from the lnd datadir on the host)
// ---------------------------------------------------------------------------

function macaroonCallCredentials(hex: string): CallCredentials {
  return CallCredentials.createFromMetadataGenerator((_options, callback) => {
    const metadata = new Metadata();
    metadata.add('macaroon', hex);
    callback(null, metadata);
  });
}

async function nodeChannelCredentials(n: HarnessNode): Promise<ChannelCredentials> {
  const cert = await readFile(tlsCertPath(n));
  let creds = ChannelCredentials.createSsl(cert);
  try {
    const macaroon = await readFile(adminMacaroonPath(n));
    creds = creds.compose(macaroonCallCredentials(macaroon.toString('hex')));
  } catch {
    // No macaroon yet (wallet not initialized) — connect without it; the
    // wallet unlocker endpoints are open pre-init by design.
  }
  return creds;
}

export async function makeTransport(n: HarnessNode): Promise<GrpcTransport> {
  return new GrpcTransport({
    host: `${n.rpcHost}:${n.rpcPort}`,
    channelCredentials: await nodeChannelCredentials(n),
  });
}

export async function makeLightningClient(n: HarnessNode): Promise<LightningClient> {
  return new LightningClient(await makeTransport(n));
}

export async function makeUnlockerClient(n: HarnessNode): Promise<WalletUnlockerClient> {
  return new WalletUnlockerClient(await makeTransport(n));
}

/** Waits until the node's RPC endpoint accepts connections. */
export async function waitForRpcReady(n: HarnessNode, timeoutMs: number): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(tlsCertPath(n));
      const cert = await readFile(tlsCertPath(n));
      await new Promise<void>((resolve, reject) => {
        const client = new Client(`${n.rpcHost}:${n.rpcPort}`, ChannelCredentials.createSsl(cert));
        client.waitForReady(deadlineMs, (err?: Error) => {
          client.close();
          if (err) {
            reject(new Error(`${n.name} RPC not ready within deadline: ${err.message}`));
          } else {
            resolve();
          }
        });
      });
      return;
    } catch (err) {
      if (Date.now() > deadlineMs) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export type WalletState = 'initialized' | 'unlocked';

/**
 * Unlocker RPCs that mean "the wallet is already in the state we wanted":
 * lnd unregisters the WalletUnlocker service the moment a wallet becomes
 * unlocked, so ANY unlocker call against a ready wallet fails with
 * "wallet already unlocked, WalletUnlocker service is no longer available",
 * and initWallet against an existing wallet fails with "already exists".
 * A bootstrap that races a prior bootstrap (the CI workflow step, or a
 * parallel vitest worker's beforeAll) must treat those as success.
 */
const WALLET_ALREADY_READY =
  /already unlocked|already initialized|already exists|WalletUnlocker service is no longer available/i;

/** Exported for tests. Matches only the idempotency errors — never others. */
export function isWalletAlreadyReady(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return WALLET_ALREADY_READY.test(message);
}

export async function initOrUnlockWallet(n: HarnessNode): Promise<WalletState> {
  const transport = await makeTransport(n);
  const unlocker = new WalletUnlockerClient(transport);
  try {
    let macaroonExists = false;
    try {
      await access(adminMacaroonPath(n));
      macaroonExists = true;
    } catch {
      macaroonExists = false;
    }
    if (macaroonExists) {
      // The macaroon proves the wallet was initialized at SOME point, not
      // that it is locked right now. When a previous bootstrap (the workflow
      // step, or a parallel vitest worker) left it unlocked, the unlocker
      // service is unregistered and unlockWallet fails with the
      // already-ready error — the success outcome, not a failure. A
      // genuinely wrong password does not match and is surfaced.
      try {
        await unlocker
          .unlockWallet(
            UnlockWalletRequest.create({
              walletPassword: Buffer.from(HARNESS_WALLET_PASSWORD, 'utf8'),
              recoveryWindow: 0,
            }),
          )
          .response;
        return 'unlocked';
      } catch (err) {
        if (!isWalletAlreadyReady(err)) throw err;
        return 'unlocked';
      }
    }
    try {
      const seed = await unlocker.genSeed(GenSeedRequest.create({})).response;
      await unlocker
        .initWallet(
          InitWalletRequest.create({
            walletPassword: Buffer.from(HARNESS_WALLET_PASSWORD, 'utf8'),
            cipherSeedMnemonic: seed.cipherSeedMnemonic,
            aezeedPassphrase: new Uint8Array(0),
            recoveryWindow: 0,
            statelessInit: false,
          }),
        )
        .response;
      return 'initialized';
    } catch (err) {
      // Lost an init race, or the wallet reached an initialized state
      // between the macaroon check and here: the wallet now exists in the
      // state the bootstrap wanted. Anything else is a real error.
      if (!isWalletAlreadyReady(err)) throw err;
      return 'initialized';
    }
  } finally {
    transport.close();
  }
}

export async function getNodeInfo(n: HarnessNode): Promise<{ identityPubkey: string; syncedToChain: boolean; blockHeight: number }> {
  const client = await makeLightningClient(n);
  const info = await client.getInfo(GetInfoRequest.create({})).response;
  return { identityPubkey: info.identityPubkey, syncedToChain: info.syncedToChain, blockHeight: info.blockHeight };
}

export interface BootstrapStatus {
  bitcoinBlocks: number;
  wallets: Record<string, WalletState>;
}

/**
 * Brings the harness to a known state: bitcoind up, wallet "harness",
 * >= 110 matured blocks, and initialized/unlocked wallets on every node.
 */
export async function bootstrapHarness(): Promise<BootstrapStatus> {
  await waitForBitcoinReady(60_000);
  await ensureBitcoinWallet('harness');
  const bitcoinBlocks = await seedChain(110);
  const wallets: Record<string, WalletState> = {};
  for (const n of HARNESS_NODES) {
    await waitForRpcReady(n, 60_000);
    wallets[n.name] = await initOrUnlockWallet(n);
  }
  return { bitcoinBlocks, wallets };
}
