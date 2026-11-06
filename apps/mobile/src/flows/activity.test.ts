import { describe, expect, it } from 'vitest';
import type { TransactionRecord } from '@sovereign/wallet-core';
import type { WavelengthActivityDetail } from '@sovereign/wavelength-adapter';
import {
  DEFAULT_ACTIVITY_FILTER,
  amountSign,
  dayLabel,
  filterActivity,
  groupByDay,
  railsPresent,
  remoteActivityItems,
  rowTitle,
  sortNewestFirst,
  wavelengthActivityItems,
} from './activity.js';
import type { RemoteActivityRecord } from './modeBRemoteController.js';

const record = (overrides: Partial<TransactionRecord> = {}): TransactionRecord => ({
  txId: 'ref-1',
  providerId: 'wavelength',
  direction: 'out',
  kind: 'lightning-invoice',
  amountSat: 5_000n,
  status: 'settled',
  at: '2026-11-05T10:00:00Z',
  ...overrides,
});

const detail = (overrides: Partial<WavelengthActivityDetail> = {}): WavelengthActivityDetail => ({
  record: record(),
  entryId: 'entry-1',
  entryKind: 'send',
  rail: 'lightning',
  feeSat: 30n,
  note: null,
  counterparty: 'swap-server',
  createdAt: '2026-11-05T09:59:00Z',
  updatedAt: '2026-11-05T10:00:00Z',
  phase: 'confirmed',
  paymentHash: 'ab'.repeat(32),
  txid: null,
  preimage: null,
  confirmationHeight: null,
  vtxoOutpoint: null,
  failureReason: null,
  failureCode: null,
  invoice: null,
  onchainAddress: null,
  arkAddress: null,
  ...overrides,
});

const remote = (overrides: Partial<RemoteActivityRecord> = {}): RemoteActivityRecord => ({
  paymentHash: 'cd'.repeat(32),
  direction: 'in',
  amountSat: 2_100n,
  feeSat: null,
  status: 'open',
  createdAt: '2026-11-05T12:00:00Z',
  memo: 'Mode B receive',
  paymentRequest: 'lnbcrt21u1sim',
  ...overrides,
});

describe('wavelengthActivityItems', () => {
  it('carries the reported receipt fields from details', () => {
    const [item] = wavelengthActivityItems(null, [
      detail({ note: 'coffee', preimage: 'ff'.repeat(32), confirmationHeight: 812 }),
    ]);
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.id).toBe('wl:entry-1');
    expect(item.fee).toEqual({ kind: 'amount', sats: 30n });
    expect(item.memo).toBe('coffee');
    expect(item.identifiers.map((i) => i.label)).toEqual(['Payment hash', 'Preimage', 'Wallet entry id']);
    expect(item.identifiers.find((i) => i.label === 'Preimage')?.sensitive).toBe(true);
    // Only reported steps: created, the confirmation block, the final status.
    expect(item.timeline.map((s) => s.label)).toEqual(['Created', 'Confirmed on-chain', 'Completed']);
    expect(item.timeline[1]?.detail).toBe('Block 812');
    expect(item.fields).toEqual([{ label: 'Counterparty', value: { kind: 'text', text: 'Swap service' } }]);
    // A preimage is proof material — never searchable.
    expect(item.searchText).not.toContain('ff'.repeat(32));
  });

  it('shows the current phase of a pending entry and the failure of a failed one', () => {
    const [pending, failed] = wavelengthActivityItems(null, [
      detail({ record: record({ status: 'pending' }), phase: 'waiting_for_payment' }),
      detail({
        entryId: 'entry-2',
        record: record({ status: 'failed' }),
        phase: 'failed',
        failureReason: 'route not found',
        failureCode: 'failed',
      }),
    ]);
    expect(pending?.timeline.map((s) => [s.label, s.state])).toEqual([
      ['Created', 'done'],
      ['Waiting for payment', 'current'],
    ]);
    expect(failed?.timeline.at(-1)).toMatchObject({ label: 'Failed', state: 'failed', detail: 'route not found' });
    expect(failed?.failureReason).toBe('route not found');
  });

  it('falls back to history records and marks what they do not report', () => {
    const [item] = wavelengthActivityItems([record({ kind: 'onchain', direction: 'in' })], null);
    expect(item?.rail).toBe('onchain');
    expect(item?.title).toBe('Received');
    expect(item?.fee).toEqual({ kind: 'missing', reason: 'Not reported by this wallet' });
    expect(item?.identifiers[0]?.label).toBe('Reference');
  });

  it('titles entries by what they were and keeps ids unique', () => {
    const items = wavelengthActivityItems(null, [
      detail({ entryKind: 'deposit', rail: 'onchain', record: record({ direction: 'in' }) }),
      detail({ entryKind: 'exit', rail: 'onchain' }),
    ]);
    expect(items.map(rowTitle)).toEqual(['Deposit · On-chain', 'Exit to on-chain · On-chain']);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });
});

