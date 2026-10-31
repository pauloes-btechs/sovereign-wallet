/**
 * Plain-language liquidity assessment. Pure functions from live numbers to
 * the recommendations the UI renders — the spec's LiquidityManager states
 * (Healthy / Constrained / Thin market) map onto these outputs.
 */

import { describeProviderFailure, type LiquidityProviderFailureKind } from './errors.js';
import type { LoopQuote } from './types.js';

/** Aggregated channel liquidity the node currently has. */
export interface ChannelLiquiditySummary {
  /** Spendable (outbound) satoshis across open channels. */
  outboundSat: number;
  /** Receivable (inbound) satoshis across open channels. */
  inboundSat: number;
  /** Number of open channels. */
  openChannels: number;
}

/** Floors below which the manager recommends action. */
export interface LiquidityThresholds {
  outboundFloorSat: number;
  inboundFloorSat: number;
}

export type RecommendationKind =
  | 'healthy'
  | 'no-channels'
  | 'inbound-low'
  | 'outbound-low'
  | 'no-affordable-quote'
  | 'provider-failure';

export interface LiquidityRecommendation {
  kind: RecommendationKind;
  severity: 'info' | 'notice' | 'warning';
  /** Plain-language message with live numbers — rendered as-is. */
  message: string;
  suggestedDirection?: 'loop-in' | 'loop-out';
  suggestedAmountSat?: number;
}

/**
 * Assess channel liquidity against floors. With no channels at all, Loop In
 * is the bootstrap path (the server opens the first channel to you); low
 * inbound suggests Loop In, low outbound suggests Loop Out.
 */
export function assessChannelLiquidity(
  channels: ChannelLiquiditySummary,
  thresholds: LiquidityThresholds,
): LiquidityRecommendation {
  if (channels.openChannels === 0) {
    return {
      kind: 'no-channels',
      severity: 'notice',
      message:
        'You have no channels yet. A Loop In swap opens your first channel from on-chain funds — you keep the keys.',
      suggestedDirection: 'loop-in',
    };
  }
  if (channels.inboundSat < thresholds.inboundFloorSat) {
    return {
      kind: 'inbound-low',
      severity: 'notice',
      message: `Only ${formatSats(channels.inboundSat)} sats can be received over Lightning. A Loop In swap of about ${formatSats(suggestedSwapAmountSat(channels.inboundSat, thresholds.inboundFloorSat))} sats would raise receiving capacity.`,
      suggestedDirection: 'loop-in',
      suggestedAmountSat: suggestedSwapAmountSat(channels.inboundSat, thresholds.inboundFloorSat),
    };
  }
  if (channels.outboundSat < thresholds.outboundFloorSat) {
    return {
      kind: 'outbound-low',
      severity: 'notice',
      message: `Only ${formatSats(channels.outboundSat)} sats can be sent over Lightning. A Loop Out swap of about ${formatSats(suggestedSwapAmountSat(channels.outboundSat, thresholds.outboundFloorSat))} sats would free up sending capacity.`,
      suggestedDirection: 'loop-out',
      suggestedAmountSat: suggestedSwapAmountSat(channels.outboundSat, thresholds.outboundFloorSat),
    };
  }
  return {
    kind: 'healthy',
    severity: 'info',
    message: `Liquidity is healthy: ${formatSats(channels.outboundSat)} sats sendable, ${formatSats(channels.inboundSat)} sats receivable.`,
  };
}

/** Suggested swap size to close a shortfall, rounded up to 100k sats. */
export function suggestedSwapAmountSat(currentSat: number, floorSat: number): number {
  const shortfall = Math.max(0, floorSat - currentSat);
  return Math.ceil(shortfall / 100_000) * 100_000;
}

/** Percent a total fee is of an amount, one decimal. */
export function feePercent(totalFeeSat: number, amountSat: number): number {
  if (amountSat <= 0) return 0;
  return Math.round((totalFeeSat / amountSat) * 1000) / 10;
}

/** Grouped satoshi formatting for user-facing messages (matches @sovereign/ui). */
export function formatSats(sats: number): string {
  return String(sats).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Plain-language description of a live quote — numbers only from the quote. */
export function describeQuote(quote: Readonly<LoopQuote>): string {
  const pct = feePercent(quote.fees.totalSat, quote.amountSat);
  const directionLabel = quote.direction === 'loop-out' ? 'Loop Out' : 'Loop In';
  return (
    `A ${directionLabel} swap of ${formatSats(quote.amountSat)} sats is estimated to cost ` +
    `${formatSats(quote.fees.totalSat)} sats (${pct}%): ${formatSats(quote.fees.swapFeeSat)} sats swap fee` +
    (quote.fees.prepayFeeSat > 0 ? `, ${formatSats(quote.fees.prepayFeeSat)} sats prepay` : '') +
    `, plus ${formatSats(quote.fees.minerFeeSat)} sats miner fees.`
  );
}

/** Recommendation for a failed quote, from the classified failure kind. */
export function describeQuoteFailure(kind: LiquidityProviderFailureKind): LiquidityRecommendation {
  if (kind === 'no-affordable-quote') {
    return {
      kind: 'no-affordable-quote',
      severity: 'warning',
      message: describeProviderFailure(kind),
    };
  }
  return {
    kind: 'provider-failure',
    severity: 'warning',
    message: describeProviderFailure(kind),
  };
}
