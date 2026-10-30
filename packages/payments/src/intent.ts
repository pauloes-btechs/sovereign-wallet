/**
 * Payment intent state machine — shared by both engines (Wavelength and litd).
 *
 * Safety rule (spec-locked): an intent is persisted in 'authorized' BEFORE
 * dispatch; on startup, any intent found in 'signing' | 'in-flight' is
 * reconciled against the backend before any retry. Blind re-dispatch is a
 * test-failing bug, not a style choice.
 */

export type PaymentKind = 'lightning-invoice' | 'onchain' | 'ark-vtxo' | 'asset-transfer';

/**
 * draft | authorized | signing        — local, reversible
 * in-flight | settled                 — dispatched — reconcile, never re-dispatch
 * failed | needs-recovery             — terminal / manual path
 */
export type IntentState =
  | 'draft'
  | 'authorized'
  | 'signing'
  | 'in-flight'
  | 'settled'
  | 'failed'
  | 'needs-recovery';

export interface Attempt {
  readonly at: string;
  readonly result: 'dispatched' | 'timeout' | 'rejected' | 'unknown';
  readonly backendRef?: string;
}

export interface PaymentIntent {
  /** UUIDv4, generated once, persisted in 'authorized' BEFORE dispatch. */
  readonly intentId: string;
  readonly kind: PaymentKind;
  /** Invoice, address, VTXO target, or asset transfer — validated before authorize. */
  readonly payload: unknown;
  /** Spend policy enforcement point. */
  readonly maxFeeSat?: number;
  state: IntentState;
  /** Payment hash / txid / swap id — the reconciliation key. */
  readonly backendRef?: string;
  readonly attempts: Attempt[];
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: IntentState,
    public readonly action: string,
  ) {
    super(`Invalid payment-intent transition: cannot ${action} from '${from}'`);
    this.name = 'InvalidTransitionError';
  }
}

export function createIntent(
  intentId: string,
  kind: PaymentKind,
  payload: unknown,
  maxFeeSat?: number,
): PaymentIntent {
  return { intentId, kind, payload, maxFeeSat, state: 'draft', attempts: [] };
}

/** Validate + authorize. The intent must be persisted in this state before dispatch. */
export function authorize(intent: PaymentIntent): PaymentIntent {
  if (intent.state !== 'draft') throw new InvalidTransitionError(intent.state, 'authorize');
  return { ...intent, state: 'authorized' };
}

export function beginSigning(intent: PaymentIntent): PaymentIntent {
  if (intent.state !== 'authorized') throw new InvalidTransitionError(intent.state, 'sign');
  return { ...intent, state: 'signing' };
}

/**
 * Dispatch an authorized+signed intent. Calling this on an intent already
 * in-flight is the blind-re-dispatch defect: it throws.
 */
export function dispatch(intent: PaymentIntent, backendRef: string, at: string): PaymentIntent {
  if (intent.state !== 'signing') throw new InvalidTransitionError(intent.state, 'dispatch');
  return {
    ...intent,
    state: 'in-flight',
    backendRef,
    attempts: [...intent.attempts, { at, result: 'dispatched', backendRef }],
  };
}

/** Result of checking the backend for a recovery-time intent. */
export type ReconcileResult =
  | { status: 'settled'; backendRef: string }
  | { status: 'unknown' }
  | { status: 'not-found' };

/**
 * Recovery rule: reconcile — never re-dispatch. A settled backend result
 * transitions to 'settled'; an unknown result transitions to 'needs-recovery'
 * with a user-facing explanation downstream.
 */
export function reconcile(intent: PaymentIntent, result: ReconcileResult, at: string): PaymentIntent {
  if (intent.state !== 'signing' && intent.state !== 'in-flight') {
    throw new InvalidTransitionError(intent.state, 'reconcile');
  }
  const attempts: Attempt[] = [...intent.attempts, { at, result: 'unknown' }];
  switch (result.status) {
    case 'settled':
      return { ...intent, state: 'settled', backendRef: result.backendRef, attempts };
    case 'not-found':
      // Nothing ever reached the backend; a single authorized retry is safe
      // because the dispatch was never observed. The caller re-signs first.
      return { ...intent, state: 'authorized', attempts };
    case 'unknown':
      return { ...intent, state: 'needs-recovery', attempts };
  }
}

/** Terminal local failure (policy rejection, validation failure). */
export function fail(intent: PaymentIntent): PaymentIntent {
  if (intent.state !== 'authorized' && intent.state !== 'signing') {
    throw new InvalidTransitionError(intent.state, 'fail');
  }
  return { ...intent, state: 'failed' };
}
