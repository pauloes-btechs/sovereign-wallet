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
