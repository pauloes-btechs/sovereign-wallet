import { describe, expect, it } from 'vitest';

import { LiquidityProviderError } from './errors.js';
import { classifyPoolMarket } from './pool.js';
import { assessChannelLiquidity, describeQuote, feePercent, suggestedSwapAmountSat } from './quote.js';
import type { LoopQuote } from './types.js';

function quote(overrides: Partial<LoopQuote> = {}): LoopQuote {
  return {
    direction: 'loop-out',
    amountSat: 500_000,
    fees: {
      swapFeeSat: 1_250,
      prepayFeeSat: 500,
      minerFeeSat: 300,
      routingFeeSat: 0,
      totalSat: 2_050,
    },
    cltvDelta: 80,
    confTarget: 6,
    swapFeePpm: 2500,
    ...overrides,
  };
}

describe('assessChannelLiquidity', () => {
  const thresholds = { outboundFloorSat: 200_000, inboundFloorSat: 200_000 };

  it('recommends Loop In when there are no channels at all', () => {
    const rec = assessChannelLiquidity({ outboundSat: 0, inboundSat: 0, openChannels: 0 }, thresholds);
    expect(rec.kind).toBe('no-channels');
    expect(rec.suggestedDirection).toBe('loop-in');
    expect(rec.message).toContain('no channels yet');
  });

  it('recommends Loop In with a concrete amount when inbound is below the floor', () => {
    const rec = assessChannelLiquidity({ outboundSat: 900_000, inboundSat: 25_000, openChannels: 1 }, thresholds);
    expect(rec.kind).toBe('inbound-low');
    expect(rec.suggestedDirection).toBe('loop-in');
    expect(rec.suggestedAmountSat).toBe(200_000); // ceil(175k / 100k) * 100k
    expect(rec.message).toContain('25,000 sats');
    expect(rec.message).toContain('200,000 sats');
  });

  it('recommends Loop Out when outbound is below the floor', () => {
    const rec = assessChannelLiquidity({ outboundSat: 10_000, inboundSat: 900_000, openChannels: 1 }, thresholds);
    expect(rec.kind).toBe('outbound-low');
    expect(rec.suggestedDirection).toBe('loop-out');
    expect(rec.suggestedAmountSat).toBe(200_000);
  });

  it('reports healthy with live numbers when both floors are met', () => {
    const rec = assessChannelLiquidity({ outboundSat: 1_000_000, inboundSat: 1_000_000, openChannels: 2 }, thresholds);
    expect(rec.kind).toBe('healthy');
    expect(rec.severity).toBe('info');
    expect(rec.message).toContain('1,000,000 sats sendable');
  });
});

describe('describeQuote', () => {
  it('renders the full cost breakdown with live numbers only', () => {
    const text = describeQuote(quote());
    expect(text).toContain('Loop Out');
    expect(text).toContain('500,000 sats');
    expect(text).toContain('2,050 sats');
    expect(text).toContain('0.4%');
    expect(text).toContain('1,250 sats swap fee');
    expect(text).toContain('500 sats prepay');
  });

  it('omits the prepay line when there is none', () => {
    const text = describeQuote(quote({ direction: 'loop-in', fees: { swapFeeSat: 625, prepayFeeSat: 0, minerFeeSat: 300, routingFeeSat: 0, totalSat: 925 } }));
    expect(text).toContain('Loop In');
    expect(text).not.toContain('prepay');
  });
});

describe('feePercent', () => {
  it('computes one-decimal percent', () => {
    expect(feePercent(2_050, 500_000)).toBe(0.4);
    expect(feePercent(0, 500_000)).toBe(0);
    expect(feePercent(100, 0)).toBe(0);
  });
});

describe('suggestedSwapAmountSat', () => {
  it('rounds the shortfall up to 100k sats', () => {
    expect(suggestedSwapAmountSat(25_000, 200_000)).toBe(200_000);
    expect(suggestedSwapAmountSat(0, 1)).toBe(100_000);
    expect(suggestedSwapAmountSat(300_000, 200_000)).toBe(0);
  });
});

describe('classifyPoolMarket', () => {
  it('classifies a live market as available', () => {
    const s = classifyPoolMarket({ matchedBatches: 3, leasedVolumeSat: 12_000_000 });
    expect(s.state).toBe('available');
    expect(s.message).toContain('3 matched batches');
  });

  it('classifies an empty market as thin — a first-class state, not an error', () => {
    const s = classifyPoolMarket({ matchedBatches: 0 });
    expect(s.state).toBe('thin');
    expect(s.message).toContain('too thin');
  });

  it('classifies a provider failure as unavailable with a plain-language message', () => {
    const s = classifyPoolMarket({ error: new LiquidityProviderError('unavailable', 'auctioneer unreachable') });
    expect(s.state).toBe('unavailable');
    expect(s.message).toContain('not reachable');
  });

  it('maps unknown errors to the unavailable state without throwing', () => {
    const s = classifyPoolMarket({ error: new Error('socket hang up') });
    expect(s.state).toBe('unavailable');
    expect(s.message).toContain('unexpected error');
  });
});
