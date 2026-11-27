import { describe, expect, it } from 'vitest';
import { feeCapText } from './fee-cap.js';

describe('feeCapText', () => {
  it('follows the amount until the user sets a cap', () => {
    expect(feeCapText(null, 0)).toBe('10');
    expect(feeCapText(null, 1_000_000)).toBe('5000');
  });

  it('keeps the cap the user typed, even an empty one', () => {
    expect(feeCapText('42', 1_000_000)).toBe('42');
    expect(feeCapText('', 1_000_000)).toBe('');
  });
});
