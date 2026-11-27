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
