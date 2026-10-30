/**
 * Mode A Ark money-flow — integration test (regtest harness).
 *
 * Drives the REAL adapter stack — WavelengthProvider, WavelengthPaymentDispatcher,
 * and the shared PaymentEngine — against a SimulatedWavelengthClient that
 * implements the pinned Wavelength SDK v0.2.0 contract (see simulated-client.ts
 * for why the daemon itself is simulated). Every SDK-shape assumption the
 * adapter makes is exercised here end-to-end on regtest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryPaymentIntentStore, PaymentEngine } from '@sovereign/payments';
import type { WalletEvent } from '@sovereign/wallet-core';
import {
  FORCE_UNROLL_ACK,
  WavelengthError,
  WavelengthPaymentDispatcher,
  WavelengthProvider,
  describeExitJobStatus,
  quoteLightningSend,
  SDK_PIN,
} from '@sovereign/wavelength-adapter';
import type { PrepareSendResult, SendResult } from '@sovereign/wavelength-adapter';
import { SimulatedWavelengthClient } from './simulated-client.js';

let idSeq = 0;
const deterministicId = (): string => {
  idSeq += 1;
  return `intent-${String(idSeq).padStart(4, '0')}`;
};

const makeEngine = (sim: SimulatedWavelengthClient): PaymentEngine =>
  new PaymentEngine({
    store: new InMemoryPaymentIntentStore(),
    dispatcher: new WavelengthPaymentDispatcher({ client: sim, sdkPin: SDK_PIN }),
    newId: deterministicId,
  });

const makeProvider = (sim: SimulatedWavelengthClient): WavelengthProvider =>
  // Long poll cadence: the tests drive pollOnce() manually; the timer is idle.
  new WavelengthProvider({ client: sim, pollIntervalMs: 1_000_000 });

const INVOICE = 'lnbcrt470n1siminvoice';

/** Narrows the optional stored quote (the dispatcher validates it at prepare). */
function requireQuote<T extends { payload: { quote?: PrepareSendResult } }>(
  quoted: T,
): PrepareSendResult {
  const quote = quoted.payload.quote;
  if (!quote) throw new Error('test setup: payload is missing its stored quote');
  return quote;
}

const makeDispatcher = (sim: SimulatedWavelengthClient): WavelengthPaymentDispatcher =>
  new WavelengthPaymentDispatcher({ client: sim, sdkPin: SDK_PIN });

/** Crashes after the swap server accepted the payment but before returning. */
class CrashMidDispatchClient extends SimulatedWavelengthClient {
  override async sendPrepared(prepared: PrepareSendResult): Promise<SendResult> {
    await super.sendPrepared(prepared);
    throw new WavelengthError('sim: connection lost after the swap server accepted the payment');
  }
}

describe('Ark money flow — swap-based Lightning payments', () => {
  // A fresh simulated wallet per test — no state leaks between flows.
  let sim: SimulatedWavelengthClient;
  let provider: WavelengthProvider | undefined;

  beforeEach(() => {
    sim = new SimulatedWavelengthClient();
  });

  afterEach(async () => {
    if (provider !== undefined) await provider.stop();
  });

  it('quotes, persists, dispatches exactly once, and reconciles the settled swap', async () => {
    sim.depositVTXO('op-fresh', 50_000, 100);
    provider = makeProvider(sim);
    await provider.start({ network: 'regtest', dataDir: '/tmp/sovereign-moneyflow-1' });

    // The store is held by the test so the FINAL persisted state is asserted.
    const store = new InMemoryPaymentIntentStore();
    const engine = new PaymentEngine({
      store,
      dispatcher: makeDispatcher(sim),
      newId: deterministicId,
    });

    // Authorization: quote through the provider, budget-checked before dispatch.
    const quoted = await provider.quoteLightning({ invoice: INVOICE, maxFeeSat: 100 });
    const quote = requireQuote(quoted);
    expect(quote.expectedFeeSat).toBe(sim.swapFeeSat);
    expect(quote.paymentHash).not.toBe('');

    const intent = await engine.submit('lightning-invoice', quoted.payload, 100);
    expect(intent.state).toBe('authorized');
    // The full quote is durable BEFORE any dispatch (persist-before-dispatch).
    expect(intent.payload).toStrictEqual(quoted.payload);

    const executed = await engine.execute(intent.intentId);
    // The swap server accepted but has not settled — the intent is in-flight.
    expect(executed.state).toBe('in-flight');
    expect(sim.sendPreparedCalls).toBe(1);
    const entry = sim.entries[0];
    expect(entry?.progress?.paymentHash).toBe(executed.backendRef);

    // The swap settles off-thread — recovery reconciles, never re-dispatches.
    sim.settleEntry(entry?.id ?? '');
    const report = await engine.recoverInterrupted();
    expect(report.reconciled).toContain(intent.intentId);
    expect(sim.sendPreparedCalls).toBe(1);

    const persisted = await store.get(intent.intentId);
    expect(persisted?.state).toBe('settled');
    expect(persisted?.backendRef).toBe(quote.paymentHash);
  });

  it('reconciles a crash between swap acceptance and outcome recording', async () => {
    const crasher = new CrashMidDispatchClient();
    crasher.depositVTXO('op-crash', 50_000, 100);
    const crashProvider = makeProvider(crasher);
    await crashProvider.start({ network: 'regtest', dataDir: '/tmp/sovereign-moneyflow-2' });
    try {
      const engine = makeEngine(crasher);
      const quoted = await quoteLightningSend(crasher, { invoice: INVOICE }, 100);
      const intent = await engine.submit('lightning-invoice', quoted.payload, 100);

      // The dispatch crashes AFTER the swap server created the pending entry.
      await expect(engine.execute(intent.intentId)).rejects.toBeInstanceOf(WavelengthError);

      // The persisted intent is in-flight with its backend ref — the recovery
      // key. The swap entry exists on the backend.
      const entry = crasher.entries[0];
      expect(entry?.status).toBe('pending');

      crasher.settleEntry(entry?.id ?? '');
      const report = await engine.recoverInterrupted();
      expect(report.reconciled).toContain(intent.intentId);
      // One dispatch attempt total — the crash never caused a double payment.
      expect(crasher.sendPreparedCalls).toBe(1);
    } finally {
      await crashProvider.stop();
    }
  });
});

