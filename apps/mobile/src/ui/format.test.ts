import { describe, expect, it } from 'vitest';
import { formatSats } from '@sovereign/ui/copy';
import {
  AMOUNT_MASK,
  amountAccessibilityLabel,
  formatAmount,
  formatBtcNumber,
  formatSatsNumber,
  maskText,
  parseAmountInput,
  shortenMiddle,
} from './format.js';

describe('amount formatting', () => {
  it('sats match the shared copy helper', () => {
    for (const v of [0n, 7n, 1_000n, 1_250_000n, 2_100_000_000_000_000n]) {
      expect(formatSatsNumber(v)).toBe(formatSats(v));
    }
  });

  it('BTC is exact to the satoshi with 8 decimals', () => {
    expect(formatBtcNumber(0n)).toBe('0.00000000');
    expect(formatBtcNumber(1n)).toBe('0.00000001');
    expect(formatBtcNumber(1_250_000n)).toBe('0.01250000');
    expect(formatBtcNumber(2_100_000_000_000_000n)).toBe('21,000,000.00000000');
    expect(formatBtcNumber(123_456_789_012n)).toBe('1,234.56789012');
  });

  it('formats per denomination with unit and sign', () => {
    expect(formatAmount(1_250_000n, { denomination: 'sats' })).toBe('1,250,000 sats');
    expect(formatAmount(1_250_000n, { denomination: 'btc' })).toBe('0.01250000 BTC');
    expect(formatAmount(5_000n, { denomination: 'sats', sign: '+' })).toBe('+5,000 sats');
    expect(formatAmount(5_000n, { denomination: 'sats', withUnit: false })).toBe('5,000');
  });

  it('privacy mode masks digits and speaks "Amount hidden"', () => {
    expect(formatAmount(1_250_000n, { denomination: 'sats', hidden: true })).toBe(`${AMOUNT_MASK} sats`);
    expect(formatAmount(1n, { denomination: 'btc', hidden: true, sign: '+' })).toBe(`${AMOUNT_MASK} BTC`);
    expect(amountAccessibilityLabel(1n, { denomination: 'sats', hidden: true })).toBe('Amount hidden');
    expect(amountAccessibilityLabel(5n, { denomination: 'sats', sign: '−' })).toBe('minus 5 sats');
    expect(maskText('bcrt1qxyz', true)).toBe(AMOUNT_MASK);
    expect(maskText('bcrt1qxyz', false)).toBe('bcrt1qxyz');
  });
});

describe('amount input parsing', () => {
  it('parses sats with grouping and refuses junk', () => {
    expect(parseAmountInput('1,000', 'sats')).toBe(1_000n);
    expect(parseAmountInput(' 25 000 ', 'sats')).toBe(25_000n);
    expect(parseAmountInput('0', 'sats')).toBeNull();
    expect(parseAmountInput('1.5', 'sats')).toBeNull();
    expect(parseAmountInput('-5', 'sats')).toBeNull();
    expect(parseAmountInput('', 'sats')).toBeNull();
  });

  it('parses BTC exactly to 8 decimals', () => {
    expect(parseAmountInput('0.0125', 'btc')).toBe(1_250_000n);
    expect(parseAmountInput('.00000001', 'btc')).toBe(1n);
    expect(parseAmountInput('1', 'btc')).toBe(100_000_000n);
    expect(parseAmountInput('1.', 'btc')).toBe(100_000_000n);
    expect(parseAmountInput('0.000000001', 'btc')).toBeNull(); // sub-satoshi
    expect(parseAmountInput('.', 'btc')).toBeNull();
    expect(parseAmountInput('0.00000000', 'btc')).toBeNull();
  });
});

describe('shortenMiddle', () => {
  it('keeps short text and elides long text in the middle', () => {
    expect(shortenMiddle('abc')).toBe('abc');
    expect(shortenMiddle('lnbcrt1500n1pjexampleinvoice9xk2f4')).toBe('lnbcrt15…9xk2f4');
  });
});
