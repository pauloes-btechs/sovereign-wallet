/**
 * Sum of ONE provider's balance buckets. Deliberately provider-scoped:
 * the boundary invariant forbids totals that merge across providers.
 */
export interface BalanceBucketTotals {
  onchainConfirmedSat: bigint;
  onchainPendingSat: bigint;
  lightningSpendableSat: bigint;
  lightningPendingSat: bigint;
  lockedOrExpiringSat: bigint;
}

export function providerTotalSat(buckets: BalanceBucketTotals): bigint {
  return (
    buckets.onchainConfirmedSat +
    buckets.onchainPendingSat +
    buckets.lightningSpendableSat +
    buckets.lightningPendingSat +
    buckets.lockedOrExpiringSat
  );
}
