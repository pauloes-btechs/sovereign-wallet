import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  beginSigning,
  createIntent,
  type PaymentIntent,
  type ReconcileResult,
} from './intent.js';
import {
  PaymentEngine,
  PaymentRejectedError,
  UnknownIntentError,
  type DispatchOutcome,
  type PaymentDispatcher,
  type PaymentIntentStore,
} from './engine.js';
import { InMemoryPaymentIntentStore } from './store.js';

const T0 = '2026-10-30T00:00:00Z';

/** Counter-based id source — deterministic, no global crypto needed. */
function makeNewId() {
  let n = 0;
  return () => `intent-${String(++n).padStart(4, '0')}`;
}

interface DispatcherSpy {
  dispatcher: PaymentDispatcher;
  calls: {
    prepare: number;
    dispatch: number;
    lookup: number;
    dispatchedIntents: PaymentIntent[];
    lookedUpIntents: PaymentIntent[];
  };
}

function recordingDispatcher(
  opts: {
    prepareBackendRef?: string;
    dispatchOutcome?: DispatchOutcome;
    lookupResult?: ReconcileResult;
  } = {},
): DispatcherSpy {
  const calls = {
    prepare: 0,
    dispatch: 0,
    lookup: 0,
    dispatchedIntents: [] as PaymentIntent[],
    lookedUpIntents: [] as PaymentIntent[],
  };
  return {
    calls,
    dispatcher: {
      prepare: async (intent) => {
        calls.prepare++;
        return { backendRef: opts.prepareBackendRef ?? `ref-${intent.intentId.slice(-4)}` };
      },
      dispatch: async (intent, _backendRef) => {
        calls.dispatch++;
        calls.dispatchedIntents.push(JSON.parse(JSON.stringify(intent)) as PaymentIntent);
        return opts.dispatchOutcome ?? { status: 'sent' };
      },
      lookup: async (intent) => {
        calls.lookup++;
        calls.lookedUpIntents.push(JSON.parse(JSON.stringify(intent)) as PaymentIntent);
        return opts.lookupResult ?? { status: 'unknown' };
      },
      ...opts,
    } as PaymentDispatcher,
  };
}

function recordingStore(log: string[]): { store: PaymentIntentStore; inner: InMemoryPaymentIntentStore } {
  const inner = new InMemoryPaymentIntentStore();
  return {
    inner,
    store: {
      save: async (i: PaymentIntent) => {
        log.push(`save:${i.state}`);
        await inner.save(i);
      },
      get: (id: string) => inner.get(id),
      listAll: () => inner.listAll(),
    },
  };
}

function makeEngine(
  store: PaymentIntentStore,
  dispatcher: PaymentDispatcher,
  opts: { authorizePolicy?: (i: PaymentIntent) => void } = {},
) {
  return new PaymentEngine({ store, dispatcher, newId: makeNewId(), now: () => T0, ...opts });
}

async function mustGet(store: PaymentIntentStore, intentId: string): Promise<PaymentIntent> {
  const intent = await store.get(intentId);
  if (intent === undefined) throw new Error(`intent '${intentId}' missing from store`);
  return intent;
}

