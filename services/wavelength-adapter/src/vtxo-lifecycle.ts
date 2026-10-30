/**
 * Ark VTXO lifecycle — the Mode A user-visible state machine (spec:
 * fresh / expiring / at-risk / exiting), mapped from live daemon data.
 *
 * Sources of truth:
 * - WalletVTXO.batchExpiry (absolute block height) vs the daemon's block
 *   height → time-to-expiry.
 * - ServerInfo.freeRefreshWindowBlocks → the operator's fee-waived refresh
 *   window (live capability data, never a hardcoded constant).
 * - WalletVTXO.exitJobStatus / exit status → the unilateral-exit progression
 *   pending → materializing → csv_pending → sweeping → completed|failed.
 *
 * Pure functions only: the provider polls and the UI renders, nothing here
 * talks to the daemon.
 */

import type { VTXOInventory, WalletVTXO } from './sdk/index.js';
import {
  ExitJobStatusCSVPending,
  ExitJobStatusMaterializing,
  ExitJobStatusPending,
  ExitJobStatusSweeping,
} from './sdk/index.js';
import type { ExitJobStatus } from './sdk/index.js';

/** The spec's four user-visible VTXO states. */
export type VtxoState = 'fresh' | 'expiring' | 'at-risk' | 'exiting';

/** Default VTXO poll cadence for the host's scheduler (30s — expiry windows are block-scale). */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Exit-job statuses that mean a unilateral exit is in flight (SDK constants). */
export const EXITING_JOB_STATUSES: readonly ExitJobStatus[] = [
  ExitJobStatusPending,
  ExitJobStatusMaterializing,
  ExitJobStatusCSVPending,
  ExitJobStatusSweeping,
];

export function isExitingJobStatus(status: ExitJobStatus): boolean {
  return EXITING_JOB_STATUSES.includes(status);
}

/** Live context the classifier needs — all of it comes from the daemon. */
export interface VtxoContext {
  /** The daemon's current best-block height (WalletInfo.blockHeight). */
  readonly blockHeight: number;
  /**
   * The operator's fee-waived refresh window in blocks
   * (WalletInfo.serverInfo.freeRefreshWindowBlocks). Undefined when the
   * operator is unreachable or has not advertised one.
   */
  readonly freeRefreshWindowBlocks?: number;
  /** Whether the Ark operator is currently reachable (WalletInfo.serverConnected). */
  readonly operatorReachable: boolean;
  /**
   * In-flight exit jobs by outpoint — built from `exitSummary()`
   * (ExitSummaryEntry { outpoint, status }). Absent entries mean no job.
   */
  readonly exitJobs?: ReadonlyMap<string, ExitJobStatus>;
}

export interface VtxoWithState {
  readonly vtxo: WalletVTXO;
  readonly state: VtxoState;
  /** Blocks until this VTXO's batch expires; undefined when no expiry is set. */
  readonly blocksToExpiry?: number;
}

/**
 * Classify one VTXO. Rules, in order (first match wins):
 * 1. A live exit job (`pending|materializing|csv_pending|sweeping`) → 'exiting'.
 * 2. batchExpiry already passed → 'at-risk' (an expired/swept VTXO needs
 *    operator cooperation or a unilateral recovery — never silently 'fresh').
 * 3. Inside the free-refresh window and the operator is unreachable → 'at-risk'
 *    (spec: "Operator unreachable inside window").
 * 4. Inside the free-refresh window → 'expiring'.
 * 5. Otherwise → 'fresh'.
 *
 * A VTXO without a batch expiry (0) carries no expiry pressure.
 */
export function classifyVtxo(vtxo: WalletVTXO, ctx: VtxoContext): VtxoState {
  const jobStatus = ctx.exitJobs?.get(vtxo.outpoint);
  if (jobStatus !== undefined && isExitingJobStatus(jobStatus)) return 'exiting';

  const blocksToExpiry = blocksToExpiryOf(vtxo, ctx.blockHeight);
  if (blocksToExpiry === undefined) return 'fresh';
  if (blocksToExpiry <= 0) return 'at-risk';

  const window = ctx.freeRefreshWindowBlocks;
  if (window !== undefined && blocksToExpiry <= window) {
    return ctx.operatorReachable ? 'expiring' : 'at-risk';
  }
  return 'fresh';
}

/** Blocks until batch expiry; undefined when the VTXO carries no expiry. */
export function blocksToExpiryOf(vtxo: WalletVTXO, blockHeight: number): number | undefined {
  // batchExpiry is read as an ABSOLUTE block height (batchExpiry − height =
  // blocks remaining); relativeExpiry is the batch's CSV sweep delay. The
  // regtest money-flow test pins this interpretation: a live VTXO's
  // batchExpiry sits far above the current height, so if the field ever
  // arrives as a relative block count the classification regresses to
  // 'at-risk' and the test fails loudly rather than silently lying.
  if (!Number.isFinite(vtxo.batchExpiry) || vtxo.batchExpiry <= 0) return undefined;
  return vtxo.batchExpiry - blockHeight;
}

/**
 * Classify a whole inventory. Aggregates are derived per VTXO — never summed
 * from daemon aggregates, which mix pending and spendable states.
 */
export function classifyVtxoInventory(
  inventory: VTXOInventory,
  ctx: VtxoContext,
): VtxoWithState[] {
  return inventory.vtxos.map((vtxo) => ({
    vtxo,
    state: classifyVtxo(vtxo, ctx),
    blocksToExpiry: blocksToExpiryOf(vtxo, ctx.blockHeight),
  }));
}

/** Sum of VTXO sats locked, expiring, or exiting — the 'locked/expiring' bucket. */
export function lockedOrExpiringSat(classified: readonly VtxoWithState[]): bigint {
  return classified
    .filter(({ state }) => state !== 'fresh')
    .reduce((sum, { vtxo }) => sum + BigInt(vtxo.amountSat), 0n);
}

/** True when any VTXO entered 'expiring' — the poller emits the expiry event once. */
export function hasExpiring(classified: readonly VtxoWithState[]): boolean {
  return classified.some(({ state }) => state === 'expiring');
}

/** True when any VTXO is 'at-risk' — the poller emits 'operator-unreachable' once. */
export function hasAtRisk(classified: readonly VtxoWithState[]): boolean {
  return classified.some(({ state }) => state === 'at-risk');
}

/**
 * User-visible copy per state — the spec's state-table strings, verbatim
 * where the spec fixes the wording. Exit copy takes the daemon's best-case
 * block countdown when available (rendered as an estimate, never a promise).
 */
export function describeVtxoState(state: VtxoState, opts?: { bestCaseBlocksRemaining?: number }): string {
  switch (state) {
    case 'fresh':
      return 'Spendable';
    case 'expiring':
      return 'Your funds are being rolled forward automatically';
    case 'at-risk':
      return (
        'Cooperative payments are paused. A unilateral exit can move these funds ' +
        'on-chain — slower, and at your cost.'
      );
    case 'exiting': {
      const blocks = opts?.bestCaseBlocksRemaining;
      return blocks !== undefined && blocks > 0
        ? `Exiting to on-chain — available in ~${blocksToHoursLabel(blocks)}. Cancel not possible.`
        : 'Exiting to on-chain — available in hours to days. Cancel not possible.';
    }
  }
}

/** Renders a block countdown as hours (~10 min/block), rounded up. */
function blocksToHoursLabel(blocks: number): string {
  return `~${Math.max(1, Math.ceil((blocks * 10) / 60))} h`;
}
