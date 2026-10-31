/**
 * Tapd asset surface integration test — REAL litd sidecar (integrated tapd
 * v0.8.6) on the Docker regtest harness. Covers the L1-core flows end to
 * end: issue → on-chain batch confirmation → receive address → self
 * transfer → balances/history → proof export/verify/backup/restore →
 * registry metadata anchoring. Regtest only — never mainnet.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AddressType,
  GenSeedRequest,
  GetInfoRequest,
  InitWalletRequest,
  NewAddressRequest,
  WalletBalanceRequest,
  tapdAssets,
  type LightningClient,
} from '@sovereign/litd-proto';
import {
  BTCD_FILTER_PORT,
  bootstrapHarness,
  bitcoinSendTo,
  getBlockchainInfo,
  HARNESS_WALLET_PASSWORD,
  mineBlocks,
  waitForTxInMempool,
} from '@sovereign/harness-regtest';

import {
  AssetManager,
  backupAssetProofs,
  backupSourcesFromAssets,
  connectionOptionsFromConfig,
  createLightningClient,
  createTapdClients,
  createWalletUnlockerClient,
  JsonFileProofBackupStore,
  launchLitdSidecar,
  probeRpcReady,
  restoreAssetProofs,
  tapdConnectionOptions,
  toRegistryEntry,
  waitForServices,
  waitForTapdServices,
  type LaunchedLitd,
  type LitdConnectionOptions,
} from '../index.js';
import { sidecarBinaryPath, sleep } from './helpers.js';

let launched: LaunchedLitd | undefined;
let conn: LitdConnectionOptions | undefined;
let lightning: LightningClient | undefined;
let manager: AssetManager | undefined;
let dataDir: string | undefined;
let proofDir: string | undefined;
// Module-level so tests build on the previous test's on-chain state — the
// asset ledger is sequential by nature (issue → send → history).
let assetIdHex = '';
let scriptKeyHex = '';

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

  dataDir = mkdtempSync(path.join(os.tmpdir(), 'litd-tapd-'));
  proofDir = mkdtempSync(path.join(os.tmpdir(), 'litd-tapd-proofs-'));
  launched = await launchLitdSidecar({
    binaryPath: sidecarBinaryPath(),
    options: {
      network: 'regtest',
      dataDir,
      backend: { kind: 'neutrino', peers: [`127.0.0.1:${BTCD_FILTER_PORT}`] },
    },
  });
  conn = connectionOptionsFromConfig(launched.config);

  // The asset surface resolves ONLY in integrated mode — assert the wiring
  // before anything else (remote mode has no local tapd).
  expect(launched.config.tapd).toBeDefined();

  await probeRpcReady(conn, 60_000);
  const unlocker = await createWalletUnlockerClient(conn);
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
  // After InitWallet, the Lightning sub-server registers asynchronously —
  // the same startup window the launcher gate covers pre-init. Wait for it
  // to actually serve before handing the client to the tests.
  await waitForServices(conn, 'lightning', 60_000);

  // The mint batch anchor tx spends from the embedded LND wallet — fund it
  // from the harness bitcoind wallet first. Fund only once the fresh
  // Neutrino client has reached the chain tip: a balance poll that races
  // the sync expires before the funding tx is ever scanned (the proven
  // sync-gate pattern from the sidecar suite).
  lightning = await createLightningClient(conn);
  const bitcoinBlocks = (await getBlockchainInfo()).blocks;
  await poll(
    () => lightning!.getInfo(GetInfoRequest.create({})).response,
    (i) => i.syncedToChain && i.blockHeight >= bitcoinBlocks - 2,
    `Neutrino sync (target height ~${bitcoinBlocks})`,
    180_000,
  );
  const address = (
    await lightning.newAddress(NewAddressRequest.create({ type: AddressType.WITNESS_PUBKEY_HASH }))
  ).response.address;
  await bitcoinSendTo(address, 2);
  await mineBlocks(6);
  await poll(
    async () => (await lightning!.walletBalance(WalletBalanceRequest.create({})).response).confirmedBalance,
    (confirmed) => confirmed >= 1_000_000_000n,
    'confirmed wallet balance >= 1 BTC',
    120_000,
  );

  // The tapd surface answers through litd's proxy with tapd's OWN macaroon.
  const tapdOptions = tapdConnectionOptions(launched.config.tapd!);
  manager = new AssetManager(await createTapdClients(tapdOptions));
  await waitForTapdServices(tapdOptions, 120_000);
}, 480_000);

afterAll(async () => {
  manager?.close();
  await launched?.stop();
  if (dataDir !== undefined) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  if (proofDir !== undefined) {
    rmSync(proofDir, { recursive: true, force: true });
  }
});

describe('integrated tapd asset surface (L1 core)', () => {
  it('serves GetInfo through the litd proxy on regtest', async () => {
    const info = await manager!.getInfo();
    expect(info.version.length).toBeGreaterThan(0);
    expect(info.network.toLowerCase()).toBe('regtest');
  });

  it('issues an asset and lands the mint batch on-chain', async () => {
    const batch = await manager!.issueAsset({
      name: 'TestUSD',
      amount: 1000n,
      metaJson: { name: 'TestUSD', issuer: 'harness', type: 'test' },
    });
    expect(batch).toBeDefined();
    // FinalizeBatch auto-funds — the anchor tx hits the mempool, then the
    // harness mines it into a block, and the batch flips to CONFIRMED.
    await waitForTxInMempool(batch!.batchTxid);
    await mineBlocks(6);
    await manager!.waitForBatchConfirmation(180_000);

    const assets = await poll(
      async () => (await manager!.listAssets()).assets,
      (assets) => assets.length > 0 && assets.every((a) => (a.chainAnchor?.anchorBlockHash ?? '') !== ''),
      'issued asset to appear with an anchored chain anchor',
      120_000,
    );
    const issued = assets.find((a) => a.assetGenesis?.name === 'TestUSD');
    expect(issued).toBeDefined();
    assetIdHex = Buffer.from(issued!.assetGenesis!.assetId).toString('hex');
    scriptKeyHex = Buffer.from(issued!.scriptKey).toString('hex');
    expect(assetIdHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports the asset balance', async () => {
    const balances = await manager!.listBalances();
    const entry = Object.values(balances.assetBalances).find(
      (b) => Buffer.from(b.assetGenesis!.assetId).toString('hex') === assetIdHex,
    );
    expect(entry).toBeDefined();
    expect(entry!.balance).toBe(1000n);
  });

  it('creates a receive address, self-transfers, and records the receive', async () => {
    // A V1 self-transfer address — no proof courier needed (local script
    // key); creation works offline (skipProofCourierConnCheck).
    const addr = await manager!.newAssetAddress({ assetIdHex, amount: 400n });
    expect(addr.encoded.startsWith('taprt1') || addr.encoded.startsWith('tap1')).toBe(true);

    // tapd's own validator accepts the address it just created.
    const decoded = await manager!.decodeTapAddress(addr.encoded);
    expect(Buffer.from(decoded.assetId).toString('hex')).toBe(assetIdHex);

    const send = await manager!.sendAsset({ tapAddresses: [addr.encoded], label: 'self-transfer' });
    expect(send.transfer).toBeDefined();
    const anchorHash = Buffer.from(send.transfer!.anchorTxHash).toString('hex');
    // tapd reports the tx hash in bitcoind (big-endian) order, but accept
    // both byte orders — LND-style txids are wire-ordered.
    await waitForTxInMempool([anchorHash, Buffer.from(anchorHash, 'hex').reverse().toString('hex')]);
    await mineBlocks(6);

    // History: the transfer confirms (anchor block height set) and carries
    // the label.
    const transfers = await poll(
      async () => (await manager!.listTransfers()).transfers,
      (t) => t.some((transfer) => transfer.label === 'self-transfer' && transfer.anchorTxBlockHeight > 0),
      'self-transfer to confirm with its label in history',
      120_000,
    );
    expect(transfers.length).toBeGreaterThanOrEqual(1);

    // Receive bookkeeping: the local AddrEvent reaches COMPLETED (local
    // freighter — no courier round-trip on regtest).
    await poll(
      async () => (await manager!.listAddrReceives()).events,
      (events) =>
        events.some(
          (e) =>
            e.addr?.assetId !== undefined &&
            Buffer.from(e.addr.assetId ?? []).toString('hex') === assetIdHex &&
            e.status === tapdAssets.AddrEventStatus.COMPLETED,
        ),
      'receive event to reach COMPLETED',
      120_000,
    );
  });

  it('exports, verifies, backs up, and restores the asset proof', async () => {
    const proofBytes = await manager!.exportProof({ assetIdHex, scriptKeyHex });
    expect(proofBytes.length).toBeGreaterThan(0);

    // tapd verifies the full inclusion proof chain — not a shape check.
    const verification = await manager!.verifyProofFile(proofBytes);
    expect(verification.valid).toBe(true);

    // Backup: every unspent local asset lands in the store, pre-verified.
    const assets = await manager!.listAssets();
    const store = new JsonFileProofBackupStore(proofDir!);
    const backup = await backupAssetProofs(manager!, backupSourcesFromAssets(assets), store);
    expect(backup.failed).toEqual([]);
    expect(backup.backed.length).toBeGreaterThanOrEqual(1);

    // Restore (the release-blocking drill): proofs re-verify on-chain and
    // re-upload to tapd — nothing silently invalid.
    const restore = await restoreAssetProofs(manager!, store);
    expect(restore.invalid).toEqual([]);
    expect(restore.restored.length).toBeGreaterThanOrEqual(1);
    expect(restore.restored.every((r) => r.verifiedAtExport)).toBe(true);
  });

  it('anchors registry metadata to the genesis meta hash', async () => {
    const meta = await manager!.fetchAssetMeta(assetIdHex);
    const assets = await manager!.listAssets();
    const issued = assets.assets.find(
      (a) => a.assetGenesis !== undefined && Buffer.from(a.assetGenesis.assetId).toString('hex') === assetIdHex,
    );
    expect(issued).toBeDefined();

    const entry = toRegistryEntry(issued!, {
      metaHashHex: Buffer.from(meta.metaHash).toString('hex'),
      metaJson: JSON.parse(Buffer.from(meta.data).toString('utf8')) as Record<string, unknown>,
    });
    // The served meta hash matches the asset's genesis witness — anchored.
    expect(entry.metaHashAnchored).toBe(true);
    expect(entry.meta?.json).toMatchObject({ name: 'TestUSD' });
  });
});
