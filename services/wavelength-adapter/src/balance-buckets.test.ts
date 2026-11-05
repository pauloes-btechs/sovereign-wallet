import { describe, expect, it } from 'vitest';
import { bucketsFromWireBalance } from './provider.js';
import type { WireBalance } from './sdk/gateway-client.js';

const wire = (o: Partial<WireBalance>): WireBalance => ({
  boardingConfirmedSat: 0,
  boardingUnconfirmedSat: 0,
  vtxoBalanceSat: 0,
  totalConfirmedSat: 0,
  onchainWalletConfirmedSat: 0,
  boardingPendingSweepSat: 0,
  boardingSweptSat: 0,
  boardingAdoptedSat: 0,
  vtxoPendingSat: 0,
  vtxoUnilateralExitSat: 0,
  assetBalances: [],
  ...o,
});

describe('bucketsFromWireBalance', () => {
  it('keeps on-chain and boarding funds out of Lightning-spendable', () => {
    const b = bucketsFromWireBalance(
      wire({ onchainWalletConfirmedSat: 40_000, boardingConfirmedSat: 10_000, boardingUnconfirmedSat: 5_000, vtxoBalanceSat: 100_000, totalConfirmedSat: 150_000 }),
      0n,
    );
    expect(b).toEqual({
      onchainConfirmedSat: 50_000n,
      onchainPendingSat: 5_000n,
      lightningSpendableSat: 100_000n,
      lightningPendingSat: 0n,
      lockedOrExpiringSat: 0n,
    });
  });

  it('moves expiring VTXOs out of spendable (never counted twice) and adds unilateral exits', () => {
    const b = bucketsFromWireBalance(wire({ vtxoBalanceSat: 100_000, vtxoUnilateralExitSat: 7_000, vtxoPendingSat: 2_000 }), 30_000n);
    expect(b.lightningSpendableSat).toBe(70_000n);
    expect(b.lockedOrExpiringSat).toBe(37_000n);
    expect(b.lightningPendingSat).toBe(2_000n);
  });

  it('clamps an over-reported expiring amount to the VTXO balance', () => {
    const b = bucketsFromWireBalance(wire({ vtxoBalanceSat: 10_000 }), 50_000n);
    expect(b.lightningSpendableSat).toBe(0n);
    expect(b.lockedOrExpiringSat).toBe(10_000n);
  });
});
