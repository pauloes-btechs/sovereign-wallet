/**
 * Swap-based payment dispatch — the Mode A implementation of the shared
 * PaymentDispatcher port.
 *
 * Lightning in Mode A works through atomic swaps with a swap server (never
 * channels). The SDK's quote → confirm → pay flow maps onto the intent
 * machine like this:
 *
 * - authorize (policy point): submitLightningSend / submitOnchainSend quote
 *   the swap (client.prepareSend), enforce the maxFeeSat budget against the
 *   LIVE quote, and store the full PrepareSendResult in the intent payload.
 *   The quote's sendIntentId is single-use; storing it verbatim is what
 *   makes dispatch dispatch-the-approved-fee, not dispatch-a-requote.
 * - prepare: reads backendRef from the stored quote — no daemon call.
 *   Lightning → paymentHash; on-chain → sendIntentId (no pre-dispatch hash).
 * - dispatch: client.sendPrepared(storedQuote) exactly once. Ambiguous
 *   outcomes stay in-flight; the SDK documents that a failed dispatch
 *   consumes the intent — recovery then re-quotes via a fresh submit.
 * - lookup: scans the daemon's activity stream for the entry carrying our
 *   payment hash / txid. NEVER dispatches.
 *
 * Double-pay guard: 'not-found' (the only reconciliation result the engine
 * turns into a retryable 'authorized' state) is returned only when the
 * daemon has no matching entry AND the intent carries no dispatched
 * attempt. A miss after a dispatched attempt is 'unknown' → needs-recovery.
 */

import type {
  DispatchOutcome,
  PaymentDispatcher,
  ReconcileResult,
} from '@sovereign/payments';
import type { PaymentIntent } from '@sovereign/payments';
import type {
  Entry,
  PrepareSendResult,
  SendResult,
  WavelengthClient,
} from './sdk/index.js';
import { WavelengthError } from './sdk/index.js';
import {
  dispatchOutcomeFromEntry,
  entryMatchesBackendRef,
  entryMatchesOnchainPayload,
  reconcileFromEntry,
} from './entry-mapping.js';
import type { LightningSendPayload, OnchainSendPayload } from './payloads.js';

/** Default upper bound on one dispatch attempt before it counts as ambiguous. */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

/** Upper bound on activity pages scanned during recovery lookup. */
const MAX_LOOKUP_PAGES = 50;

/** Thrown when an intent payload does not match its declared payment kind. */
export class PayloadValidationError extends Error {
  constructor(readonly intentId: string, reason: string) {
    super(`Payment intent '${intentId}' has an invalid payload: ${reason}`);
    this.name = 'PayloadValidationError';
  }
}

/** Thrown for payment kinds this pinned SDK version cannot dispatch. */
export class UnsupportedPaymentKindError extends Error {
  constructor(readonly kind: string, readonly sdkPin: string) {
    super(
      `Payment kind '${kind}' has no typed dispatch path in the pinned Wavelength SDK ` +
        `(@lightninglabs/wavelength-core@${sdkPin}): SendRequest is a Lightning-invoice / ` +
        'on-chain-address union only. Ark-address sends need a typed upstream method ' +
        'before they can be consumed within the pinned surface.',
    );
    this.name = 'UnsupportedPaymentKindError';
  }
}

export function isLightningSendPayload(payload: unknown): payload is LightningSendPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'invoice' in payload &&
    typeof (payload as LightningSendPayload).invoice === 'string'
  );
}

export function isOnchainSendPayload(payload: unknown): payload is OnchainSendPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'onchainAddress' in payload &&
    typeof (payload as OnchainSendPayload).onchainAddress === 'string'
  );
}

export interface WavelengthDispatcherOptions {
  readonly client: WavelengthClient;
  readonly sdkPin: string;
  /** Dispatch attempt timeout; an expired attempt is ambiguous, never retried. */
  readonly dispatchTimeoutMs?: number;
}

export class WavelengthPaymentDispatcher implements PaymentDispatcher {
  private readonly client: WavelengthClient;
  private readonly sdkPin: string;
  private readonly dispatchTimeoutMs: number;

  constructor(options: WavelengthDispatcherOptions) {
    this.client = options.client;
    this.sdkPin = options.sdkPin;
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  }

  /** backendRef comes from the stored quote — the budget was enforced at authorization. */
  async prepare(intent: Readonly<PaymentIntent>): Promise<{ backendRef: string }> {
    switch (intent.kind) {
      case 'lightning-invoice': {
        const quote = this.quoteOf(intent);
        if (quote.paymentHash.length === 0) {
          throw new PayloadValidationError(intent.intentId, 'stored quote carries no payment hash');
        }
        return { backendRef: quote.paymentHash };
      }
      case 'onchain': {
        const quote = this.quoteOf(intent);
        return { backendRef: quote.sendIntentId };
      }
      case 'ark-vtxo':
      case 'asset-transfer':
        throw new UnsupportedPaymentKindError(intent.kind, this.sdkPin);
      default:
        throw new UnsupportedPaymentKindError(String(intent.kind), this.sdkPin);
    }
  }

  async dispatch(intent: Readonly<PaymentIntent>, backendRef: string): Promise<DispatchOutcome> {
    switch (intent.kind) {
      case 'lightning-invoice':
      case 'onchain': {
        // sendPrepared consumes the single-use intent quoted at authorization
        // time — the exact one the user's fee approval covers. Never re-quote
        // here: a re-quote is a new fee the user never approved.
        const quote = this.quoteOf(intent);
        const result = await this.withTimeout(
          this.client.sendPrepared(quote),
          `send ${backendRef}`,
        );
        return this.outcomeFrom(result, backendRef);
      }
      case 'ark-vtxo':
      case 'asset-transfer':
        throw new UnsupportedPaymentKindError(intent.kind, this.sdkPin);
      default:
        throw new UnsupportedPaymentKindError(String(intent.kind), this.sdkPin);
    }
  }

