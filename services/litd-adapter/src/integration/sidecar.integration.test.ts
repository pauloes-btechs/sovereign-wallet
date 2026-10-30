import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AddressType,
  CloseChannelRequest,
  ConnectPeerRequest,
  GenSeedRequest,
  GetInfoRequest,
  InitWalletRequest,
  ListChannelsRequest,
  NewAddressRequest,
  OpenChannelRequest,
  SendCoinsRequest,
  WalletBalanceRequest,
  type LightningClient,
} from '@sovereign/litd-proto';
import {
  ALICE,
  ALICE_P2P_PORT,
  BTCD_FILTER_PORT,
  bootstrapHarness,
  bitcoinSendTo,
  getBlockchainInfo,
  getNewAddress,
  getNodeInfo,
  HARNESS_WALLET_PASSWORD,
  mineBlocks,
} from '@sovereign/regtest-harness';

import {
  connectionOptionsFromConfig,
  createLightningClient,
  createWalletUnlockerClient,
  launchLitdSidecar,
  probeRpcReady,
  type LaunchedLitd,
  type LitdConnectionOptions,
} from '../index.js';
import { sidecarBinaryPath, sleep } from './helpers.js';

// The full money-flow suite against a REAL litd sidecar binary on the
// regtest harness. Regtest only — this file must never target mainnet.

let launched: LaunchedLitd | undefined;
let conn: LitdConnectionOptions | undefined;
let client: LightningClient | undefined;
let dataDir: string | undefined;
let mnemonic: string[] = [];

