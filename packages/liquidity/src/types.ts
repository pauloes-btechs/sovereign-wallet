/**
 * Engine-level domain types for the liquidity feature. Everything here is
 * backend-agnostic: the litd adapter maps the Loop/Pool gRPC surfaces onto
 * these shapes, and the UI renders them directly.
 */

/** Direction of a Loop swap. */
export type LoopDirection = 'loop-out' | 'loop-in';

/**
 * A quoted swap's cost split. All values are satoshis as reported/derived
 * from the live quote — the UI never invents fee numbers.
 */
export interface FeeBreakdownSat {
  /** Swap fee charged by the loop server (ppm applied to the amount). */
  swapFeeSat: number;
  /** Prepay (probe) fee for Loop Out; 0 for Loop In. */
  prepayFeeSat: number;
  /** Estimated miner fee for the on-chain legs. */
  minerFeeSat: number;
  /** Estimated routing fees for the off-chain leg (Loop Out). */
  routingFeeSat: number;
  /** swapFee + prepay + miner + routing. */
  totalSat: number;
}

export interface LoopQuote {
  direction: LoopDirection;
  /** Swap amount in satoshis (excludes fees). */
  amountSat: number;
  fees: FeeBreakdownSat;
  /** CLTV delta the swap's HTLCs will use. */
  cltvDelta: number;
  /** Confirmation target the quote's miner fees were estimated at. */
  confTarget: number;
  /** Server swap fee as parts-per-million of the amount. */
  swapFeePpm: number;
}

/** Why a swap ended, in engine terms (mapped from loopd's SwapState enum). */
export type SwapState =
  | 'initiated'
  | 'preimage-revealed'
  | 'htlc-published'
  | 'settled'
  | 'failed'
  | 'canceled'
  | 'invoice-settled';

/** A swap's lifecycle as the engine observes it. */
export interface SwapUpdate {
  swapId: string;
  direction: LoopDirection;
  state: SwapState;
  amountSat: number;
  /** Realized total cost so far, from the server's cost report. */
  costSat: number;
  /** Epoch ms of the observation. */
  at: number;
}

/**
 * AutoLoop configuration as the loop sub-server stores it. The manager sets
 * `autoloopEnabled` only through the explicit opt-in flow; the other knobs
 * are either derived from the budget policy or provided by the caller.
 */
export interface AutoLoopParams {
  autoloopEnabled: boolean;
  /** loopd's own cumulative budget (sats) for automated swaps since budgetStartSec. */
  budgetSat: number;
  /** Budget window start, epoch seconds (loopd's autoloop budget start). */
  budgetStartSec: number;
  /** Max server fee in ppm of the swap amount. */
  maxSwapFeePpm: number;
  /** Max miner fee per swap. */
  maxMinerFeeSat: number;
  /** Max prepay (probe) fee per swap. */
  maxPrepaySat: number;
  /** Confirmation target for automated sweeps. */
  sweepConfTarget: number;
  /** Backoff after a failed swap, seconds. */
  failureBackoffSec: number;
}
