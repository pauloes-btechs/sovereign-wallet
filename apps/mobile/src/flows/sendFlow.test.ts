import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LNC_REMOTE_DECLARATION, WAVELENGTH_DECLARATION } from '@sovereign/wallet-core';
import { remoteLndCapabilities, wavelengthCapabilities } from './capabilities.js';
import { parseDestination } from './destination.js';
import { NO_PLATFORM_SERVICES } from './platform.js';
import { DEFAULT_PREFERENCES, createPreferencesStore, memoryPreferencesBackend } from './preferences.js';
import type { Preferences } from './preferences.js';
import {
  REMOTE_LND_RAIL_RULES,
  WAVELENGTH_RAIL_RULES,
  defaultRail,
  explainSendFailure,
  fixedAmountSat,
  invoiceStatus,
  railOptions,
  relativeDuration,
} from './sendFlow.js';
import { ModeBRemoteController, PaymentNotDispatchedError } from './modeBRemoteController.js';
import { createModeAController } from '../App.js';
import { SimulatedLncPort } from '../testing/simulatedLncPort.js';
import { MobileFlowSimulatedClient } from '../testing/simulatedWalletClient.js';
import { encodeSimulatedBolt11, simHashHex, simSegwitAddress } from '../testing/simInvoice.js';

const NOW = Math.floor(Date.now() / 1000);

function invoice(amountMsat: bigint | null, opts: { expirySeconds?: number; timestamp?: number; label?: string } = {}): string {
  return encodeSimulatedBolt11({
    network: 'regtest',
    amountMsat,
    paymentHashHex: simHashHex(opts.label ?? 'send-flow'),
    description: 'Lunch',
    expirySeconds: opts.expirySeconds ?? 3600,
    timestamp: opts.timestamp ?? NOW,
  });
}

const wavelength = wavelengthCapabilities({
  declared: WAVELENGTH_DECLARATION.capabilities,
  walletReady: true,
  operatorReachable: true,
  platform: NO_PLATFORM_SERVICES,
});

const remote = remoteLndCapabilities({
  declared: LNC_REMOTE_DECLARATION.capabilities,
  connected: true,
  foregrounded: true,
  port: { listLightningActivity: true, listSessions: false, revokeSession: false },
  platform: NO_PLATFORM_SERVICES,
});

function parsed(text: string) {
  const result = parseDestination(text, 'regtest');
  if (!result.ok) throw new Error(result.error.message);
  return result.destination;
}

