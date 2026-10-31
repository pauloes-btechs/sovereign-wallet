import { describe, expect, it } from 'vitest';

import { Loop, LoopClient, PoolAuctioneer } from '@sovereign/litd-proto';
import { LiquidityProviderError } from '@sovereign/liquidity';

import {
  autoLoopParamsOntoLiquidityParameters,
  mapInQuoteToLoopQuote,
  mapLiquidityParameters,
  mapOutQuoteToLoopQuote,
  mapSwapStatusToSwapUpdate,
  mapSwapState,
  mapTransportError,
  swapTimestampToMs,
} from './loop-client.js';
import { batchSnapshotsToMarketRaw as poolMarketFromSnapshots } from './pool-client.js';

describe('swapTimestampToMs', () => {
  it('treats unix seconds as seconds', () => {
    expect(swapTimestampToMs(1_793_472_000n)).toBe(1_793_472_000_000);
  });

  it('survives a future proto switching to milliseconds or nanoseconds', () => {
    expect(swapTimestampToMs(1_793_472_000_000n)).toBe(1_793_472_000);
  });

  it('falls back to observation time when unset', () => {
    const before = Date.now();
    expect(swapTimestampToMs(0n)).toBeGreaterThanOrEqual(before);
  });
});

describe('mapSwapState', () => {
  it('maps every loopd terminal and progress state', () => {
    expect(mapSwapState(Loop.SwapState.INITIATED)).toBe('initiated');
    expect(mapSwapState(Loop.SwapState.PREIMAGE_REVEALED)).toBe('preimage-revealed');
    expect(mapSwapState(Loop.SwapState.INVOICE_SETTLED)).toBe('invoice-settled');
    expect(mapSwapState(Loop.SwapState.SUCCESS)).toBe('settled');
    expect(mapSwapState(Loop.SwapState.FAILED)).toBe('failed');
  });
});

describe('mapSwapStatusToSwapUpdate', () => {
  it('sums server, on-chain, and off-chain costs into costSat', () => {
    const update = mapSwapStatusToSwapUpdate(
      Loop.SwapStatus.create({
        id: 'abc',
        type: Loop.SwapType.LOOP_OUT,
        state: Loop.SwapState.SUCCESS,
        amt: 500_000n,
        costServer: 1_250n,
        costOnchain: 600n,
        costOffchain: 20n,
        lastUpdateTime: 1_793_472_000n,
      }),
    );
    expect(update.swapId).toBe('abc');
    expect(update.direction).toBe('loop-out');
    expect(update.state).toBe('settled');
    expect(update.amountSat).toBe(500_000);
    expect(update.costSat).toBe(1_870);
    expect(update.at).toBe(1_793_472_000_000);
  });

  it('maps loop-in types (including static) to the loop-in direction', () => {
    expect(
      mapSwapStatusToSwapUpdate(Loop.SwapStatus.create({ type: Loop.SwapType.LOOP_IN })).direction,
    ).toBe('loop-in');
    expect(
      mapSwapStatusToSwapUpdate(Loop.SwapStatus.create({ type: Loop.SwapType.STATIC_LOOP_IN })).direction,
    ).toBe('loop-in');
  });
});

describe('quote mappings', () => {
  it('maps the out quote with prepay and computes ppm', () => {
    const q = mapOutQuoteToLoopQuote(
      Loop.OutQuoteResponse.create({ swapFeeSat: 1_250n, prepayAmtSat: 500n, htlcSweepFeeSat: 300n, cltvDelta: 80, confTarget: 6 }),
      500_000,
    );
    expect(q.direction).toBe('loop-out');
    expect(q.fees).toEqual({ swapFeeSat: 1_250, prepayFeeSat: 500, minerFeeSat: 300, routingFeeSat: 0, totalSat: 2_050 });
    expect(q.swapFeePpm).toBe(2_500);
    expect(q.cltvDelta).toBe(80);
  });

  it('maps the in quote without prepay', () => {
    const q = mapInQuoteToLoopQuote(
      Loop.InQuoteResponse.create({ swapFeeSat: 625n, htlcPublishFeeSat: 300n, cltvDelta: 80, confTarget: 6, quotedAmt: 500_000n }),
      500_000,
    );
    expect(q.direction).toBe('loop-in');
    expect(q.fees).toEqual({ swapFeeSat: 625, prepayFeeSat: 0, minerFeeSat: 300, routingFeeSat: 0, totalSat: 925 });
    expect(q.swapFeePpm).toBe(1_250);
  });
});