describe('PaymentEngine — send path', () => {
  it('submit: persists a draft, authorizes it, and persists the authorized intent', async () => {
    const log: string[] = [];
    const { store } = recordingStore(log);
    const { dispatcher } = recordingDispatcher();
    const engine = makeEngine(store, dispatcher);

    const intent = await engine.submit('lightning-invoice', { invoice: 'lnbc1...' }, 1_000);

    expect(intent.state).toBe('authorized');
    expect(log).toEqual(['save:draft', 'save:authorized']);
  });

  it('submit: authorization-policy rejection fails the intent and never dispatches', async () => {
    const log: string[] = [];
    const { store } = recordingStore(log);
    const { dispatcher, calls } = recordingDispatcher();
    let rejectedId = '';
    const engine = makeEngine(store, dispatcher, {
      authorizePolicy: (i) => {
        rejectedId = i.intentId;
        throw new Error('fee over daily budget');
      },
    });

    await expect(engine.submit('onchain', { address: 'bcrt1q...' }, 1_000)).rejects.toThrowError(
      PaymentRejectedError,
    );

    const stored = await store.get(rejectedId);
    expect(stored?.state).toBe('failed');
    expect(calls.dispatch).toBe(0);
    expect(log).toEqual(['save:draft', 'save:failed']);
  });

  it('execute: happy path — settled, exactly one dispatch, audit trail kept', async () => {
    const { store } = recordingStore([]);
    const { dispatcher, calls } = recordingDispatcher({
      dispatchOutcome: { status: 'settled', backendRef: 'ref-final' },
    });
    const engine = makeEngine(store, dispatcher);
    const intent = await engine.submit('lightning-invoice', { invoice: 'lnbc1...' }, 1_000);

    const result = await engine.execute(intent.intentId);

    expect(result.state).toBe('settled');
    expect(result.backendRef).toBe('ref-final');
    // Audit trail: the dispatch attempt plus the settled backend response.
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.result).toBe('dispatched');
    expect(result.attempts[1]?.result).toBe('resolved');
    expect(calls.prepare).toBe(1);
    expect(calls.dispatch).toBe(1);
  });

  it('execute: persists in-flight BEFORE the network dispatch is attempted', async () => {
    const log: string[] = [];
    const { store } = recordingStore(log);
    const engine = makeEngine(store, {
      prepare: async () => {
        log.push('prepare');
        return { backendRef: 'ref-x' };
      },
      dispatch: async () => {
        log.push('dispatch');
        return { status: 'sent' };
      },
      lookup: async () => {
        log.push('lookup');
        return { status: 'unknown' };
      },
    });
    const intent = await engine.submit('onchain', { address: 'bcrt1q...' }, 1_000);

    log.length = 0;
    await engine.execute(intent.intentId);

    // A 'sent' outcome is ambiguous by design: nothing is persisted after the
    // network call — the intent stays in-flight until recovery reconciles it.
    expect(log).toEqual(['save:signing', 'prepare', 'save:in-flight', 'dispatch']);
    const inFlightIdx = log.indexOf('save:in-flight');
    const dispatchIdx = log.indexOf('dispatch');
    expect(inFlightIdx).toBeGreaterThanOrEqual(0);
    expect(inFlightIdx).toBeLessThan(dispatchIdx);
    await expect(store.get(intent.intentId)).resolves.toMatchObject({ state: 'in-flight' });
  });

  it('execute: definitive backend failure reconciles to failed — still exactly one dispatch', async () => {
    const { store } = recordingStore([]);
    const { dispatcher, calls } = recordingDispatcher({
      dispatchOutcome: { status: 'definitive-failure', reason: 'invoice expired' },
    });
    const engine = makeEngine(store, dispatcher);
    const intent = await engine.submit('lightning-invoice', { invoice: 'lnbc1...' }, 1_000);

    const result = await engine.execute(intent.intentId);

    expect(result.state).toBe('failed');
    expect(calls.dispatch).toBe(1);
    const stored = await store.get(intent.intentId);
    expect(stored?.state).toBe('failed');
  });

  it('execute: ambiguous outcome (timeout) leaves the intent in-flight for recovery', async () => {
    const { store } = recordingStore([]);
    const { dispatcher, calls } = recordingDispatcher({ dispatchOutcome: { status: 'timeout' } });
    const engine = makeEngine(store, dispatcher);
    const intent = await engine.submit('lightning-invoice', { invoice: 'lnbc1...' }, 1_000);

    const result = await engine.execute(intent.intentId);

    expect(result.state).toBe('in-flight');
    expect(calls.dispatch).toBe(1);
  });

  it('execute: refuses an unknown intent id', async () => {
    const { store } = recordingStore([]);
    const { dispatcher } = recordingDispatcher();
    const engine = makeEngine(store, dispatcher);
    await expect(engine.execute('missing')).rejects.toThrowError(UnknownIntentError);
  });

  it('execute: refuses an intent that was never authorized (draft)', async () => {
    const { store } = recordingStore([]);
    const { dispatcher, calls } = recordingDispatcher();
    const engine = makeEngine(store, dispatcher);
    // Persist a draft directly — never authorized.
    await store.save(createIntent('draft-1', 'onchain', { address: 'bcrt1q...' }, 100));

    await expect(engine.execute('draft-1')).rejects.toThrowError(InvalidTransitionError);
    expect(calls.dispatch).toBe(0);
  });

  it('execute: refuses to double-send an in-flight intent', async () => {
    const { store } = recordingStore([]);
    const { dispatcher, calls } = recordingDispatcher({ dispatchOutcome: { status: 'timeout' } });
    const engine = makeEngine(store, dispatcher);
    const intent = await engine.submit('lightning-invoice', { invoice: 'lnbc1...' }, 1_000);
    await engine.execute(intent.intentId);

    await expect(engine.execute(intent.intentId)).rejects.toThrowError(InvalidTransitionError);
    expect(calls.dispatch).toBe(1); // still exactly one network dispatch
  });
});

