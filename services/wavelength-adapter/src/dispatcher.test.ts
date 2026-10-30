import { describe, expect, it, vi } from 'vitest';
import type { PaymentIntent } from '@sovereign/payments';
import {
  EntryFailureCodeFailed,
  EntryFailureCodeTimedOut,
  EntryPhaseConfirmed,
  EntryPhaseFailed,
  EntryStatusComplete,
  EntryStatusFailed,
  EntryStatusPending,
  EntryRequestTypeOnchain,
  SendQuoteStatusComplete,
  SendRailLightning,
  WavelengthError,
  type Entry,
  type ListResult,
  type PrepareSendResult,
  type SendResult,
  type WavelengthClient,
} from './sdk/index.js';
import { WavelengthPaymentDispatcher, UnsupportedPaymentKindError } from './dispatcher.js';
import { SDK_PIN } from './sdk-pin.js';
import type { LightningSendPayload } from './payloads.js';

const QUOTE: PrepareSendResult = {
  sendIntentId: 'send-intent-7',
  amountSat: 470,
  expectedFeeSat: 30,
  feeKnown: true,
  expectedTotalOutflowSat: 500,
  totalOutflowKnown: true,
  rail: SendRailLightning,
  quoteStatus: SendQuoteStatusComplete,
  destinationSummary: 'self',
  invoiceDescription: 'coffee',
  paymentHash: 'ph-settled',
  expiresAtUnix: 1_798_000_000,
  selectedOutpoints: [],
  warning: '',
};

const PAYLOAD: LightningSendPayload = {
  invoice: 'lnbcrt1invoice',
  amountSat: 470,
  quote: QUOTE,
};

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1',
    kind: 'send',
    status: 'pending',
    amountSat: 470,
    feeSat: 30,
    counterparty: 'swap-server',
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:01:00Z',
    note: '',
    failureReason: '',
    cursor: 0,
    failureCode: EntryFailureCodeFailed,
    ...overrides,
  };
}

function sendResult(e: Entry): SendResult {
  return { entry: e, actualAmountSat: e.amountSat };
}

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    intentId: '11111111-2222-3333-4444-555555555555',
    kind: 'lightning-invoice',
    payload: PAYLOAD,
    maxFeeSat: 100,
    state: 'authorized',
    attempts: [],
    ...overrides,
  };
}

function dispatchedIntent(): PaymentIntent {
  return intent({
    state: 'in-flight',
    backendRef: 'ph-settled',
    attempts: [{ at: 't0', result: 'dispatched', backendRef: 'ph-settled' }],
  });
}

function fakeClient(overrides: Partial<WavelengthClient> = {}): WavelengthClient {
  return {
    prepareSend: vi.fn().mockResolvedValue(QUOTE),
    sendPrepared: vi.fn(),
    list: vi.fn().mockResolvedValue({
      view: 'activity',
      activity: { entries: [], total: 0, hasMore: false, nextCursor: '' },
    } satisfies ListResult),
    ...overrides,
  } as unknown as WavelengthClient;
}

function listPage(entries: Entry[], hasMore = false, nextCursor = ''): ListResult {
  return {
    view: 'activity',
    activity: { entries, total: entries.length, hasMore, nextCursor },
  };
}

