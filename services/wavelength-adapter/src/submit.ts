/**
 * Submit helpers — the authorization-time policy point for Mode A sends.
 *
 * Each helper quotes the payment against the live daemon (client.prepareSend),
 * enforces the caller's maxFeeSat budget against the quote BEFORE anything is
 * persisted, and returns the payload the host hands to
 * `PaymentEngine.submit` (fee/spend policy enforced at authorization per
 * spec). Dispatch later replays the stored quote's single-use sendIntentId.
 *
 * These helpers never dispatch — they move nothing.
 */

import { FeeExceedsBudgetError } from '@sovereign/wallet-core';
import type { PrepareSendResult, WavelengthClient } from './sdk/index.js';
import type { LightningSendPayload, OnchainSendPayload } from './payloads.js';

/** Input for {@link quoteLightningSend} — no quote attached yet. */
export type LightningSendInput = Omit<LightningSendPayload, 'quote'>;

/** Input for {@link quoteOnchainSend} — no quote attached yet. */
export type OnchainSendInput = Omit<OnchainSendPayload, 'quote'>;

/** Base payload with the approved quote attached. */
export interface QuotedSend {
  readonly payload: LightningSendPayload | OnchainSendPayload;
  readonly quote: PrepareSendResult;
}

/** Quotes a Lightning swap send; throws when the fee exceeds the budget. */
export async function quoteLightningSend(
  client: WavelengthClient,
  input: LightningSendInput,
  maxFeeSat?: number,
): Promise<QuotedSend & { payload: LightningSendPayload }> {
  const quote = await client.prepareSend({
    invoice: input.invoice,
    amountSat: input.amountSat,
    note: input.note,
    maxFeeSat,
  });
  assertFeeWithinBudget(quote, maxFeeSat);
  return { payload: { ...input, quote }, quote };
}

/** Quotes an on-chain send; throws when the fee exceeds the budget. */
export async function quoteOnchainSend(
  client: WavelengthClient,
  input: OnchainSendInput,
  maxFeeSat?: number,
): Promise<QuotedSend & { payload: OnchainSendPayload }> {
  const quote = await client.prepareSend({
    onchainAddress: input.onchainAddress,
    amountSat: input.amountSat,
    sweepAll: input.sweepAll,
    note: input.note,
    maxFeeSat,
  });
  assertFeeWithinBudget(quote, maxFeeSat);
  return { payload: { ...input, quote }, quote };
}

/** The authorization-time fee policy check — shared by both rails. */
function assertFeeWithinBudget(
  quote: { expectedFeeSat: number; feeKnown: boolean },
  maxFeeSat: number | undefined,
): void {
  if (maxFeeSat !== undefined && quote.expectedFeeSat > maxFeeSat) {
    throw new FeeExceedsBudgetError(BigInt(quote.expectedFeeSat), maxFeeSat);
  }
}
