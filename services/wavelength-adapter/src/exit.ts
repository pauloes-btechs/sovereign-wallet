/**
 * Unilateral exit — the fee-funded escape hatch when the Ark operator is
 * unreachable (spec: 'async' unilateral exit, hours to days; irreversible
 * once broadcast; never started without the daemon's exact acknowledgement
 * string, which the host UI must surface to the user first).
 *
 * The funding model is the daemon's: `getExitPlan` previews the backing-wallet
 * funding needed per outpoint; the wallet funds the backing wallet; only then
 * can exits start. Structural infeasibilities (dust, uneconomical) cannot be
 * fixed by funding — `isExitInfeasibilityFundable` classifies them.
 */

import type {
  ExitBatchEvent,
  ExitBatchResult,
  ExitInfeasibilityReason,
  ExitJobStatus,
  GetExitPlanResult,
  WavelengthClient,
} from './sdk/index.js';
import {
  FORCE_UNROLL_ACK,
  ExitInfeasibilityReasonUnspecified,
  exitBatch,
  isExitInfeasibilityFundable,
} from './sdk/index.js';

export type { ExitBatchEvent, ExitBatchResult };

/** Thrown when a caller attempts a unilateral unroll without the exact ack. */
export class MissingUnrollAckError extends Error {
  constructor(readonly provided?: string) {
    super(
      'Refusing to start a unilateral exit: the irreversible-unroll acknowledgement ' +
        'must be the exact string "I_KNOW_WHAT_I_AM_DOING" (the daemon rejects anything else).',
    );
    this.name = 'MissingUnrollAckError';
  }
}

/** Aggregate exit readiness for a set of VTXO outpoints. */
export interface ExitReadiness {
  readonly canStart: boolean;
  /** Backing-wallet address to fund, when a shortfall must be covered first. */
  readonly fundingAddress: string | null;
  readonly fundingShortfallSat: bigint;
  readonly recommendedFundingSat: bigint;
  readonly infeasibilityReason: ExitInfeasibilityReason;
  /** False for structural blocks (dust/uneconomical) that funding cannot fix. */
  readonly infeasibilityFundable: boolean;
  readonly feeRateSatPerVByte: number;
}

/** Reduces the daemon's plan result to the readiness facts the UI acts on. */
export function summarizeExitReadiness(result: GetExitPlanResult): ExitReadiness {
  const blocking = result.plans.find((p) => !p.canStart);
  const reason = blocking?.infeasibilityReason ?? ExitInfeasibilityReasonUnspecified;
  return {
    canStart: result.canStart,
    fundingAddress: blocking?.fundingAddress ?? result.plans[0]?.fundingAddress ?? null,
    fundingShortfallSat: BigInt(result.totalFundingShortfallSat),
    recommendedFundingSat: BigInt(result.totalRecommendedFundingSat),
    infeasibilityReason: reason,
    infeasibilityFundable: isExitInfeasibilityFundable(reason),
    feeRateSatPerVByte: result.feeRateSatPerVByte,
  };
}

/** Previews unilateral-exit readiness for the given outpoints — moves nothing. */
export async function planUnilateralExit(
  client: WavelengthClient,
  outpoints: readonly string[],
  confTarget?: number,
): Promise<ExitReadiness> {
  const result = await client.getExitPlan({ outpoints: [...outpoints], confTarget });
  return summarizeExitReadiness(result);
}

/** Options for {@link startUnilateralExit}. */
export interface UnilateralExitOptions {
  /**
   * The exact daemon acknowledgement (FORCE_UNROLL_ACK =
   * "I_KNOW_WHAT_I_AM_DOING"). The provider refuses to start without it —
   * cooperative failures never silently escalate to a unilateral exit.
   */
  readonly forceUnrollAck: string;
  readonly confTarget?: number;
  readonly onEvent?: (event: ExitBatchEvent) => void;
}

/**
 * Starts unilateral exits for every outpoint via the SDK's batch helper.
 * Resolves once every exit is STARTED — each still runs for hours to days
 * afterward. Irreversible once broadcast.
 */
export async function startUnilateralExit(
  client: WavelengthClient,
  outpoints: readonly string[],
  opts: UnilateralExitOptions,
): Promise<ExitBatchResult> {
  if (opts.forceUnrollAck !== FORCE_UNROLL_ACK) {
    throw new MissingUnrollAckError(opts.forceUnrollAck);
  }
  return exitBatch({
    mode: 'unilateral',
    outpoints: [...outpoints],
    confTarget: opts.confTarget,
    client,
    onEvent: opts.onEvent,
  });
}

/**
 * User-visible copy per exit phase — the spec's exiting-state strings.
 * `bestCaseBlocksRemaining` (from exitStatus) renders an estimated countdown;
 * it is an estimate, never a promise.
 */
export function describeExitJobStatus(
  status: ExitJobStatus,
  opts?: { bestCaseBlocksRemaining?: number },
): string {
  const base: string = (() => {
    switch (status) {
      case 'pending':
        return 'Exit starting — the exit transaction is being built.';
      case 'materializing':
        return 'Exit in progress — recovery transactions are confirming.';
      case 'csv_pending':
        return 'Exit in progress — waiting out the safety timelock before funds can sweep.';
      case 'sweeping':
        return 'Exit almost done — sweeping funds to your on-chain address.';
      case 'completed':
        return 'Exit complete — funds are on-chain.';
      case 'failed':
        return 'Exit failed — your VTXOs were not moved. Retry or seek help with the exit tools.';
      case 'unspecified':
      default:
        return 'Exit status unknown.';
    }
  })();
  // The daemon's best-case estimate is an approximation, never a promise —
  // render it as such, and only while the exit is still moving.
  if (
    opts?.bestCaseBlocksRemaining !== undefined &&
    opts.bestCaseBlocksRemaining > 0 &&
    status !== 'completed' &&
    status !== 'failed'
  ) {
    return `${base} Best-case estimate: about ${opts.bestCaseBlocksRemaining} blocks.`;
  }
  return base;
}