describe('PaymentEngine — crash recovery (reconcile-on-recovery)', () => {
  it('an in-flight intent with unknown backend status is reconciled to needs-recovery and NEVER re-dispatched', async () => {
    const { store } = recordingStore([]);
    const send = recordingDispatcher({ dispatchOutcome: { status: 'timeout' } });
    const engineA = makeEngine(store, send.dispatcher);
    const draft = await engineA.submit('lightning-invoice', { invoice: 'lnbc1...' }, 1_000);
    const sent = await engineA.execute(draft.intentId); // crash-equivalent: ambiguous dispatch outcome

    // Restart: fresh engine over the same persisted store.
    const recovery = recordingDispatcher({ lookupResult: { status: 'unknown' } });
    const engineB = makeEngine(store, recovery.dispatcher);
    const report = await engineB.recoverInterrupted();

    // THE RULE UNDER TEST: reconciliation precedes any retry — blind re-dispatch here
    // is the test-failing defect this suite exists to catch.
    expect(recovery.calls.dispatch).toBe(0);
    expect(recovery.calls.lookup).toBe(1);
    expect(recovery.calls.lookedUpIntents[0]?.backendRef).toBe(sent.backendRef);
    const stored = await store.get(draft.intentId);
    expect(stored?.state).toBe('needs-recovery');
    expect(report.needsRecovery).toEqual([draft.intentId]);
  });

  it('an in-flight intent the backend confirms settled becomes settled — never re-dispatched', async () => {
    const { store } = recordingStore([]);
    const send = recordingDispatcher({ dispatchOutcome: { status: 'timeout' } });
    const engineA = makeEngine(store, send.dispatcher);
    const intent = await engineA.submit('lightning-invoice', { invoice: 'lnbc1...' }, 1_000);
    await engineA.execute(intent.intentId);

    const recovery = recordingDispatcher({
      lookupResult: { status: 'settled', backendRef: 'ref-final' },
    });
    const engineB = makeEngine(store, recovery.dispatcher);
    const report = await engineB.recoverInterrupted();

    expect(recovery.calls.dispatch).toBe(0);
    const stored = await store.get(intent.intentId);
    expect(stored?.state).toBe('settled');
    expect(stored?.backendRef).toBe('ref-final');
    expect(report.reconciled).toEqual([intent.intentId]);
  });

  it('a signing intent (crashed pre-dispatch) with no backend record returns to authorized — recovery itself still never dispatches', async () => {
    const { store } = recordingStore([]);
    const engineA = makeEngine(store, recordingDispatcher().dispatcher);
    const intent = await engineA.submit('onchain', { address: 'bcrt1q...' }, 1_000);
    // Simulate a crash between persist(signing) and the network call.
    const authorized = await mustGet(store, intent.intentId);
    await store.save(beginSigning(authorized));

    const recovery = recordingDispatcher({ lookupResult: { status: 'not-found' } });
    const engineB = makeEngine(store, recovery.dispatcher);
    await engineB.recoverInterrupted();

    expect(recovery.calls.dispatch).toBe(0);
    const stored = await store.get(intent.intentId);
    expect(stored?.state).toBe('authorized');
  });

  it('a signing-state crash with ambiguous backend status lands in needs-recovery — never re-dispatched', async () => {
    const { store } = recordingStore([]);
    const engineA = makeEngine(store, recordingDispatcher().dispatcher);
    const intent = await engineA.submit('onchain', { address: 'bcrt1q...' }, 1_000);
    const authorized = await mustGet(store, intent.intentId);
    await store.save(beginSigning(authorized));

    const recovery = recordingDispatcher({ lookupResult: { status: 'unknown' } });
    const engineB = makeEngine(store, recovery.dispatcher);
    await engineB.recoverInterrupted();

    expect(recovery.calls.dispatch).toBe(0);
    expect((await store.get(intent.intentId))?.state).toBe('needs-recovery');
  });

  it('recovery is idempotent: a second pass over terminal intents does nothing', async () => {
    const { store } = recordingStore([]);
    const send = recordingDispatcher({ dispatchOutcome: { status: 'timeout' } });
    const engineA = makeEngine(store, send.dispatcher);
    const intent = await engineA.submit('lightning-invoice', { invoice: 'lnbc1...' }, 1_000);
    await engineA.execute(intent.intentId);

    const first = recordingDispatcher({ lookupResult: { status: 'settled', backendRef: 'ref-final' } });
    await makeEngine(store, first.dispatcher).recoverInterrupted();
    const second = recordingDispatcher({ lookupResult: { status: 'settled', backendRef: 'ref-final' } });
    const report = await makeEngine(store, second.dispatcher).recoverInterrupted();

    expect(second.calls.lookup).toBe(0);
    expect(second.calls.dispatch).toBe(0);
    expect(report.reconciled).toEqual([]);
    expect(report.needsRecovery).toEqual([]);
    expect((await store.get(intent.intentId))?.state).toBe('settled');
  });

  it('after safe-retry recovery (not-found), execute is legal again exactly once', async () => {
    const { store } = recordingStore([]);
    const engineA = makeEngine(store, recordingDispatcher().dispatcher);
    const intent = await engineA.submit('onchain', { address: 'bcrt1q...' }, 1_000);
    const authorized = await mustGet(store, intent.intentId);
    await store.save(beginSigning(authorized));

    const recovery = recordingDispatcher({ lookupResult: { status: 'not-found' } });
    await makeEngine(store, recovery.dispatcher).recoverInterrupted();

    const retry = recordingDispatcher({
      dispatchOutcome: { status: 'settled', backendRef: 'ref-retry' },
    });
    const engineC = makeEngine(store, retry.dispatcher);
    const result = await engineC.execute(intent.intentId);

    expect(result.state).toBe('settled');
    expect(retry.calls.dispatch).toBe(1);
  });
});

