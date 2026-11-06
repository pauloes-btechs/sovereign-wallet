/**
 * Mapping from SDK activity entries onto the shared payments vocabulary:
 * dispatch outcomes, reconciliation results, and transaction history
 * records. Pure functions — the dispatcher and provider call these at the
 * daemon boundary.
 *
 * Reconciliation rule (spec-locked): a settled backend result settles the
 * intent; an unknown result parks it in 'needs-recovery'; only a backend
 * that provably never saw the payment may return 'not-found' (the one state
 * a safe re-signed retry is allowed from).
 */

import type { PaymentKind, ProviderId, ReconcileResult, TransactionRecord } from '@sovereign/wallet-core';
import type { Entry, EntryPhase } from './sdk/index.js';

/**
 * Dispatch-outcome mapping for a freshly returned send entry. The trailing
 * 'sent' arms unknown statuses too (a future SDK status value must not
 * silently settle a payment) — 'sent' leaves the intent in-flight, and
 * recovery reconciles it against the backend.
 */
export function dispatchOutcomeFromEntry(entry: Entry): 'settled' | 'sent' | 'definitive-failure' {
  switch (entry.status) {
    case 'complete':
      return 'settled';
    case 'failed':
      return 'definitive-failure';
    case 'pending':
      return 'sent';
    default:
      return 'sent';
  }
}

/**
 * Recovery-time lookup mapping for an entry found (or not) by backendRef.
 * A still-pending entry maps to 'unknown' — a live swap must NOT be
 * re-dispatched, and 'unknown' is the only reconciliation result that
 * forbids it outright.
 */
export function reconcileFromEntry(entry: Entry | undefined): ReconcileResult {
  if (entry === undefined) return { status: 'not-found' };
  switch (entry.status) {
    case 'complete':
      return { status: 'settled', backendRef: backendRefOf(entry) };
    case 'failed':
      return {
        status: 'failed',
        reason: describeEntryFailure(entry),
        backendRef: backendRefOf(entry),
      };
    case 'pending':
      return { status: 'unknown' };
    default:
      return { status: 'unknown' };
  }
}

/** The stable reconciliation key an entry carries (paymentHash, then txid). */
export function backendRefOf(entry: Entry): string {
  return entry.progress?.paymentHash || entry.progress?.txid || entry.id;
}

/**
 * True when the entry matches the reconciliation key — payment hash for
 * Lightning swaps, txid for on-chain sends.
 */
export function entryMatchesBackendRef(entry: Entry, backendRef: string): boolean {
  return (
    entry.progress?.paymentHash === backendRef ||
    entry.progress?.txid === backendRef ||
    entry.id === backendRef
  );
}

/**
 * A Bitcoin txid is exactly 64 hex characters — the only format-stable way
 * to tell a persisted txid backendRef apart from a send-intent id, whose
 * shape the SDK does not fix.
 */
export function isTxid(ref: string): boolean {
  return /^[0-9a-f]{64}$/i.test(ref);
}

/**
 * Correlates an entry with an on-chain send payload when no payment hash
 * exists (the on-chain path has no pre-dispatch hash): same destination,
 * same amount when the payload specified one.
 */
export function entryMatchesOnchainPayload(
  entry: Entry,
  onchainAddress: string,
  amountSat?: number,
): boolean {
  if (entry.request?.type !== 'onchain') return false;
  if (entry.request.onchainAddress !== onchainAddress) return false;
  if (amountSat !== undefined && entry.amountSat !== amountSat) return false;
  return true;
}

/** Maps an SDK entry's request type (falling back to kind) onto PaymentKind. */
export function paymentKindOfEntry(entry: Entry): PaymentKind {
  switch (entry.request?.type) {
    case 'lightning':
      return 'lightning-invoice';
    case 'ark':
      return 'ark-vtxo';
    case 'onchain':
      return 'onchain';
    default:
      // Exits and deposits without a request echo settle on-chain.
      return 'onchain';
  }
}

/** Maps an SDK entry onto a per-provider transaction history record. */
export function mapEntryToRecord(entry: Entry, providerId: ProviderId): TransactionRecord {
  // The entry mapping is Mode A vocabulary — refuse anything else explicitly
  // rather than mislabeling another provider's history.
  if (providerId !== 'wavelength') {
    throw new Error(`mapEntryToRecord is Mode A only — refusing provider '${providerId}'`);
  }
  const direction: 'in' | 'out' = entry.kind === 'send' ? 'out' : 'in';
  return {
    txId: entry.progress?.txid || entry.progress?.paymentHash || entry.id,
    providerId,
    direction,
    kind: paymentKindOfEntry(entry),
    amountSat: BigInt(entry.amountSat),
    status:
      entry.status === 'complete' ? 'settled' : entry.status === 'failed' ? 'failed' : 'pending',
    at: entry.updatedAt || entry.createdAt,
    backendRef: backendRefOf(entry),
  };
}

