import { describe, expect, it } from 'vitest';
import { summarizeVtxos } from './vtxo-summary.js';

describe('summarizeVtxos', () => {
  it('is fresh with no expiry when there are no VTXOs', () => {
    expect(summarizeVtxos([])).toEqual({ state: 'fresh', hoursToExpiry: null, vtxoCount: 0 });
  });

  it('reports the most severe state across VTXOs', () => {
    expect(summarizeVtxos([{ state: 'fresh' }, { state: 'expiring', blocksToExpiry: 100 }]).state).toBe('expiring');
    expect(summarizeVtxos([{ state: 'expiring' }, { state: 'at-risk', blocksToExpiry: 0 }]).state).toBe('at-risk');
    expect(summarizeVtxos([{ state: 'at-risk' }, { state: 'exiting' }]).state).toBe('exiting');
  });

  it('uses the soonest expiry of non-exiting VTXOs, in hours of 10-minute blocks', () => {
    const s = summarizeVtxos([
      { state: 'fresh', blocksToExpiry: 4_320 },
      { state: 'expiring', blocksToExpiry: 144 },
      { state: 'exiting', blocksToExpiry: 6 },
    ]);
    expect(s.hoursToExpiry).toBe(24);
  });

  it('never reports negative hours for an already-expired VTXO', () => {
    expect(summarizeVtxos([{ state: 'at-risk', blocksToExpiry: -5 }]).hoursToExpiry).toBe(0);
  });
});