describe('PaymentEngine — needs-recovery manual resolution', () => {
  it('resolveNeedsRecovery(settled) moves a needs-recovery intent to settled and persists it', async () => {
    const { store } = recordingStore([]);
    const send = recordingDispatcher({ dispatchOutcome: { status: 'timeout' } });
    const engineA = makeEngine(store, send.dispatcher);
    const intent = await engineA.submit('lightning-invoice', { invoice: 'lnbc1...' }, 1_000);
    await engineA.execute(intent.intentId);
    await makeEngine(store, recordingDispatcher({ lookupResult: { status: 'unknown' } }).dispatcher).recoverInterrupted();

    const engine = makeEngine(store, recordingDispatcher().dispatcher);
    const resolved = await engine.resolveNeedsRecovery(intent.intentId, {
      status: 'settled',
      backendRef: 'ref-manual',
    });

    expect(resolved.state).toBe('settled');
    expect(resolved.backendRef).toBe('ref-manual');
    expect((await store.get(intent.intentId))?.state).toBe('settled');
  });

  it('resolveNeedsRecovery on a non-needs-recovery intent throws', async () => {
    const { store } = recordingStore([]);
    const engine = makeEngine(store, recordingDispatcher().dispatcher);
    const intent = await engine.submit('onchain', { address: 'bcrt1q...' }, 1_000);
    await expect(
      engine.resolveNeedsRecovery(intent.intentId, { status: 'failed' }),
    ).rejects.toThrowError(InvalidTransitionError);
  });
});
