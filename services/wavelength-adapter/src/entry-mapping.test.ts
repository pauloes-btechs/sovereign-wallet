import { describe, expect, it } from 'vitest';
import {
  EntryFailureCodeExpired,
  EntryFailureCodeFailed,
  EntryFailureCodeTimedOut,
  EntryKindSend,
  EntryPhaseConfirmed,
  EntryRequestTypeOnchain,
  EntryStatusComplete,
  EntryStatusFailed,
  EntryStatusPending,
} from './sdk/index.js';
import type { Entry } from './sdk/index.js';
import {
  backendRefOf,
  describeEntryFailure,
  dispatchOutcomeFromEntry,
  entryMatchesBackendRef,
  entryMatchesOnchainPayload,
  isInboundSettled,
  mapEntryToRecord,
  paymentKindOfEntry,
  reconcileFromEntry,
} from './entry-mapping.js';

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1',
    kind: 'send',
    status: 'pending',
    amountSat: 12_345,
    feeSat: 100,
    counterparty: 'swap-server',
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:01:00Z',
    note: '',
    failureReason: '',
    cursor: 0,
    failureCode: EntryFailureCodeFailed,
    ...overrides,
  };
}

describe('dispatchOutcomeFromEntry', () => {
  it('maps a complete entry to settled', () => {
    expect(dispatchOutcomeFromEntry(entry({ status: EntryStatusComplete }))).toBe('settled');
  });

  it('maps a failed entry to a definitive failure', () => {
    expect(dispatchOutcomeFromEntry(entry({ status: EntryStatusFailed }))).toBe('definitive-failure');
  });

  it('maps a pending entry to sent — in-flight, reconcile later', () => {
    expect(dispatchOutcomeFromEntry(entry({ status: EntryStatusPending }))).toBe('sent');
  });

  it('maps unknown statuses to sent — a future status must not silently settle a payment', () => {
    expect(dispatchOutcomeFromEntry(entry({ status: 'exploded' as Entry['status'] }))).toBe('sent');
  });
});

describe('reconcileFromEntry — the recovery-time mapping', () => {
  it('maps a complete entry to settled with its backend ref', () => {
    const settled = entry({
      status: EntryStatusComplete,
      progress: { phase: EntryPhaseConfirmed, phaseLabel: '', paymentHash: 'ph-1', txid: '', confirmationHeight: 0, vTXOOutpoint: '', preimage: '' },
    });
    expect(reconcileFromEntry(settled)).toEqual({ status: 'settled', backendRef: 'ph-1' });
  });

  it('maps a failed entry to failed with a human reason', () => {
    const failed = entry({
      status: EntryStatusFailed,
      failureCode: EntryFailureCodeExpired,
      failureReason: 'swap expired before funding',
    });
    const result = reconcileFromEntry(failed);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toContain('expired');
      expect(result.backendRef).toBe('entry-1');
    }
  });

  it('maps a pending (live swap) entry to unknown — never safe to re-dispatch', () => {
    expect(reconcileFromEntry(entry({ status: EntryStatusPending }))).toEqual({ status: 'unknown' });
  });

  it('maps a missing entry to not-found — the one retryable result', () => {
    expect(reconcileFromEntry(undefined)).toEqual({ status: 'not-found' });
  });
});

describe('entry matching', () => {
  const e = entry({
    progress: { phase: EntryPhaseConfirmed, phaseLabel: '', paymentHash: 'ph-9', txid: 'tx-9', confirmationHeight: 0, vTXOOutpoint: '', preimage: '' },
  });

  it('matches by payment hash, txid, or entry id', () => {
    expect(entryMatchesBackendRef(e, 'ph-9')).toBe(true);
    expect(entryMatchesBackendRef(e, 'tx-9')).toBe(true);
    expect(entryMatchesBackendRef({ ...e, progress: undefined }, 'entry-1')).toBe(true);
    expect(entryMatchesBackendRef(e, 'nope')).toBe(false);
  });

  it('correlates on-chain sends by destination and optional amount', () => {
    const onchain = entry({
      kind: 'send',
      amountSat: 5_000,
      request: { type: EntryRequestTypeOnchain, lightningInvoice: '', paymentHash: '', onchainAddress: 'bcrt1qdest', arkAddress: '' },
    });
    expect(entryMatchesOnchainPayload(onchain, 'bcrt1qdest')).toBe(true);
    expect(entryMatchesOnchainPayload(onchain, 'bcrt1qdest', 5_000)).toBe(true);
    expect(entryMatchesOnchainPayload(onchain, 'bcrt1qdest', 9_999)).toBe(false);
    expect(entryMatchesOnchainPayload(onchain, 'bcrt1qother')).toBe(false);
  });
});

describe('paymentKindOfEntry + history records', () => {
  it('maps request types onto shared payment kinds', () => {
    const withType = (type: string) =>
      entry({ request: { type: type as never, lightningInvoice: '', paymentHash: '', onchainAddress: '', arkAddress: '' } });
    expect(paymentKindOfEntry(withType('lightning'))).toBe('lightning-invoice');
    expect(paymentKindOfEntry(withType('onchain'))).toBe('onchain');
    expect(paymentKindOfEntry(withType('ark'))).toBe('ark-vtxo');
    // Exits/deposits without a request echo settle on-chain.
    expect(paymentKindOfEntry(entry({ request: undefined }))).toBe('onchain');
  });

  it('maps a send entry to an outbound record with the settled status', () => {
    const record = mapEntryToRecord(
      entry({
        kind: EntryKindSend,
        status: EntryStatusComplete,
        amountSat: 7_000,
        progress: { phase: EntryPhaseConfirmed, phaseLabel: '', paymentHash: 'ph-2', txid: 'tx-2', confirmationHeight: 6, vTXOOutpoint: '', preimage: '' },
      }),
      'wavelength',
    );
    expect(record.direction).toBe('out');
    expect(record.amountSat).toBe(7_000n);
    expect(record.status).toBe('settled');
    expect(record.providerId).toBe('wavelength');
    expect(record.txId).toBe('tx-2');
    expect(backendRefOf(entry({ progress: undefined }))).toBe('entry-1');
  });

  it('refuses to label another provider history', () => {
    expect(() => mapEntryToRecord(entry(), 'litd-local')).toThrow(/Mode A only/);
  });
});

describe('isInboundSettled', () => {
  it('is true for complete entries and confirmed-phase progress', () => {
    expect(
      isInboundSettled(entry({ status: EntryStatusComplete })),
    ).toBe(true);
    expect(
      isInboundSettled(
        entry({
          status: EntryStatusPending,
          progress: { phase: EntryPhaseConfirmed, phaseLabel: '', paymentHash: '', txid: '', confirmationHeight: 0, vTXOOutpoint: '', preimage: '' },
        }),
      ),
    ).toBe(true);
    expect(isInboundSettled(entry({ status: EntryStatusPending }))).toBe(false);
  });
});

describe('describeEntryFailure', () => {
  it('includes the stable code and human reason', () => {
    const text = describeEntryFailure(entry({ status: EntryStatusFailed, failureCode: EntryFailureCodeTimedOut, failureReason: 'swap timed out' }));
    expect(text).toContain('timed_out');
    expect(text).toContain('swap timed out');
  });
});
