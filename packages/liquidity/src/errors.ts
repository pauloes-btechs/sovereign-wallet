/**
 * Typed failures from the Loop/Pool backends. The engine classifies every
 * provider failure into a kind so the UI can render a real state
 * ("no affordable liquidity right now", "market unavailable", ...) instead
 * of a raw error message.
 */

export type LiquidityProviderFailureKind =
  /** Service not reachable or not yet registered (e.g. pre-sync litd, server down). */
  | 'unavailable'
  /** Macaroon/permission problem — a configuration defect, not a user state. */
  | 'unauthenticated'
  /** Amount outside the server's current min/max terms. */
  | 'out-of-terms'
  /** Channel/UTXO constraints prevent the swap (no capacity, no funds). */
  | 'insufficient-funds'
  /** The server cannot serve a swap at these constraints right now (thin market). */
  | 'no-affordable-quote'
  | 'unknown';

export class LiquidityProviderError extends Error {
  readonly kind: LiquidityProviderFailureKind;

  constructor(kind: LiquidityProviderFailureKind, message: string) {
    super(message);
    this.name = 'LiquidityProviderError';
    this.kind = kind;
  }
}

/**
 * True when the error is an engine-classified provider failure. Raw non-gRPC
 * transport failures and programming errors must NOT be swallowed into a
 * friendly state — the manager surfaces those as `unknown` only when the
 * error came from the provider call itself.
 */
export function isLiquidityProviderError(err: unknown): err is LiquidityProviderError {
  return err instanceof LiquidityProviderError;
}

/** Plain-language rendering per failure kind — shown verbatim in the UI. */
export function describeProviderFailure(kind: LiquidityProviderFailureKind): string {
  switch (kind) {
    case 'unavailable':
      return 'The liquidity service is not reachable right now. This can happen while the node is still syncing.';
    case 'unauthenticated':
      return 'The wallet is not authorized to use this liquidity service. Check the daemon connection settings.';
    case 'out-of-terms':
      return 'This amount is outside the service\u2019s supported range right now.';
    case 'insufficient-funds':
      return 'There is not enough channel or on-chain balance to run this swap.';
    case 'no-affordable-quote':
      return 'No affordable liquidity is available right now. Try a smaller amount or retry later.';
    case 'unknown':
      return 'The liquidity service returned an unexpected error.';
  }
}
