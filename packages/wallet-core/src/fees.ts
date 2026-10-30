import type { PaymentKind } from '@sovereign/payments';

export type FeePriority = 'slow' | 'normal' | 'fast';

export interface FeeRateEntry {
  readonly satPerVByte: number;
  readonly vsize: number;
}

/**
 * Rate configuration for a static estimator. Live rate sources (LND RPC,
 * swap-server fee schedules) arrive as adapters implementing `FeeEstimator`;
 * this table exists for tests, offline quoting, and the fallback path.
 */
export interface FeeRateTable {
  readonly kinds: Record<PaymentKind, FeeRateEntry>;
  /** Multipliers applied to satPerVByte, rounded UP to whole sat/vB. */
  readonly priorities: Record<FeePriority, number>;
}

export interface FeeEstimateRequest {
  readonly kind: PaymentKind;
  readonly priority?: FeePriority;
}

export interface FeeQuote {
  readonly kind: PaymentKind;
  readonly priority: FeePriority;
  readonly satPerVByte: number;
  readonly vsize: number;
  readonly feeSat: bigint;
}

export interface FeeEstimator {
  estimate(request: FeeEstimateRequest): Promise<FeeQuote>;
}

export class MissingFeeRateError extends Error {
  constructor(readonly kind: PaymentKind) {
    super(`No fee rate configured for payment kind '${kind}'`);
    this.name = 'MissingFeeRateError';
  }
}

export class InvalidFeeRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFeeRateError';
  }
}

export class FeeExceedsBudgetError extends Error {
  constructor(
    readonly feeSat: bigint,
    readonly maxFeeSat: number,
  ) {
    super(`Estimated fee of ${feeSat} sats exceeds the spend policy budget of ${maxFeeSat} sats`);
    this.name = 'FeeExceedsBudgetError';
  }
}

/**
 * Deterministic fee estimator driven entirely by an injected rate table —
 * the domain layer invents no fee constants of its own.
 */
export class StaticFeeEstimator implements FeeEstimator {
  constructor(private readonly table: FeeRateTable) {}

  async estimate(request: FeeEstimateRequest): Promise<FeeQuote> {
    const priority = request.priority ?? 'normal';
    const entry = this.table.kinds[request.kind];
    if (entry === undefined) {
      throw new MissingFeeRateError(request.kind);
    }
    if (
      !Number.isInteger(entry.satPerVByte) ||
      entry.satPerVByte < 1 ||
      !Number.isInteger(entry.vsize) ||
      entry.vsize < 1
    ) {
      throw new InvalidFeeRateError(
        `Fee rate for '${request.kind}' must have integer satPerVByte >= 1 and vsize >= 1`,
      );
    }
    const multiplier = this.table.priorities[priority];
    if (multiplier === undefined || !(multiplier > 0)) {
      throw new InvalidFeeRateError(`Priority multiplier for '${priority}' must be positive`);
    }
    const satPerVByte = Math.ceil(entry.satPerVByte * multiplier);
    const feeSat = BigInt(satPerVByte) * BigInt(entry.vsize);
    return { kind: request.kind, priority, satPerVByte, vsize: entry.vsize, feeSat };
  }
}

/**
 * The maxFeeSat enforcement point (spec: spend policy is enforced at
 * authorization). A missing budget means no cap; a fractional or negative
 * budget is a programming error, not something to silently round.
 */
export function assertFeeWithinBudget(quote: FeeQuote, maxFeeSat?: number): void {
  if (maxFeeSat === undefined) return;
  if (!Number.isInteger(maxFeeSat) || maxFeeSat < 0) {
    throw new RangeError(`maxFeeSat must be a non-negative integer, got ${maxFeeSat}`);
  }
  if (quote.feeSat > BigInt(maxFeeSat)) {
    throw new FeeExceedsBudgetError(quote.feeSat, maxFeeSat);
  }
}
