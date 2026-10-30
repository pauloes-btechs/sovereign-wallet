import type { PaymentKind } from '@sovereign/payments';
import type { ProviderId } from './provider.js';

export type TransactionStatus = 'pending' | 'settled' | 'failed';

export interface TransactionRecord {
  readonly txId: string;
  readonly providerId: ProviderId;
  readonly direction: 'in' | 'out';
  readonly kind: PaymentKind;
  readonly amountSat: bigint;
  readonly status: TransactionStatus;
  readonly at: string;
  readonly intentId?: string;
  readonly backendRef?: string;
}

export interface ListOptions {
  readonly limit?: number;
  readonly status?: TransactionStatus;
}

/**
 * Append-only transaction history, strictly partitioned by provider.
 * There is no cross-provider view: a payment history belongs to exactly
 * one wallet engine.
 */
export class TransactionHistory {
  private readonly records: TransactionRecord[] = [];

  append(record: TransactionRecord): void {
    this.records.push({ ...record });
  }

  /** Newest first; `limit` keeps the most recent records. */
  list(providerId: ProviderId, options: ListOptions = {}): TransactionRecord[] {
    let out = this.records.filter((r) => r.providerId === providerId);
    if (options.status !== undefined) {
      out = out.filter((r) => r.status === options.status);
    }
    const newestFirst = out.slice().reverse().map((r) => ({ ...r }));
    return options.limit === undefined
      ? newestFirst
      : newestFirst.slice(0, Math.max(0, options.limit));
  }
}
