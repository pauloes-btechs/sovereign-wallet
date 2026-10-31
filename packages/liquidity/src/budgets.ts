/**
 * Budget policy for AutoLoop — pure functions over the journal so the
 * enforcement rules are testable and the same code runs in tests, CI, and
 * the app. Automation spends are measured from SETTLED auto-swap entries;
 * a projected cost is checked before any new automation is allowed.
 */

import type { LiquidityJournal, LiquidityJournalEntry } from './journal.js';
import type { SwapUpdate } from './types.js';

/** Opt-in budget policy governing AutoLoop. All values are satoshis. */
export interface AutoLoopBudgetPolicy {
  /** Maximum total cost (fees) a single automated swap may consume. */
  perActionCapSat: number;
  /** Maximum total cost automated swaps may consume per UTC day. */
  dailyBudgetSat: number;
  /** Maximum total cost automated swaps may consume per UTC month. */
  monthlyBudgetSat: number;
}

export type BudgetRefusalReason =
  | 'per-action-cap'
  | 'daily-budget-exhausted'
  | 'monthly-budget-exhausted';

export interface BudgetCheck {
  allowed: boolean;
  reason?: BudgetRefusalReason;
  /** Plain-language explanation, rendered when the check blocks an action. */
  message?: string;
  remainingDailySat: number;
  remainingMonthlySat: number;
}

/** Inclusive start, exclusive end of the UTC day containing `atMs`. */
export function utcDayWindow(atMs: number): { startMs: number; endMs: number } {
  const d = new Date(atMs);
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 };
}

/** Inclusive start, exclusive end of the UTC month containing `atMs`. */
export function utcMonthWindow(atMs: number): { startMs: number; endMs: number } {
  const d = new Date(atMs);
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { startMs, endMs };
}

function settledCostInWindow(entries: readonly LiquidityJournalEntry[], kind: 'auto-swap', startMs: number, endMs: number): number {
  let total = 0;
  for (const e of entries) {
    if (e.kind !== kind) continue;
    const data = e.data ?? {};
    if (data.phase !== 'settled') continue;
    const atMs = Date.parse(e.at);
    if (!(atMs >= startMs && atMs < endMs)) continue;
    total += typeof data.costSat === 'number' ? data.costSat : 0;
  }
  return total;
}

/**
 * Check whether an automated swap with the given estimated cost fits the
 * policy given the journaled history. `entries` is the full journal;
 * windows are UTC day/month of `nowMs`.
 */
export function checkAutoLoopBudget(
  policy: AutoLoopBudgetPolicy,
  entries: readonly LiquidityJournalEntry[],
  nowMs: number,
  projectedCostSat: number,
): BudgetCheck {
  if (projectedCostSat > policy.perActionCapSat) {
    return {
      allowed: false,
      reason: 'per-action-cap',
      message: `Estimated cost of ${projectedCostSat} sats exceeds the per-action cap of ${policy.perActionCapSat} sats.`,
      remainingDailySat: remaining(policy.dailyBudgetSat, entries, nowMs, utcDayWindow),
      remainingMonthlySat: remaining(policy.monthlyBudgetSat, entries, nowMs, utcMonthWindow),
    };
  }

  const day = utcDayWindow(nowMs);
  const month = utcMonthWindow(nowMs);
  const spentDaily = settledCostInWindow(entries, 'auto-swap', day.startMs, day.endMs);
  const spentMonthly = settledCostInWindow(entries, 'auto-swap', month.startMs, month.endMs);

  // Daily is checked first: it is the tighter, faster-resetting limit, so its
  // message is the more actionable one when both ceilings are hit. A spend
  // that would consume the budget exactly is also refused — no free rides at
  // the boundary.
  if (spentDaily + projectedCostSat >= policy.dailyBudgetSat) {
    return {
      allowed: false,
      reason: 'daily-budget-exhausted',
      message: `Daily automation budget is used up (${spentDaily} of ${policy.dailyBudgetSat} sats). It resets at 00:00 UTC.`,
      remainingDailySat: Math.max(0, policy.dailyBudgetSat - spentDaily),
      remainingMonthlySat: Math.max(0, policy.monthlyBudgetSat - spentMonthly),
    };
  }

  if (spentMonthly + projectedCostSat >= policy.monthlyBudgetSat) {
    return {
      allowed: false,
      reason: 'monthly-budget-exhausted',
      message: `Monthly automation budget is used up (${spentMonthly} of ${policy.monthlyBudgetSat} sats).`,
      remainingDailySat: Math.max(0, policy.dailyBudgetSat - spentDaily),
      remainingMonthlySat: Math.max(0, policy.monthlyBudgetSat - spentMonthly),
    };
  }

  return {
    allowed: true,
    remainingDailySat: Math.max(0, policy.dailyBudgetSat - (spentDaily + projectedCostSat)),
    remainingMonthlySat: Math.max(0, policy.monthlyBudgetSat - (spentMonthly + projectedCostSat)),
  };
}

function remaining(
  budget: number,
  entries: readonly LiquidityJournalEntry[],
  nowMs: number,
  window: (atMs: number) => { startMs: number; endMs: number },
): number {
  const w = window(nowMs);
  return Math.max(0, budget - settledCostInWindow(entries, 'auto-swap', w.startMs, w.endMs));
}

/**
 * Validate a user-provided policy. Throws with a clear message on nonsense
 * values — the manager refuses to enable automation under an invalid policy.
 */
export function validateAutoLoopBudgetPolicy(policy: AutoLoopBudgetPolicy): void {
  for (const [name, value] of [
    ['perActionCapSat', policy.perActionCapSat],
    ['dailyBudgetSat', policy.dailyBudgetSat],
    ['monthlyBudgetSat', policy.monthlyBudgetSat],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`AutoLoop budget policy: ${name} must be a positive integer (got ${value}).`);
    }
  }
  if (policy.monthlyBudgetSat < policy.dailyBudgetSat) {
    throw new Error(
      `AutoLoop budget policy: monthlyBudgetSat (${policy.monthlyBudgetSat}) must be at least dailyBudgetSat (${policy.dailyBudgetSat}).`,
    );
  }
}

/** Journal a settled swap observation for budget accounting. */
export function swapUpdateToEntry(update: Readonly<SwapUpdate>, automation: boolean, newId: () => string): LiquidityJournalEntry {
  return {
    id: newId(),
    at: new Date(update.at).toISOString(),
    kind: automation ? 'auto-swap' : 'manual-swap',
    message:
      automation
        ? `AutoLoop ${update.direction} ${update.state} — cost ${update.costSat} sats`
        : `${update.direction} swap ${update.state} — cost ${update.costSat} sats`,
    data: {
      phase: 'settled',
      swapId: update.swapId,
      direction: update.direction,
      state: update.state,
      amountSat: update.amountSat,
      costSat: update.costSat,
    },
  };
}

/** Convenience for reading back spend from a journal. */
export async function readJournal(journal: LiquidityJournal): Promise<LiquidityJournalEntry[]> {
  return journal.list();
}
