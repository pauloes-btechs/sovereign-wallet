import { describe, expect, it } from 'vitest';
import { sendStatusOf } from './payments.js';

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
