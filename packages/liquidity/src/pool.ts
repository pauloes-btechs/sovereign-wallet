/**
 * Pool market availability. Per the spec, Pool leases are behind
 * market-availability detection and a thin/empty market is a first-class
 * state — never an error dialog, never silently hidden.
 */

import { describeProviderFailure, isLiquidityProviderError } from './errors.js';
import type { PoolMarketRaw } from './ports.js';

export type PoolMarketState = 'unavailable' | 'thin' | 'available';

export interface PoolMarketSnapshot {
  state: PoolMarketState;
  /** Number of matched batches visible in the latest snapshot. */
  matchedBatches: number;
  /** Total lease volume (sats) in the latest snapshot, when reported. */
  leasedVolumeSat?: number;
  /** Plain-language explanation of the state. */
  message: string;
}

/**
 * Classify the market from raw data or a provider failure. `matchedBatches`
 * of 0 means the auctioneer answered but no matched markets exist — the
 * thin-market state.
 */
export function classifyPoolMarket(raw: PoolMarketRaw | { error: unknown }): PoolMarketSnapshot {
  if ('error' in raw) {
    const kind = isLiquidityProviderError(raw.error) ? raw.error.kind : 'unknown';
    return {
      state: 'unavailable',
      matchedBatches: 0,
      message: describeProviderFailure(kind),
    };
  }
  if (raw.matchedBatches <= 0) {
    return {
      state: 'thin',
      matchedBatches: raw.matchedBatches,
      leasedVolumeSat: raw.leasedVolumeSat,
      message: 'No Pool lease activity is visible right now — the market is too thin to rely on.',
    };
  }
  return {
    state: 'available',
    matchedBatches: raw.matchedBatches,
    leasedVolumeSat: raw.leasedVolumeSat,
    message: `Pool market is live with ${raw.matchedBatches} matched batch${raw.matchedBatches === 1 ? '' : 'es'}.`,
  };
}