  /**
   * Backend lookup by reconciliation key — the ONLY method recovery calls.
   * Never dispatches.
   */
  async lookup(intent: Readonly<PaymentIntent>): Promise<ReconcileResult> {
    switch (intent.kind) {
      case 'lightning-invoice': {
        const ref = this.lightningRefOf(intent);
        const entry = await this.findEntry((e) => entryMatchesBackendRef(e, ref));
        return this.reconcileResultFor(entry, ref, intent);
      }
      case 'onchain': {
        const payload = this.onchainPayloadOf(intent);
        const ref = intent.backendRef;
        // A txid backendRef (persisted by a settled dispatch) matches
        // directly; otherwise correlate by destination/amount.
        if (ref !== undefined && !ref.startsWith('send_')) {
          const byTxid = await this.findEntry((e) => entryMatchesBackendRef(e, ref));
          return this.reconcileResultFor(byTxid, ref, intent);
        }
        const correlated = await this.findEntry((e) =>
          entryMatchesOnchainPayload(e, payload.onchainAddress, payload.amountSat),
        );
        return this.reconcileResultFor(correlated, ref ?? 'unavailable', intent);
      }
      case 'ark-vtxo':
      case 'asset-transfer':
        throw new UnsupportedPaymentKindError(intent.kind, this.sdkPin);
      default:
        throw new UnsupportedPaymentKindError(String(intent.kind), this.sdkPin);
    }
  }

  // ——— internals ———

  /** The full quote stored at authorization; refuses to dispatch without one. */
  private quoteOf(intent: Readonly<PaymentIntent>): PrepareSendResult {
    const stored = intent.kind === 'lightning-invoice'
      ? this.lightningPayloadOf(intent).quote
      : this.onchainPayloadOf(intent).quote;
    if (stored === undefined) {
      throw new PayloadValidationError(
        intent.intentId,
        'no stored quote — submit through submitLightningSend/submitOnchainSend so the fee is authorized',
      );
    }
    return stored;
  }

  private outcomeFrom(result: SendResult, fallbackRef: string): DispatchOutcome {
    const outcome = dispatchOutcomeFromEntry(result.entry);
    switch (outcome) {
      case 'settled': {
        // On-chain sends carry the txid; Lightning sends carry the payment
        // hash in entry.progress. The fallback is the local ref we dispatched.
        const ref =
          result.entry.progress?.txid ||
          result.entry.progress?.paymentHash ||
          fallbackRef;
        return { status: 'settled', backendRef: ref };
      }
      case 'definitive-failure':
        return { status: 'definitive-failure', reason: describeFailure(result.entry) };
      case 'sent':
        return { status: 'sent' };
    }
  }

  private reconcileResultFor(
    entry: Entry | undefined,
    ref: string,
    intent: Readonly<PaymentIntent>,
  ): ReconcileResult {
    const result = reconcileFromEntry(entry);
    if (result.status === 'not-found') {
      // Double-pay guard: after a dispatched attempt, a lookup miss is NOT
      // safe to retry — the payment may exist outside the pages we scanned.
      const everDispatched = intent.attempts.some((a) => a.result === 'dispatched');
      return everDispatched ? { status: 'unknown' } : { status: 'not-found' };
    }
    if (result.status === 'settled' && result.backendRef.length === 0) {
      return { status: 'settled', backendRef: ref };
    }
    return result;
  }

  private lightningRefOf(intent: Readonly<PaymentIntent>): string {
    if (intent.backendRef !== undefined) return intent.backendRef;
    const payload = this.lightningPayloadOf(intent);
    if (payload.quote?.paymentHash) return payload.quote.paymentHash;
    throw new PayloadValidationError(intent.intentId, 'no payment hash to reconcile against');
  }

  private lightningPayloadOf(intent: Readonly<PaymentIntent>): LightningSendPayload {
    if (!isLightningSendPayload(intent.payload)) {
      throw new PayloadValidationError(intent.intentId, 'expected a Lightning invoice payload');
    }
    return intent.payload;
  }

  private onchainPayloadOf(intent: Readonly<PaymentIntent>): OnchainSendPayload {
    if (!isOnchainSendPayload(intent.payload)) {
      throw new PayloadValidationError(intent.intentId, 'expected an on-chain address payload');
    }
    return intent.payload;
  }

  /** Scans activity pages for a matching entry (bounded — recovery, not exhaustive). */
  private async findEntry(predicate: (entry: Entry) => boolean): Promise<Entry | undefined> {
    let cursor = '';
    for (let page = 0; page < MAX_LOOKUP_PAGES; page++) {
      const result = await this.client.list({ view: 'activity', cursor, pendingOnly: false });
      const match = result.activity?.entries.find(predicate);
      if (match !== undefined) return match;
      if (!result.activity?.hasMore) return undefined;
      cursor = result.activity?.nextCursor ?? '';
      if (cursor.length === 0) return undefined;
    }
    return undefined;
  }

  /** Races the SDK call against the dispatch timeout — expiry is an error (ambiguous). */
  private async withTimeout<T>(call: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new WavelengthError(
              `Dispatch for ${label} exceeded ${this.dispatchTimeoutMs}ms`,
              'wavelength_error',
            ),
          ),
        this.dispatchTimeoutMs,
      );
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function describeFailure(entry: Entry): string {
  const code = entry.failureCode ? ` (${entry.failureCode})` : '';
  const reason = entry.failureReason ? `: ${entry.failureReason}` : '';
  return `Daemon rejected the payment${code}${reason}`;
}
