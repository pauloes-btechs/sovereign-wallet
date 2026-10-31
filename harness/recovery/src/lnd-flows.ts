/**
 * Shared regtest LND flows for the recovery drills: funding, channel
 * opening, and readiness polls against compose nodes. Regtest only.
 */
import {
  AddressType,
  ConnectPeerRequest,
  GetInfoRequest,
  ListChannelsRequest,
  NewAddressRequest,
  OpenChannelRequest,
  WalletBalanceRequest,
  type ChannelPoint,
  type LightningClient,
} from '@sovereign/litd-proto';

import {
  bitcoinSendTo,
  getBlockchainInfo,
  mineBlocks,
  waitForMempoolNonEmpty,
  waitForTxInMempool,
} from '@sovereign/harness-regtest';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `isDone` holds, else throws with `what`. */
export async function poll<T>(
  fn: () => Promise<T>,
  isDone: (value: T) => boolean,
  what: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (isDone(value)) return value;
    } catch (err) {
      lastErr = err;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (Date.now() > deadline) {
      if (lastErr !== undefined) {
        throw new Error(`timed out waiting for ${what}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
      }
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(1000);
  }
}

/** Waits until a LightningClient answers GetInfo (service registered). */
export async function waitNodeReady(client: LightningClient, what: string, timeoutMs: number): Promise<void> {
  await poll(
    async () => client.getInfo(GetInfoRequest.create({})).response,
    (info) => info.identityPubkey.length > 0,
    `${what} GetInfo to answer`,
    timeoutMs,
  );
}

/**
 * Funds a node's on-chain wallet from the harness bitcoind wallet. Only
 * proceeds once the node has synced to the chain tip — a balance poll that
 * races the sync expires before the funding tx is ever scanned (the proven
 * sync-gate pattern from the sidecar suite).
 */
export async function fundFromHarness(
  client: LightningClient,
  amountBtc: number,
  what: string,
): Promise<void> {
  const tip = (await getBlockchainInfo()).blocks;
  await poll(
    async () => client.getInfo(GetInfoRequest.create({})).response,
    (info) => info.syncedToChain && info.blockHeight >= tip - 2,
    `${what} chain sync (target height ~${tip})`,
    240_000,
  );
  const address = (
    await client.newAddress(NewAddressRequest.create({ type: AddressType.WITNESS_PUBKEY_HASH }))
  ).response.address;
  const txid = await bitcoinSendTo(address, amountBtc);
  await waitForTxInMempool(txid);
  await mineBlocks(3);
  await poll(
    async () => (await client.walletBalance(WalletBalanceRequest.create({})).response).confirmedBalance,
    (confirmed) => confirmed >= BigInt(Math.round(amountBtc * 1e8 * 0.99)),
    `${what} confirmed wallet balance >= ${amountBtc} BTC`,
    120_000,
  );
}

/**
 * Connects `payer` to `payee` (host as reachable from the payer's container,
 * e.g. 'lnd-bob:9735'), opens `amountSat` to it, and waits for the channel
 * to go active. Returns the funding ChannelPoint (reused for force-close).
 */
export async function openChannelActive(
  payer: LightningClient,
  payeePubKeyHex: string,
  payeeHost: string,
  amountSat: number,
): Promise<ChannelPoint> {
  await payer.connectPeer(
    ConnectPeerRequest.create({ addr: { pubkey: payeePubKeyHex, host: payeeHost } }),
  ).response;
  const channelPoint = (
    await payer
      .openChannelSync(
        OpenChannelRequest.create({
          nodePubkey: Uint8Array.from(Buffer.from(payeePubKeyHex, 'hex')),
          localFundingAmount: BigInt(amountSat),
        }),
      )
      .response
  );
  await mineBlocks(3);
  await poll(
    async () => (await payer.listChannels(ListChannelsRequest.create({}))).response.channels,
    (channels) => channels.some((c) => c.active),
    `the new ${amountSat}-sat channel to activate`,
    120_000,
  );
  return channelPoint;
}

/** Waits for any transaction to hit the mempool (unilateral close broadcast). */
export async function waitForCloseBroadcast(timeoutMs: number): Promise<void> {
  await waitForMempoolNonEmpty(1, timeoutMs);
}

/** Polls a node's wallet for a confirmed on-chain balance target. */
export async function awaitOnchainFunds(
  client: LightningClient,
  targetSat: bigint,
  what: string,
  timeoutMs: number,
): Promise<bigint> {
  return poll(
    async () => {
      // Mining in batches keeps the CSV wait fast; 20 blocks ≈ a second.
      await mineBlocks(20);
      return (await client.walletBalance(WalletBalanceRequest.create({})).response).confirmedBalance;
    },
    (confirmed) => confirmed >= targetSat,
    what,
    timeoutMs,
  );
}
