/**
 * Recovery drills 1 and 5 — REAL LND nodes on the Docker regtest harness.
 *
 * Drill 1 (aezeed + SCB restore): a funded node with an active channel is
 * WIPED, then rebuilt from nothing but its seed and its static channel
 * backup; the restored channel is force-closed with the peer down and the
 * funds must return on-chain (through the CSV delay) to the fresh wallet.
 *
 * Drill 5 (two nodes, one seed): two live nodes initialized from the SAME
 * seed produce identical identity keys, and wallet-core's registration
 * guard refuses the second one — the double-spend guard.
 *
 * RELEASE-BLOCKING per the Sovereign Wallet spec (art_c8VM79Nw). Every node
 * wipe is destructive by design and guarded by an on-node regtest
 * assertion. Regtest only — never mainnet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CloseChannelRequest,
  ExportChannelBackupRequest,
  GenSeedRequest,
  GetInfoRequest,
  InitWalletRequest,
  ListChannelsRequest,
  RestoreChanBackupRequest,
  type ChannelBackup,
  type ChannelPoint,
} from '@sovereign/litd-proto';
import {
  ALICE,
  BOB,
  bootstrapHarness,
  getNodeInfo,
  HARNESS_WALLET_PASSWORD,
  mineBlocks,
} from '@sovereign/harness-regtest';
import {
  assertWalletIdentityUnique,
  DuplicateWalletIdentityError,
  type WalletIdentityRef,
} from '@sovereign/wallet-core';

import {
  assertRegtestOnly,
  composeService,
  execLightningClient,
  execUnlockerClient,
  waitForContainerCert,
  waitForContainerMacaroon,
  wipeNodeData,
} from './docker-nodes.js';
import {
  awaitOnchainFunds,
  fundFromHarness,
  openChannelActive,
  poll,
  waitForCloseBroadcast,
  waitNodeReady,
} from './lnd-flows.js';
import { renderTestResults, runDrill } from './recorder.js';

const ENV = 'docker compose regtest: wiped lnd datadir, disposable per drill';

const INIT_PASSWORD = Buffer.from(HARNESS_WALLET_PASSWORD, 'utf8');
const CHANNEL_SAT = 1_000_000;

/** Drill state carried between the sequential steps of one drill. */
let bobSeed: string[] = [];
let bobBackup: ChannelBackup | undefined;
let bobChannelPoint: ChannelPoint | undefined;

async function initWalletFromSeed(
  unlocker: Awaited<ReturnType<typeof execUnlockerClient>>,
  mnemonic: string[],
  recoveryWindow: number,
): Promise<void> {
  await unlocker
    .initWallet(
      InitWalletRequest.create({
        walletPassword: INIT_PASSWORD,
        cipherSeedMnemonic: mnemonic,
        aezeedPassphrase: new Uint8Array(0),
        recoveryWindow,
        statelessInit: false,
      }),
    )
    .response;
}

beforeAll(async () => {
  await bootstrapHarness();
  await assertRegtestOnly(BOB);
});

afterAll(() => {
  renderTestResults();
});

