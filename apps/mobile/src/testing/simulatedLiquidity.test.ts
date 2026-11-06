import { describe, expect, it } from 'vitest';
import { loopInFeeLimits, loopOutFeeLimits } from '../flows/transfers.js';
import type { RemoteSwapState } from '../flows/transfers.js';
import {
  SIM_LOOP,
  SimulatedLiquidityNode,
  decodeSimulatedAssetAddress,
  simulatedAssetAddress,
} from './simulatedLiquidity.js';

const T0 = Date.parse('2026-11-05T12:00:00Z');

function node() {
  let now = T0;
  const sim = new SimulatedLiquidityNode(() => now);
  return { sim, at: (ms: number) => (now = T0 + ms) };
}

const statesOver = (sim: SimulatedLiquidityNode, id: string, at: (ms: number) => number, times: readonly number[]): RemoteSwapState[] =>
  times.map((t) => {
    at(t);
    return sim.swapStatus(id).state;
  });

describe('simulated Loop server', () => {
  it('quotes from its stated terms', () => {
    const { sim } = node();
    const q = sim.quote('loop-out', 400_000n);
    expect(q.swapFeeSat).toBe(SIM_LOOP.swapFeeBaseSat + (400_000n * SIM_LOOP.swapFeePpm) / 1_000_000n);
    expect(q.prepayAmtSat).toBe(SIM_LOOP.prepayAmtSat);
    expect(q.minerFeeSat).toBe(SIM_LOOP.feeRateSatPerVbyte * SIM_LOOP.sweepVbytes);
    expect(() => sim.quote('loop-in', 10n)).toThrow(/out of the swap server's range/);
  });

  it('Loop Out passes through every state over time, never instantly', () => {
    const { sim, at } = node();
    const before = sim.balances();
    const q = sim.quote('loop-out', 400_000n);
    const { swapId } = sim.loopOut({ amountSat: 400_000n, destAddress: null, sweepConfTarget: 9, label: 't', ...loopOutFeeLimits(q) });
    expect(sim.swapStatus(swapId).state).toBe('initiated');
    expect(statesOver(sim, swapId, at, [1_000, 4_000, 9_000, 14_999, 15_000])).toEqual([
      'initiated',
      'htlc-published',
      'preimage-revealed',
      'preimage-revealed',
      'succeeded',
    ]);
    const after = sim.balances();
    const swap = sim.swapStatus(swapId);
    expect(after.onchainConfirmedSat - before.onchainConfirmedSat).toBe(400_000n - q.swapFeeSat - q.minerFeeSat);
    expect(before.lightningSpendableSat - after.lightningSpendableSat).toBe(400_000n + swap.costOffchainSat);
    expect(swap.costServerSat).toBe(q.swapFeeSat);
    expect(swap.costOnchainSat).toBe(q.minerFeeSat);
  });

  it('a Loop In no channel has room for times out and refunds on-chain minus the miner fee', () => {
    const { sim, at } = node();
    const before = sim.balances();
    const q = sim.quote('loop-in', 200_000n);
    const { swapId } = sim.loopIn({ amountSat: 200_000n, label: 't', ...loopInFeeLimits(q) });
    expect(statesOver(sim, swapId, at, [0, 4_000, 10_000])).toEqual(['initiated', 'htlc-published', 'failed']);
    expect(sim.swapStatus(swapId).failureReason).toBe('timeout');
    expect(before.onchainConfirmedSat - sim.balances().onchainConfirmedSat).toBe(q.minerFeeSat);
  });

  it('after a Loop Out makes room, a Loop In moves on-chain funds into a channel', () => {
    const { sim, at } = node();
    const qo = sim.quote('loop-out', 700_000n);
    sim.loopOut({ amountSat: 700_000n, destAddress: null, sweepConfTarget: 9, label: 't', ...loopOutFeeLimits(qo) });
    at(15_000);
    const before = sim.balances();
    const q = sim.quote('loop-in', 200_000n);
    const { swapId } = sim.loopIn({ amountSat: 200_000n, label: 't', ...loopInFeeLimits(q) });
    expect(statesOver(sim, swapId, (ms) => at(15_000 + ms), [0, 4_000, 10_000, 15_000])).toEqual([
      'initiated',
      'htlc-published',
      'invoice-settled',
      'succeeded',
    ]);
    const after = sim.balances();
    expect(before.onchainConfirmedSat - after.onchainConfirmedSat).toBe(200_000n + q.minerFeeSat);
    expect(after.lightningSpendableSat - before.lightningSpendableSat).toBe(200_000n - q.swapFeeSat);
  });

  it('refuses to start when the limits sent are below its fees (as loopd)', () => {
    const { sim } = node();
    const q = sim.quote('loop-out', 400_000n);
    expect(() =>
      sim.loopOut({ amountSat: 400_000n, destAddress: null, sweepConfTarget: 9, label: 't', ...loopOutFeeLimits(q), maxPrepayAmtSat: 1n }),
    ).toThrow(/prepay amount too high/);
    expect(sim.listSwaps()).toHaveLength(0);
  });

  it('a Loop Out no single channel can carry fails off-chain, with nothing deducted', () => {
    const { sim, at } = node();
    const before = sim.balances();
    const q = sim.quote('loop-out', 1_500_000n);
    const { swapId } = sim.loopOut({ amountSat: 1_500_000n, destAddress: null, sweepConfTarget: 9, label: 't', ...loopOutFeeLimits(q) });
    at(3_000);
    const swap = sim.swapStatus(swapId);
    expect(swap.state).toBe('failed');
    expect(swap.failureReason).toBe('offchain');
    expect(sim.balances()).toEqual(before);
  });
});

describe('simulated Taproot Assets', () => {
  it('decodes its own address format and rejects others', () => {
    const { sim } = node();
    const asset = sim.listAssets()[0];
    if (asset === undefined) throw new Error('no asset');
    const address = simulatedAssetAddress(asset.assetIdHex, 25n);
    expect(decodeSimulatedAssetAddress(address)).toEqual({ assetIdHex: asset.assetIdHex, amount: 25n, network: 'regtest' });
    expect(() => sim.decodeAssetAddress('taprt1qqqq')).toThrow(/invalid address/);
  });

  it('a send deducts units, pays an anchor fee, then confirms', () => {
    const { sim, at } = node();
    const asset = sim.listAssets()[0];
    if (asset === undefined) throw new Error('no asset');
    const onchain = sim.balances().onchainConfirmedSat;
    const { chainFeeSat } = sim.sendAsset(simulatedAssetAddress(asset.assetIdHex, 100n));
    expect(sim.listAssets()[0]?.balance).toBe(asset.balance - 100n);
    expect(sim.balances().onchainConfirmedSat).toBe(onchain - chainFeeSat);
    expect(sim.assetTransfers()[0]).toMatchObject({ direction: 'out', amount: 100n, status: 'unconfirmed', chainFeeSat });
    at(10_000);
    expect(sim.assetTransfers()[0]?.status).toBe('confirmed');
    expect(() => sim.sendAsset(simulatedAssetAddress(asset.assetIdHex, 10_000_000n))).toThrow(/insufficient asset balance/);
  });
});
