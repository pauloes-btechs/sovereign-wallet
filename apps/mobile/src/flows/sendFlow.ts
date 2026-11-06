/**
 * Send and Receive flow rules shared by both wallet modes — pure functions,
 * no React Native, unit-tested directly.
 *
 * - Which rails a parsed destination can use on THIS backend, each with the
 *   reason when it can't (`railOptions`).
 * - Plain-language explanations for known failures, with the next step and
 *   whether retrying is safe (`explainSendFailure`).
 * - What to expect about timing (`timeExpectation`).
 * - Receive status from the backend's own records (`invoiceStatus`).
 */

import type { MobileWalletCapabilities } from './capabilities.js';
import type { Bolt11Invoice, ParsedDestination } from './destination.js';
import { invoiceAmountSat } from './destination.js';

export type SendRail = 'lightning' | 'onchain';

export const RAIL_LABEL: Readonly<Record<SendRail, string>> = {
  lightning: 'Lightning',
  onchain: 'On-chain',
};

export interface RailOption {
  readonly rail: SendRail;
  readonly available: boolean;
  /** Why it can't be used; null when available. */
  readonly reason: string | null;
}

export interface RailRules {
  /** Whether this backend can pay an invoice that carries no amount. */
  readonly amountlessInvoices: false | { readonly reason: string };
}

/** Wavelength's SDK pays only amount-bearing invoices (v1 `SendRequest`). */
export const WAVELENGTH_RAIL_RULES: RailRules = {
  amountlessInvoices: {
    reason:
      "This invoice doesn't say how much to pay. The everyday wallet can only pay invoices that include an amount — ask the recipient for one.",
  },
};

/** The LNC port's `payInvoice` has no amount field, so amountless invoices can't be paid. */
export const REMOTE_LND_RAIL_RULES: RailRules = {
  amountlessInvoices: {
    reason:
      "This invoice doesn't say how much to pay, and this connection can't add an amount yet. Ask the recipient for an invoice with an amount.",
  },
};

/** True when `nowSec` is at or past the invoice's expiry. */
export function isInvoiceExpired(invoice: Bolt11Invoice, nowSec: number): boolean {
  return nowSec >= invoice.expiresAt;
}

/**
 * The rails this destination offers, filtered by what the backend can do
 * right now. Lightning first: when a unified QR offers both, Lightning is
 * usually faster and cheaper.
 */
export function railOptions(
  destination: ParsedDestination,
  capabilities: MobileWalletCapabilities,
  rules: RailRules,
  nowSec: number,
): readonly RailOption[] {
  const options: RailOption[] = [];
  if (destination.lightning !== null) {
    const feature = capabilities.features.lightningSend;
    const invoice = destination.lightning;
    let reason: string | null = feature.available ? null : feature.reason;
    if (reason === null && isInvoiceExpired(invoice, nowSec)) {
      reason = `This invoice expired at ${clockTime(invoice.expiresAt)}. Ask the recipient for a new one.`;
    }
    if (reason === null && invoice.amountMsat === null && rules.amountlessInvoices !== false) {
      reason = rules.amountlessInvoices.reason;
    }
    options.push({ rail: 'lightning', available: reason === null, reason });
  }
  if (destination.onchain !== null) {
    const feature = capabilities.features.onchainSend;
    options.push({ rail: 'onchain', available: feature.available, reason: feature.available ? null : feature.reason });
  }
  return options;
}

/** The rail to start with: the first available one, else the first offered. */
export function defaultRail(options: readonly RailOption[]): SendRail | null {
  return options.find((o) => o.available)?.rail ?? options[0]?.rail ?? null;
}

/** The amount fixed by the destination for a rail; null when the user must enter one. */
export function fixedAmountSat(destination: ParsedDestination, rail: SendRail): bigint | null {
  if (rail === 'lightning') return destination.lightning === null ? null : invoiceAmountSat(destination.lightning);
  return destination.onchainAmountSat;
}

