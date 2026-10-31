import { beforeEach, describe, expect, it } from 'vitest';

import type { AutoLoopBudgetPolicy } from './budgets.js';
import { LiquidityProviderError } from './errors.js';
import { MemoryLiquidityJournal, type LiquidityJournal, type LiquidityJournalEntry } from './journal.js';
import { LiquidityManager } from './manager.js';
import type { LoopOutRequest, LoopPort, PoolPort } from './ports.js';
import type { AutoLoopParams, LoopQuote, SwapUpdate } from './types.js';

function makeQuote(direction: 'loop-out' | 'loop-in', amountSat = 500_000): LoopQuote {
  return {
    direction,
    amountSat,
    fees: {
      swapFeeSat: Math.round(amountSat * 0.0025), // 2500 ppm
      prepayFeeSat: direction === 'loop-out' ? 500 : 0,
      minerFeeSat: 300,
      routingFeeSat: 0,
      totalSat: Math.round(amountSat * 0.0025) + (direction === 'loop-out' ? 800 : 300),
    },
    cltvDelta: 80,
    confTarget: 6,
    swapFeePpm: 2500,
  };
}

class FakeLoopPort implements LoopPort {
  quoteImpl: (direction: 'loop-out' | 'loop-in', amountSat: number) => Promise<LoopQuote> = async (d, a) => makeQuote(d, a);
  executeOutImpl: (req: LoopOutRequest) => Promise<{ swapId: string }> = async (req) => {
    this.executeOutCalls.push(req);
    return { swapId: `manual-${this.executeOutCalls.length}` };
  };
  autoLoopParams: AutoLoopParams | null = null;
  paramsWrites: AutoLoopParams[] = [];
  executeOutCalls: LoopOutRequest[] = [];
  swapListeners = new Set<(update: SwapUpdate) => void>();
  swaps: SwapUpdate[] = [];

  async loopOutQuote(amountSat: number): Promise<LoopQuote> {
    return this.quoteImpl('loop-out', amountSat);
  }
  async loopInQuote(amountSat: number): Promise<LoopQuote> {
    return this.quoteImpl('loop-in', amountSat);
  }
  async executeLoopOut(req: Readonly<LoopOutRequest>): Promise<{ swapId: string }> {
    return this.executeOutImpl({ ...req });
  }
  async executeLoopIn(): Promise<{ swapId: string }> {
    throw new Error('not used in this test');
  }
  async getAutoLoopParams(): Promise<AutoLoopParams | null> {
    return this.autoLoopParams;
  }
  async setAutoLoopParams(params: Readonly<AutoLoopParams>): Promise<void> {
    this.paramsWrites.push({ ...params });
    this.autoLoopParams = { ...params };
  }
  async listSwaps(): Promise<SwapUpdate[]> {
    return [...this.swaps];
  }
  onSwapEvent(listener: (update: SwapUpdate) => void): () => void {
    this.swapListeners.add(listener);
    return () => this.swapListeners.delete(listener);
  }
  emit(update: SwapUpdate): void {
    for (const l of this.swapListeners) l(update);
  }
}

const unavailablePool: PoolPort = {
  marketRaw: async () => {
    throw new LiquidityProviderError('unavailable', 'auctioneer unreachable');
  },
};
const emptyMarketPool: PoolPort = {
  marketRaw: async () => ({ matchedBatches: 0 }),
};
const liveMarketPool: PoolPort = {
  marketRaw: async () => ({ matchedBatches: 2, leasedVolumeSat: 8_000_000 }),
};

const policy: AutoLoopBudgetPolicy = {
  perActionCapSat: 10_000,
  dailyBudgetSat: 50_000,
  monthlyBudgetSat: 150_000,
};

const BASE_NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

interface Fixture {
  loop: FakeLoopPort;
  journal: LiquidityJournal;
  manager: LiquidityManager;
}

function makeManager(journal: LiquidityJournal = new MemoryLiquidityJournal()): Fixture {
  const loop = new FakeLoopPort();
  const manager = new LiquidityManager({
    loop,
    pool: unavailablePool,
    journal,
    newId: (() => { let n = 0; return () => `j${++n}`; })(),
    now: () => BASE_NOW,
  });
  return { loop, journal, manager };
}

function autoSettled(update: SwapUpdate): LiquidityJournalEntry {
  return {
    id: `journal-${update.swapId}`,
    at: new Date(update.at).toISOString(),
    kind: 'auto-swap',
    message: 'AutoLoop swap settled',
    data: { phase: 'settled', swapId: update.swapId, costSat: update.costSat, direction: update.direction, state: 'settled', amountSat: update.amountSat },
  };
}

