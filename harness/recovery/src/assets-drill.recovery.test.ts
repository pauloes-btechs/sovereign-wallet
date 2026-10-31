/**
 * Recovery drill 3 — Taproot asset state restore: the LND seed alone is
 * INSUFFICIENT; the tapd wallet backup must restore asset state.
 *
 * RELEASE-BLOCKING per the Sovereign Wallet spec (art_c8VM79Nw): a restored
 * LND wallet shows NO assets until the tapd wallet backup (RAW mode,
 * self-contained proofs, encrypted under a key derived from the LND seed) is
 * imported. The drill proves both halves of that claim on REAL daemons:
 *
 *   negative leg — fresh tapd + LND restored from the seed alone lists zero
 *                  assets (the seed does not carry asset state);
 *   positive leg — importing the captured backup restores the asset with its
 *                  full balance, under the same asset id.
 *
 * Runs a real litd v0.17.8 sidecar (integrated tapd v0.8.6) per phase, on
 * the Docker regtest harness's btcd as a Neutrino compact-filter backend.
 * Regtest only — never mainnet.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  AddressType,
  GenSeedRequest,
  GetInfoRequest,
  InitWalletRequest,
  NewAddressRequest,
  WalletBalanceRequest,
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
  connectionOptionsFromConfig,
  createLightningClient,
  createTapdClients,
  createWalletUnlockerClient,
  launchLitdSidecar,
  probeRpcReady,
  tapdConnectionOptions,
  waitForServices,
  waitForTapdServices,
  type LaunchedLitd,
  type LitdConnectionOptions,
} from '@sovereign/litd-adapter';

import { renderTestResults, runDrill } from './recorder.js';

const ENV = 'real litd v0.17.8 sidecar (integrated tapd v0.8.6, Neutrino over btcd) — disposable data dirs';

// harness/recovery/src/*.ts -> monorepo root (3 up). Default matches
// scripts/fetch-sidecars.mjs on linux-x64; override with SOVEREIGN_LITD_BIN.
function sidecarBinaryPath(): string {
  const binaryPath =
    process.env['SOVEREIGN_LITD_BIN'] ??
    path.resolve(import.meta.dirname, '..', '..', '..', 'apps/desktop/src-tauri/binaries/litd-x86_64-unknown-linux-gnu');
  return binaryPath;
}

async function poll<T>(
  fn: () => Promise<T>,
  isDone: (value: T) => boolean,
  what: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (isDone(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

interface Sidecar {
  readonly launched: LaunchedLitd;
  readonly conn: LitdConnectionOptions;
  readonly lightning: LightningClient;
  readonly manager: AssetManager;
  readonly dataDir: string;
  /** The aezeed words this wallet was initialized from — the recovery artifact. */
  readonly mnemonic: string[];
}

/** Boots a fresh litd sidecar on Neutrino and waits for its RPC + tapd. */
async function bootSidecar(
  label: string,
  mnemonic: string[] | undefined,
): Promise<Sidecar> {
  const dataDir = `/tmp/sovereign-recovery-assets-${label}`;
  const launched = await launchLitdSidecar({
    binaryPath: sidecarBinaryPath(),
    options: {
      network: 'regtest',
      dataDir,
      backend: { kind: 'neutrino', peers: [`127.0.0.1:${BTCD_FILTER_PORT}`] },
    },
  });
  const conn = connectionOptionsFromConfig(launched.config);
  await probeRpcReady(conn, 60_000);

  // Fresh install: generate a seed here and RETURN it — the words the wallet
  // was actually initialized with are the only ones a restore can use.
  const unlocker = await createWalletUnlockerClient(conn);
  const seed = mnemonic ?? (await unlocker.genSeed(GenSeedRequest.create({})).response).cipherSeedMnemonic;
  await unlocker
    .initWallet(
      InitWalletRequest.create({
        walletPassword: Buffer.from(HARNESS_WALLET_PASSWORD, 'utf8'),
        cipherSeedMnemonic: seed,
        aezeedPassphrase: new Uint8Array(0),
        recoveryWindow: 0,
        statelessInit: false,
      }),
    )
    .response;
  await waitForServices(conn, 'lightning', 60_000);

  const lightning = await createLightningClient(conn);
  // Sync gate: the mint anchor and balance polls race an unsynced Neutrino.
  const bitcoinBlocks = (await getBlockchainInfo()).blocks;
  await poll(
    () => lightning.getInfo(GetInfoRequest.create({})).response,
    (i) => i.syncedToChain && i.blockHeight >= bitcoinBlocks - 2,
    `Neutrino sync (target height ~${bitcoinBlocks})`,
    240_000,
  );

  const tapdOptions = tapdConnectionOptions(launched.config.tapd!);
  await waitForTapdServices(tapdOptions, 120_000);
  const manager = new AssetManager(await createTapdClients(tapdOptions));
  return { launched, conn, lightning, manager, dataDir, mnemonic: seed };
}

/** Funds the sidecar's embedded LND wallet for the mint anchor. */
async function fundSidecar(sidecar: Sidecar): Promise<void> {
  const address = (
    await sidecar.lightning.newAddress(NewAddressRequest.create({ type: AddressType.WITNESS_PUBKEY_HASH }))
  ).response.address;
  await bitcoinSendTo(address, 2);
  await mineBlocks(6);
  await poll(
    async () => (await sidecar.lightning.walletBalance(WalletBalanceRequest.create({})).response).confirmedBalance,
    (confirmed) => confirmed >= 200_000_000n,
    'confirmed wallet balance >= 2 BTC',
    120_000,
  );
}

