import {
  authorize,
  beginSigning,
  createIntent,
  dispatch,
  fail,
  reconcile,
  resolveNeedsRecovery,
  type PaymentIntent,
  type PaymentKind,
  type ReconcileResult,
  type RecoveryOutcome,
} from './intent.js';
import type { PaymentIntentStore } from './store.js';

export type { PaymentIntentStore } from './store.js';

/**
 * Outcome of ONE network dispatch attempt. `sent` and `timeout` are
 * deliberately ambiguous: the engine leaves the intent in-flight and
 * recovery reconciles it against the backend later — never a blind retry.
 */
export type DispatchOutcome =
  | { status: 'settled'; backendRef: string }
  | { status: 'sent' }
  | { status: 'timeout' }
  | { status: 'definitive-failure'; reason: string };

/**
 * Backend adapter port. `dispatch` may be called at most once per
 * backendRef; `lookup` is the ONLY method recovery is allowed to call.
 */
export interface PaymentDispatcher {
  /** Computes the local backend reference (payment hash / txid) pre-network. */
  prepare(intent: Readonly<PaymentIntent>): Promise<{ backendRef: string }>;
  dispatch(intent: Readonly<PaymentIntent>, backendRef: string): Promise<DispatchOutcome>;
  /** Backend lookup by payment hash / txid / swap id — never dispatches. */
  lookup(intent: Readonly<PaymentIntent>): Promise<ReconcileResult>;
}

export interface PaymentEngineOptions {
  store: PaymentIntentStore;
  dispatcher: PaymentDispatcher;
  /** Intent id source (UUIDv4 in production). Required — no hidden globals. */
  newId: () => string;
  now?: () => string;
  /**
   * Spend/fee policy enforced at authorization: throwing here fails the
   * intent before anything is signed or sent.
   */
  authorizePolicy?: (intent: Readonly<PaymentIntent>) => void;
}

export class UnknownIntentError extends Error {
  constructor(readonly intentId: string) {
    super(`No persisted payment intent with id '${intentId}'`);
    this.name = 'UnknownIntentError';
  }
}

/** Authorization (validation/policy) rejected the payment. */
export class PaymentRejectedError extends Error {
  constructor(
    readonly intentId: string,
    options?: { cause?: unknown },
  ) {
    super(`Payment intent '${intentId}' was rejected by the spend policy`, options);
    this.name = 'PaymentRejectedError';
  }
}

export interface RecoveryReport {
  /** Interrupted intents reconciled to a terminal state (incl. safe retry). */
  readonly reconciled: readonly string[];
  /** Interrupted intents of unknown backend status — need a human explanation. */
  readonly needsRecovery: readonly string[];
}

/**
 * Orchestrates the payment-intent state machine over a persistent store.
 *
 * Safety rules (spec-locked):
 * - The intent is persisted in 'authorized' BEFORE any dispatch, and
 *   persisted 'in-flight' BEFORE the network call.
 * - On startup, intents found in 'signing' | 'in-flight' are reconciled
 *   against the backend before any retry. Blind re-dispatch is a
 *   test-failing bug, not a style choice.
 */
export class PaymentEngine {
  private readonly store: PaymentIntentStore;
  private readonly dispatcher: PaymentDispatcher;
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly authorizePolicy?: (intent: Readonly<PaymentIntent>) => void;

  constructor(options: PaymentEngineOptions) {
    this.store = options.store;
    this.dispatcher = options.dispatcher;
    this.newId = options.newId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.authorizePolicy = options.authorizePolicy;
  }

  /** Create → authorize (policy enforcement point). Persists both states. */
  async submit(kind: PaymentKind, payload: unknown, maxFeeSat?: number): Promise<PaymentIntent> {
    let intent = createIntent(this.newId(), kind, payload, maxFeeSat);
    await this.store.save(intent);

    try {
      this.authorizePolicy?.(intent);
      intent = authorize(intent);
    } catch (cause) {
      intent = fail(intent);
      await this.store.save(intent);
      throw new PaymentRejectedError(intent.intentId, { cause });
    }
    await this.store.save(intent);
    return intent;
  }

  /** Sign → persist 'in-flight' → dispatch exactly once → record the outcome. */
  async execute(intentId: string): Promise<PaymentIntent> {
    const current = await this.getIntent(intentId);

    // Signing is local and reversible — persisted before anything else happens.
    const signing = beginSigning(current);
    await this.store.save(signing);

    const { backendRef } = await this.dispatcher.prepare(signing);

    // PERSIST BEFORE DISPATCH: the in-flight state (with its backendRef) is
    // durable before the network is touched. A crash from here on is
    // reconciled on startup, never blindly retried.
    const inFlight = dispatch(signing, backendRef, this.now());
    await this.store.save(inFlight);

    const outcome = await this.dispatcher.dispatch(inFlight, backendRef);
    return this.applyDispatchOutcome(inFlight, outcome);
  }

  private async applyDispatchOutcome(
    intent: Readonly<PaymentIntent>,
    outcome: DispatchOutcome,
  ): Promise<PaymentIntent> {
    switch (outcome.status) {
      case 'settled':
        return this.save(
          reconcile(intent, { status: 'settled', backendRef: outcome.backendRef }, this.now()),
        );
      case 'definitive-failure':
        return this.save(
          reconcile(intent, { status: 'failed', reason: outcome.reason }, this.now()),
        );
      case 'sent':
      case 'timeout':
        // Ambiguous by design: stays in-flight; recovery reconciles it later.
        return intent;
    }
  }

  /**
   * Startup crash recovery. Every intent found in 'signing' | 'in-flight'
   * is reconciled against the backend BEFORE any retry. This method never
   * calls dispatcher.dispatch — re-dispatching here is the exact defect the
   * test suite (engine.test.ts, crash-recovery block) fails CI for.
   */
  async recoverInterrupted(): Promise<RecoveryReport> {
    const report: { reconciled: string[]; needsRecovery: string[] } = {
      reconciled: [],
      needsRecovery: [],
    };
    for (const intent of await this.store.listAll()) {
      if (intent.state !== 'signing' && intent.state !== 'in-flight') continue;

      const result = await this.dispatcher.lookup(intent);
      const next = reconcile(intent, result, this.now());
      await this.store.save(next);

      if (next.state === 'needs-recovery') report.needsRecovery.push(next.intentId);
      else report.reconciled.push(next.intentId);
    }
    return report;
  }

  /** Manual resolution of a needs-recovery intent once its fate is known. */
  async resolveNeedsRecovery(intentId: string, outcome: RecoveryOutcome): Promise<PaymentIntent> {
    const intent = await this.getIntent(intentId);
    return this.save(resolveNeedsRecovery(intent, outcome, this.now()));
  }

  private async getIntent(intentId: string): Promise<PaymentIntent> {
    const intent = await this.store.get(intentId);
    if (intent === undefined) throw new UnknownIntentError(intentId);
    return intent;
  }

  private async save(intent: Readonly<PaymentIntent>): Promise<PaymentIntent> {
    await this.store.save(intent);
    return intent;
  }
}