describe('remoteActivityItems', () => {
  it('maps an open invoice: no fee applies, preimage and settle time not reported', () => {
    const [item] = remoteActivityItems([remote()]);
    expect(item?.title).toBe('Invoice');
    expect(item?.status).toBe('open');
    expect(item?.fee.kind).toBe('missing');
    expect(item?.identifiers.map((i) => i.label)).toEqual(['Payment hash', 'Payment request']);
    expect(item?.timeline.map((s) => s.label)).toEqual(['Invoice created', 'Awaiting payment']);
    expect(item?.timeline[1]?.at).toBeNull();
    expect(item?.fields[0]?.value).toEqual({ kind: 'missing', reason: 'Not reported over this connection' });
  });

  it('reports the routing fee of a settled payment', () => {
    const [item] = remoteActivityItems([remote({ direction: 'out', status: 'settled', feeSat: 3n })]);
    expect(item?.title).toBe('Sent');
    expect(item?.fee).toEqual({ kind: 'amount', sats: 3n });
    expect(item === undefined ? null : amountSign(item)).toBe('−');
  });
});

describe('filtering, search and grouping', () => {
  const items = [
    ...wavelengthActivityItems(null, [
      detail({ entryId: 'a', note: 'coffee', record: record({ amountSat: 2_100n, at: '2026-11-05T08:00:00Z' }) }),
      detail({
        entryId: 'b',
        entryKind: 'deposit',
        rail: 'onchain',
        txid: '12'.repeat(32),
        record: record({ direction: 'in', status: 'pending', amountSat: 50_000n, at: '2026-11-04T08:00:00Z' }),
      }),
      detail({
        entryId: 'c',
        record: record({ status: 'failed', amountSat: 700n, at: '2026-10-30T00:00:00Z' }),
      }),
    ]),
  ];

  it('filters by status, direction and rail', () => {
    const ids = (filter: Partial<typeof DEFAULT_ACTIVITY_FILTER>): string[] =>
      filterActivity(items, { ...DEFAULT_ACTIVITY_FILTER, ...filter }).map((i) => i.id);
    expect(ids({})).toEqual(['wl:a', 'wl:b', 'wl:c']);
    expect(ids({ status: 'sent' })).toEqual(['wl:a', 'wl:c']);
    expect(ids({ status: 'received' })).toEqual(['wl:b']);
    expect(ids({ status: 'pending' })).toEqual(['wl:b']);
    expect(ids({ status: 'failed' })).toEqual(['wl:c']);
    expect(ids({ rail: 'onchain' })).toEqual(['wl:b']);
    expect(railsPresent(items)).toEqual(['lightning', 'onchain']);
  });

  it('searches memo, identifiers and amounts (sats digits or exact BTC)', () => {
    const ids = (query: string): string[] =>
      filterActivity(items, { ...DEFAULT_ACTIVITY_FILTER, query }).map((i) => i.id);
    expect(ids('COFFEE')).toEqual(['wl:a']);
    expect(ids('1212')).toEqual(['wl:b']); // txid fragment
    expect(ids('2,100')).toEqual(['wl:a']);
    expect(ids('0.0005')).toEqual(['wl:b']); // exactly 50,000 sats
    expect(ids('nothing-like-this')).toEqual([]);
  });

  it('sorts newest first and groups by UTC day with relative labels', () => {
    const now = Date.parse('2026-11-05T20:00:00Z');
    const groups = groupByDay(sortNewestFirst([...items].reverse()), now);
    expect(groups.map((g) => g.label)).toEqual([
      'Today · Thu 5 Nov 2026',
      'Yesterday · Wed 4 Nov 2026',
      'Fri 30 Oct 2026',
    ]);
    expect(dayLabel(Date.parse('2026-01-01T23:59:00Z'))).toBe('Thu 1 Jan 2026');
  });

  it('puts items without a reported time last, under their own header', () => {
    const [undated] = wavelengthActivityItems([record({ at: '' })], null);
    if (undated === undefined) throw new Error('expected an item');
    const sorted = sortNewestFirst([undated, ...items]);
    expect(sorted.at(-1)).toBe(undated);
    expect(groupByDay(sorted, Date.now()).at(-1)?.label).toBe('Date not reported');
  });
});

describe('honest titles and signs', () => {
  it('calls an unpaid Lightning receive an invoice, without a plus sign', () => {
    const [invoice, receiving, received] = wavelengthActivityItems(null, [
      detail({ entryKind: 'receive', record: record({ direction: 'in', status: 'pending' }), phase: 'waiting_for_payment' }),
      detail({ entryId: 'r2', entryKind: 'receive', record: record({ direction: 'in', status: 'pending' }), phase: 'settling' }),
      detail({ entryId: 'r3', entryKind: 'receive', record: record({ direction: 'in', status: 'settled' }) }),
    ]);
    expect([invoice?.title, receiving?.title, received?.title]).toEqual(['Invoice', 'Receiving', 'Received']);
    expect(invoice === undefined ? 'x' : amountSign(invoice)).toBeNull();
    expect(received === undefined ? 'x' : amountSign(received)).toBe('+');
  });

  it('signs an outgoing payment in flight (the funds are committed)', () => {
    const [sending] = wavelengthActivityItems(null, [detail({ record: record({ status: 'pending' }) })]);
    expect(sending === undefined ? 'x' : amountSign(sending)).toBe('−');
  });
});