/** Every sidecar this drill ever boots — afterAll destroys any survivor. */
const registry: Sidecar[] = [];
const destroyed = new Set<Sidecar>();

function register(s: Sidecar): Sidecar {
  registry.push(s);
  return s;
}

/** Idempotently destroys one sidecar: RPCs closed, daemon stopped, data gone. */
async function destroy(s: Sidecar): Promise<void> {
  if (destroyed.has(s)) return;
  destroyed.add(s);
  s.manager.close();
  await s.launched.stop();
  rmSync(s.dataDir, { recursive: true, force: true });
}

afterAll(async () => {
  for (const s of registry) {
    await destroy(s);
  }
  renderTestResults();
});

let sidecarA: Sidecar | undefined;
let sidecarB: Sidecar | undefined;

describe('recovery drill 3 — Taproot asset restore (LND seed insufficient, backup required)', () => {
  it('restores asset state ONLY from the tapd wallet backup, never from the seed', async () => {
    await runDrill('drill-3-taproot-asset-backup-restore', 'LND seed alone restores no assets; the tapd wallet backup does', ENV, async (d) => {
      // Idempotent: boots the compose harness and the btcd filter server the
      // sidecar Neutrino clients sync against (no-op when CI already did it).
      await bootstrapHarness();
      const chain = await getBlockchainInfo();
      expect(chain.chain.toLowerCase()).toBe('regtest');
      d.step('regtest guard passed (harness chain is regtest)');

      // ——— phase A: build a funded wallet holding a minted asset ———
      sidecarA = register(await bootSidecar('a', undefined));
      const seedA = sidecarA.mnemonic;
      d.step('booted litd sidecar A and initialized a fresh wallet — seed words captured');

      await fundSidecar(sidecarA);
      d.step('funded sidecar A with 2 confirmed BTC (mint anchor source)');

      const batch = await sidecarA.manager.issueAsset({
        name: 'RecoveryUSD',
        amount: 1000n,
        metaJson: { name: 'RecoveryUSD', issuer: 'recovery-drill', type: 'test' },
      });
      expect(batch).toBeDefined();
      await waitForTxInMempool(batch!.batchTxid);
      await mineBlocks(6);
      await sidecarA.manager.waitForBatchConfirmation(180_000);
      const assetsA = await poll(
        async () => (await sidecarA!.manager.listAssets()).assets,
        (assets) => assets.length > 0 && assets.every((a) => (a.chainAnchor?.anchorBlockHash ?? '') !== ''),
        'issued asset to appear with an anchored chain anchor',
        120_000,
      );
      const issued = assetsA.find((a) => a.assetGenesis?.name === 'RecoveryUSD');
      expect(issued).toBeDefined();
      const assetIdHex = Buffer.from(issued!.assetGenesis!.assetId).toString('hex');
      d.step(`minted 1000 RecoveryUSD units — asset ${assetIdHex.slice(0, 16)}… anchored on-chain`);

      // ——— the backup: the ONLY artifact that carries asset state ———
      const backup = await sidecarA.manager.exportWalletBackup();
      expect(backup.length).toBeGreaterThan(0);
      d.step(`exported the RAW tapd wallet backup (${backup.length} bytes, self-contained proofs, encrypted under the LND seed)`);

      // ——— the disaster: destroy sidecar A entirely ———
      await destroy(sidecarA);
      d.step('stopped sidecar A and deleted its data directory — the node is gone');

      // ——— phase B: restore the LND wallet from the seed ALONE ———
      sidecarB = register(await bootSidecar('b', seedA));
      d.step('booted a fresh sidecar B and restored the LND wallet STRICTLY from the captured aezeed words');

      // ——— negative leg: the seed alone rebuilt NO asset state ———
      await waitForTapdServices(tapdConnectionOptions(sidecarB.launched.config.tapd!), 120_000);
      const emptyAssets = (await sidecarB.manager.listAssets()).assets;
      expect(emptyAssets).toStrictEqual([]);
      const emptyBalances = await sidecarB.manager.listBalances();
      expect(Object.values(emptyBalances.assetBalances)).toStrictEqual([]);
      d.step('negative leg CONFIRMED: fresh tapd + restored LND seed lists ZERO assets — the seed does not carry asset state');

      // ——— positive leg: the wallet backup restores the asset ———
      const report = await sidecarB.manager.importAssetsFromBackup(backup);
      expect(report.numSkipped).toBe(0);
      expect(report.numImported).toBeGreaterThanOrEqual(1);
      d.step(`imported the wallet backup — ${report.numImported} asset(s) imported, ${report.numSkipped} skipped`);

      const restored = await poll(
        async () => (await sidecarB!.manager.listAssets()).assets,
        (assets) => assets.some((a) => a.assetGenesis !== undefined && Buffer.from(a.assetGenesis.assetId).toString('hex') === assetIdHex),
        'the imported RecoveryUSD asset to appear on sidecar B',
        120_000,
      );
      const restoredIssued = restored.find(
        (a) => a.assetGenesis !== undefined && Buffer.from(a.assetGenesis.assetId).toString('hex') === assetIdHex,
      );
      expect(restoredIssued).toBeDefined();

      const balances = await sidecarB.manager.listBalances();
      const entry = Object.values(balances.assetBalances).find(
        (b) => Buffer.from(b.assetGenesis!.assetId).toString('hex') === assetIdHex,
      );
      expect(entry).toBeDefined();
      expect(entry!.balance).toBe(1000n);
      d.step('positive leg CONFIRMED: the asset is restored under the SAME asset id with its full 1000-unit balance');
    });
  }, 1_500_000);
});