describe('recovery drill 1 — LND aezeed + SCB restore, funds return on-chain', () => {
  it('wipes a funded node and recovers every sat through seed + SCB + force-close', async () => {
    await runDrill(
      'drill-1-lnd-aezeed-scb-restore',
      'LND aezeed + SCB restore — wipe, restore, force-close with peer down, funds on-chain',
      ENV,
      async (d) => {
        // ——— phase A: build the victim state on a FRESH node ———
        await wipeNodeData(BOB);
        await waitForContainerCert(BOB, 60_000);
        const unlockerA = await execUnlockerClient(BOB);
        const seed = await unlockerA.genSeed(GenSeedRequest.create({})).response;
        bobSeed = seed.cipherSeedMnemonic;
        await initWalletFromSeed(unlockerA, bobSeed, 0);
        await waitForContainerMacaroon(BOB, 60_000);
        let bob = await execLightningClient(BOB);
        await waitNodeReady(bob, 'fresh bob', 120_000);
        d.step(`wiped lnd-bob's datadir and initialized a fresh aezeed wallet (${bobSeed.length} words captured)`);

        await fundFromHarness(bob, 2, 'bob');
        d.step('funded bob with 2 BTC from the harness bitcoind wallet');

        const alicePubkey = (await getNodeInfo(ALICE)).identityPubkey;
        bobChannelPoint = await openChannelActive(bob, alicePubkey, 'lnd-alice:9735', CHANNEL_SAT);
        d.step(`opened a ${CHANNEL_SAT}-sat channel bob→alice and waited for it to go active`);

        // ——— the backup: the artifact a dead node leaves behind ———
        const backup = (
          await bob.exportChannelBackup(ExportChannelBackupRequest.create({ chanPoint: bobChannelPoint }))
        ).response;
        expect(backup.chanBackup?.length ?? 0).toBeGreaterThan(0);
        bobBackup = backup;
        d.step('exported the static channel backup — encrypted single-chan SCB payload present');

        // ——— phase B: the disaster. Peer stopped, node wiped: the wallet
        // must come back from the two artifacts a user can hold — the
        // seed words and the SCB — with nobody to talk to. ———
        await composeService('stop', ALICE);
        try {
          await wipeNodeData(BOB);
          await waitForContainerCert(BOB, 60_000);
          const unlockerB = await execUnlockerClient(BOB);
          // A fresh install generates its OWN seed — discarded: we hold the
          // aezeed words and the SCB, and nothing else.
          await unlockerB.genSeed(GenSeedRequest.create({})).response;
          await initWalletFromSeed(unlockerB, bobSeed, 1);
          await waitForContainerMacaroon(BOB, 60_000);
          bob = await execLightningClient(BOB);
          await waitNodeReady(bob, 'restored bob (peer down)', 120_000);
          d.step('wiped bob again, stopped the peer, and re-initialized STRICTLY from the captured aezeed (recovery window 1) — no wallet state, no peer');

          // Restore the channel from the SCB — the pinned protos restore via
          // the dedicated RestoreChannelBackups RPC (channel/backup pairs).
          // Polled: lnd answers whitelisted RPCs (GetInfo) before its RPC
          // server finishes starting, so an immediate restore can hit
          // "server is still in the process of starting" — retry until ready.
          const restoreRes = await poll(
            async () =>
              (
                await bob.restoreChannelBackups(
                  RestoreChanBackupRequest.create({
                    backup: { oneofKind: 'chanBackups', chanBackups: { chanBackups: [bobBackup!] } },
                  }),
                )
              ).response,
            (res) => res.numRestored === 1,
            'the SCB restore to complete (numRestored = 1)',
            120_000,
          );
          expect(restoreRes.numRestored).toBe(1);
          d.step('restored the channel from the SCB file — lnd reports numRestored = 1');

          const restoredChannels = await poll(
            async () => (await bob.listChannels(ListChannelsRequest.create({}))).response.channels,
            (channels) => channels.length >= 1,
            'the SCB-restored channel to appear',
            120_000,
          );
          expect(restoredChannels.length).toBeGreaterThanOrEqual(1);
          d.step(`SCB restore rebuilt the channel record (${restoredChannels.length} channel present after restore)`);

          // Force-close with the peer down: lnd broadcasts the latest
          // commitment it holds — the funds become purely on-chain, no
          // peer, no server. The close stream is consumed to its end (it
          // can error when lnd stops streaming after broadcast — recorded,
          // not swallowed).
          const closeUpdates: string[] = [];
          const call = bob.closeChannel(
            CloseChannelRequest.create({ channelPoint: bobChannelPoint, force: true }),
          );
          void (async () => {
            try {
              for await (const update of call.responses) {
                closeUpdates.push(update.update.oneofKind ?? 'none');
              }
            } catch (err) {
              closeUpdates.push(`stream ended: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
          d.step('force-closed the restored channel (peer down) — awaiting the commitment broadcast');

          await waitForCloseBroadcast(120_000);
          await mineBlocks(1);
          d.step(`commitment tx observed in the mempool and mined (close stream updates: ${closeUpdates.length})`);
        } finally {
          await composeService('start', ALICE);
        }

        // ——— phase C: the funds return through the CSV delay ———
        const recovered = await awaitOnchainFunds(
          bob,
          BigInt(CHANNEL_SAT) - 60_000n,
          "restored wallet to recover ≥ 940k sat on-chain (CSV delay + sweep)",
          420_000,
        );
        d.step(`funds RETURNED: bob's fresh wallet holds ${recovered} confirmed sats on-chain after the CSV delay and sweep`);
        expect(recovered).toBeGreaterThanOrEqual(BigInt(CHANNEL_SAT) - 60_000n);
      },
    );
  });
});

describe('recovery drill 5 — two LND nodes initialized from the same seed', () => {
  it('produces identical identity keys and the registration guard refuses the second', async () => {
    await runDrill(
      'drill-5-two-nodes-same-seed-guard',
      'Two LND nodes, one seed — identical identities; wallet-core guard refuses the second',
      ENV,
      async (d) => {
        // Both nodes wiped and initialized from ONE seed: the exact
        // double-spend foot-gun the guard exists for.
        await wipeNodeData(ALICE);
        await wipeNodeData(BOB);
        await waitForContainerCert(ALICE, 60_000);
        await waitForContainerCert(BOB, 60_000);

        const aliceUnlocker = await execUnlockerClient(ALICE);
        const seed = await aliceUnlocker.genSeed(GenSeedRequest.create({})).response;
        const shared = seed.cipherSeedMnemonic;
        await initWalletFromSeed(aliceUnlocker, shared, 0);
        const bobUnlocker = await execUnlockerClient(BOB);
        await initWalletFromSeed(bobUnlocker, shared, 0);
        await waitForContainerMacaroon(ALICE, 60_000);
        await waitForContainerMacaroon(BOB, 60_000);
        d.step('wiped BOTH nodes and initialized them from the SAME 24-word seed');

        const alice = await execLightningClient(ALICE);
        const bob = await execLightningClient(BOB);
        await waitNodeReady(alice, 'alice (same-seed)', 120_000);
        await waitNodeReady(bob, 'bob (same-seed)', 120_000);
        const alicePubkey = (await alice.getInfo(GetInfoRequest.create({})).response).identityPubkey;
        const bobPubkey = (await bob.getInfo(GetInfoRequest.create({})).response).identityPubkey;
        expect(bobPubkey).toBe(alicePubkey);
        d.step(`both live nodes report the SAME identity key (${alicePubkey.slice(0, 16)}…) — on-chain funds are now spendable by either`);

        const registered: WalletIdentityRef[] = [
          { providerId: 'litd-local', instanceId: 'lnd-alice', identityPubKey: alicePubkey },
        ];
        expect(() =>
          assertWalletIdentityUnique(registered, {
            providerId: 'litd-local',
            instanceId: 'lnd-bob',
            identityPubKey: bobPubkey,
          }),
        ).toThrow(DuplicateWalletIdentityError);
        d.step('wallet-core registration guard REFUSED the second instance with DuplicateWalletIdentityError — the double-spend foot-gun is closed');

        // Same-instance restarts stay legal (the guard's other half).
        expect(() =>
          assertWalletIdentityUnique(registered, {
            providerId: 'litd-local',
            instanceId: 'lnd-alice',
            identityPubKey: alicePubkey,
          }),
        ).not.toThrow();
        d.step('the same instance re-registering (a restart) stays legal — the guard blocks only a second live identity');
      },
    );
  });
});
