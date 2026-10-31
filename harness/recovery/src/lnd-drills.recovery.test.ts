/**
 * Recovery drills 1 and 5 — REAL LND nodes on the Docker regtest harness.
 *
 * Drill 1 (aezeed + SCB restore): a funded node with an active channel is
 * WIPED, then rebuilt from nothing but its seed and its static channel
 * backup. With the peer down, lnd accepts the backup but cannot close the
 * channel alone: SCB recovery is the data-loss-protocol handshake — the
 * restored wallet reconnects and the PEER force-closes, handing over the
 * state needed to claim the funds. The funds must return on-chain (through
 * the CSV delay) to the fresh wallet.
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
  ConnectPeerRequest,
  ExportChannelBackupRequest,
  GenSeedRequest,
  GetInfoRequest,
  InitWalletRequest,
  RestoreChanBackupRequest,
  UnlockWalletRequest,
  type ChannelBackup,
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
  it('wipes a funded node and recovers every sat through seed + SCB + data-loss recovery', async () => {
    await runDrill(
      'drill-1-lnd-aezeed-scb-restore',
      'LND aezeed + SCB restore — wipe, restore from seed + SCB, peer-driven recovery, funds on-chain',
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
        const channelPoint = await openChannelActive(bob, alicePubkey, 'lnd-alice:9735', CHANNEL_SAT);
        d.step(`opened a ${CHANNEL_SAT}-sat channel bob→alice and waited for it to go active`);

        // ——— the backup: the artifact a dead node leaves behind ———
        const backup = (
          await bob.exportChannelBackup(ExportChannelBackupRequest.create({ chanPoint: channelPoint }))
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

          // SCB recovery cannot broadcast anything with the peer offline:
          // the restored wallet must reestablish the channel, and the PEER
          // — holding the newer state — drives the force-close and hands
          // over what is needed to claim the funds (lnd's data-loss
          // protocol). Bring the peer back and reconnect; the commitment
          // broadcast that follows IS the recovery completing.
          // Restarting alice boots her EXISTING encrypted wallet: lnd
          // binds no listeners until it is unlocked (no unlock-password
          // file in the harness config), so unlock her through the same
          // WalletUnlocker flow the bootstrap used — a running-but-locked
          // peer refuses connections (connection refused on 9735).
          await composeService('start', ALICE);
          await poll(
            async () => {
              const unlocker = await execUnlockerClient(ALICE);
              return (
                await unlocker
                  .unlockWallet(
                    UnlockWalletRequest.create({ walletPassword: INIT_PASSWORD }),
                  )
                  .response
              );
            },
            () => true,
            'restarted alice to accept its wallet unlock',
            60_000,
          );
          const aliceClient = await execLightningClient(ALICE);
          await waitNodeReady(aliceClient, 'restarted alice (unlocked)', 120_000);
          await poll(
            async () =>
              bob
                .connectPeer(
                  ConnectPeerRequest.create({
                    addr: { pubkey: alicePubkey, host: 'lnd-alice:9735' },
                  }),
                )
                .response,
            () => true,
            'restored bob to reconnect to alice',
            60_000,
          );
          d.step('brought the peer back and reconnected — the data-loss protocol takes over the recovery');

          await waitForCloseBroadcast(180_000);
          await mineBlocks(1);
          d.step("the peer's force-close commitment hit the mempool and was mined");
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