describe('LiquidityManager — AutoLoop default and opt-in', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeManager();
  });

  it('never touches AutoLoop params unless enableAutoLoop is called', async () => {
    await fx.manager.start();
    await fx.manager.quoteLoopOut(500_000);
    fx.manager.assessChannels({ outboundSat: 0, inboundSat: 0, openChannels: 0 }, { outboundFloorSat: 1, inboundFloorSat: 1 });
    await fx.manager.poolMarket();
    expect(fx.loop.paramsWrites).toHaveLength(0);
    expect(fx.manager.isAutoLoopEnabled()).toBe(false);
  });

  it('enableAutoLoop writes daemon params with autoloop on and the monthly budget, and journals the change', async () => {
    await fx.manager.enableAutoLoop(policy, { budgetStartSec: 1790000000 });
    expect(fx.loop.paramsWrites).toHaveLength(1);
    const written = fx.loop.paramsWrites[0];
    expect(written?.autoloopEnabled).toBe(true);
    expect(written?.budgetSat).toBe(150_000);
    expect(written?.budgetStartSec).toBe(1790000000);
    expect(written?.maxMinerFeeSat).toBe(10_000); // per-action cap default
    expect(written?.maxPrepaySat).toBe(5_000);
    const entries = await fx.journal.list();
    expect(entries.some((e) => e.kind === 'policy-change' && e.data?.['action'] === 'enable')).toBe(true);
    expect(fx.manager.isAutoLoopEnabled()).toBe(true);
  });

  it('refuses to double-enable and validates the policy before any daemon write', async () => {
    await fx.manager.enableAutoLoop(policy);
    await expect(fx.manager.enableAutoLoop(policy)).rejects.toThrow(/already enabled/);
    expect(fx.loop.paramsWrites).toHaveLength(1); // no second write

    const bad: AutoLoopBudgetPolicy = { ...policy, dailyBudgetSat: -5 };
    const fx2 = makeManager();
    await expect(fx2.manager.enableAutoLoop(bad)).rejects.toThrow(/dailyBudgetSat/);
    expect(fx2.loop.paramsWrites).toHaveLength(0);
  });

  it('disableAutoLoop writes autoloop=false, journals, and is idempotent', async () => {
    await fx.manager.enableAutoLoop(policy);
    await fx.manager.disableAutoLoop('user turned it off');
    const last = fx.loop.paramsWrites.at(-1);
    expect(last?.autoloopEnabled).toBe(false);
    const entries = await fx.journal.list();
    expect(entries.some((e) => e.kind === 'policy-change' && e.data?.['action'] === 'disable')).toBe(true);
    expect(fx.manager.isAutoLoopEnabled()).toBe(false);
    // Idempotent: no further writes.
    await fx.manager.disableAutoLoop('again');
    expect(fx.loop.paramsWrites).toHaveLength(2);
  });
});

describe('LiquidityManager — quotes', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeManager();
  });

  it('returns a live quote with a plain-language message and journals it', async () => {
    const r = await fx.manager.quoteLoopOut(500_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.quote.fees.swapFeeSat).toBe(1_250);
      expect(r.message).toContain('500,000 sats');
      expect(r.message).toContain('2,050 sats');
    }
    const entries = await fx.journal.list();
    expect(entries.filter((e) => e.kind === 'quote' && e.data?.['phase'] === 'quoted')).toHaveLength(1);
  });

  it('maps provider failures to classified results — never throws', async () => {
    fx.loop.quoteImpl = async () => {
      throw new LiquidityProviderError('out-of-terms', 'amount outside terms');
    };
    const r = await fx.manager.quoteLoopOut(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('out-of-terms');
      expect(r.message).toContain('outside the service');
    }
    const entries = await fx.journal.list();
    expect(entries.some((e) => e.kind === 'quote' && e.data?.['errorKind'] === 'out-of-terms')).toBe(true);
  });

  it('maps a no-affordable-quote failure to the thin-market recommendation', async () => {
    fx.loop.quoteImpl = async () => {
      throw new LiquidityProviderError('no-affordable-quote', 'no affordable quote');
    };
    const r = await fx.manager.quoteLoopOut(500_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('no-affordable-quote');
      expect(r.message).toContain('No affordable liquidity');
    }
  });

  it('classifies unknown transport errors as unknown kind', async () => {
    fx.loop.quoteImpl = async () => {
      throw new Error('socket hang up');
    };
    const r = await fx.manager.quoteLoopOut(500_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown');
  });
});

