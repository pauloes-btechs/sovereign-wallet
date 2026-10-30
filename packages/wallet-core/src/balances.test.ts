import { describe, expect, it } from 'vitest';
import { BalanceBook } from './balances.js';

describe('BalanceBook — per-provider accounting', () => {
  it('starts at zero for every provider', () => {
    const book = new BalanceBook();
    const snap = book.snapshot('wavelength');
    expect(snap.totalSat).toBe(0n);
    expect(Object.values(snap.buckets).every((v) => v === 0n)).toBe(true);
  });

  it('accumulates signed deltas within one provider', () => {
    const book = new BalanceBook();
    book.apply('wavelength', { lightningSpendableSat: 100_000n });
    book.apply('wavelength', { lightningSpendableSat: -30_000n, onchainPendingSat: 30_000n });
    const snap = book.snapshot('wavelength');
    expect(snap.buckets.lightningSpendableSat).toBe(70_000n);
    expect(snap.buckets.onchainPendingSat).toBe(30_000n);
    expect(snap.totalSat).toBe(100_000n);
  });

  it('moves expiring VTXOs into locked/expiring without changing the total', () => {
    const book = new BalanceBook();
    book.apply('wavelength', { lightningSpendableSat: 100_000n });
    book.apply('wavelength', { lightningSpendableSat: -100_000n, lockedOrExpiringSat: 100_000n });
    const snap = book.snapshot('wavelength');
    expect(snap.buckets.lightningSpendableSat).toBe(0n);
    expect(snap.buckets.lockedOrExpiringSat).toBe(100_000n);
    expect(snap.totalSat).toBe(100_000n);
  });

  it('never merges balances across providers — snapshots stay separate', () => {
    const book = new BalanceBook();
    book.apply('wavelength', { lightningSpendableSat: 100_000n });
    book.apply('litd-local', { lightningSpendableSat: 7_000n, onchainConfirmedSat: 2_000n });

    const snaps = book.snapshots();
    expect(snaps).toHaveLength(2);
    expect(book.snapshot('wavelength').totalSat).toBe(100_000n);
    expect(book.snapshot('litd-local').totalSat).toBe(9_000n);
  });

  it('an untouched provider still snapshots at zero', () => {
    const book = new BalanceBook();
    book.apply('wavelength', { lightningSpendableSat: 5n });
    expect(book.snapshot('lnc-remote').totalSat).toBe(0n);
  });

  it('totals include locked and pending funds — they are still the user’s sats', () => {
    const book = new BalanceBook();
    book.apply('litd-local', {
      onchainConfirmedSat: 500n,
      onchainPendingSat: 100n,
      lightningSpendableSat: 200n,
      lightningPendingSat: 40n,
      lockedOrExpiringSat: 60n,
    });
    expect(book.snapshot('litd-local').totalSat).toBe(900n);
  });
});
