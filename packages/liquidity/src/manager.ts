/**
 * LiquidityManager — the engine over litd's bundled Loop/Pool sub-servers.
 *
 * Division of enforcement (documented, not accidental):
 *  - loopd's LiquidityParams are the PREVENTIVE knobs (per-swap fee caps,
 *    budget window) applied inside the daemon before it dispatches.
 *  - This manager adds the REACTIVE layer: every settled automated swap is
 *    journaled with its realized cost; when realized cost breaches the
 *    per-action cap or the daily/monthly budgets, automation is disabled
 *    immediately and a `budget-block` entry is journaled.
 *  - Automation is disabled by default: the ONLY path that turns AutoLoop on
 *    is `enableAutoLoop` with an explicit, validated budget policy.
 */

import {
  checkAutoLoopBudget,
  swapUpdateToEntry,
  validateAutoLoopBudgetPolicy,
  type AutoLoopBudgetPolicy,
} from './budgets.js';
import { isLiquidityProviderError, type LiquidityProviderFailureKind } from './errors.js';
import type { LiquidityJournal, LiquidityJournalEntry } from './journal.js';
import type { LoopPort, PoolPort } from './ports.js';
import { classifyPoolMarket, type PoolMarketSnapshot } from './pool.js';
import {
  assessChannelLiquidity,
  describeQuote,
  describeQuoteFailure,
  type ChannelLiquiditySummary,
  type LiquidityRecommendation,
  type LiquidityThresholds,
} from './quote.js';
import type { AutoLoopParams, LoopQuote, SwapUpdate } from './types.js';

export interface LiquidityManagerDeps {
  loop: LoopPort;
  pool: PoolPort;
  journal: LiquidityJournal;
  /** Id source for journal entries (UUIDv4 in production). Required. */
  newId: () => string;
  /** Wall clock, epoch ms. Defaults to Date.now; injected for tests. */
  now?: () => number;
}

export interface EnableAutoLoopOptions {
  /** Server-fee bound in ppm of swap amount. Default 2500 (0.25%). */
  maxSwapFeePpm?: number;
  /** On-chain sweep fee ceiling, sat/vB. Default 30 — the app's
   * conservative default; loopd rejects params that set neither this nor
   * the deprecated flat fee ppm ("set either fee ppm, or individual fee
   * categories" — observed against the pinned binary). */
  sweepFeeRateSatPerVbyte?: number;
  /** Per-swap miner-fee bound. Default: the per-action cap. */
  maxMinerFeeSat?: number;
  /** Per-swap prepay bound. Default: min(per-action cap, 5,000 sats). */
  maxPrepaySat?: number;
  /** Sweep confirmation target. Default 6. */
  sweepConfTarget?: number;
  /** Backoff after a failed swap, seconds. Default 3600. */
  failureBackoffSec?: number;
  /** loopd budget-window start, epoch seconds. Default: now. */
  budgetStartSec?: number;
}

export type QuoteResult =
  | { ok: true; quote: LoopQuote; message: string }
  | { ok: false; reason: LiquidityProviderFailureKind; message: string };

export interface ExecuteLoopOutOptions {
  amountSat: number;
  destAddress: string;
  /** Fee bounds; when omitted they are derived from a fresh quote. */
  maxSwapFeeSat?: number;
  maxMinerFeeSat?: number;
  sweepConfTarget?: number;
}

export interface ExecuteLoopInOptions {
  amountSat: number;
  maxSwapFeeSat?: number;
  maxMinerFeeSat?: number;
  lastHopPubkeyHex?: string;
}

/** Margin applied to quoted fees when deriving execution bounds. */
const FEE_BOUND_MARGIN = 2;

export class LiquidityManager {
  private readonly loop: LoopPort;
  private readonly pool: PoolPort;
  private readonly journal: LiquidityJournal;
  private readonly newId: () => string;
  private readonly now: () => number;

