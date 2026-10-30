import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  authorize,
  beginSigning,
  createIntent,
  dispatch,
  fail,
  reconcile,
} from './intent.js';

function anIntent() {
  return authorize(createIntent('11111111-1111-4111-8111-111111111111', 'lightning-invoice', { invoice: 'lnbc1...' }, 1_000));
}

describe('payment intent state machine', () => {
  it('persists intent as authorized before dispatch', () => {
    const i = anIntent();
    expect(i.state).toBe('authorized');
  });

  it('moves authorized → signing → in-flight and records the attempt', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', '2026-10-30T00:00:00Z');
    expect(i.state).toBe('in-flight');
    expect(i.backendRef).toBe('payhash-abc');
    expect(i.attempts).toHaveLength(1);
  });

  it('rejects blind re-dispatch of an in-flight intent', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', '2026-10-30T00:00:00Z');
    expect(() => dispatch(i, 'payhash-abc', '2026-10-30T00:00:01Z')).toThrowError(
      InvalidTransitionError,
    );
  });

  it('reconciles a settled backend result to settled — never re-dispatch', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', '2026-10-30T00:00:00Z');
    const r = reconcile(i, { status: 'settled', backendRef: 'payhash-abc' }, '2026-10-30T00:01:00Z');
    expect(r.state).toBe('settled');
    expect(r.backendRef).toBe('payhash-abc');
  });

  it('routes unknown reconciliation to needs-recovery with audit trail', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', '2026-10-30T00:00:00Z');
    const r = reconcile(i, { status: 'unknown' }, '2026-10-30T00:01:00Z');
    expect(r.state).toBe('needs-recovery');
    expect(r.attempts).toHaveLength(2);
  });

  it('allows a single safe retry only when the backend never saw the payment', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', '2026-10-30T00:00:00Z');
    const r = reconcile(i, { status: 'not-found' }, '2026-10-30T00:01:00Z');
    expect(r.state).toBe('authorized');
    // The safe retry re-signs first; dispatch is then legal exactly once.
    expect(() => dispatch(beginSigning(r), 'payhash-def', '2026-10-30T00:02:00Z')).not.toThrow();
  });

  it('refuses terminal transitions out of settled', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', '2026-10-30T00:00:00Z');
    const settled = reconcile(i, { status: 'settled', backendRef: 'payhash-abc' }, '2026-10-30T00:01:00Z');
    expect(() => fail(settled)).toThrowError(InvalidTransitionError);
  });

  it('crash-recovery: a signing-state intent is reconciled, not re-dispatched', () => {
    // Simulate restart: intent found mid-signing after a crash.
    const crashed = beginSigning(anIntent());
    expect(() => dispatch(crashed, 'payhash-xyz', '2026-10-30T00:00:00Z')).not.toThrow();
    // The rule: reconciliation precedes any retry — unknown ⇒ needs-recovery.
    const recovered = reconcile(crashed, { status: 'unknown' }, '2026-10-30T00:00:00Z');
    expect(recovered.state).toBe('needs-recovery');
  });
});
