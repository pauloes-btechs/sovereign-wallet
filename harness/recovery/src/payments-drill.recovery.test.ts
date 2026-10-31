/**
 * Recovery drill 4 — interrupted-payment recovery against a REAL LND.
 *
 * Payments are persisted 'in-flight' (with their backendRef) BEFORE the
 * network is touched; on restart every 'signing' | 'in-flight' intent is
 * reconciled against the backend — NEVER blindly re-dispatched. This drill
 * crashes the dispatcher at both dangerous moments against live lnd nodes
 * on the regtest harness and proves reconciliation from the durable SQLite
 * intent store:
 *   - crash AFTER the HTLC entered flight → the payment completes on the
 *     network, restart reconciles it to 'settled', zero new dispatches;
 *   - crash BEFORE the send → restart reconciles to 'authorized' (one safe,
 *     re-signed retry) and exactly ONE payment ever reaches the network.
 *
 * RELEASE-BLOCKING per the Sovereign Wallet spec (art_c8VM79Nw).
 * Regtest only — never mainnet.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Invoice,
  GetInfoRequest,
  ListPaymentsRequest,
  Payment_PaymentStatus,
  RouterClient,
  SendPaymentRequest,
  LightningClient,
  type Payment,
} from '@sovereign/litd-proto';
import {
  ALICE,
  BOB,
  bootstrapHarness,
  waitForRoutable,
} from '@sovereign/harness-regtest';
import { PaymentEngine, SqlitePaymentIntentStore, type DispatchOutcome, type PaymentDispatcher, type PaymentIntent, type ReconcileResult } from '@sovereign/payments';
import { openNodeSqliteDatabase } from '@sovereign/secure-store';

import { assertRegtestOnly, execTransport } from './docker-nodes.js';
import { fundFromHarness, openChannelActive, poll } from './lnd-flows.js';
import { renderTestResults, runDrill } from './recorder.js';

const ENV = 'docker compose regtest: real lnd payment, disposable SQLite intent store';

type CrashMode = 'before-send' | 'after-inflight';

interface InvoicePayload {
  bolt11: string;
  paymentHashHex: string;
}

/**
 * Real LND payment dispatcher with crash injection at the two dangerous
 * moments. `dispatch` is called at most once per intent by the engine;
 * `lookup` is the ONLY method recovery is allowed to call.
 */
class RealLndPaymentDispatcher implements PaymentDispatcher {
  dispatchCalls = 0;

  constructor(
    private readonly router: RouterClient,
    private readonly lightning: LightningClient,
    private readonly crash?: CrashMode,
  ) {}

  async prepare(intent: Readonly<PaymentIntent>): Promise<{ backendRef: string }> {
    const payload = intent.payload as InvoicePayload;
    return { backendRef: payload.paymentHashHex };
  }

  async dispatch(intent: Readonly<PaymentIntent>, backendRef: string): Promise<DispatchOutcome> {
    this.dispatchCalls += 1;
    if (this.crash === 'before-send') {
      throw new Error('simulated crash: process died before the payment was dispatched');
    }
    const payload = intent.payload as InvoicePayload;
    const call = this.router.sendPaymentV2(
      SendPaymentRequest.create({ paymentRequest: payload.bolt11, timeoutSeconds: 60 }),
    );
    if (this.crash === 'after-inflight') {
      // protobuf-ts ServerStreamingCall has no per-call cancel — abandoning
      // consumption (break) leaves the HTLC live server-side, which is
      // exactly the crash this leg models.
      let sawInFlight = false;
      for await (const update of call.responses) {
        if (update.status === Payment_PaymentStatus.IN_FLIGHT) {
          sawInFlight = true;
          break;
        }
      }
      if (!sawInFlight) {
        throw new Error('simulated crash: stream ended before an in-flight update');
      }
      throw new Error('simulated crash: process died with the payment in flight');
    }
    for await (const update of call.responses) {
      if (update.status === Payment_PaymentStatus.SUCCEEDED) {
        return { status: 'settled', backendRef };
      }
      if (update.status === Payment_PaymentStatus.FAILED) {
        return { status: 'definitive-failure', reason: String(update.failureReason) };
      }
    }
    return { status: 'timeout' };
  }

