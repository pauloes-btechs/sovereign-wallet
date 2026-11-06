import { describe, expect, it } from 'vitest';
import { darkRuns, qrMatrix } from './qr.js';

/** A finder pattern: 7×7 dark ring, light ring, 3×3 dark core. */
function hasFinderAt(rows: readonly (readonly boolean[])[], top: number, left: number): boolean {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if ((rows[top + r]?.[left + c] ?? false) !== (ring || core)) return false;
    }
  }
  return true;
}

describe('qrMatrix', () => {
  it('an 11-byte payload is a version 1 symbol (21 modules) at level M', () => {
    const m = qrMatrix('hello world');
    expect(m.size).toBe(21);
    expect(m.rows).toHaveLength(21);
    expect(m.rows.every((row) => row.length === 21)).toBe(true);
  });

  it('version grows exactly at the level-M byte capacity boundaries', () => {
    // Byte-mode capacity at level M: v3 = 42 bytes, v4 = 62 bytes (ISO/IEC 18004 table 7).
    expect(qrMatrix('x'.repeat(42)).size).toBe(29); // v3
    expect(qrMatrix('x'.repeat(43)).size).toBe(33); // v4
    expect(qrMatrix('x'.repeat(62)).size).toBe(33); // v4
    expect(qrMatrix('x'.repeat(63)).size).toBe(37); // v5
  });

  it('a BIP21 regtest URI encodes to the expected symbol size', () => {
    const uri = 'bitcoin:bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?amount=1';
    expect(uri).toHaveLength(61);
    expect(qrMatrix(uri).size).toBe(33);
  });

  it('draws the three finder patterns', () => {
    const m = qrMatrix('lnbcrt1500n1sim');
    expect(hasFinderAt(m.rows, 0, 0)).toBe(true);
    expect(hasFinderAt(m.rows, 0, m.size - 7)).toBe(true);
    expect(hasFinderAt(m.rows, m.size - 7, 0)).toBe(true);
  });

  it('is deterministic for the same payload', () => {
    expect(qrMatrix('abc')).toEqual(qrMatrix('abc'));
  });
});

describe('darkRuns', () => {
  it('merges adjacent dark modules', () => {
    expect(darkRuns([true, true, false, true, false, false, true, true, true])).toEqual([
      { start: 0, length: 2 },
      { start: 3, length: 1 },
      { start: 6, length: 3 },
    ]);
    expect(darkRuns([false, false])).toEqual([]);
  });

  it('runs cover exactly the dark modules of a real symbol', () => {
    const m = qrMatrix('hello world');
    for (const row of m.rows) {
      const dark = row.filter(Boolean).length;
      expect(darkRuns(row).reduce((sum, run) => sum + run.length, 0)).toBe(dark);
    }
  });
});
