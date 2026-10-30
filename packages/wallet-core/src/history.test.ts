import { describe, expect, it } from 'vitest';
import { TransactionHistory, type TransactionRecord } from './history.js';

function rec(over: Partial<TransactionRecord>): TransactionRecord {
  return {
    txId: 'tx-1',
    providerId: 'wavelength',
    direction: 'out',
    kind: 'lightning-invoice',
    amountSat: 1_000n,
    status: 'settled',
    at: '2026-10-30T00:00:00Z',
    ...over,
  };
}

describe('TransactionHistory — per-provider isolation', () => {
  it('returns only the requested provider’s records, newest first', () => {
    const h = new TransactionHistory();
    h.append(rec({ txId: 'a' }));
    h.append(rec({ txId: 'b', providerId: 'litd-local' }));
    h.append(rec({ txId: 'c' }));
    expect(h.list('wavelength').map((r) => r.txId)).toEqual(['c', 'a']);
    expect(h.list('litd-local').map((r) => r.txId)).toEqual(['b']);
    expect(h.list('lnc-remote')).toEqual([]);
  });

  it('limit returns the most recent records', () => {
    const h = new TransactionHistory();
    for (let n = 1; n <= 5; n++) {
      h.append(rec({ txId: `t${n}`, at: `2026-10-30T00:0${n}:00Z` }));
    }
    expect(h.list('wavelength', { limit: 2 }).map((r) => r.txId)).toEqual(['t5', 't4']);
  });

  it('filters by status', () => {
    const h = new TransactionHistory();
    h.append(rec({ txId: 'a', status: 'settled' }));
    h.append(rec({ txId: 'b', status: 'pending' }));
    expect(h.list('wavelength', { status: 'pending' }).map((r) => r.txId)).toEqual(['b']);
  });

  it('mutating a returned record does not corrupt the history', () => {
    const h = new TransactionHistory();
    h.append(rec({ txId: 'a' }));
    const listed = h.list('wavelength')[0];
    // Cast through readonly — simulating a hostile consumer of the public API.
    if (listed) (listed as { amountSat: bigint }).amountSat = 999_999n;
    expect(h.list('wavelength')[0]?.amountSat).toBe(1_000n);
  });
});
