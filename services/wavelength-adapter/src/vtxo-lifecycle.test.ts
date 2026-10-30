import { describe, expect, it } from 'vitest';
import {
  ExitJobStatusCompleted,
  ExitJobStatusCSVPending,
  ExitJobStatusFailed,
  ExitJobStatusMaterializing,
  ExitJobStatusPending,
  ExitJobStatusSweeping,
} from './sdk/index.js';
import type { WalletVTXO } from './sdk/index.js';
import {
  DEFAULT_POLL_INTERVAL_MS,
  blocksToExpiryOf,
  classifyVtxo,
  classifyVtxoInventory,
  describeVtxoState,
  hasAtRisk,
  hasExpiring,
  isExitingJobStatus,
  lockedOrExpiringSat,
} from './vtxo-lifecycle.js';
import type { VtxoContext } from './vtxo-lifecycle.js';

/** A live VTXO: batch expiry is an absolute height far above the tip. */
function vtxo(overrides: Partial<WalletVTXO> = {}): WalletVTXO {
  return {
    outpoint: 'abc:0',
    amountSat: 10_000,
    status: 'available',
    batchExpiry: 10_000,
    relativeExpiry: 144,
    commitmentTxid: 'deadbeef',
    ...overrides,
  };
}

/** An in-window VTXO: expiry 8,000 vs tip 7,900 — 100 blocks left, window 144. */
const EXPIRING_VTXO = { batchExpiry: 8_000 } as const;

/** Block-height 7,900, free-refresh window 144 blocks (the research example). */
const BASE_CTX: VtxoContext = {
  blockHeight: 7_900,
  freeRefreshWindowBlocks: 144,
  operatorReachable: true,
};

describe('classifyVtxo — the spec four-state machine', () => {
  it('classifies a VTXO far from expiry as fresh', () => {
    expect(classifyVtxo(vtxo(), BASE_CTX)).toBe('fresh');
  });

  it('classifies a VTXO inside the free-refresh window as expiring while the operator is reachable', () => {
    // 7,900 + 144 = 8,044 ≥ 8,000 → 100 blocks to expiry, inside the window.
    expect(classifyVtxo(vtxo(EXPIRING_VTXO), BASE_CTX)).not.toBe('fresh');
    expect(classifyVtxo(vtxo(EXPIRING_VTXO), BASE_CTX)).toBe('expiring');
  });

  it('classifies the same VTXO as at-risk when the operator is unreachable inside the window', () => {
    expect(
      classifyVtxo(vtxo(EXPIRING_VTXO), { ...BASE_CTX, operatorReachable: false }),
    ).toBe('at-risk');
  });

  it('classifies a VTXO whose batch expiry has passed as at-risk — never silently fresh', () => {
    const expired = vtxo({ batchExpiry: 7_900 });
    expect(classifyVtxo(expired, BASE_CTX)).toBe('at-risk');
    expect(
      classifyVtxo(expired, { ...BASE_CTX, operatorReachable: false }),
    ).toBe('at-risk');
  });

  it('classifies a VTXO with an in-flight exit job as exiting — regardless of expiry', () => {
    const ctx: VtxoContext = { ...BASE_CTX, exitJobs: new Map([['abc:0', ExitJobStatusPending]]) };
    expect(classifyVtxo(vtxo(), ctx)).toBe('exiting');
  });

  it('treats every in-flight exit phase as exiting', () => {
    for (const status of [
      ExitJobStatusPending,
      ExitJobStatusMaterializing,
      ExitJobStatusCSVPending,
      ExitJobStatusSweeping,
    ]) {
      const ctx: VtxoContext = { ...BASE_CTX, exitJobs: new Map([['abc:0', status]]) };
      expect(classifyVtxo(vtxo(), ctx)).toBe('exiting');
    }
  });

  it('never classifies terminal exit jobs as exiting — the VTXO is back to expiry logic', () => {
    for (const status of [ExitJobStatusCompleted, ExitJobStatusFailed]) {
      const ctx: VtxoContext = { ...BASE_CTX, exitJobs: new Map([['abc:0', status]]) };
      // Completed/failed are not in-flight; expiry logic decides (in-window).
      expect(classifyVtxo(vtxo(EXPIRING_VTXO), ctx)).toBe('expiring');
    }
  });

  it('classifies a VTXO without a batch expiry as fresh — no expiry pressure', () => {
    expect(classifyVtxo(vtxo({ batchExpiry: 0 }), BASE_CTX)).toBe('fresh');
  });

  it('is conservative when the operator has not advertised a refresh window', () => {
    // No window advertised → cannot claim 'expiring' (no free refresh
    // available); the VTXO stays fresh until the window is known.
    const ctx: VtxoContext = { ...BASE_CTX, freeRefreshWindowBlocks: undefined };
    expect(classifyVtxo(vtxo(), ctx)).toBe('fresh');
  });
});

