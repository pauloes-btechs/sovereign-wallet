import { describe, expect, it } from 'vitest';

import {
  checkAutoLoopBudget,
  swapUpdateToEntry,
  utcDayWindow,
  utcMonthWindow,
  validateAutoLoopBudgetPolicy,
  type AutoLoopBudgetPolicy,
} from './budgets.js';
import type { LiquidityJournalEntry } from './journal.js';

const policy: AutoLoopBudgetPolicy = {
  perActionCapSat: 10_000,
  dailyBudgetSat: 50_000,
  monthlyBudgetSat: 150_000,
};

function autoSwapEntry(costSat: number, atMs: number, id = `j${costSat}-${atMs}`): LiquidityJournalEntry {
  return {
    id,
    at: new Date(atMs).toISOString(),
    kind: 'auto-swap',
    message: `AutoLoop swap settled — cost ${costSat} sats`,
    data: { phase: 'settled', costSat, swapId: id },
  };
}

describe('utc windows', () => {
  it('bounds the UTC day containing a timestamp', () => {
    const w = utcDayWindow(Date.UTC(2026, 9, 31, 23, 59, 59));
    expect(w.startMs).toBe(Date.UTC(2026, 9, 31));
    expect(w.endMs).toBe(Date.UTC(2026, 10, 1));
  });

  it('bounds the UTC month, including across month lengths', () => {
    expect(utcMonthWindow(Date.UTC(2026, 9, 15))).toEqual({
      startMs: Date.UTC(2026, 9, 1),
      endMs: Date.UTC(2026, 10, 1),
    });
    expect(utcMonthWindow(Date.UTC(2026, 1, 5))).toEqual({
      startMs: Date.UTC(2026, 1, 1),
      endMs: Date.UTC(2026, 2, 1),
    });
  });

  it('keeps day boundaries independent of the local timezone', () => {
    // 2026-10-31 00:30 UTC is 2026-10-30 evening in UTC-4 — the window must
    // still be the UTC day of 10-31.
    const atMs = Date.UTC(2026, 9, 31, 0, 30);
    const w = utcDayWindow(atMs);
    expect(new Date(w.startMs).toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });
});

describe('checkAutoLoopBudget', () => {
  const now = Date.UTC(2026, 9, 31, 12);

  it('allows an action when nothing has been spent', () => {
    const check = checkAutoLoopBudget(policy, [], now, 5_000);
    expect(check.allowed).toBe(true);
    expect(check.remainingDailySat).toBe(45_000);
    expect(check.remainingMonthlySat).toBe(145_000);
  });

  it('refuses an action above the per-action cap', () => {
    const check = checkAutoLoopBudget(policy, [], now, 10_001);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('per-action-cap');
    expect(check.message).toContain('per-action cap');
  });

  it('allows an action exactly at the per-action cap', () => {
    const check = checkAutoLoopBudget(policy, [], now, 10_000);
    expect(check.allowed).toBe(true);
  });

  it('refuses when the daily budget is exhausted by settled swaps today', () => {
    const todaySwap = autoSwapEntry(49_000, Date.UTC(2026, 9, 31, 8));
    const priorMonthSwap = autoSwapEntry(100_000, Date.UTC(2026, 8, 30, 8)); // Sep 30
    const check = checkAutoLoopBudget(policy, [todaySwap, priorMonthSwap], now, 2_000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('daily-budget-exhausted');
    // Daily counts only today's swap; the prior-month swap counts monthly only.
    expect(check.remainingDailySat).toBe(1_000);
    expect(check.remainingMonthlySat).toBe(101_000);
  });

  it('refuses when the projected action would exceed the daily budget', () => {
    const todaySwap = autoSwapEntry(45_000, Date.UTC(2026, 9, 31, 8));
    const check = checkAutoLoopBudget(policy, [todaySwap], now, 5_001);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('daily-budget-exhausted');
  });

  it('ignores future entries outside the current month window', () => {
    const entries = [
      autoSwapEntry(70_000, Date.UTC(2026, 10, 1, 10)), // next month, counts for monthly only
    ];
    // now is Oct 31; the Nov 1 swap is in the FUTURE — should not count.
    const check = checkAutoLoopBudget(policy, entries, now, 1_000);
    expect(check.allowed).toBe(true);
  });

  it('counts prior-month swaps only against the monthly budget', () => {
    const entries = [
      autoSwapEntry(60_000, Date.UTC(2026, 8, 30, 10)), // September
      autoSwapEntry(70_000, Date.UTC(2026, 9, 5, 10)), // October
      autoSwapEntry(25_000, Date.UTC(2026, 9, 31, 1)), // today
    ];
    // Monthly spend = 70k + 25k = 95k; +6k projected → 101k < 150k ✓.
    // Daily spend = 25k; +6k → 31k < 50k ✓.
    const check = checkAutoLoopBudget(policy, entries, now, 6_000);
    expect(check.allowed).toBe(true);
    // Remaining figures include the projected action.
    expect(check.remainingDailySat).toBe(19_000);
    expect(check.remainingMonthlySat).toBe(49_000);
  });

  it('refuses when spend plus projection would consume the monthly budget', () => {
    const entries = [
      autoSwapEntry(80_000, Date.UTC(2026, 9, 5, 10)),
      autoSwapEntry(60_000, Date.UTC(2026, 9, 20, 10)),
    ];
    const check = checkAutoLoopBudget(policy, entries, now, 10_000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('monthly-budget-exhausted');
    // The action was refused, so the projection is not subtracted.
    expect(check.remainingMonthlySat).toBe(10_000);
  });

  it('ignores manual swaps, unsettled phases, and non-numeric costs', () => {
    const entries: LiquidityJournalEntry[] = [
      {
        id: 'm1',
        at: new Date(now - 1000).toISOString(),
        kind: 'manual-swap',
        message: 'manual',
        data: { phase: 'settled', costSat: 500_000 },
      },
      {
        id: 'a1',
        at: new Date(now - 1000).toISOString(),
        kind: 'auto-swap',
        message: 'pending',
        data: { phase: 'initiated', swapId: 's1' },
      },
      {
        id: 'a2',
        at: new Date(now - 1000).toISOString(),
        kind: 'auto-swap',
        message: 'no cost yet',
        data: { phase: 'settled', swapId: 's2' },
      },
    ];
    const check = checkAutoLoopBudget(policy, entries, now, 5_000);
    expect(check.allowed).toBe(true);
  });
});

describe('validateAutoLoopBudgetPolicy', () => {
  it('accepts a sane policy', () => {
    expect(() => validateAutoLoopBudgetPolicy(policy)).not.toThrow();
  });

  it('rejects non-positive or non-integer values', () => {
    expect(() => validateAutoLoopBudgetPolicy({ ...policy, perActionCapSat: 0 })).toThrow(/perActionCapSat/);
    expect(() => validateAutoLoopBudgetPolicy({ ...policy, dailyBudgetSat: -1 })).toThrow(/dailyBudgetSat/);
    expect(() => validateAutoLoopBudgetPolicy({ ...policy, monthlyBudgetSat: 1.5 })).toThrow(/monthlyBudgetSat/);
  });

  it('rejects a monthly budget smaller than the daily budget', () => {
    expect(() => validateAutoLoopBudgetPolicy({ ...policy, monthlyBudgetSat: 1000 })).toThrow(/monthlyBudgetSat/);
  });
});

describe('swapUpdateToEntry', () => {
  it('journalizes settled updates with cost for budget accounting', () => {
    const entry = swapUpdateToEntry(
      { swapId: 's1', direction: 'loop-out', state: 'settled', amountSat: 500_000, costSat: 1_234, at: Date.UTC(2026, 9, 31, 12) },
      true,
      () => 'id-1',
    );
    expect(entry.kind).toBe('auto-swap');
    expect(entry.data?.['phase']).toBe('settled');
    expect(entry.data?.['costSat']).toBe(1_234);
    expect(entry.id).toBe('id-1');
  });

  it('keeps manual swaps out of the automation ledger', () => {
    const entry = swapUpdateToEntry(
      { swapId: 's2', direction: 'loop-in', state: 'settled', amountSat: 1, costSat: 1, at: Date.UTC(2026, 9, 31, 12) },
      false,
      () => 'id-2',
    );
    expect(entry.kind).toBe('manual-swap');
  });
});
