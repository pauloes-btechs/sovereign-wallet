/**
 * Backend ports for the liquidity engine. The litd adapter implements these
 * over the Loop/Pool sub-servers bundled in the litd sidecar — the engine
 * itself never touches gRPC, so all decision logic is testable without a
 * daemon.
 */

import type { AutoLoopParams, LoopDirection, LoopQuote, SwapUpdate } from './types.js';
import type { PoolMarketSnapshot } from './pool.js';

/** Request to execute a Loop Out swap (Lightning -> on-chain). */
export interface LoopOutRequest {
  amountSat: number;
  /** On-chain destination address for the swapped funds. */
  destAddress: string;
  /** Hard bound on the server fee — authorization is refused without one. */
  maxSwapFeeSat: number;
  /** Hard bound on miner fees — authorization is refused without one. */
  maxMinerFeeSat: number;
  /** Confirmation target for the sweep (0 = fast/next-block). */
  sweepConfTarget?: number;
}

/** Request to execute a Loop In swap (on-chain -> new inbound channel). */
export interface LoopInRequest {
  amountSat: number;
  maxSwapFeeSat: number;
  maxMinerFeeSat: number;
  /** Pubkey hex of an existing peer to attach the new channel to. */
  lastHopPubkeyHex?: string;
}

/**
 * The Loop surface the engine consumes. Implementations MUST map transport
 * failures onto `LiquidityProviderError` — the engine classifies those into
 * user-facing states.
 */
export interface LoopPort {
  loopOutQuote(amountSat: number, confTarget?: number): Promise<LoopQuote>;
  loopInQuote(amountSat: number, confTarget?: number): Promise<LoopQuote>;
  executeLoopOut(req: Readonly<LoopOutRequest>): Promise<{ swapId: string }>;
  executeLoopIn(req: Readonly<LoopInRequest>): Promise<{ swapId: string }>;
  /** Current AutoLoop params; `null` when the server has never stored any. */
  getAutoLoopParams(): Promise<AutoLoopParams | null>;
  setAutoLoopParams(params: Readonly<AutoLoopParams>): Promise<void>;
  /** All swaps known to the daemon (both automated and manual). */
  listSwaps(): Promise<SwapUpdate[]>;
  /** Subscribe to swap lifecycle updates; returns an unsubscribe function. */
  onSwapEvent(listener: (update: Readonly<SwapUpdate>) => void): () => void;
}

/** Data needed to classify the Pool market's availability. */
export interface PoolMarketRaw {
  /** Number of matched batches visible in the latest snapshot. */
  matchedBatches: number;
  /** Total lease volume (sats) in the latest snapshot, when reported. */
  leasedVolumeSat?: number;
}

/**
 * The Pool surface the engine consumes. Implementations throw
 * `LiquidityProviderError` (kind 'unavailable') when the auctioneer/market
 * cannot be reached — the engine turns that into a first-class state.
 */
export interface PoolPort {
  marketRaw(): Promise<PoolMarketRaw>;
}

export type { LoopDirection, LoopQuote, SwapUpdate, AutoLoopParams, PoolMarketSnapshot };