async function poll<T>(fn: () => Promise<T>, isDone: (value: T) => boolean, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (isDone(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(1000);
  }
}

beforeAll(async () => {
  await bootstrapHarness();

  dataDir = mkdtempSync(path.join(os.tmpdir(), 'litd-sidecar-'));
  launched = await launchLitdSidecar({
    binaryPath: sidecarBinaryPath(),
    options: {
      network: 'regtest',
      dataDir,
      backend: { kind: 'neutrino', peers: [`127.0.0.1:${BTCD_FILTER_PORT}`] },
    },
  });
  conn = connectionOptionsFromConfig(launched.config);
  await probeRpcReady(conn, 60_000);

  // Wallet create through the sidecar's own unlocker (aezeed).
  const unlocker = await createWalletUnlockerClient(conn);
  const seed = await unlocker.genSeed(GenSeedRequest.create({})).response;
  mnemonic = seed.cipherSeedMnemonic;
  await unlocker
    .initWallet(
      InitWalletRequest.create({
        walletPassword: Buffer.from(HARNESS_WALLET_PASSWORD, 'utf8'),
        cipherSeedMnemonic: mnemonic,
        aezeedPassphrase: new Uint8Array(0),
        recoveryWindow: 0,
        statelessInit: false,
      }),
    )
    .response;
  client = await createLightningClient(conn);
}, 240_000);

afterAll(async () => {
  await launched?.stop();
  if (dataDir !== undefined) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('litd sidecar on the regtest harness', () => {
  it('created a 24-word aezeed wallet through its unlocker', () => {
    expect(mnemonic.length).toBe(24);
  });

  it('refuses a second InitWallet (wallet already exists)', async () => {
    const unlocker = await createWalletUnlockerClient(conn!);
    await expect(
      unlocker
        .initWallet(
          InitWalletRequest.create({
            walletPassword: Buffer.from(HARNESS_WALLET_PASSWORD, 'utf8'),
            cipherSeedMnemonic: mnemonic,
            aezeedPassphrase: new Uint8Array(0),
            recoveryWindow: 0,
            statelessInit: false,
          }),
        )
        .response,
    ).rejects.toThrow(/already/i);
  });

  it('syncs the regtest chain over Neutrino (BIP157 via the pinned btcd)', async () => {
    const bitcoinBlocks = (await getBlockchainInfo()).blocks;
    const info = await poll(
      () => client!.getInfo(GetInfoRequest.create({})).response,
      (i) => i.syncedToChain && i.blockHeight >= bitcoinBlocks - 2,
      `Neutrino sync (target height ~${bitcoinBlocks})`,
      180_000,
    );
    expect(info.syncedToChain).toBe(true);
    expect(info.blockHeight).toBeGreaterThanOrEqual(bitcoinBlocks - 2);
  });

  it('receives confirmed on-chain funds', async () => {
    const address = (await client!.newAddress(NewAddressRequest.create({ type: AddressType.WITNESS_PUBKEY_HASH })))
      .response.address;
    expect(address).toBeTruthy();
    await bitcoinSendTo(address, 0.5);
    await mineBlocks(6);
    const balance = await poll(
      async () => (await client!.walletBalance(WalletBalanceRequest.create({})).response).confirmedBalance,
      (confirmed) => confirmed >= 50_000_000n,
      'confirmed balance >= 0.5 BTC',
      120_000,
    );
    expect(balance).toBeGreaterThanOrEqual(50_000_000n);
  });

  it('sends on-chain funds with a returned txid', async () => {
    const before = (await client!.walletBalance(WalletBalanceRequest.create({})).response).confirmedBalance;
    const destination = await getNewAddress();
    const txid = (
      await client!
        .sendCoins(
          SendCoinsRequest.create({
            addr: destination,
            amount: 100_000_000n, // 0.1 BTC in sats
            satPerVbyte: 2n,
          }),
        )
        .response
    ).txid;
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    await mineBlocks(6);
    const after = await poll(
      async () => (await client!.walletBalance(WalletBalanceRequest.create({})).response).confirmedBalance,
      (confirmed) => before - confirmed >= 100_000_000n,
      'balance to drop by >= 0.1 BTC',
      120_000,
    );
    expect(before - after).toBeGreaterThanOrEqual(100_000_000n);
  });

  it('opens and closes a channel to lnd-alice', async () => {
    const alice = await getNodeInfo(ALICE);

    // Connect the sidecar to alice's published P2P port.
    await client!
      .connectPeer(
        ConnectPeerRequest.create({
          addr: { pubkey: alice.identityPubkey, host: `127.0.0.1:${ALICE_P2P_PORT}` },
        }),
      )
      .response;

    // Open a 1M-sat channel; openChannelSync returns the funding ChannelPoint.
    const fundingPoint = await client!
      .openChannelSync(
        OpenChannelRequest.create({
          nodePubkey: Buffer.from(alice.identityPubkey, 'hex'),
          localFundingAmount: 1_000_000n,
          satPerVbyte: 5n,
        }),
      )
      .response;
    expect(fundingPoint.fundingTxid.oneofKind).toBe('fundingTxidStr');
    await mineBlocks(6);

    const opened = await poll(
      async () => (await client!.listChannels(ListChannelsRequest.create({})).response).channels,
      (channels) => channels.some((c) => c.active && c.remotePubkey.toLowerCase() === alice.identityPubkey.toLowerCase()),
      'channel to become active',
      120_000,
    );
    const channel = opened.find((c) => c.active)!;
    expect(channel.channelPoint).toBeTruthy();

    // Cooperative close: consume the update stream in the background — the
    // chanClose update only arrives once the closing tx is MINED, so mining
    // must happen while the stream is open.
    const closeCall = client!.closeChannel(
      CloseChannelRequest.create({ channelPoint: fundingPoint, force: false }),
    );
    const closeDone = (async () => {
      for await (const update of closeCall.responses) {
        if (update.update.oneofKind === 'chanClose') {
          return update.update.chanClose.closingTxid;
        }
      }
      throw new Error('closeChannel stream ended without a chanClose update');
    })();
    await mineBlocks(6);
    const closingTxid = await closeDone;
    expect(closingTxid).toMatch(/^[0-9a-f]{64}$/);

    // The stream is abandoned after chanClose (no cancel API on the call);
    // litd is stopped and the transport dies in afterAll.
    await poll(
      async () => (await client!.listChannels(ListChannelsRequest.create({})).response).channels,
      (channels) => !channels.some((c) => c.remotePubkey.toLowerCase() === alice.identityPubkey.toLowerCase()),
      'channel to disappear after close',
      120_000,
    );
  });
});