describe('mapLiquidityParameters', () => {
  it('maps a zero message to null — nothing configured', () => {
    expect(mapLiquidityParameters(Loop.LiquidityParameters.create({}))).toBeNull();
  });

  it('maps configured params to the engine shape', () => {
    const params = mapLiquidityParameters(
      Loop.LiquidityParameters.create({
        autoloop: true,
        autoloopBudgetSat: 150_000n,
        autoloopBudgetStartSec: 1_793_472_000n,
        maxSwapFeePpm: 2_500n,
        sweepFeeRateSatPerVbyte: 30n,
        maxMinerFeeSat: 10_000n,
        maxPrepaySat: 5_000n,
        sweepConfTarget: 6,
        failureBackoffSec: 3_600n,
      }),
    );
    expect(params).toEqual({
      autoloopEnabled: true,
      budgetSat: 150_000,
      budgetStartSec: 1_793_472_000,
      maxSwapFeePpm: 2_500,
      sweepFeeRateSatPerVbyte: 30,
      maxMinerFeeSat: 10_000,
      maxPrepaySat: 5_000,
      sweepConfTarget: 6,
      failureBackoffSec: 3_600,
    });
  });
});

describe('autoLoopParamsOntoLiquidityParameters', () => {
  it('writes engine knobs over the daemon params and preserves rules', () => {
    const current = Loop.LiquidityParameters.create({
      sweepConfTarget: 2,
      maxSwapAmount: 10_000_000n,
      autoloopDestAddress: 'bcrt1qdefault',
      // A fresh daemon read carries loopd's default flat fee ppm — it must
      // never ride into a category-based write (loopd rejects both-set).
      feePpm: 2_500n,
    });
    const merged = autoLoopParamsOntoLiquidityParameters(current, {
      autoloopEnabled: true,
      budgetSat: 150_000,
      budgetStartSec: 0,
      maxSwapFeePpm: 2_500,
      sweepFeeRateSatPerVbyte: 30,
      maxMinerFeeSat: 10_000,
      maxPrepaySat: 5_000,
      sweepConfTarget: 6,
      failureBackoffSec: 3_600,
    });
    expect(merged.autoloop).toBe(true);
    expect(merged.sweepFeeRateSatPerVbyte).toBe(30n);
    expect(merged.autoloopBudgetSat).toBe(150_000n);
    // Monthly ceiling, expressed as loopd's refresh period.
    expect(merged.autoloopBudgetRefreshPeriodSec).toBe(30n * 24n * 60n * 60n);
    expect(merged.maxMinerFeeSat).toBe(10_000n);
    expect(merged.maxPrepaySat).toBe(5_000n);
    // The engine writes categories, so the daemon's flat ppm is zeroed.
    expect(merged.feePpm).toBe(0n);
    // Daemon-owned fields ride through untouched.
    expect(merged.sweepConfTarget).toBe(2);
    expect(merged.maxSwapAmount).toBe(10_000_000n);
    expect(merged.autoloopDestAddress).toBe('bcrt1qdefault');
  });
});

