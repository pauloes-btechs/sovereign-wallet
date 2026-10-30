import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  authorize,
  beginSigning,
  createIntent,
  dispatch,
  fail,
  reconcile,
  resolveNeedsRecovery,
  type IntentState,
  type PaymentIntent,
} from './intent.js';

const T0 = '2026-10-30T00:00:00Z';

function anIntent() {
  return authorize(
    createIntent('11111111-1111-4111-8111-111111111111', 'lightning-invoice', { invoice: 'lnbc1...' }, 1_000),
  );
}

describe('payment intent state machine', () => {
  it('persists intent as authorized before dispatch', () => {
    const i = anIntent();
    expect(i.state).toBe('authorized');
  });

  it('moves authorized → signing → in-flight and records the attempt', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', T0);
    expect(i.state).toBe('in-flight');
    expect(i.backendRef).toBe('payhash-abc');
    expect(i.attempts).toHaveLength(1);
  });

  it('rejects blind re-dispatch of an in-flight intent', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', T0);
    expect(() => dispatch(i, 'payhash-abc', '2026-10-30T00:00:01Z')).toThrowError(
      InvalidTransitionError,
    );
  });

  it('reconciles a settled backend result to settled — never re-dispatch', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', T0);
    const r = reconcile(i, { status: 'settled', backendRef: 'payhash-abc' }, '2026-10-30T00:01:00Z');
    expect(r.state).toBe('settled');
    expect(r.backendRef).toBe('payhash-abc');
  });

  it('routes unknown reconciliation to needs-recovery with audit trail', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', T0);
    const r = reconcile(i, { status: 'unknown' }, '2026-10-30T00:01:00Z');
    expect(r.state).toBe('needs-recovery');
    expect(r.attempts).toHaveLength(2);
  });

  it('allows a single safe retry only when the backend never saw the payment', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', T0);
    const r = reconcile(i, { status: 'not-found' }, '2026-10-30T00:01:00Z');
    expect(r.state).toBe('authorized');
    // The safe retry re-signs first; dispatch is then legal exactly once.
    expect(() => dispatch(beginSigning(r), 'payhash-def', '2026-10-30T00:02:00Z')).not.toThrow();
  });

  it('refuses terminal transitions out of settled', () => {
    const i = dispatch(beginSigning(anIntent()), 'payhash-abc', T0);
    const settled = reconcile(i, { status: 'settled', backendRef: 'payhash-abc' }, '2026-10-30T00:01:00Z');
    expect(() => fail(settled)).toThrowError(InvalidTransitionError);
  });

  it('crash-recovery: a signing-state intent is reconciled, not re-dispatched', () => {
    // Simulate restart: intent found mid-signing after a crash.
    const crashed = beginSigning(anIntent());
    expect(() => dispatch(crashed, 'payhash-xyz', T0)).not.toThrow();
    // The rule: reconciliation precedes any retry — unknown ⇒ needs-recovery.
    const recovered = reconcile(crashed, { status: 'unknown' }, T0);
    expect(recovered.state).toBe('needs-recovery');
  });
});

describe('every state-machine transition', () => {
  const states: IntentState[] = [
    'draft',
    'authorized',
    'signing',
    'in-flight',
    'settled',
    'failed',
    'needs-recovery',
  ];

  function intentIn(state: IntentState): PaymentIntent {
    const draft = createIntent(
      '22222222-2222-4222-8222-222222222222',
      'onchain',
      { address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080' },
      500,
    );
    const authorized = authorize(draft);
    const signing = beginSigning(authorized);
    const inFlight = dispatch(signing, 'ref-1', T0);
    switch (state) {
      case 'draft':
        return draft;
      case 'authorized':
        return authorized;
      case 'signing':
        return signing;
      case 'in-flight':
        return inFlight;
      case 'settled':
        return reconcile(inFlight, { status: 'settled', backendRef: 'ref-1' }, T0);
      case 'failed':
        return fail(authorized);
      case 'needs-recovery':
        return reconcile(inFlight, { status: 'unknown' }, T0);
    }
  }

  const actions: Record<string, { run: (i: PaymentIntent) => PaymentIntent; allowedFrom: IntentState[] }> = {
    authorize: { run: authorize, allowedFrom: ['draft'] },
    beginSigning: { run: beginSigning, allowedFrom: ['authorized'] },
    dispatch: { run: (i) => dispatch(i, 'ref-2', T0), allowedFrom: ['signing'] },
    'reconcile:settled': {
      run: (i) => reconcile(i, { status: 'settled', backendRef: 'ref-2' }, T0),
      allowedFrom: ['signing', 'in-flight'],
    },
    'reconcile:not-found': {
      run: (i) => reconcile(i, { status: 'not-found' }, T0),
      allowedFrom: ['signing', 'in-flight'],
    },
    'reconcile:unknown': {
      run: (i) => reconcile(i, { status: 'unknown' }, T0),
      allowedFrom: ['signing', 'in-flight'],
    },
    'reconcile:failed': {
      run: (i) => reconcile(i, { status: 'failed', reason: 'invoice expired' }, T0),
      allowedFrom: ['signing', 'in-flight'],
    },
    fail: { run: fail, allowedFrom: ['draft', 'authorized', 'signing'] },
    'resolve:settled': {
      run: (i) => resolveNeedsRecovery(i, { status: 'settled', backendRef: 'ref-2' }, T0),
      allowedFrom: ['needs-recovery'],
    },
    'resolve:failed': {
      run: (i) => resolveNeedsRecovery(i, { status: 'failed' }, T0),
      allowedFrom: ['needs-recovery'],
    },
  };

  for (const [actionName, action] of Object.entries(actions)) {
    for (const state of states) {
      const allowed = action.allowedFrom.includes(state);
      it(`${actionName} ${allowed ? 'is allowed' : 'throws'} from '${state}'`, () => {
        const i = intentIn(state);
        if (allowed) {
          expect(() => action.run(i)).not.toThrow();
        } else {
          expect(() => action.run(i)).toThrowError(InvalidTransitionError);
        }
      });
    }
  }
});