describe('prepare — the local backend reference', () => {
  it('derives the Lightning backend ref from the stored quote payment hash', async () => {
    const d = new WavelengthPaymentDispatcher({ client: fakeClient(), sdkPin: SDK_PIN });
    const ref = await d.prepare(
      intent({ payload: { ...PAYLOAD, quote: { ...QUOTE, paymentHash: 'ph-77' } } }),
    );
    expect(ref.backendRef).toBe('ph-77');
  });

  it('refuses to prepare a Lightning send whose quote carries no payment hash', async () => {
    const d = new WavelengthPaymentDispatcher({ client: fakeClient(), sdkPin: SDK_PIN });
    await expect(
      d.prepare(intent({ payload: { ...PAYLOAD, quote: { ...QUOTE, paymentHash: '' } } })),
    ).rejects.toThrow(/payment hash/i);
  });

  it('refuses to prepare a Lightning send whose quote was never persisted', async () => {
    const d = new WavelengthPaymentDispatcher({ client: fakeClient(), sdkPin: SDK_PIN });
    await expect(
      d.prepare(intent({ payload: { invoice: 'lnbcrt1x' } })),
    ).rejects.toThrow(/quote/i);
  });

  it('derives the on-chain backend ref from the quote sendIntentId', async () => {
    const d = new WavelengthPaymentDispatcher({ client: fakeClient(), sdkPin: SDK_PIN });
    const ref = await d.prepare(
      intent({
        kind: 'onchain',
        payload: { onchainAddress: 'bcrt1qdest', amountSat: 500, quote: QUOTE },
      }),
    );
    expect(ref.backendRef).toBe('send-intent-7');
  });

  it('rejects Ark VTXO and asset-transfer kinds — Mode A does not implement them', async () => {
    const d = new WavelengthPaymentDispatcher({ client: fakeClient(), sdkPin: SDK_PIN });
    await expect(d.prepare(intent({ kind: 'ark-vtxo' }))).rejects.toBeInstanceOf(UnsupportedPaymentKindError);
    await expect(d.prepare(intent({ kind: 'asset-transfer' }))).rejects.toBeInstanceOf(UnsupportedPaymentKindError);
  });
});

describe('dispatch — send the exact approved quote once', () => {
  it('sends the stored quote object itself — never a re-quote', async () => {
    const c = fakeClient({ sendPrepared: vi.fn().mockResolvedValue(sendResult(entry())) });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    await d.dispatch(intent(), 'send-intent-7');
    expect(c.sendPrepared).toHaveBeenCalledWith(QUOTE);
    expect(c.sendPrepared).toHaveBeenCalledTimes(1);
  });

  it('maps a complete entry to settled with the canonical payment hash', async () => {
    const e = entry({
      status: EntryStatusComplete,
      progress: { phase: EntryPhaseConfirmed, phaseLabel: '', paymentHash: 'ph-final', txid: '', confirmationHeight: 0, vTXOOutpoint: '', preimage: '' },
    });
    const c = fakeClient({ sendPrepared: vi.fn().mockResolvedValue(sendResult(e)) });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    const outcome = await d.dispatch(intent(), 'send-intent-7');
    expect(outcome).toEqual({ status: 'settled', backendRef: 'ph-final' });
  });

  it('falls back to the dispatched local ref when the settled entry carries no progress', async () => {
    const c = fakeClient({ sendPrepared: vi.fn().mockResolvedValue(sendResult(entry({ status: EntryStatusComplete }))) });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    const outcome = await d.dispatch(intent(), 'send-intent-7');
    expect(outcome).toEqual({ status: 'settled', backendRef: 'send-intent-7' });
  });

  it('maps a pending entry to sent — in-flight, reconciliation owns the rest', async () => {
    const c = fakeClient({ sendPrepared: vi.fn().mockResolvedValue(sendResult(entry())) });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    expect(await d.dispatch(intent(), 'send-intent-7')).toEqual({ status: 'sent' });
  });

  it('maps a failed entry to a definitive failure with the reason', async () => {
    const e = entry({
      status: EntryStatusFailed,
      failureCode: EntryFailureCodeTimedOut,
      failureReason: 'swap server never funded',
    });
    const c = fakeClient({ sendPrepared: vi.fn().mockResolvedValue(sendResult(e)) });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    const outcome = await d.dispatch(intent(), 'send-intent-7');
    expect(outcome.status).toBe('definitive-failure');
    if (outcome.status === 'definitive-failure') {
      expect(outcome.reason).toContain('timed_out');
    }
  });

  it('rejects unsupported payment kinds at dispatch time too', async () => {
    const d = new WavelengthPaymentDispatcher({ client: fakeClient(), sdkPin: SDK_PIN });
    await expect(d.dispatch(intent({ kind: 'ark-vtxo' }), 'ref')).rejects.toBeInstanceOf(UnsupportedPaymentKindError);
  });

  it('surfaces an SDK throw as a WavelengthError — not a silent crash', async () => {
    const c = fakeClient({
      sendPrepared: vi.fn().mockRejectedValue(new WavelengthError('swap backend exploded')),
    });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    await expect(d.dispatch(intent(), 'ref')).rejects.toBeInstanceOf(WavelengthError);
  });

  it('times out a hanging send and reports a WavelengthError', async () => {
    const c = fakeClient({ sendPrepared: vi.fn().mockReturnValue(new Promise(() => {})) });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN, dispatchTimeoutMs: 10 });
    await expect(d.dispatch(intent(), 'ref')).rejects.toBeInstanceOf(WavelengthError);
  });
});