describe('LiquidityManager — manual execution', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeManager();
  });

  it('derives fee bounds from a fresh quote, journals initiation, and classifies the swap as manual', async () => {
    await fx.manager.start();
    const { swapId, quote } = await fx.manager.executeLoopOut({ amountSat: 500_000, destAddress: 'bcrt1qtest' });
    expect(swapId).toBe('manual-1');
    expect(quote.fees.swapFeeSat).toBe(1_250);
    const req = fx.loop.executeOutCalls[0];
    expect(req?.maxSwapFeeSat).toBe(1_250);
    expect(req?.maxMinerFeeSat).toBe(600); // 2x quoted miner fee
    expect(req?.destAddress).toBe('bcrt1qtest');

    // Manual settlement is journaled but does NOT consume automation budget.
    await fx.manager.handleSwapEvent({
      swapId, direction: 'loop-out', state: 'settled', amountSat: 500_000, costSat: 9_999_999, at: BASE_NOW,
    });
    const entries = await fx.journal.list();
    expect(entries.some((e) => e.kind === 'manual-swap' && e.data?.['phase'] === 'settled')).toBe(true);
    expect(entries.some((e) => e.kind === 'auto-swap')).toBe(false);
  });

  it('refuses execution without a destination address', async () => {
    await expect(fx.manager.executeLoopOut({ amountSat: 1, destAddress: ' ' })).rejects.toThrow(/destination address/i);
  });

  it('refuses execution when the fresh quote fails', async () => {
    fx.loop.quoteImpl = async () => {
      throw new LiquidityProviderError('out-of-terms', 'too small');
    };
    await expect(fx.manager.executeLoopOut({ amountSat: 1, destAddress: 'bcrt1q' })).rejects.toThrow(/Loop Out/);
    expect(fx.loop.executeOutCalls).toHaveLength(0);
  });
});

describe('LiquidityManager — automation budget enforcement', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeManager();
  });

  it('keeps automation enabled when a settled auto swap is within all caps', async () => {
    await fx.manager.enableAutoLoop(policy);
    await fx.manager.handleSwapEvent({
      swapId: 'auto-1', direction: 'loop-out', state: 'settled', amountSat: 500_000, costSat: 4_500, at: BASE_NOW,
    });
    expect(fx.manager.isAutoLoopEnabled()).toBe(true);
    const entries = await fx.journal.list();
    expect(entries.some((e) => e.kind === 'auto-swap' && e.data?.['costSat'] === 4_500)).toBe(true);
    expect(entries.some((e) => e.kind === 'budget-block')).toBe(false);
  });

  it('disables automation and journals a budget-block when realized cost exceeds the per-action cap', async () => {
    await fx.manager.enableAutoLoop(policy);
    await fx.manager.handleSwapEvent({
      swapId: 'auto-2', direction: 'loop-out', state: 'settled', amountSat: 500_000, costSat: 12_000, at: BASE_NOW,
    });
    expect(fx.manager.isAutoLoopEnabled()).toBe(false);
    const last = fx.loop.paramsWrites.at(-1);
    expect(last?.autoloopEnabled).toBe(false);
    const entries = await fx.journal.list();
    const block = entries.find((e) => e.kind === 'budget-block');
    expect(block).toBeDefined();
    expect(block?.data?.['reason']).toBe('per-action-cap');
    expect(block?.data?.['costSat']).toBe(12_000);
  });

  it('disables automation when settled auto swaps exhaust the daily budget', async () => {
    await fx.manager.enableAutoLoop(policy);
    // Pre-existing journal: 46,000 sats already spent today on automation.
    await fx.journal.append(
      autoSettled({ swapId: 'earlier', direction: 'loop-in', state: 'settled', amountSat: 300_000, costSat: 46_000, at: BASE_NOW - 3_600_000 }),
    );
    // This swap fits within the per-action cap but busts the daily budget.
    await fx.manager.handleSwapEvent({
      swapId: 'auto-3', direction: 'loop-out', state: 'settled', amountSat: 500_000, costSat: 5_000, at: BASE_NOW,
    });
    expect(fx.manager.isAutoLoopEnabled()).toBe(false);
    const block = (await fx.journal.list()).find((e) => e.kind === 'budget-block');
    expect(block?.data?.['reason']).toBe('daily-budget-exhausted');
  });

  it('failed auto swaps count their realized cost toward the budget', async () => {
    await fx.manager.enableAutoLoop(policy);
    await fx.journal.append(
      autoSettled({ swapId: 'earlier', direction: 'loop-in', state: 'settled', amountSat: 300_000, costSat: 48_000, at: BASE_NOW - 3_600_000 }),
    );
    await fx.manager.handleSwapEvent({
      swapId: 'auto-4', direction: 'loop-out', state: 'failed', amountSat: 500_000, costSat: 3_000, at: BASE_NOW,
    });
    expect(fx.manager.isAutoLoopEnabled()).toBe(false);
    const block = (await fx.journal.list()).find((e) => e.kind === 'budget-block');
    expect(block?.data?.['reason']).toBe('daily-budget-exhausted');
  });

  it('ignores non-terminal swap updates', async () => {
    await fx.manager.enableAutoLoop(policy);
    await fx.manager.handleSwapEvent({
      swapId: 'auto-5', direction: 'loop-out', state: 'htlc-published', amountSat: 500_000, costSat: 0, at: BASE_NOW,
    });
    expect(await fx.journal.list()).toHaveLength(1); // only the enable policy-change entry
  });

  it('restores manual classification from the journal after a restart', async () => {
    // First manager: manual swap initiated, then a simulated crash.
    await fx.manager.start();
    const { swapId } = await fx.manager.executeLoopOut({ amountSat: 500_000, destAddress: 'bcrt1qtest' });

    // Second manager over the same journal (the restart case).
    const restart: Fixture = makeManager(fx.journal);
    await restart.manager.start();
    await restart.manager.enableAutoLoop(policy);
    // The swap settles AFTER the restart — it must still be counted manual.
    await restart.manager.handleSwapEvent({
      swapId, direction: 'loop-out', state: 'settled', amountSat: 500_000, costSat: 9_999_999, at: BASE_NOW,
    });
    const entries = await fx.journal.list();
    expect(entries.some((e) => e.kind === 'manual-swap' && e.data?.['swapId'] === swapId && e.data?.['phase'] === 'settled')).toBe(true);
    expect(entries.some((e) => e.kind === 'auto-swap')).toBe(false);
    expect(restart.manager.isAutoLoopEnabled()).toBe(true); // manual cost never triggers budget enforcement
  });
});

