/**
 * One wallet-level VTXO status from the provider's per-VTXO classification
 * (`provider.classifyVtxos()`), so the balance card states the real state
 * instead of assuming every VTXO is fresh and the operator is reachable.
 */
import type { VtxoState } from '@sovereign/ui';

export interface VtxoClassification {
  readonly state: VtxoState;
  readonly blocksToExpiry?: number;
}

export interface VtxoSummary {
  readonly state: VtxoState;
  /** Hours until the soonest non-exiting VTXO expires (~10-minute blocks); null when none expire. */
  readonly hoursToExpiry: number | null;
  readonly vtxoCount: number;
}

/** Worst state wins: one exiting or at-risk VTXO is what the user must act on. */
const SEVERITY: Record<VtxoState, number> = { fresh: 0, expiring: 1, 'at-risk': 2, exiting: 3 };

export const MINUTES_PER_BLOCK = 10;

export function summarizeVtxos(classified: readonly VtxoClassification[]): VtxoSummary {
  let state: VtxoState = 'fresh';
  let soonest: number | undefined;
  for (const v of classified) {
    if (SEVERITY[v.state] > SEVERITY[state]) state = v.state;
    if (v.state !== 'exiting' && v.blocksToExpiry !== undefined) {
      soonest = soonest === undefined ? v.blocksToExpiry : Math.min(soonest, v.blocksToExpiry);
    }
  }
  return {
    state,
    hoursToExpiry: soonest === undefined ? null : Math.max(0, Math.round((soonest * MINUTES_PER_BLOCK) / 60)),
    vtxoCount: classified.length,
  };
}
