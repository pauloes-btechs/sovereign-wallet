import type { ProviderId } from './provider.js';

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

export interface BalanceSnapshot {
  readonly providerId: ProviderId;
  readonly buckets: Readonly<BalanceBuckets>;
  /** Sum of this provider's buckets only — totals are never merged. */
  readonly totalSat: bigint;
}

function zeroBuckets(): BalanceBuckets {
  return {
    onchainConfirmedSat: 0n,
    onchainPendingSat: 0n,
    lightningSpendableSat: 0n,
    lightningPendingSat: 0n,
    lockedOrExpiringSat: 0n,
  };
}

function sumBuckets(b: BalanceBuckets): bigint {
  return (
    b.onchainConfirmedSat +
    b.onchainPendingSat +
    b.lightningSpendableSat +
    b.lightningPendingSat +
    b.lockedOrExpiringSat
  );
}

/**
 * Per-provider balance accounting. Deliberately offers NO cross-provider
 * total: the boundary invariant forbids merging balances across providers —
 * `snapshots()` returns one snapshot per provider, never an aggregate.
 */
export class BalanceBook {
  private readonly books = new Map<ProviderId, BalanceBuckets>();

  /** Applies signed deltas and returns the provider's fresh snapshot. */
  apply(providerId: ProviderId, delta: Partial<BalanceBuckets>): BalanceSnapshot {
    const buckets = this.books.get(providerId) ?? zeroBuckets();
    for (const key of Object.keys(zeroBuckets()) as Array<keyof BalanceBuckets>) {
      const d = delta[key];
      if (d !== undefined) {
        buckets[key] = buckets[key] + d;
      }
    }
    this.books.set(providerId, buckets);
    return this.snapshot(providerId);
  }

  /** Snapshot for one provider — zeroed if nothing was ever applied. */
  snapshot(providerId: ProviderId): BalanceSnapshot {
    const buckets = this.books.get(providerId) ?? zeroBuckets();
    return { providerId, buckets: { ...buckets }, totalSat: sumBuckets(buckets) };
  }

  /** One snapshot per touched provider. Never a merged total. */
  snapshots(): BalanceSnapshot[] {
    return [...this.books.keys()].map((id) => this.snapshot(id));
  }
}