describe('LiquidityManager — Pool market states', () => {
  it('reports the thin market and available market as first-class states', async () => {
    const thin = new LiquidityManager({ loop: new FakeLoopPort(), pool: emptyMarketPool, journal: new MemoryLiquidityJournal(), newId: () => 'x', now: () => BASE_NOW });
    expect((await thin.poolMarket()).state).toBe('thin');

    const live = new LiquidityManager({ loop: new FakeLoopPort(), pool: liveMarketPool, journal: new MemoryLiquidityJournal(), newId: () => 'x', now: () => BASE_NOW });
    const liveState = await live.poolMarket();
    expect(liveState.state).toBe('available');
    expect(liveState.leasedVolumeSat).toBe(8_000_000);
  });

  it('reports an unreachable auctioneer as unavailable instead of throwing', async () => {
    const mgr = new LiquidityManager({ loop: new FakeLoopPort(), pool: unavailablePool, journal: new MemoryLiquidityJournal(), newId: () => 'x', now: () => BASE_NOW });
    const state = await mgr.poolMarket();
    expect(state.state).toBe('unavailable');
    expect(state.message).toContain('not reachable');
  });
});

describe('LiquidityManager — event subscription', () => {
  it('routes settled updates through the subscription into journaling', async () => {
    const fx = makeManager();
    await fx.manager.start();
    fx.loop.emit({ swapId: 'auto-6', direction: 'loop-out', state: 'settled', amountSat: 100_000, costSat: 250, at: BASE_NOW });
    // handleSwapEvent is invoked void — flush the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    const entries = await fx.journal.list();
    expect(entries.some((e) => e.kind === 'auto-swap' && e.data?.['swapId'] === 'auto-6')).toBe(true);
    fx.manager.stop();
  });

  it('passes through listSwaps', async () => {
    const fx = makeManager();
    fx.loop.swaps.push({ swapId: 's1', direction: 'loop-in', state: 'initiated', amountSat: 1, costSat: 0, at: BASE_NOW });
    await expect(fx.manager.listSwaps()).resolves.toHaveLength(1);
  });
});
