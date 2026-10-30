import { describe, expect, it, vi } from 'vitest';
import { FeeExceedsBudgetError } from '@sovereign/wallet-core';
import {
  SendQuoteStatusComplete,
  SendRailLightning,
  SendRailOnchain,
  type PrepareSendResult,
  type WavelengthClient,
} from './sdk/index.js';
import { quoteLightningSend, quoteOnchainSend } from './submit.js';

function quoteResult(overrides: Partial<PrepareSendResult> = {}): PrepareSendResult {
  return {
    sendIntentId: 'send-intent-1',
    amountSat: 470,
    expectedFeeSat: 30,
    feeKnown: true,
    expectedTotalOutflowSat: 500,
    totalOutflowKnown: true,
    rail: SendRailLightning,
    quoteStatus: SendQuoteStatusComplete,
    destinationSummary: 'self',
    invoiceDescription: 'coffee',
    paymentHash: 'ph-1',
    expiresAtUnix: 1_798_000_000,
    selectedOutpoints: [],
    warning: '',
    ...overrides,
  };
}

function client(result: PrepareSendResult): WavelengthClient {
  return {
    prepareSend: vi.fn().mockResolvedValue(result),
  } as unknown as WavelengthClient;
}

describe('quoteLightningSend — authorization-time fee gate', () => {
  it('attaches the daemon quote verbatim to the payload without dispatching', async () => {
    const c = client(quoteResult());
    const { payload, quote } = await quoteLightningSend(
      c,
      { invoice: 'lnbcrt1invoice', amountSat: 470, note: 'coffee' },
      100,
    );
    expect(c.prepareSend).toHaveBeenCalledWith({
      invoice: 'lnbcrt1invoice',
      amountSat: 470,
      note: 'coffee',
      maxFeeSat: 100,
    });
    expect(quote.expectedFeeSat).toBe(30);
    expect(quote.sendIntentId).toBe('send-intent-1');
    // The exact quote object is stored — dispatch replays it, never re-quotes.
    expect(payload.quote).toBe(quote);
    expect(payload.invoice).toBe('lnbcrt1invoice');
  });

  it('rejects a quote whose fee exceeds the user budget — before anything moves', async () => {
    const c = client(quoteResult({ expectedFeeSat: 300 }));
    await expect(
      quoteLightningSend(c, { invoice: 'lnbcrt1x', amountSat: 200 }, 100),
    ).rejects.toBeInstanceOf(FeeExceedsBudgetError);
    // One prepare call — no retries, no dispatch.
    expect(c.prepareSend).toHaveBeenCalledTimes(1);
  });

  it('passes without a budget check when no maxFeeSat is set', async () => {
    const c = client(quoteResult());
    const { payload } = await quoteLightningSend(c, { invoice: 'lnbcrt1y' });
    expect(payload.quote?.expectedFeeSat).toBe(30);
  });
});

describe('quoteOnchainSend', () => {
  it('quotes and attaches the quote for the on-chain payload', async () => {
    const c = client(
      quoteResult({ rail: SendRailOnchain, expectedFeeSat: 250, expectedTotalOutflowSat: 5_250 }),
    );
    const { payload, quote } = await quoteOnchainSend(
      c,
      { onchainAddress: 'bcrt1qdest', amountSat: 5_000, sweepAll: false },
      1_000,
    );
    expect(c.prepareSend).toHaveBeenCalledWith({
      onchainAddress: 'bcrt1qdest',
      amountSat: 5_000,
      sweepAll: false,
      note: undefined,
      maxFeeSat: 1_000,
    });
    expect(quote.expectedFeeSat).toBe(250);
    expect(payload.onchainAddress).toBe('bcrt1qdest');
    expect(payload.quote).toBe(quote);
  });

  it('rejects on-chain quotes above budget', async () => {
    const c = client(quoteResult({ expectedFeeSat: 2_000 }));
    await expect(
      quoteOnchainSend(c, { onchainAddress: 'bcrt1qdest', amountSat: 5_000 }, 1_000),
    ).rejects.toBeInstanceOf(FeeExceedsBudgetError);
  });
});