describe('Ark money flow — VTXO lifecycle and unilateral exit', () => {
  let sim: SimulatedWavelengthClient;
  let provider: WavelengthProvider | undefined;

  beforeEach(() => {
    sim = new SimulatedWavelengthClient();
  });

  afterEach(async () => {
    if (provider !== undefined) await provider.stop();
  });

  it('surfaces expiry and operator-loss edges from the live poll', async () => {
    sim.depositVTXO('op-fresh', 50_000, 100);
    sim.depositVTXO('op-expiring', 50_000, 20); // inside the 25-block free window
    provider = makeProvider(sim);
    const events: WalletEvent[] = [];
    provider.onEvent((e) => events.push(e));
    await provider.start({ network: 'regtest', dataDir: '/tmp/sovereign-moneyflow-3' });

    await provider.pollOnce();
    expect(events).toContainEqual({ type: 'vtxo-expiry-approaching' });

    sim.connectOperator(false);
    await provider.pollOnce();
    expect(events).toContainEqual({ type: 'operator-unreachable' });

    // Balance buckets: the expiring VTXO is locked, the fresh one spendable.
    const buckets = await provider.balanceBuckets();
    expect(buckets.lightningSpendableSat).toBe(100_000n);
    expect(buckets.lockedOrExpiringSat).toBe(50_000n);
  });

  it('walks the unilateral exit: infeasible, funded, started, swept, on-chain', async () => {
    sim.depositVTXO('op-exit', 40_000, 2);
    sim.connectOperator(false); // at-risk — the operator is gone
    provider = makeProvider(sim);
    await provider.start({ network: 'regtest', dataDir: '/tmp/sovereign-moneyflow-4' });

    // Underfunded backing wallet: readiness reports the shortfall, not a start.
    const blocked = await provider.exitReadiness(['op-exit']);
    expect(blocked.canStart).toBe(false);
    expect(blocked.infeasibilityFundable).toBe(true);
    expect(blocked.infeasibilityReason).toBe('wallet_underfunded');

    // Wrong acknowledgement is refused before anything reaches the daemon.
    await expect(
      provider.startUnilateralExit(['op-exit'], 'i know what i am doing'),
    ).rejects.toMatchObject({ reason: 'ack-required' });

    sim.fundBacking(900);
    const ready = await provider.exitReadiness(['op-exit']);
    expect(ready.canStart).toBe(true);

    const batch = await provider.startUnilateralExit(['op-exit'], FORCE_UNROLL_ACK);
    expect(batch.started.map((s) => s.outpoint)).toStrictEqual(['op-exit']);
    expect(sim.exits.get('op-exit')?.status).toBe('pending');

    // The job walks the unilateral phases; copy never promises a speed.
    sim.advanceExitJob('op-exit', 'materializing');
    const status = await provider.exitStatusFor('op-exit', true);
    expect(status.status).toBe('materializing');
    const copy = describeExitJobStatus(status.status, {
      bestCaseBlocksRemaining: status.bestCaseBlocksRemaining,
    });
    expect(copy).toMatch(/best-case/i);

    const summary = await provider.exitSummary();
    expect(summary.totalExits).toBe(1);
    expect(summary.totalVTXOAmountSat).toBe(40_000);

    sim.advanceExitJob('op-exit', 'csv_pending');
    sim.advanceExitJob('op-exit', 'sweeping');
    sim.advanceExitJob('op-exit', 'completed');

    const finalStatus = await provider.exitStatusFor('op-exit');
    expect(finalStatus.found).toBe(true);
    expect(finalStatus.status).toBe('completed');
    expect(finalStatus.sweepTxid).not.toBe('');
    expect(describeExitJobStatus('completed')).toMatch(/on-chain/i);

    // Settled: the VTXO left the wallet and the funds are on-chain.
    expect(sim.vtxos).toStrictEqual([]);
    expect(sim.balances.confirmedSat).toBe(0);
  });
});
