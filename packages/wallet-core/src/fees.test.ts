import { describe, expect, it } from 'vitest';
import {
  FeeExceedsBudgetError,
  InvalidFeeRateError,
  MissingFeeRateError,
  StaticFeeEstimator,
  assertFeeWithinBudget,
  type FeeQuote,
  type FeeRateTable,
} from './fees.js';

const table: FeeRateTable = {
  kinds: {
    'lightning-invoice': { satPerVByte: 10, vsize: 200 },
    onchain: { satPerVByte: 4, vsize: 141 },
    'ark-vtxo': { satPerVByte: 5, vsize: 100 },
    'asset-transfer': { satPerVByte: 2, vsize: 300 },
  },
  priorities: { slow: 0.5, normal: 1, fast: 2 },
};

describe('StaticFeeEstimator', () => {
  it('quotes the base rate at normal priority', async () => {
    const estimator = new StaticFeeEstimator(table);
    const quote = await estimator.estimate({ kind: 'onchain' });
    expect(quote.priority).toBe('normal');
    expect(quote.satPerVByte).toBe(4);
    expect(quote.vsize).toBe(141);
    expect(quote.feeSat).toBe(564n);
  });

  it('rounds fractional priority-adjusted rates UP to whole sat/vB', async () => {
    const estimator = new StaticFeeEstimator(table);
    const quote = await estimator.estimate({ kind: 'ark-vtxo', priority: 'slow' });
    expect(quote.satPerVByte).toBe(3); // ceil(5 * 0.5) = 3
    expect(quote.feeSat).toBe(300n);
  });

  it('doubles the rate at fast priority', async () => {
    const estimator = new StaticFeeEstimator(table);
    const quote = await estimator.estimate({ kind: 'onchain', priority: 'fast' });
    expect(quote.satPerVByte).toBe(8);
    expect(quote.feeSat).toBe(1128n);
  });

  it('supports every payment kind', async () => {
    const estimator = new StaticFeeEstimator(table);
    for (const kind of ['lightning-invoice', 'onchain', 'ark-vtxo', 'asset-transfer'] as const) {
      await expect(estimator.estimate({ kind })).resolves.toMatchObject({ kind });
    }
  });

  it('throws MissingFeeRateError for a kind absent from the table', async () => {
    const incomplete = {
      kinds: { 'lightning-invoice': { satPerVByte: 10, vsize: 200 } },
      priorities: { slow: 0.5, normal: 1, fast: 2 },
    } as unknown as FeeRateTable;
    const estimator = new StaticFeeEstimator(incomplete);
    await expect(estimator.estimate({ kind: 'onchain' })).rejects.toThrowError(MissingFeeRateError);
  });

  it('rejects non-positive or non-integer rate entries', async () => {
    const bad: FeeRateTable = {
      kinds: { ...table.kinds, onchain: { satPerVByte: 0, vsize: 141 } },
      priorities: { ...table.priorities },
    };
    const estimator = new StaticFeeEstimator(bad);
    await expect(estimator.estimate({ kind: 'onchain' })).rejects.toThrowError(InvalidFeeRateError);
  });
});

describe('assertFeeWithinBudget (the maxFeeSat policy point)', () => {
  const quote: FeeQuote = {
    kind: 'onchain',
    priority: 'normal',
    satPerVByte: 4,
    vsize: 141,
    feeSat: 564n,
  };

  it('accepts a fee exactly at budget (boundary)', () => {
    expect(() => assertFeeWithinBudget(quote, 564)).not.toThrow();
  });

  it('rejects a fee one sat over budget, naming both numbers', () => {
    try {
      assertFeeWithinBudget(quote, 563);
      expect.unreachable('expected FeeExceedsBudgetError');
    } catch (err) {
      expect(err).toBeInstanceOf(FeeExceedsBudgetError);
      expect((err as Error).message).toContain('564');
      expect((err as Error).message).toContain('563');
    }
  });

  it('no budget means no cap', () => {
    expect(() => assertFeeWithinBudget(quote, undefined)).not.toThrow();
  });

  it('a zero budget rejects any positive fee', () => {
    expect(() => assertFeeWithinBudget(quote, 0)).toThrowError(FeeExceedsBudgetError);
  });

  it('fractional budgets are a programming error, not a silent round-down', () => {
    expect(() => assertFeeWithinBudget(quote, 100.5)).toThrowError(RangeError);
  });
});