describe('mapTransportError', () => {
  it('keeps already-classified provider errors', () => {
    const err = new LiquidityProviderError('no-affordable-quote', 'none');
    expect(mapTransportError(err)).toBe(err);
  });

  it('classifies grpc codes: unauthenticated, unavailable, out-of-terms, exhausted', () => {
    const mk = (code: number | undefined, message: string) => Object.assign(new Error(message), { code });
    expect(mapTransportError(mk(16, 'unauthenticated')).kind).toBe('unauthenticated');
    expect(mapTransportError(mk(7, 'permission denied')).kind).toBe('unauthenticated');
    expect(mapTransportError(mk(14, 'connection refused')).kind).toBe('unavailable');
    expect(mapTransportError(mk(12, 'unknown service SwapClient')).kind).toBe('unavailable');
    // litd answers calls to not-yet-registered sub-servers with
    // "unknown service" — observed live WITHOUT a usable grpc code.
    expect(mapTransportError(mk(undefined, 'unknown service looprpc.SwapClient')).kind).toBe('unavailable');
    // Dial refusals against a dead operator endpoint can carry a generic
    // code; the message is the classification evidence.
    expect(mapTransportError(mk(2, 'dial tcp 127.0.0.1:1: connect: connection refused')).kind).toBe('unavailable');
    // The per-call RPC deadline (rpc-timeout.ts) fires against an operator
    // that holds the call open while retrying upstream — bounded failure,
    // classified unavailable (never an unbounded hang).
    expect(mapTransportError(mk(4, '4 DEADLINE_EXCEEDED: Deadline exceeded')).kind).toBe('unavailable');
    // Unmatched codes keep the generic 'unknown' kind by default…
    expect(mapTransportError(mk(2, 'internal server error')).kind).toBe('unknown');
    // …but a call-site context can override the fallback: a failed market
    // READ is the unavailable-market state, whatever the code shape poold
    // surfaces (observed: code 2 "internal server error" against a dead
    // auctioneer).
    expect(mapTransportError(mk(2, 'internal server error'), 'unavailable').kind).toBe('unavailable');
    // The fallback never overrides stronger evidence.
    expect(mapTransportError(mk(16, 'unauthenticated'), 'unavailable').kind).toBe('unauthenticated');
    expect(mapTransportError(mk(3, 'invalid argument')).kind).toBe('out-of-terms');
    expect(mapTransportError(mk(8, 'resource exhausted')).kind).toBe('no-affordable-quote');
  });

  it('refines coarse codes with the error message', () => {
    const mk = (code: number, message: string) => Object.assign(new Error(message), { code });
    expect(mapTransportError(mk(3, 'swap amount too small: 1 < 50000')).kind).toBe('out-of-terms');
    expect(mapTransportError(mk(9, 'insufficient outbound capacity')).kind).toBe('insufficient-funds');
    expect(mapTransportError(mk(14, 'no affordable quote available')).kind).toBe('no-affordable-quote');
  });

  it('maps non-grpc errors to unknown', () => {
    expect(mapTransportError(new Error('socket hang up')).kind).toBe('unknown');
  });
});

describe('batchSnapshotsToMarketRaw', () => {
  function batch(matched: number, clearedPerOrder: bigint): PoolAuctioneer.BatchSnapshotResponse {
    return PoolAuctioneer.BatchSnapshotResponse.create({
      matchedOrders: Array.from({ length: matched }, () =>
        PoolAuctioneer.MatchedOrderSnapshot.create({ totalSatsCleared: clearedPerOrder, unitsMatched: 1 }),
      ),
    });
  }

  it('counts matched batches and sums cleared volume', () => {
    expect(poolMarketFromSnapshots([batch(2, 100_000n), batch(1, 50_000n)])).toEqual({
      matchedBatches: 2,
      leasedVolumeSat: 250_000,
    });
  });

  it('maps an empty batch list to the thin-market raw data', () => {
    expect(poolMarketFromSnapshots([])).toEqual({ matchedBatches: 0 });
    expect(poolMarketFromSnapshots([batch(0, 0n)])).toEqual({ matchedBatches: 0 });
  });
});

describe('grpc message factory smoke', () => {
  it('creates requests the generated clients accept', () => {
    expect(Loop.LoopOutRequest.create({ amt: 1n, dest: 'x', maxSwapFee: 1n, maxMinerFee: 1n }).amt).toBe(1n);
    expect(PoolAuctioneer.BatchSnapshotsRequest.create({})).toBeDefined();
    expect(LoopClient.SwapClientClient).toBeDefined();
  });
});