  /** Backend lookup by payment hash — never dispatches. */
  async lookup(intent: Readonly<PaymentIntent>): Promise<ReconcileResult> {
    const payload = intent.payload as InvoicePayload;
    const res = await this.lightning
      .listPayments(ListPaymentsRequest.create({ includeIncomplete: true, maxPayments: 100n }))
      .response;
    const payment: Payment | undefined = res.payments.find(
      (p) => p.paymentHash === payload.paymentHashHex,
    );
    if (payment === undefined) return { status: 'not-found' };
    if (payment.status === Payment_PaymentStatus.SUCCEEDED) {
      return { status: 'settled', backendRef: payload.paymentHashHex };
    }
    if (payment.status === Payment_PaymentStatus.FAILED) {
      return { status: 'failed', reason: String(payment.failureReason) };
    }
    return { status: 'unknown' };
  }
}

let dataRoot: string | undefined;
let alice: LightningClient | undefined;
let bob: LightningClient | undefined;
let aliceTransport: Awaited<ReturnType<typeof execTransport>> | undefined;
let bobTransport: Awaited<ReturnType<typeof execTransport>> | undefined;
let bobPubkey = '';
let idSeq = 0;
const deterministicId = (): string => {
  idSeq += 1;
  return `intent-${String(idSeq).padStart(4, '0')}`;
};

/** Adds a 50k-sat invoice on bob and returns the payload the engine stores. */
async function invoiceOnBob(memo: string): Promise<InvoicePayload> {
  const res = await bob!
    .addInvoice(Invoice.create({ value: 50_000n, memo }))
    .response;
  return {
    bolt11: res.paymentRequest,
    paymentHashHex: Buffer.from(res.rHash).toString('hex'),
  };
}

beforeAll(async () => {
  await bootstrapHarness();
  await assertRegtestOnly(BOB);
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'recovery-payments-'));
  // BOTH nodes over container-side credential reads: the SCB drill (which
  // runs in the same CI job) wipes and re-initializes bob AND alice, and
  // re-created macaroons are root-owned in the bind mounts — host-side file
  // reads would race them. One transport per node, multiplexed by the
  // lightning client and every router below, closed in afterAll.
  aliceTransport = await execTransport(ALICE);
  bobTransport = await execTransport(BOB);
  alice = new LightningClient(aliceTransport);
  bob = new LightningClient(bobTransport);
  await fundFromHarness(alice, 2, 'alice');
  // Identity via the exec client — never a host-side read of bob's files
  // (the SCB drill re-creates them root-owned in the bind mount).
  bobPubkey = (await bob.getInfo(GetInfoRequest.create({})).response).identityPubkey;
  await openChannelActive(alice, bobPubkey, 'lnd-bob:9735', 1_000_000);
  await waitForRoutable(alice, 50_000n, bobPubkey, 120_000);
}, 480_000);

afterAll(async () => {
  aliceTransport?.close();
  bobTransport?.close();
  if (dataRoot !== undefined) rmSync(dataRoot, { recursive: true, force: true });
  renderTestResults();
});

