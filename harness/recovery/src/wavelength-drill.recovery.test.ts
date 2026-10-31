/**
 * Recovery drill 2 — Wavelength seed restore before VTXO batch expiry,
 * including the operator-unreachable → unilateral-exit fallback.
 *
 * RELEASE-BLOCKING per the Sovereign Wallet spec (art_c8VM79Nw): seed
 * recovery must complete BEFORE the VTXO batch expires, and when the Ark
 * operator is unreachable the wallet's own encrypted backup must rebuild
 * VTXO state and the unilateral exit must carry funds on-chain.
 *
 * Runs on the simulated daemon (SimulatedWavelengthClient — the only
 * documented Mode A desktop runtime pattern) through the REAL adapter
 * provider. The operator-side indexer is shared across daemons, modeling
 * the property seed restore depends on: state is rebuilt from the
 * OPERATOR's view of live batches, and from nothing else.
 * Regtest only — never mainnet.
 */
import { afterAll, describe, expect, it } from 'vitest';

import {
  OperatorIndexer,
  SimulatedWavelengthClient,
  simWalletKey,
} from '@sovereign/harness-regtest/simulated-client';
import {
  FORCE_UNROLL_ACK,
  WavelengthError,
  WavelengthProvider,
} from '@sovereign/wavelength-adapter';

import { runDrill, renderTestResults } from './recorder.js';

const ENV = 'simulated waved daemon + shared operator indexer (regtest-only)';

/** The recovery window the restore request must fit in: the FREE-refresh window. */
const RECOVERY_WINDOW_BLOCKS = 40;

let idSeq = 0;
function nextDataDir(label: string): string {
  idSeq += 1;
  return `/tmp/sovereign-recovery-wavelength-${label}-${idSeq}`;
}

function makeProvider(client: SimulatedWavelengthClient): WavelengthProvider {
  return new WavelengthProvider({ client });
}

const indexer = new OperatorIndexer();