  private policy: AutoLoopBudgetPolicy | null = null;
  /** Swap ids this manager initiated manually — everything else is automation. */
  private readonly manualSwapIds = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(deps: LiquidityManagerDeps) {
    this.loop = deps.loop;
    this.pool = deps.pool;
    this.journal = deps.journal;
    this.newId = deps.newId;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Start observing swap events. Restores manual-swap classification from
   * the journal first — swap ids recorded as manual before a restart stay
   * manual, so automation accounting never absorbs a crash-interrupted
   * user swap. Call once per manager lifetime.
   */
  async start(): Promise<void> {
    if (this.unsubscribe !== null) return;
    for (const entry of await this.journal.list()) {
      if (entry.kind !== 'manual-swap') continue;
      const swapId = entry.data?.['swapId'];
      if (typeof swapId === 'string' && entry.data?.['phase'] === 'initiated') {
        this.manualSwapIds.add(swapId);
      }
    }
    this.unsubscribe = this.loop.onSwapEvent((update) => {
      void this.handleSwapEvent(update);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  isAutoLoopEnabled(): boolean {
    return this.policy !== null;
  }

  /** The active policy, if automation was enabled in this session. */
  getBudgetPolicy(): AutoLoopBudgetPolicy | null {
    return this.policy;
  }

  /**
   * Explicit opt-in: validates the policy, writes AutoLoop params to the
   * daemon (autoloop on, loopd budget = the monthly cap), and journals the
   * change. Refuses to double-enable.
   */
  async enableAutoLoop(policy: AutoLoopBudgetPolicy, opts: EnableAutoLoopOptions = {}): Promise<void> {
    if (this.policy !== null) {
      throw new Error('AutoLoop is already enabled — disable it first to change the policy.');
    }
    validateAutoLoopBudgetPolicy(policy);

    const nowMs = this.now();
    const params: AutoLoopParams = {
      autoloopEnabled: true,
      budgetSat: policy.monthlyBudgetSat,
      budgetStartSec: opts.budgetStartSec ?? Math.floor(nowMs / 1000),
      maxSwapFeePpm: opts.maxSwapFeePpm ?? 2500,
      sweepFeeRateSatPerVbyte: opts.sweepFeeRateSatPerVbyte ?? 30,
      maxMinerFeeSat: opts.maxMinerFeeSat ?? policy.perActionCapSat,
      maxPrepaySat: opts.maxPrepaySat ?? Math.min(policy.perActionCapSat, 5_000),
      sweepConfTarget: opts.sweepConfTarget ?? 6,
      failureBackoffSec: opts.failureBackoffSec ?? 3600,
    };
    await this.loop.setAutoLoopParams(params);
    this.policy = policy;
    await this.journal.append(this.entry('policy-change', 'AutoLoop enabled with budget policy', {
      action: 'enable',
      perActionCapSat: policy.perActionCapSat,
      dailyBudgetSat: policy.dailyBudgetSat,
      monthlyBudgetSat: policy.monthlyBudgetSat,
      maxSwapFeePpm: params.maxSwapFeePpm,
      sweepFeeRateSatPerVbyte: params.sweepFeeRateSatPerVbyte,
      maxMinerFeeSat: params.maxMinerFeeSat,
      maxPrepaySat: params.maxPrepaySat,
    }));
  }

  /** Turn automation off and journal why. Idempotent. */
  async disableAutoLoop(reason: string): Promise<void> {
    if (this.policy === null) return;
    this.policy = null;
    try {
      const current = await this.loop.getAutoLoopParams();
      if (current !== null && current.autoloopEnabled) {
        await this.loop.setAutoLoopParams({ ...current, autoloopEnabled: false });
      }
    } catch (err) {
      // Params write failing must not lose the disable record — the journal
      // entry below is the durable state; the daemon flag is reconciled by
      // the next enable/disable call.
      await this.journal.append(
        this.entry('policy-change', `AutoLoop disable recorded; daemon update failed: ${stringify(err)}`, {
          action: 'disable-daemon-error',
          reason,
        }),
      );
      return;
    }
    await this.journal.append(this.entry('policy-change', `AutoLoop disabled: ${reason}`, { action: 'disable', reason }));
  }

  /**
   * Fetch a live Loop Out quote. Provider failures become classified,
   * user-renderable results — never thrown.
   */
  async quoteLoopOut(amountSat: number, confTarget?: number): Promise<QuoteResult> {
    return this.quote('loop-out', amountSat, confTarget);
  }

  /** Fetch a live Loop In quote. */
  async quoteLoopIn(amountSat: number, confTarget?: number): Promise<QuoteResult> {
    return this.quote('loop-in', amountSat, confTarget);
  }

  /**
   * Execute a Loop Out swap. Fee bounds are enforced at authorization: a
   * fresh quote is taken and its fees (with margin) become the hard max the
   * daemon may consume — unless the caller pins tighter bounds explicitly.
   */
  async executeLoopOut(opts: ExecuteLoopOutOptions): Promise<{ swapId: string; quote: LoopQuote }> {
    if (opts.destAddress.trim() === '') {
      throw new Error('A destination address is required for Loop Out.');
    }
    const result = await this.quote('loop-out', opts.amountSat, opts.sweepConfTarget);
    if (!result.ok) {
      throw new Error(`Cannot execute a Loop Out: ${result.message}`);
    }
    const quote = result.quote;
    const maxSwapFeeSat = opts.maxSwapFeeSat ?? quote.fees.swapFeeSat;
    const maxMinerFeeSat = opts.maxMinerFeeSat ?? quote.fees.minerFeeSat * FEE_BOUND_MARGIN;
    const { swapId } = await this.loop.executeLoopOut({
      amountSat: opts.amountSat,
      destAddress: opts.destAddress,
      maxSwapFeeSat,
      maxMinerFeeSat,
      sweepConfTarget: opts.sweepConfTarget,
    });
    this.manualSwapIds.add(swapId);
    await this.journal.append(this.entry('manual-swap', `Loop Out of ${opts.amountSat} sats initiated`, {
      phase: 'initiated',
      swapId,
      direction: 'loop-out',
      amountSat: opts.amountSat,
      maxSwapFeeSat,
      maxMinerFeeSat,
    }));
    return { swapId, quote };
  }

  /** Execute a Loop In swap (on-chain funds -> new inbound capacity). */
  async executeLoopIn(opts: ExecuteLoopInOptions): Promise<{ swapId: string; quote: LoopQuote }> {
    const result = await this.quote('loop-in', opts.amountSat);
    if (!result.ok) {
      throw new Error(`Cannot execute a Loop In: ${result.message}`);
    }
    const quote = result.quote;
    const maxSwapFeeSat = opts.maxSwapFeeSat ?? quote.fees.swapFeeSat;
    const maxMinerFeeSat = opts.maxMinerFeeSat ?? quote.fees.minerFeeSat * FEE_BOUND_MARGIN;
    const { swapId } = await this.loop.executeLoopIn({
      amountSat: opts.amountSat,
      maxSwapFeeSat,
      maxMinerFeeSat,
      lastHopPubkeyHex: opts.lastHopPubkeyHex,
    });
    this.manualSwapIds.add(swapId);
    await this.journal.append(this.entry('manual-swap', `Loop In of ${opts.amountSat} sats initiated`, {
      phase: 'initiated',
      swapId,
      direction: 'loop-in',
      amountSat: opts.amountSat,
      maxSwapFeeSat,
      maxMinerFeeSat,
    }));
    return { swapId, quote };
  }

  /**
   * Pool market state as a first-class value: 'unavailable' (auctioneer not
   * reachable), 'thin' (reachable, no matched markets), or 'available'.
   */
  async poolMarket(): Promise<PoolMarketSnapshot> {
    try {
      const raw = await this.pool.marketRaw();
      return classifyPoolMarket(raw);
    } catch (err) {
      return classifyPoolMarket({ error: err });
    }
  }

  /** Channel-liquidity recommendation from live aggregates and floors. */
  assessChannels(channels: ChannelLiquiditySummary, thresholds: LiquidityThresholds): LiquidityRecommendation {
    return assessChannelLiquidity(channels, thresholds);
  }

  /** Swap history as the daemon sees it (manual + automated). */
  listSwaps(): Promise<SwapUpdate[]> {
    return this.loop.listSwaps();
  }

  /**
   * Handle one swap lifecycle update. Settled/failed swaps are journaled;
   * automated ones additionally trigger budget enforcement — a breach
   * disables automation immediately and journals a budget-block.
   */
  async handleSwapEvent(update: Readonly<SwapUpdate>): Promise<void> {
    if (update.state !== 'settled' && update.state !== 'failed') return;
    const isManual = this.manualSwapIds.has(update.swapId);
    await this.journal.append(swapUpdateToEntry(update, !isManual, this.newId));

    if (isManual || this.policy === null) return;

    // Automation governance — realized-cost enforcement.
    const perActionCapSat = this.policy.perActionCapSat;
    const entries = await this.journal.list();
    const perActionBreach = update.costSat > perActionCapSat;
    const budget = checkAutoLoopBudget(this.policy, entries, this.now(), 0);
    if (perActionBreach || !budget.allowed) {
      const reason = perActionBreach
        ? `Automated swap ${update.swapId} cost ${update.costSat} sats, above the per-action cap of ${perActionCapSat} sats.`
        : (budget.message ?? 'Budget exhausted.');
      await this.disableAutoLoop(reason);
      await this.journal.append(
        this.entry('budget-block', `AutoLoop disabled by budget policy: ${reason}`, {
          reason: perActionBreach ? 'per-action-cap' : (budget.reason ?? 'unknown'),
          swapId: update.swapId,
          costSat: update.costSat,
          perActionCapSat,
        }),
      );
    }
  }

  private async quote(direction: 'loop-out' | 'loop-in', amountSat: number, confTarget?: number): Promise<QuoteResult> {
    try {
      const quote =
        direction === 'loop-out' ? await this.loop.loopOutQuote(amountSat, confTarget) : await this.loop.loopInQuote(amountSat, confTarget);
      await this.journal.append(this.entry('quote', describeQuote(quote), {
        phase: 'quoted',
        direction,
        amountSat,
        totalFeeSat: quote.fees.totalSat,
      }));
      return { ok: true, quote, message: describeQuote(quote) };
    } catch (err) {
      const kind = this.classifyFailure(err);
      await this.journal.append(this.entry('quote', `Quote failed (${kind}): ${stringify(err)}`, {
        phase: 'failed',
        direction,
        amountSat,
        errorKind: kind,
      }));
      return { ok: false, reason: kind, message: describeQuoteFailure(kind).message };
    }
  }

  private classifyFailure(err: unknown): LiquidityProviderFailureKind {
    return isLiquidityProviderError(err) ? err.kind : 'unknown';
  }

  private entry(kind: LiquidityJournalEntry['kind'], message: string, data: LiquidityJournalEntry['data']): LiquidityJournalEntry {
    return { id: this.newId(), at: new Date(this.now()).toISOString(), kind, message, data };
  }
}

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