describe('recovery drill 4 — interrupted-payment recovery (never blind re-dispatch)', () => {
  it('reconciles a crashed in-flight payment to settled with zero re-dispatches', async () => {
    await runDrill(
      'drill-4a-interrupted-payment-settled',
      'Crash with the payment in flight → restart reconciles to settled, zero re-dispatches',
      ENV,
      async (d) => {
        const payload = await invoiceOnBob('recovery-drill-4a');
        const db1 = await openNodeSqliteDatabase('payment-intents', dataRoot!);
        const store1 = new SqlitePaymentIntentStore(db1);
        const crashDispatcher = new RealLndPaymentDispatcher(
          new RouterClient(aliceTransport!),
          alice!,
          'after-inflight',
        );
        const crashedEngine = new PaymentEngine({ store: store1, dispatcher: crashDispatcher, newId: deterministicId });
        const intent = await crashedEngine.submit('lightning-invoice', payload, 1_000);
        d.step(`intent ${intent.intentId} submitted (50k sat invoice, max fee 1000 sat) and authorized`);

        // The crash: dispatch throws AFTER the HTLC entered flight — the
        // engine had persisted 'in-flight' (with the backendRef) BEFORE the
        // network call, so the intent is durable.
        await expect(crashedEngine.execute(intent.intentId)).rejects.toThrow(/simulated crash/);
        const afterCrash = await store1.get(intent.intentId);
        expect(afterCrash?.state).toBe('in-flight');
        expect(afterCrash?.backendRef).toBe(payload.paymentHashHex);
        d.step('dispatcher crashed with the payment in flight — the intent is durable in SQLite as in-flight with its backendRef');

        // lnd finishes the payment on its own — the network did the work.
        await poll(
          async () => (await alice!.listPayments(ListPaymentsRequest.create({ includeIncomplete: true }))).response.payments.find((p) => p.paymentHash === payload.paymentHashHex)?.status,
          (status) => status === Payment_PaymentStatus.SUCCEEDED,
          'the crashed-in-flight payment to settle on the network',
          180_000,
        );
        d.step('lnd carried the abandoned HTLC to SUCCEEDED — the payment completed despite the crash');

        // Restart: a NEW engine over the SAME durable store, clean dispatcher.
        const db2 = await openNodeSqliteDatabase('payment-intents', dataRoot!);
        const store2 = new SqlitePaymentIntentStore(db2);
        const liveDispatcher = new RealLndPaymentDispatcher(new RouterClient(aliceTransport!), alice!);
        const restartedEngine = new PaymentEngine({ store: store2, dispatcher: liveDispatcher, newId: deterministicId });
        const report = await restartedEngine.recoverInterrupted();
        expect(report.reconciled).toContain(intent.intentId);
        const reconciled = await store2.get(intent.intentId);
        expect(reconciled?.state).toBe('settled');
        expect(reconciled?.backendRef).toBe(payload.paymentHashHex);
        d.step('restarted engine reconciled the intent from the SQLite store against lnd → settled — with ZERO dispatch calls on the new dispatcher');
        expect(liveDispatcher.dispatchCalls).toBe(0);

        // The network saw exactly ONE payment for this hash — no duplicates.
        const payments = (await alice!.listPayments(ListPaymentsRequest.create({ includeIncomplete: true }))).response.payments.filter((p) => p.paymentHash === payload.paymentHashHex);
        expect(payments).toHaveLength(1);
        d.step('lnd shows exactly 1 payment for this hash — blind re-dispatch would have paid twice');
      },
    );
  });

  it('returns a never-dispatched intent to authorized and re-signs exactly once', async () => {
    await runDrill(
      'drill-4b-interrupted-payment-retry',
      'Crash before dispatch → restart reconciles to authorized → one safe re-signed retry settles',
      ENV,
      async (d) => {
        const payload = await invoiceOnBob('recovery-drill-4b');
        const db1 = await openNodeSqliteDatabase('payment-intents', dataRoot!);
        const store1 = new SqlitePaymentIntentStore(db1);
        const crashDispatcher = new RealLndPaymentDispatcher(
          new RouterClient(aliceTransport!),
          alice!,
          'before-send',
        );
        const crashedEngine = new PaymentEngine({ store: store1, dispatcher: crashDispatcher, newId: deterministicId });
        const intent = await crashedEngine.submit('lightning-invoice', payload, 1_000);
        await expect(crashedEngine.execute(intent.intentId)).rejects.toThrow(/simulated crash/);
        const afterCrash = await store1.get(intent.intentId);
        expect(afterCrash?.state).toBe('in-flight');
        d.step('dispatcher crashed BEFORE any network send — intent durable as in-flight, but lnd never saw the payment');

        const db2 = await openNodeSqliteDatabase('payment-intents', dataRoot!);
        const store2 = new SqlitePaymentIntentStore(db2);
        const liveDispatcher = new RealLndPaymentDispatcher(new RouterClient(aliceTransport!), alice!);
        const restartedEngine = new PaymentEngine({ store: store2, dispatcher: liveDispatcher, newId: deterministicId });
        const report = await restartedEngine.recoverInterrupted();
        expect(report.reconciled).toContain(intent.intentId);
        const reconciledState = (await store2.get(intent.intentId))?.state;
        expect(reconciledState).toBe('authorized');
        d.step('restarted engine looked the payment up at lnd → not-found → the intent returns to AUTHORIZED for one safe, re-signed retry (never a blind retry)');

        // The one safe retry: re-sign and execute through the live engine.
        const settled = await restartedEngine.execute(intent.intentId);
        expect(settled.state).toBe('settled');
        expect(liveDispatcher.dispatchCalls).toBe(1);
        d.step('the single authorized retry executed and settled — exactly one live dispatch');

        const payments = (await alice!.listPayments(ListPaymentsRequest.create({ includeIncomplete: true }))).response.payments.filter((p) => p.paymentHash === payload.paymentHashHex);
        expect(payments).toHaveLength(1);
        d.step('lnd shows exactly 1 payment for this hash — the crash never produced a duplicate on the network');
      },
    );
  });
});