describe('lookup — the ONLY method recovery may call', () => {
  it('finds a settled entry by the persisted backend ref', async () => {
    const e = entry({
      id: 'entry-9',
      status: EntryStatusComplete,
      progress: { phase: EntryPhaseConfirmed, phaseLabel: '', paymentHash: 'ph-settled', txid: '', confirmationHeight: 0, vTXOOutpoint: '', preimage: '' },
    });
    const c = fakeClient({ list: vi.fn().mockResolvedValue(listPage([e])) });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    expect(await d.lookup(dispatchedIntent())).toEqual({ status: 'settled', backendRef: 'ph-settled' });
  });

  it('finds a failed entry and reports it failed — never retryable', async () => {
    const e = entry({
      id: 'entry-9',
      status: EntryStatusFailed,
      failureCode: EntryFailureCodeTimedOut,
      failureReason: 'swap expired',
      // A failed swap entry still carries the payment hash in progress —
      // that is how recovery correlates it to the dispatched intent.
      progress: { phase: EntryPhaseFailed, phaseLabel: '', paymentHash: 'ph-settled', txid: '', confirmationHeight: 0, vTXOOutpoint: '', preimage: '' },
    });
    const c = fakeClient({ list: vi.fn().mockResolvedValue(listPage([e])) });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    const result = await d.lookup(dispatchedIntent());
    expect(result.status).toBe('failed');
  });

  it('reports unknown for a live entry — the double-pay guard', async () => {
    const e = entry({ id: 'entry-9', status: EntryStatusPending });
    const c = fakeClient({ list: vi.fn().mockResolvedValue(listPage([e])) });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    expect(await d.lookup(dispatchedIntent())).toEqual({ status: 'unknown' });
  });

  it('reports not-found when nothing dispatched — safe to re-sign a retry', async () => {
    const c = fakeClient();
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    expect(await d.lookup(intent({ backendRef: 'ph-never-sent' }))).toEqual({ status: 'not-found' });
  });

  it('escalates a dispatched-but-unfindable payment to unknown — never re-dispatch on a guess', async () => {
    const c = fakeClient();
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    expect(await d.lookup(dispatchedIntent())).toEqual({ status: 'unknown' });
  });

  it('walks pagination pages until the entry is found', async () => {
    const page2 = listPage([
      entry({
        id: 'entry-9',
        status: EntryStatusComplete,
        progress: { phase: EntryPhaseConfirmed, phaseLabel: '', paymentHash: 'ph-settled', txid: '', confirmationHeight: 0, vTXOOutpoint: '', preimage: '' },
      }),
    ]);
    const page1 = listPage([entry({ id: 'entry-1' })], true, 'next-cursor');
    const list = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const c = fakeClient({ list });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    expect(await d.lookup(dispatchedIntent())).toEqual({ status: 'settled', backendRef: 'ph-settled' });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('correlates on-chain sends by destination address when no ref matches', async () => {
    const e = entry({
      id: 'entry-9',
      kind: 'send',
      status: EntryStatusComplete,
      amountSat: 5_000,
      request: { type: EntryRequestTypeOnchain, lightningInvoice: '', paymentHash: '', onchainAddress: 'bcrt1qdest', arkAddress: '' },
    });
    const c = fakeClient({ list: vi.fn().mockResolvedValue(listPage([e])) });
    const d = new WavelengthPaymentDispatcher({ client: c, sdkPin: SDK_PIN });
    const result = await d.lookup(
      intent({
        kind: 'onchain',
        payload: { onchainAddress: 'bcrt1qdest', amountSat: 5_000, quote: { ...QUOTE, sendIntentId: 'other-intent' } },
      }),
    );
    expect(result.status).toBe('settled');
  });
});