describe('recovery drill 2 — Wavelength seed restore before VTXO batch expiry', () => {
  afterAll(() => renderTestResults());

  it('restores the seed on a fresh daemon BEFORE batch expiry', async () => {
    await runDrill('drill-2-wavelength-seed-restore-before-expiry', 'Wavelength seed restore before VTXO batch expiry (fresh daemon)', ENV, async (d) => {
      const simA = new SimulatedWavelengthClient(indexer);
      const providerA = makeProvider(simA);
      await providerA.start({ network: 'regtest', dataDir: nextDataDir('a') });
      d.step('started daemon A on regtest');

      const created = await providerA.createWallet({
        password: 'recovery-drill-password',
        recoverState: false,
      });
      expect(created.recoveryRan).toBe(false);
      d.step(`created fresh wallet A (identity ${created.identityPubKey.slice(0, 20)}…)`);

      // Fund as a VTXO batched by the operator (wallet exists → indexed).
      simA.depositVTXO('op-recover-1', 100_000, RECOVERY_WINDOW_BLOCKS);
      expect(simA.balances.confirmedSat).toBe(100_000);
      const seedA = created.mnemonic;
      const backupRecords = indexer.liveFor(simWalletKey(seedA), simA.blockHeight);
      expect(backupRecords.map((r) => r.outpoint)).toStrictEqual(['op-recover-1']);
      d.step('deposited a 100k-sat VTXO batch (expires in 40 blocks); operator holds it in a live batch');

      // ——— the restore: a FRESH daemon, same seed, BEFORE expiry ———
      const simB = new SimulatedWavelengthClient(indexer);
      const providerB = makeProvider(simB);
      await providerB.start({ network: 'regtest', dataDir: nextDataDir('b') });

      const restored = await providerB.createWallet({
        password: 'recovery-drill-password',
        mnemonic: seedA,
        recoverState: true,
        recoveryWindow: RECOVERY_WINDOW_BLOCKS,
      });
      d.step('restored the seed on daemon B with recoverState=true (pre-expiry)');

      expect(restored.recoveryRan).toBe(true);
      expect(restored.recoveredVTXOs).toBe(1);
      expect(restored.identityPubKey).toBe(created.identityPubKey);
      d.step(`operator-side scan rebuilt 1 VTXO; identity matches daemon A (${restored.identityPubKey.slice(0, 20)}…)`);

      // The funds are spendable again under the restored wallet.
      const buckets = await providerB.balanceBuckets();
      expect(buckets.lightningSpendableSat).toBe(100_000n);
      const states = await providerB.classifyVtxos();
      expect(states.map((v) => [v.vtxo.outpoint, v.state])).toStrictEqual([['op-recover-1', 'fresh']]);
      d.step('restored VTXO classifies fresh — spendable well inside the free-refresh window');
    });
  });

  it('recovers nothing once the batch has expired — restore must beat the clock', async () => {
    await runDrill('drill-2-negative-expired-restore', 'Seed restore AFTER batch expiry recovers nothing off-chain (negative leg)', ENV, async (d) => {
      const simA = new SimulatedWavelengthClient(indexer);
      const providerA = makeProvider(simA);
      await providerA.start({ network: 'regtest', dataDir: nextDataDir('expired-a') });
      const created = await providerA.createWallet({
        password: 'recovery-drill-password',
        recoverState: false,
      });
      simA.depositVTXO('op-expired-1', 60_000, 2);
      d.step('wallet funded with a 60k-sat VTXO expiring in 2 blocks');

      // The chain (and the operator's batch clock) advances past expiry.
      for (let i = 0; i < 3; i += 1) simA.addBlock();
      d.step('3 blocks mined — the VTXO batch expired');

      const simC = new SimulatedWavelengthClient(indexer);
      simC.blockHeight = simA.blockHeight;
      const providerC = makeProvider(simC);
      await providerC.start({ network: 'regtest', dataDir: nextDataDir('expired-c') });

      const restored = await providerC.createWallet({
        password: 'recovery-drill-password',
        mnemonic: created.mnemonic,
        recoverState: true,
        recoveryWindow: RECOVERY_WINDOW_BLOCKS,
      });
      expect(restored.recoveryRan).toBe(true);
      expect(restored.recoveredVTXOs).toBe(0);
      d.step('operator-side scan found 0 live batches — the seed alone rebuilt no VTXO state');
      expect((await providerC.balanceBuckets()).lightningSpendableSat).toBe(0n);
      d.step('the off-chain path is unrecoverable after expiry — only a unilateral exit remains (exercised in the next drill)');
    });
  });

  it('falls back to the wallet backup + unilateral exit when the operator is unreachable', async () => {
    await runDrill('drill-2-operator-unreachable-fallback', 'Operator-unreachable restore → local encrypted backup → unilateral exit', ENV, async (d) => {
      const simA = new SimulatedWavelengthClient(indexer);
      const providerA = makeProvider(simA);
      await providerA.start({ network: 'regtest', dataDir: nextDataDir('fallback-a') });
      const created = await providerA.createWallet({
        password: 'recovery-drill-password',
        recoverState: false,
      });
      simA.depositVTXO('op-fallback-1', 80_000, RECOVERY_WINDOW_BLOCKS);
      const walletKey = simWalletKey(created.mnemonic);
      // The app layer persists VTXO records alongside the seed — the wallet's
      // OWN encrypted backup, captured while the operator was reachable.
      const localBackup = indexer.liveFor(walletKey, simA.blockHeight);
      expect(localBackup.map((r) => r.outpoint)).toStrictEqual(['op-fallback-1']);
      d.step('wallet funded (80k-sat VTXO) and the local encrypted backup captured');

      // ——— fresh daemon, operator DOWN: the operator-side scan must fail ———
      const simD = new SimulatedWavelengthClient(indexer);
      simD.operatorReachable = false;
      const providerD = makeProvider(simD);
      await providerD.start({ network: 'regtest', dataDir: nextDataDir('fallback-d') });

      const scanFailure = await providerD
        .createWallet({
          password: 'recovery-drill-password',
          mnemonic: created.mnemonic,
          recoverState: true,
          recoveryWindow: RECOVERY_WINDOW_BLOCKS,
        })
        .catch((err: unknown) => err);
      expect(scanFailure).toBeInstanceOf(WavelengthError);
      expect((scanFailure as WavelengthError).code).toBe('unavailable');
      d.step('operator-unreachable restore scan FAILED as designed — the seed alone cannot rebuild VTXO state');
      expect(simD.vtxos).toStrictEqual([]);
      expect(simD.walletMnemonic).toStrictEqual(created.mnemonic);
      d.step('the wallet exists (keys work) but holds zero VTXOs — no operator, no state');

      // The fallback: rebuild from the wallet's OWN backup, then exit.
      const adopted = simD.restoreVtxoStateFromBackup(localBackup);
      expect(adopted).toBe(1);
      expect((await providerD.balanceBuckets()).lightningSpendableSat).toBe(80_000n);
      d.step('local encrypted backup rebuilt the 80k-sat VTXO — inventory restored without the operator');

      const ready = await providerD.exitReadiness(['op-fallback-1']);
      expect(ready.canStart).toBe(false); // backing wallet unfunded
      expect(ready.infeasibilityFundable).toBe(true);
      simD.fundBacking(900);
      const funded = await providerD.exitReadiness(['op-fallback-1']);
      expect(funded.canStart).toBe(true);
      d.step('exit readiness gates on a funded fee source — 900 sats backing makes the exit feasible');

      const batch = await providerD.startUnilateralExit(['op-fallback-1'], FORCE_UNROLL_ACK);
      expect(batch.started.map((s) => s.outpoint)).toStrictEqual(['op-fallback-1']);
      d.step('unilateral exit STARTED (operator still unreachable — wallet-side operation)');

      for (const phase of ['materializing', 'csv_pending', 'sweeping', 'completed'] as const) {
        simD.advanceExitJob('op-fallback-1', phase);
      }
      const finalStatus = await providerD.exitStatusFor('op-fallback-1');
      expect(finalStatus.found).toBe(true);
      expect(finalStatus.status).toBe('completed');
      expect(finalStatus.sweepTxid).not.toBe('');
      d.step(`exit completed on-chain — sweep tx ${finalStatus.sweepTxid}, funds out of the operator's hands`);
      expect(simD.vtxos).toStrictEqual([]);
      expect(simD.balances.confirmedSat).toBe(0);
    });
  });

  it('keeps the suite honest: daemon identity derives from the seed alone', () => {
    // Same words on a third daemon → same identity: the property every leg
    // above relies on. No cross-daemon wallet state is shared.
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu'];
    expect(simWalletKey(words)).toBe(simWalletKey([...words]));
    const other = [...words];
    other[0] = 'sigma';
    expect(simWalletKey(other)).not.toBe(simWalletKey(words));
  });
});
