/**
 * Balance buckets within ONE provider. Mode A reads lightning-spendable and
 * locked/expiring (VTXO states); Mode B reads on-chain and channel balances.
 * One shape serves both — the UI renders from the provider's declaration.
 */
export interface BalanceBuckets {
  onchainConfirmedSat: bigint;
  onchainPendingSat: bigint;
  lightningSpendableSat: bigint;
  lightningPendingSat: bigint;
  lockedOrExpiringSat: bigint;
}