/** "14:05 UTC" (or with the date when not today) from unix seconds. */
export function clockTime(unixSec: number, nowSec?: number): string {
  const iso = new Date(unixSec * 1000).toISOString();
  const today = nowSec !== undefined && new Date(nowSec * 1000).toISOString().slice(0, 10) === iso.slice(0, 10);
  return nowSec === undefined || today ? `${iso.slice(11, 16)} UTC` : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "in 59 min", "in 2 h 5 min", "in 3 days" — for expiry countdowns. */
export function relativeDuration(seconds: number): string {
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

// ——— timing ———

export function timeExpectation(rail: SendRail, backend: MobileWalletCapabilities['backend']): string {
  if (rail === 'onchain') {
    return 'On-chain payments are final after block confirmations — about 10 minutes per block on average, longer when the network is busy.';
  }
  return backend === 'wavelength'
    ? 'Lightning payments through the swap service usually complete within seconds.'
    : 'Lightning payments usually complete within seconds. Your node keeps trying until it succeeds, fails, or reaches the payment timeout.';
}

// ——— failures ———

export interface FailureExplanation {
  readonly title: string;
  readonly detail: string;
  readonly nextStep: string;
  /**
   * True only when nothing can have left the wallet (refused before
   * dispatch, or a definitive failure). False = check status first.
   */
  readonly safeToRetry: boolean;
  /** True when the payment may still complete (not a failure yet). */
  readonly unknownOutcome?: boolean;
}

interface FailureRule {
  readonly match: RegExp;
  readonly explain: (raw: string) => FailureExplanation;
}

/** The controllers' own "result not known" wording. */
const NOT_CONFIRMED_RULE: FailureRule = {
  match: /could pay twice|could not be confirmed|needs.?recovery/i,
  explain: () => ({
    title: "The payment's result isn't known yet",
    detail: 'The wallet sent the payment but has not confirmed whether it completed.',
    nextStep: 'Check Activity for this payment before trying again — paying again now could pay twice.',
    safeToRetry: false,
    unknownOutcome: true,
  }),
};

/** True for the wallet's own "result not known yet, could pay twice" notice (not a backend error). */
export function isUnconfirmedNotice(text: string): boolean {
  return NOT_CONFIRMED_RULE.match.test(text);
}

const RULES: readonly FailureRule[] = [
  NOT_CONFIRMED_RULE,
  {
    match: /exceeds the spend policy budget|fee.*(above|exceeds).*(budget|limit|cap)|max.?fee/i,
    explain: () => ({
      title: 'The fee is higher than your limit',
      detail: 'Nothing was sent. The quoted fee is above the maximum Lightning fee set in your payment preferences.',
      nextStep: 'Raise the maximum Lightning fee in Wallet settings, or try again later when fees may be lower.',
      safeToRetry: true,
    }),
  },
  {
    match: /insufficient|not enough (funds|balance)|INSUFFICIENT_BALANCE/i,
    explain: () => ({
      title: 'Not enough funds',
      detail: "The wallet doesn't have enough spendable balance for this amount plus fees.",
      nextStep: 'Send a smaller amount, or add funds and try again.',
      safeToRetry: true,
    }),
  },
  {
    match: /no.?route|unable to find a path|FAILURE_REASON_NO_ROUTE|route not found/i,
    explain: () => ({
      title: 'No route to the recipient',
      detail: 'No path with enough capacity was found within your fee limit.',
      nextStep: 'Try a smaller amount, raise your maximum Lightning fee, or try again later.',
      safeToRetry: true,
    }),
  },
  {
    match: /already.?paid|ALREADY_PAID|invoice is already/i,
    explain: () => ({
      title: 'This invoice was already paid',
      detail: 'An invoice can be paid only once.',
      nextStep: "Don't pay it again. If you're unsure, check Activity or ask the recipient.",
      safeToRetry: false,
    }),
  },
  {
    match: /expired/i,
    explain: () => ({
      title: 'The invoice expired',
      detail: 'The recipient set a time limit and it has passed.',
      nextStep: 'Ask the recipient for a new invoice.',
      safeToRetry: false,
    }),
  },
  {
    match: /INCORRECT_PAYMENT_DETAILS|incorrect.*payment details|unknown payment hash/i,
    explain: () => ({
      title: 'The recipient rejected the payment',
      detail: "The recipient's node didn't recognize this invoice or amount.",
      nextStep: 'Ask the recipient for a new invoice.',
      safeToRetry: false,
    }),
  },
  {
    match: /time.?out|timed out|FAILURE_REASON_TIMEOUT|deadline/i,
    explain: () => ({
      title: 'The payment timed out',
      detail: 'It did not complete within the payment timeout.',
      nextStep: 'Check Activity before trying again, so you don\'t pay twice.',
      safeToRetry: false,
    }),
  },
  {
    match: /operator.*unreachable|unreachable|unavailable|ECONNREFUSED|network error/i,
    explain: () => ({
      title: "The wallet's service can't be reached",
      detail: 'Nothing was sent.',
      nextStep: 'Check your connection and try again in a moment.',
      safeToRetry: true,
    }),
  },
  {
    match: /while the app is open|backgrounded|Reopen the app/i,
    explain: () => ({
      title: 'Payments run only while the app is open',
      detail: 'Nothing was sent.',
      nextStep: 'Keep the app open and try again.',
      safeToRetry: true,
    }),
  },
  {
    match: /no funds were moved/i,
    explain: () => ({
      title: 'The payment failed',
      detail: 'The wallet reported a definitive failure. No funds were moved.',
      nextStep: 'You can try again, or ask the recipient for a new invoice if it keeps failing.',
      safeToRetry: true,
    }),
  },
  {
    match: /permission denied|macaroon|not allowed/i,
    explain: () => ({
      title: "This connection isn't allowed to do that",
      detail: 'The session on your node does not have the permission this needs.',
      nextStep: 'Create a session on your node with payment permissions, then pair again.',
      safeToRetry: true,
    }),
  },
];

/**
 * When an error was raised, relative to handing the payment to the backend:
 * - `before-dispatch`: refused before submit/execute could hand anything to
 *   the backend (quote errors, validation, foreground rule), or a terminal
 *   failure the backend itself reported. "Nothing was sent" can be true.
 * - `after-dispatch`: thrown once the payment was submitted/dispatched — the
 *   request may have reached the backend, so the outcome is unknown until a
 *   status lookup says otherwise. Never "failed", never "nothing was sent".
 */
export type SendErrorStage = 'before-dispatch' | 'after-dispatch';

/**
 * Errors that by their nature mean the request left the wallet and the
 * answer was lost — e.g. the Wavelength dispatcher's own timeout
 * ("Dispatch for send X exceeded Nms"). Unknown outcome at any stage.
 */
const DISPATCHED_THEN_LOST = /Dispatch for .* exceeded \d+\s*ms/i;

function unknownOutcome(raw: string): FailureExplanation {
  return {
    title: "The payment's result isn't known yet",
    detail:
      raw === ''
        ? 'The wallet handed the payment off, then lost track of it. It may still complete.'
        : `The wallet handed the payment off, then reported: ${raw}. It may still complete.`,
    nextStep: 'Check the payment status or Activity before trying again — paying again now could pay twice.',
    safeToRetry: false,
    unknownOutcome: true,
  };
}

/**
 * Maps a backend or controller error message to plain language. `stage`
 * says whether the error came before anything was dispatched; after
 * dispatch every error is an unknown outcome (the "nothing was sent, safe to
 * retry" rules apply only before dispatch). Unknown messages keep the
 * backend's own text and assume the worst: check status before retrying.
 */
export function explainSendFailure(raw: string | null, stage: SendErrorStage): FailureExplanation {
  const text = raw ?? '';
  if (stage === 'after-dispatch' || DISPATCHED_THEN_LOST.test(text)) {
    // The controllers' own "could pay twice" wording is already an explanation.
    return NOT_CONFIRMED_RULE.match.test(text) ? NOT_CONFIRMED_RULE.explain(text) : unknownOutcome(text);
  }
  const rule = RULES.find((r) => r.match.test(text));
  if (rule !== undefined) return rule.explain(text);
  return {
    title: 'The payment failed',
    detail: text === '' ? 'The wallet did not say why.' : text,
    nextStep: 'Check Activity before trying again.',
    safeToRetry: false,
  };
}

// ——— receive status ———

export type ReceiveStatus = 'waiting' | 'paid' | 'expired' | 'canceled' | 'failed' | 'unknown';

export const RECEIVE_STATUS_LABEL: Readonly<Record<ReceiveStatus, string>> = {
  waiting: 'Waiting for payment',
  paid: 'Paid',
  expired: 'Expired',
  canceled: 'Canceled',
  failed: 'Failed',
  unknown: 'Status unknown',
};

/**
 * Status of a receive invoice from the backend's own record (when one is
 * found) and the invoice's decoded expiry. A record's settled state always
 * wins over the local clock.
 */
export function invoiceStatus(
  recordStatus: 'pending' | 'open' | 'settled' | 'failed' | 'canceled' | null,
  invoice: Bolt11Invoice | null,
  nowSec: number,
): ReceiveStatus {
  if (recordStatus === 'settled') return 'paid';
  if (recordStatus === 'failed') return 'failed';
  if (recordStatus === 'canceled') return invoice !== null && isInvoiceExpired(invoice, nowSec) ? 'expired' : 'canceled';
  if (invoice !== null && isInvoiceExpired(invoice, nowSec)) return 'expired';
  if (recordStatus === 'pending' || recordStatus === 'open') return 'waiting';
  return invoice === null ? 'unknown' : 'waiting';
}