describe('rail selection', () => {
  it('offers both rails of a unified QR on the everyday wallet, Lightning first', () => {
    const address = simSegwitAddress('regtest', 'rails');
    const dest = parsed(`bitcoin:${address}?amount=0.0001&lightning=${invoice(10_000_000n)}`);
    const options = railOptions(dest, wavelength, WAVELENGTH_RAIL_RULES, NOW);
    expect(options.map((o) => [o.rail, o.available])).toEqual([
      ['lightning', true],
      ['onchain', true],
    ]);
    expect(defaultRail(options)).toBe('lightning');
    expect(fixedAmountSat(dest, 'lightning')).toBe(10_000n);
    expect(fixedAmountSat(dest, 'onchain')).toBe(10_000n);
  });

  it('on a remote node only Lightning is usable; on-chain carries the reason', () => {
    const dest = parsed(`bitcoin:${simSegwitAddress('regtest', 'r')}?lightning=${invoice(5_000_000n)}`);
    const options = railOptions(dest, remote, REMOTE_LND_RAIL_RULES, NOW);
    expect(options.find((o) => o.rail === 'onchain')?.reason).toMatch(/isn't available over this connection/);
    expect(defaultRail(options)).toBe('lightning');
    // An address alone has no usable rail there.
    const onchainOnly = railOptions(parsed(simSegwitAddress('regtest', 'x')), remote, REMOTE_LND_RAIL_RULES, NOW);
    expect(onchainOnly).toHaveLength(1);
    expect(onchainOnly[0]?.available).toBe(false);
  });

  it('refuses amountless and expired invoices with the reason', () => {
    const amountless = railOptions(parsed(invoice(null)), wavelength, WAVELENGTH_RAIL_RULES, NOW);
    expect(amountless[0]?.reason).toMatch(/only pay invoices that include an amount/);
    const expired = railOptions(
      parsed(invoice(1_000_000n, { timestamp: NOW - 7200, expirySeconds: 60 })),
      remote,
      REMOTE_LND_RAIL_RULES,
      NOW,
    );
    expect(expired[0]?.reason).toMatch(/This invoice expired at .* Ask the recipient for a new one/);
  });
});

describe('failure explanations', () => {
  it('maps known backend reasons to plain language with a safe next step', () => {
    expect(explainSendFailure('Estimated fee of 30 sats exceeds the spend policy budget of 10 sats', 'before-dispatch')).toMatchObject({
      title: 'The fee is higher than your limit',
      safeToRetry: true,
    });
    expect(explainSendFailure('Payment failed: FAILURE_REASON_NO_ROUTE', 'before-dispatch').title).toBe('No route to the recipient');
    expect(explainSendFailure('Payment failed: FAILURE_REASON_INSUFFICIENT_BALANCE', 'before-dispatch').title).toBe('Not enough funds');
    expect(explainSendFailure('Payment failed: invoice is already paid', 'before-dispatch')).toMatchObject({ safeToRetry: false });
    expect(explainSendFailure('invoice expired', 'before-dispatch').title).toBe('The invoice expired');
    expect(
      explainSendFailure('The payment could not be confirmed. Check your history before retrying — retrying now could pay twice.', 'before-dispatch'),
    ).toMatchObject({ title: "The payment's result isn't known yet", safeToRetry: false });
  });

  it('after dispatch, every error is an unknown outcome — never "Nothing was sent" or safe to retry', () => {
    for (const raw of [
      'rpc error: code = Unavailable desc = transport is closing',
      'operator unreachable',
      'Payments run while the app is open. Reopen the app and try again.',
      'kaboom',
    ]) {
      const e = explainSendFailure(raw, 'after-dispatch');
      expect(e).toMatchObject({ unknownOutcome: true, safeToRetry: false });
      expect(e.title).not.toMatch(/failed/i);
      expect(e.detail).not.toMatch(/Nothing was sent/);
    }
    // Before dispatch, the same "unavailable" text really means nothing left.
    expect(explainSendFailure('operator unreachable', 'before-dispatch')).toMatchObject({ detail: 'Nothing was sent.', safeToRetry: true });
  });

  it("reads the Wavelength dispatcher's own timeout as an unknown outcome at any stage", () => {
    const e = explainSendFailure('Dispatch for send abc exceeded 30000ms', 'before-dispatch');
    expect(e).toMatchObject({ title: "The payment's result isn't known yet", unknownOutcome: true, safeToRetry: false });
  });

  it('keeps unknown messages verbatim and assumes the worst', () => {
    expect(explainSendFailure('kaboom', 'before-dispatch')).toEqual({
      title: 'The payment failed',
      detail: 'kaboom',
      nextStep: 'Check Activity before trying again.',
      safeToRetry: false,
    });
  });
});

describe('receive status', () => {
  it('prefers the backend record, then the invoice expiry', () => {
    const dest = parsed(invoice(1_000_000n, { timestamp: NOW, expirySeconds: 600 }));
    const inv = dest.lightning;
    expect(invoiceStatus('settled', inv, NOW + 10_000)).toBe('paid');
    expect(invoiceStatus('open', inv, NOW)).toBe('waiting');
    expect(invoiceStatus('open', inv, NOW + 600)).toBe('expired');
    expect(invoiceStatus(null, inv, NOW)).toBe('waiting');
    expect(invoiceStatus('canceled', inv, NOW)).toBe('canceled');
    expect(invoiceStatus(null, null, NOW)).toBe('unknown');
    expect(relativeDuration(3600)).toBe('1 h');
    expect(relativeDuration(3700)).toBe('1 h 1 min');
  });
});

describe('remote node send: review → confirm with the fee limit and timeout', () => {
  let port: SimulatedLncPort;
  let controller: ModeBRemoteController;
  const prefs: Preferences = { ...DEFAULT_PREFERENCES, maxLightningFeePpm: 10_000, maxLightningFeeSat: 5, paymentTimeoutSeconds: 45 };

  beforeEach(async () => {
    port = new SimulatedLncPort();
    controller = new ModeBRemoteController({ port, network: 'regtest' });
    controller.enterPairingPhrase('abstract acid acrobat actor actual admit adopt adore advance adventure');
    await controller.pair();
  });
  afterEach(() => controller.stop());

  it('review decodes the invoice and fixes the cap; nothing reaches the node until confirm', async () => {
    const text = invoice(50_000_000n, { label: 'b-1' });
    controller.editSendDestination(`lightning:${text}`);
    controller.reviewSend(prefs);
    const review = controller.getState().sendReview;
    expect(controller.getState().sendStatus).toBe('review');
    expect(review?.amountSat).toBe(50_000n);
    expect(review?.feeLimitSat).toBe(500n); // 1% of 50,000
    expect(review?.timeoutSeconds).toBe(45);
    expect(port.payRequests).toHaveLength(0);

    await controller.confirmSend();
    expect(port.payRequests).toEqual([{ bolt11: text, timeoutSeconds: 45, feeLimitSat: 500 }]);
    const state = controller.getState();
    expect(state.sendStatus).toBe('settled');
    // Receipt fee read back from the node's own payment record (sim: 0.1%).
    expect(state.sendReceipt).toMatchObject({ amountSat: 50_000n, feeSat: 50n, paymentHash: simHashHex('b-1') });
  });

  it('a fee above the limit fails at the node with the reason kept for the screen', async () => {
    controller.editSendDestination(invoice(50_000_000n, { label: 'b-2' }));
    controller.reviewSend({ ...prefs, maxLightningFeePpm: 0, maxLightningFeeSat: 10 });
    await controller.confirmSend();
    expect(controller.getState().sendStatus).toBe('failed');
    expect(controller.getState().sendError).toBe('Payment failed: FAILURE_REASON_NO_ROUTE');
    expect(port.payRequests[0]?.feeLimitSat).toBe(10);
  });

  it('two concurrent confirms dispatch once; a confirm after it settled dispatches nothing', async () => {
    controller.editSendDestination(invoice(50_000_000n, { label: 'b-dup' }));
    controller.reviewSend(prefs);
    await Promise.all([controller.confirmSend(), controller.confirmSend()]);
    expect(port.payRequests).toHaveLength(1);
    expect(controller.getState().sendStatus).toBe('settled');
    await controller.confirmSend();
    expect(port.payRequests).toHaveLength(1);
    expect(controller.getState().sendStatus).toBe('settled');
  });

  it('a connection error thrown after the request reached the node stays in flight and is reconciled by lookup', async () => {
    class DroppingPort extends SimulatedLncPort {
      lookups = 0;
      override async payInvoice(request: Parameters<SimulatedLncPort['payInvoice']>[0]): ReturnType<SimulatedLncPort['payInvoice']> {
        await super.payInvoice(request); // the node got it and paid…
        throw new Error('rpc error: code = Unavailable desc = transport is closing'); // …then the stream dropped
      }
      override async lookupPayment(hash: string): ReturnType<SimulatedLncPort['lookupPayment']> {
        this.lookups += 1;
        return { status: 'settled', backendRef: hash };
      }
    }
    const dropping = new DroppingPort();
    const c = new ModeBRemoteController({ port: dropping, network: 'regtest' });
    c.enterPairingPhrase('abstract acid acrobat actor actual admit adopt adore advance adventure');
    await c.pair();
    c.editSendDestination(invoice(50_000_000n, { label: 'b-drop' }));
    c.reviewSend(prefs);
    await c.confirmSend();
    const s = c.getState();
    expect(dropping.payRequests).toHaveLength(1);
    expect(s.sendStatus).toBe('in-flight'); // never "failed", never "Nothing was sent"
    expect(s.sendError).toContain('transport is closing');
    expect(explainSendFailure(s.sendError, 'after-dispatch')).toMatchObject({ unknownOutcome: true, safeToRetry: false });
    expect(explainSendFailure(s.sendError, 'after-dispatch').detail).not.toMatch(/Nothing was sent/);

    await c.checkPaymentStatus();
    expect(dropping.lookups).toBe(1);
    expect(c.getState().sendStatus).toBe('settled');
    expect(dropping.payRequests).toHaveLength(1); // looked up, never re-sent
    c.stop();
  });

  it('a typed pre-dispatch refusal from the port is a definitive failure', async () => {
    class OfflinePort extends SimulatedLncPort {
      override async payInvoice(): ReturnType<SimulatedLncPort['payInvoice']> {
        throw new PaymentNotDispatchedError('not connected to the node');
      }
    }
    const offline = new OfflinePort();
    const c = new ModeBRemoteController({ port: offline, network: 'regtest' });
    c.enterPairingPhrase('abstract acid acrobat actor actual admit adopt adore advance adventure');
    await c.pair();
    c.editSendDestination(invoice(50_000_000n, { label: 'b-off' }));
    c.reviewSend(prefs);
    await c.confirmSend();
    expect(c.getState().sendStatus).toBe('failed');
    expect(c.getState().sendError).toBe('Payment failed: not connected to the node');
    c.stop();
  });

  it('review refuses wrong-network, amountless and expired invoices without touching the node', () => {
    controller.editSendDestination(invoice(null));
    controller.reviewSend(prefs);
    expect(controller.getState().sendStatus).toBe('idle');
    expect(controller.getState().sendError).toMatch(/doesn't say how much to pay/);

    controller.editSendDestination('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    controller.reviewSend(prefs);
    expect(controller.getState().sendError).toMatch(/mainnet address, but this wallet is on regtest/);

    controller.editSendDestination(invoice(1_000_000n, { timestamp: NOW - 7200, expirySeconds: 60 }));
    controller.reviewSend(prefs);
    expect(controller.getState().sendError).toMatch(/expired/);
    expect(port.payRequests).toHaveLength(0);
  });

  it('receive passes the expiry preference and memo; paying our own invoice marks it paid', async () => {
    controller.editInvoiceMemo('Pizza');
    await controller.createInvoice({ amountSat: 2_100n, expirySeconds: 900 });
    const created = parsed(controller.getState().invoice ?? '').lightning;
    expect(created?.expirySeconds).toBe(900);
    expect(created?.description).toBe('Pizza');

    // Amountless (payer chooses) is allowed on a node.
    await controller.createInvoice({ amountSat: null });
    expect(parsed(controller.getState().invoice ?? '').lightning?.amountMsat).toBeNull();

    controller.editSendDestination(created?.invoice ?? '');
    controller.reviewSend(prefs);
    await controller.confirmSend();
    await controller.loadActivity();
    const record = controller.getState().activity?.find((r) => r.direction === 'in' && r.paymentHash === created?.paymentHash);
    expect(record?.status).toBe('settled');
  });
});

describe('everyday wallet send: quote with the fee cap, reconcile reports the real outcome', () => {
  it('passes the cap to the quote and keeps the full quote for the review and receipt', async () => {
    const sim = new MobileFlowSimulatedClient();
    const controller = createModeAController({ client: sim, network: 'regtest', dataDir: '/tmp/sf', pollIntervalMs: 600_000 });
    await controller.start();
    const text = invoice(25_000_000n, { label: 'a-1' });
    await controller.reviewPayment({ rail: 'lightning', destination: text, amountSat: 25_000n, maxFeeSat: 125 });
    const quote = controller.getState().sendQuote;
    expect(controller.getState().sendStatus).toBe('review');
    expect(quote).toMatchObject({ rail: 'lightning', amountSat: 25_000n, feeSat: 30n, totalSat: 25_030n, maxFeeSat: 125 });

    // A cap below the swap fee is refused at the quote; nothing is persisted.
    await controller.reviewPayment({ rail: 'lightning', destination: text, amountSat: 25_000n, maxFeeSat: 10 });
    expect(controller.getState().sendStatus).toBe('failed');
    expect(controller.getState().sendQuote).toBeNull();
    expect(explainSendFailure(controller.getState().sendError, 'before-dispatch').title).toBe('The fee is higher than your limit');
    expect(sim.sendPreparedCalls).toBe(0);
    await controller.stop();
  });

  it("the dispatcher's own timeout (thrown after sendPrepared went out) leaves the payment in flight, not failed", async () => {
    class HangingClient extends MobileFlowSimulatedClient {
      prepared = 0;
      override sendPrepared(): ReturnType<MobileFlowSimulatedClient['sendPrepared']> {
        this.prepared += 1;
        return new Promise(() => undefined); // the daemon never answers
      }
    }
    const sim = new HangingClient();
    const store = createPreferencesStore(memoryPreferencesBackend());
    const controller = createModeAController({
      client: sim,
      network: 'regtest',
      dataDir: '/tmp/sf',
      pollIntervalMs: 600_000,
      preferences: { ...store, get: () => ({ ...DEFAULT_PREFERENCES, paymentTimeoutSeconds: 0.05 }) },
    });
    await controller.start();
    await controller.reviewPayment({ rail: 'lightning', destination: invoice(5_000_000n, { label: 'a-hang' }), amountSat: 5_000n, maxFeeSat: 100 });
    await controller.confirmSend();
    const s = controller.getState();
    expect(sim.prepared).toBe(1);
    expect(s.sendError).toMatch(/^Dispatch for send .* exceeded 50ms$/);
    expect(s.sendStatus).toBe('sending'); // in-flight view with "Check payment status"
    // Even without the stage, this message is never read as "failed".
    expect(explainSendFailure(s.sendError, 'before-dispatch')).toMatchObject({ unknownOutcome: true, safeToRetry: false });
    await controller.stop();
  });

  it('a reconciled FAILED payment is reported as failed, never as sent', async () => {
    const sim = new MobileFlowSimulatedClient();
    const controller = createModeAController({ client: sim, network: 'regtest', dataDir: '/tmp/sf', pollIntervalMs: 600_000 });
    await controller.start();
    await controller.reviewPayment({ rail: 'lightning', destination: invoice(5_000_000n, { label: 'a-2' }), amountSat: 5_000n, maxFeeSat: 100 });
    await controller.confirmSend();
    expect(controller.getState().sendStatus).toBe('sending'); // in flight
    const entry = sim.entries[sim.entries.length - 1];
    sim.failEntry(entry?.id ?? '', 'failed', 'swap server refused the payment');
    await controller.reconcilePending();
    expect(controller.getState().sendStatus).toBe('failed');
    expect(controller.getState().sendError).toMatch(/no funds were moved/);
    expect(sim.sendPreparedCalls).toBe(1);
    await controller.stop();
  });

  it('on-chain review needs an amount and quotes the parsed address', async () => {
    const sim = new MobileFlowSimulatedClient();
    const controller = createModeAController({ client: sim, network: 'regtest', dataDir: '/tmp/sf', pollIntervalMs: 600_000 });
    await controller.start();
    const address = simSegwitAddress('regtest', 'a-3');
    await controller.reviewPayment({ rail: 'onchain', destination: address });
    expect(controller.getState().sendError).toMatch(/amount/);
    await controller.reviewPayment({ rail: 'onchain', destination: address, amountSat: 40_000n });
    expect(controller.getState().sendQuote).toMatchObject({ rail: 'onchain', destination: address, amountSat: 40_000n, paymentHash: null });
    await controller.stop();
  });
});
