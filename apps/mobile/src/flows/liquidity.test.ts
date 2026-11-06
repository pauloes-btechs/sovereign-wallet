import { describe, expect, it } from 'vitest';
import type { RemoteChannelSummary } from './modeBRemoteController.js';
import type { RemoteChannelDetail } from './liquidity.js';
import {
  clampToTerms,
  liquidityAdvice,
  liquidityAttention,
  receiveCapacityWarning,
  sendCapacityWarning,
  summarizeChannels,
  wavelengthAvailability,
} from './liquidity.js';
import type { RemoteSwap } from './transfers.js';

const ch = (chanId: string, localSat: bigint, remoteSat: bigint, active = true): RemoteChannelSummary => ({
  chanId,
  active,
  localSat,
  remoteSat,
  capacitySat: localSat + remoteSat,
});

const terms = { loopOut: { minSat: 100_000n, maxSat: 2_000_000n }, loopIn: { minSat: 100_000n, maxSat: 2_000_000n } };

describe('channel liquidity', () => {
  it('spendable = your side, receivable = the peers’ side, active channels only', () => {
    const l = summarizeChannels([ch('a', 400_000n, 100_000n), ch('b', 50_000n, 450_000n), ch('c', 300_000n, 300_000n, false)]);
    expect(l.spendableSat).toBe(450_000n);
    expect(l.receivableSat).toBe(550_000n);
    expect(l.largestReceiveSat).toBe(450_000n);
    expect(l.activeChannels).toBe(2);
    expect(l.inactiveChannels).toBe(1);
    expect(l.reservesApplied).toBe(false);
  });

  it('subtracts channel reserves when the node reports them', () => {
    const detail: RemoteChannelDetail = {
      ...ch('a', 400_000n, 100_000n),
      remotePubkey: `02${'ab'.repeat(32)}`,
      peerAlias: 'peer',
      localReserveSat: 5_000n,
      remoteReserveSat: 5_000n,
      private: false,
    };
    const l = summarizeChannels([detail]);
    expect(l.spendableSat).toBe(395_000n);
    expect(l.receivableSat).toBe(95_000n);
    expect(l.reservesApplied).toBe(true);
    expect(l.channels[0]?.label).toBe('peer');
  });
});

describe('recommendations use the correct Loop direction', () => {
  it('low RECEIVING capacity → Loop Out (more inbound)', () => {
    const l = summarizeChannels([ch('a', 1_500_000n, 100_000n)]);
    const advice = liquidityAdvice(l, { onchainSat: 0n, loopAvailable: true, terms });
    expect(advice.kind).toBe('receive-low');
    expect(advice.action?.direction).toBe('loop-out');
    expect(advice.action?.label).toBe('Loop Out to receive more');
    // Toward half-and-half: (1.6M / 2) − 100k = 700k.
    expect(advice.action?.amountSat).toBe(700_000n);
  });

  it('low SENDING capacity → Loop In (more outbound), sized by on-chain funds', () => {
    const l = summarizeChannels([ch('a', 50_000n, 1_000_000n)]);
    const advice = liquidityAdvice(l, { onchainSat: 300_000n, loopAvailable: true, terms });
    expect(advice.kind).toBe('send-low');
    expect(advice.action?.direction).toBe('loop-in');
    expect(advice.action?.amountSat).toBe(300_000n);
  });

  it('no action when Loop is unavailable — the reason is shown instead', () => {
    const l = summarizeChannels([ch('a', 1_500_000n, 100_000n)]);
    const advice = liquidityAdvice(l, { onchainSat: 0n, loopAvailable: false, loopUnavailableReason: 'No Loop here.', terms: null });
    expect(advice.action).toBeNull();
    expect(advice.actionUnavailable).toBe('No Loop here.');
  });

  it('healthy, no channels, all inactive', () => {
    expect(liquidityAdvice(summarizeChannels([ch('a', 500_000n, 500_000n)]), { onchainSat: 0n, loopAvailable: true, terms }).kind).toBe('healthy');
    expect(liquidityAdvice(summarizeChannels([]), { onchainSat: 0n, loopAvailable: true, terms }).kind).toBe('no-channels');
    expect(liquidityAdvice(summarizeChannels([ch('a', 1n, 1n, false)]), { onchainSat: 0n, loopAvailable: true, terms }).kind).toBe('all-inactive');
  });

  it('clamps to the source and terms; below the minimum offers nothing', () => {
    expect(clampToTerms(5_000_000n, 3_000_000n, terms.loopOut)).toBe(2_000_000n);
    expect(clampToTerms(20_000n, 500_000n, terms.loopOut)).toBe(100_000n);
    expect(clampToTerms(20_000n, 50_000n, terms.loopOut)).toBeNull();
  });
});

describe('payment warnings', () => {
  const l = summarizeChannels([ch('a', 200_000n, 30_000n), ch('b', 100_000n, 40_000n)]);
  it('receiving', () => {
    expect(receiveCapacityWarning(l, 10_000n)).toBeNull();
    expect(receiveCapacityWarning(l, 100_000n)).toBe(
      'Your wallet currently has insufficient receiving capacity for this payment: it can receive up to 70,000 sats.',
    );
    expect(receiveCapacityWarning(l, 50_000n)).toMatch(/No single channel can receive 50,000 sats/);
  });
  it('sending', () => {
    expect(sendCapacityWarning(l, 300_000n)).toBeNull();
    expect(sendCapacityWarning(l, 300_001n)).toMatch(/insufficient sending capacity/);
  });
});

describe('contextual attention for Home', () => {
  const swap: RemoteSwap = {
    id: 'ab'.repeat(32),
    direction: 'loop-out',
    state: 'htlc-published',
    failureReason: null,
    amountSat: 250_000n,
    costServerSat: 0n,
    costOnchainSat: 0n,
    costOffchainSat: 0n,
    htlcAddress: null,
    initiatedAt: '2026-11-05T12:00:00Z',
    updatedAt: '2026-11-05T12:00:04Z',
    label: null,
  };
  it('a pending swap links to its progress first', () => {
    expect(liquidityAttention(null, [swap])).toEqual({
      kind: 'pending-swap',
      message: 'Loop Out of 250,000 sats in progress',
      route: 'swap',
      params: { id: swap.id },
    });
  });
  it('then a liquidity problem; nothing when healthy', () => {
    const low = { lightningSpendableSat: 1_000_000n, onchainConfirmedSat: 0n, channels: [ch('a', 1_000_000n, 10_000n)] };
    expect(liquidityAttention(low, [{ ...swap, state: 'succeeded' }])).toMatchObject({ kind: 'liquidity', route: 'liquidity' });
    const ok = { lightningSpendableSat: 500_000n, onchainConfirmedSat: 0n, channels: [ch('a', 500_000n, 500_000n)] };
    expect(liquidityAttention(ok, [])).toBeNull();
  });
});

describe('Wavelength availability (no channels)', () => {
  it('reports its own buckets and notes, never channel balances', () => {
    const a = wavelengthAvailability(
      { lightningSpendableSat: 80_000n, lightningPendingSat: 2_000n, onchainConfirmedSat: 10_000n, onchainPendingSat: 0n, lockedOrExpiringSat: 5_000n },
      { state: 'expiring', operatorReachable: true, hoursToExpiry: 12 },
    );
    expect(a.spendableSat).toBe(80_000n);
    expect(a.onchainSat).toBe(10_000n);
    expect(a.notes.join(' ')).toMatch(/expires in about 12 h/);
    expect(a.notes.join(' ')).toMatch(/On-chain deposits become spendable/);
  });
});