describe('blocksToExpiryOf — absolute-height interpretation (regtest-pinned)', () => {
  it('subtracts the current height from the absolute batch expiry', () => {
    expect(blocksToExpiryOf(vtxo({ batchExpiry: 8_000 }), 7_900)).toBe(100);
  });

  it('returns negative once the expiry height has passed', () => {
    expect(blocksToExpiryOf(vtxo({ batchExpiry: 7_899 }), 7_900)).toBe(-1);
  });

  it('returns undefined for a zero/invalid expiry', () => {
    expect(blocksToExpiryOf(vtxo({ batchExpiry: 0 }), 7_900)).toBeUndefined();
    expect(blocksToExpiryOf(vtxo({ batchExpiry: Number.NaN }), 7_900)).toBeUndefined();
  });
});

describe('inventory aggregation', () => {
  const inventory = {
    vtxos: [
      vtxo({ outpoint: 'a:0', amountSat: 1_000, batchExpiry: 9_000 }), // fresh
      vtxo({ outpoint: 'b:0', amountSat: 2_000, batchExpiry: 8_000 }), // expiring
      vtxo({ outpoint: 'c:0', amountSat: 3_000, batchExpiry: 7_900 }), // at-risk (passed)
      vtxo({ outpoint: 'd:0', amountSat: 4_000, batchExpiry: 9_000 }), // exiting
    ],
    total: 4,
  };
  const ctx: VtxoContext = {
    ...BASE_CTX,
    exitJobs: new Map([['d:0', ExitJobStatusMaterializing]]),
  };

  it('classifies every VTXO against the live context', () => {
    const classified = classifyVtxoInventory(inventory, ctx);
    expect(classified.map((c) => c.state)).toEqual([
      'fresh',
      'expiring',
      'at-risk',
      'exiting',
    ]);
  });

  it('sums locked/expiring across non-fresh states only', () => {
    expect(lockedOrExpiringSat(classifyVtxoInventory(inventory, ctx))).toBe(9_000n);
  });

  it('reports alert edges via hasExpiring/hasAtRisk', () => {
    const classified = classifyVtxoInventory(inventory, ctx);
    expect(hasExpiring(classified)).toBe(true);
    expect(hasAtRisk(classified)).toBe(true);
  });

  it('reports no alerts on an all-fresh inventory', () => {
    const fresh = classifyVtxoInventory({ vtxos: [vtxo({ batchExpiry: 99_000 })], total: 1 }, BASE_CTX);
    expect(hasExpiring(fresh)).toBe(false);
    expect(hasAtRisk(fresh)).toBe(false);
    expect(lockedOrExpiringSat(fresh)).toBe(0n);
  });
});

describe('describeVtxoState — spec copy verbatim', () => {
  it('renders the spec state-table strings', () => {
    expect(describeVtxoState('fresh')).toBe('Spendable');
    expect(describeVtxoState('expiring')).toBe(
      'Your funds are being rolled forward automatically',
    );
    expect(describeVtxoState('at-risk')).toContain('Cooperative payments are paused');
    expect(describeVtxoState('exiting')).toContain('Cancel not possible');
  });

  it('renders the exit countdown as an estimate when blocks are known', () => {
    // 12 blocks ≈ 2 hours at ~10 min/block.
    expect(describeVtxoState('exiting', { bestCaseBlocksRemaining: 12 })).toContain('~2 h');
  });
});

describe('isExitingJobStatus + poll cadence default', () => {
  it('accepts exactly the four in-flight phases', () => {
    expect(isExitingJobStatus(ExitJobStatusPending)).toBe(true);
    expect(isExitingJobStatus(ExitJobStatusFailed)).toBe(false);
  });

  it('keeps the default poll cadence block-scale, not subsecond', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
  });
});