/**
 * One activity entry as a receipt: the history record plus every field the
 * daemon reported for it. Empty strings and zero heights (the SDK's "not
 * known yet") become null, so hosts can say a field was not reported rather
 * than show a blank.
 */
export interface WavelengthActivityDetail {
  readonly record: TransactionRecord;
  /** The daemon's entry id — unique within the wallet's activity. */
  readonly entryId: string;
  /** send · receive (Lightning via the swap service) · deposit (on-chain boarding) · exit (to on-chain). */
  readonly entryKind: 'send' | 'receive' | 'deposit' | 'exit';
  /** The rail the entry moved over, from its request echo or its kind. */
  readonly rail: 'lightning' | 'onchain' | 'ark';
  /** Fee the daemon recorded for the entry, in sats. */
  readonly feeSat: bigint;
  readonly note: string | null;
  /** Who the wallet dealt with, as the daemon names it (e.g. `swap-server`, `chain`). */
  readonly counterparty: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** Coarse lifecycle phase; null when the daemon gave no hint. */
  readonly phase: EntryPhase | null;
  readonly paymentHash: string | null;
  readonly txid: string | null;
  readonly preimage: string | null;
  readonly confirmationHeight: number | null;
  readonly vtxoOutpoint: string | null;
  readonly failureReason: string | null;
  readonly failureCode: string | null;
  readonly invoice: string | null;
  readonly onchainAddress: string | null;
  readonly arkAddress: string | null;
}

const orNull = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

/** Maps an SDK entry onto a receipt (record + reported fields). Mode A only. */
export function mapEntryToActivityDetail(entry: Entry, providerId: ProviderId): WavelengthActivityDetail {
  const record = mapEntryToRecord(entry, providerId);
  const progress = entry.progress;
  const request = entry.request;
  const rail: WavelengthActivityDetail['rail'] =
    request?.type === 'lightning'
      ? 'lightning'
      : request?.type === 'ark'
        ? 'ark'
        : request?.type === 'onchain'
          ? 'onchain'
          : entry.kind === 'receive'
            ? 'lightning'
            : 'onchain';
  const failed = entry.status === 'failed';
  return {
    record,
    entryId: entry.id,
    entryKind: entry.kind,
    rail,
    feeSat: BigInt(entry.feeSat),
    note: orNull(entry.note),
    counterparty: orNull(entry.counterparty),
    createdAt: orNull(entry.createdAt),
    updatedAt: orNull(entry.updatedAt),
    phase: progress === undefined || progress.phase === 'unspecified' ? null : progress.phase,
    paymentHash: orNull(progress?.paymentHash) ?? orNull(request?.paymentHash),
    txid: orNull(progress?.txid),
    preimage: orNull(progress?.preimage),
    confirmationHeight:
      progress !== undefined && progress.confirmationHeight > 0 ? progress.confirmationHeight : null,
    vtxoOutpoint: orNull(progress?.vTXOOutpoint),
    failureReason: failed ? orNull(entry.failureReason) : null,
    failureCode: failed ? orNull(entry.failureCode) : null,
    invoice: orNull(request?.lightningInvoice),
    onchainAddress: orNull(request?.onchainAddress),
    arkAddress: orNull(request?.arkAddress),
  };
}

/** The daemon phase that means an inbound payment was durably settled. */
const SETTLED_PHASES: readonly EntryPhase[] = ['confirmed'];

/** Coarser inbound-progress check used by the receive flow and tests. */
export function isInboundSettled(entry: Entry): boolean {
  return (
    entry.status === 'complete' ||
    SETTLED_PHASES.includes(entry.progress?.phase ?? 'unspecified')
  );
}

/** Human summary of a failed entry for the needs-recovery explanation. */
export function describeEntryFailure(entry: Entry): string {
  const code = entry.failureCode ? ` (${entry.failureCode})` : '';
  const reason = entry.failureReason ? `: ${entry.failureReason}` : '';
  return `The daemon reported a failed payment${code}${reason}`;
}
