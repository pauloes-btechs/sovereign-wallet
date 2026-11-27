import { describe, expect, it } from 'vitest';
import type { PrepareSendResult } from '@sovereign/wavelength-adapter';
import { reviewAmounts, sendStatusOf } from './payments.js';

describe('sendStatusOf', () => {
  it('shows settled only for a settled intent', () => {
    expect(sendStatusOf('settled')).toBe('settled');
  });

  it('keeps ambiguous outcomes in flight so no resend is offered', () => {
    expect(sendStatusOf('in-flight')).toBe('sending');
    expect(sendStatusOf('needs-recovery')).toBe('sending');
  });

  it('shows failed for a definitive failure', () => {
    expect(sendStatusOf('failed')).toBe('failed');
  });
});

describe('reviewAmounts', () => {
  const quote = { amountSat: 10_000, expectedFeeSat: 5_000, feeKnown: true } as PrepareSendResult;

  it('shows the quoted amount and fee', () => {
    expect(reviewAmounts(quote)).toEqual({ amountSat: 10_000n, feeSat: 5_000n });
  });

  it('hides an unknown fee instead of showing 0', () => {
    expect(reviewAmounts({ ...quote, feeKnown: false, expectedFeeSat: 0 })).toEqual({ amountSat: 10_000n, feeSat: null });
  });

  it('shows nothing before a quote exists', () => {
    expect(reviewAmounts(undefined)).toEqual({ amountSat: null, feeSat: null });
  });
});
