/**
 * Activity model shared by both wallet modes: one `ActivityItem` per entry
 * the backend reported, plus the pure filtering, searching and day grouping
 * the Activity tab and Home render.
 *
 * Rule: an item carries only what its source reported. A field the source
 * does not have is `missing` with the reason — never a guessed value. Mode A
 * items come from the Wavelength daemon's activity page (with receipt
 * fields when the provider offers `activityDetails`); Mode B items come from
 * the remote node's Lightning payments and invoices.
 */

import type { PaymentKind, TransactionRecord } from '@sovereign/wallet-core';
import type { WavelengthActivityDetail } from '@sovereign/wavelength-adapter';
import type { RemoteActivityRecord } from './modeBRemoteController.js';

export type ActivitySource = 'wavelength' | 'remote-lnd';
export type ActivityRail = 'lightning' | 'onchain' | 'ark' | 'asset';
/** `open` = an invoice awaiting payment; `canceled` = cancelled or expired invoice. */
export type ActivityStatus = 'settled' | 'pending' | 'failed' | 'open' | 'canceled';

export const RAIL_LABEL: Readonly<Record<ActivityRail, string>> = {
  lightning: 'Lightning',
  onchain: 'On-chain',
  ark: 'Ark',
  asset: 'Asset',
};

export const STATUS_LABEL: Readonly<Record<ActivityStatus, string>> = {
  settled: 'Settled',
  pending: 'Pending',
  failed: 'Failed',
  open: 'Awaiting payment',
  canceled: 'Canceled',
};

/** A value on the receipt: reported (text, amount, time) or not reported (with why). */
export type ActivityFieldValue =
  | { readonly kind: 'text'; readonly text: string; readonly mono?: boolean }
  | { readonly kind: 'amount'; readonly sats: bigint }
  | { readonly kind: 'time'; readonly at: number }
  | { readonly kind: 'missing'; readonly reason: string };

export interface ActivityField {
  readonly label: string;
  readonly value: ActivityFieldValue;
}

/** An identifier the user can copy. `sensitive` ones are proof material (preimage). */
export interface ActivityIdentifier {
  readonly label: string;
  readonly value: string;
  readonly sensitive?: boolean;
  readonly hint?: string;
}

/** One status step the source actually reported; `at` null = the time was not reported. */
export interface ActivityTimelineStep {
  readonly label: string;
  readonly at: number | null;
  readonly state: 'done' | 'current' | 'failed';
  readonly detail?: string;
}

export interface ActivityItem {
  /** Stable within one read; the transaction route's `id` param. */
  readonly id: string;
  readonly source: ActivitySource;
  readonly direction: 'in' | 'out';
  readonly rail: ActivityRail;
  /** "Sent", "Received", "Deposit", "Exit to on-chain", "Invoice". */
  readonly title: string;
  readonly amountSat: bigint;
  readonly status: ActivityStatus;
  /** When it happened (epoch ms) — the time grouping and sorting use; null if unreported. */
  readonly at: number | null;
  readonly memo: string | null;
  /** The fee as reported; `missing` explains an unreported one. */
  readonly fee: ActivityFieldValue;
  readonly failureReason: string | null;
  readonly identifiers: readonly ActivityIdentifier[];
  readonly timeline: readonly ActivityTimelineStep[];
  /** Extra receipt rows (counterparty, block height…), in display order. */
  readonly fields: readonly ActivityField[];
  /** Lower-cased memo + identifiers, for search. */
  readonly searchText: string;
}

const NOT_REPORTED = 'Not reported by this wallet';

function parseTime(text: string | null | undefined): number | null {
  if (text === null || text === undefined || text === '') return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

function searchTextOf(memo: string | null, identifiers: readonly ActivityIdentifier[]): string {
  return [memo ?? '', ...identifiers.filter((i) => i.sensitive !== true).map((i) => i.value)]
    .join(' ')
    .toLowerCase();
}

function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const count = seen.get(item.id) ?? 0;
    seen.set(item.id, count + 1);
    return count === 0 ? item : { ...item, id: `${item.id}#${count + 1}` };
  });
}

// ——— Mode A (Wavelength) ———

const RAIL_OF_KIND: Readonly<Record<PaymentKind, ActivityRail>> = {
  'lightning-invoice': 'lightning',
  onchain: 'onchain',
  'ark-vtxo': 'ark',
  'asset-transfer': 'asset',
};

const PHASE_LABEL: Readonly<Record<NonNullable<WavelengthActivityDetail['phase']>, string>> = {
  unspecified: 'In progress',
  request_created: 'Request created',
  waiting_for_payment: 'Waiting for payment',
  payment_detected: 'Payment detected',
  settling: 'Settling',
  confirmed: 'Confirmed',
  refunding: 'Refunding',
  refunded: 'Refunded',
  failed: 'Failed',
  waiting_for_confirmation: 'Waiting for confirmation',
};

const ENTRY_TITLE: Readonly<Record<WavelengthActivityDetail['entryKind'], string>> = {
  send: 'Sent',
  receive: 'Received',
  deposit: 'Deposit',
  exit: 'Exit to on-chain',
};

/**
 * Mode A items. With receipt details (preferred) every reported field is
 * carried; with only history records, fee and memo are marked not reported.
 */
export function wavelengthActivityItems(
  records: readonly TransactionRecord[] | null,
  details: readonly WavelengthActivityDetail[] | null,
): ActivityItem[] {
  if (details !== null) return uniqueIds(details.map(itemFromDetail));
  if (records === null) return [];
  return uniqueIds(records.map(itemFromRecord));
}

function itemFromRecord(record: TransactionRecord): ActivityItem {
  const at = parseTime(record.at);
  const identifiers: ActivityIdentifier[] = [
    {
      label: 'Reference',
      value: record.txId,
      hint: 'Transaction id, payment hash or entry id — whichever the wallet reported first.',
    },
  ];
  const status: ActivityStatus = record.status;
  return {
    id: `wl:${record.txId}`,
    source: 'wavelength',
    direction: record.direction,
    rail: RAIL_OF_KIND[record.kind],
    title: record.direction === 'out' ? 'Sent' : status === 'settled' ? 'Received' : 'Incoming',
    amountSat: record.amountSat,
    status,
    at,
    memo: null,
    fee: { kind: 'missing', reason: NOT_REPORTED },
    failureReason: null,
    identifiers,
    timeline: [
      { label: 'Recorded', at, state: 'done' },
      statusStep(status, null, null),
    ],
    fields: [],
    searchText: searchTextOf(null, identifiers),
  };
}

function itemFromDetail(detail: WavelengthActivityDetail): ActivityItem {
  const { record } = detail;
  // An incoming entry still waiting for the payer (an invoice or a deposit
  // address nobody has paid yet) is awaiting payment, not a payment in flight.
  const awaitingPayment =
    record.status === 'pending' &&
    (detail.entryKind === 'receive' || detail.entryKind === 'deposit') &&
    (detail.phase === null || detail.phase === 'request_created' || detail.phase === 'waiting_for_payment');
  const status: ActivityStatus = awaitingPayment ? 'open' : record.status;
  const createdAt = parseTime(detail.createdAt);
  const updatedAt = parseTime(detail.updatedAt);
  const identifiers: ActivityIdentifier[] = [];
  if (detail.paymentHash !== null) identifiers.push({ label: 'Payment hash', value: detail.paymentHash });
  if (detail.txid !== null) identifiers.push({ label: 'Transaction id', value: detail.txid });
  if (detail.preimage !== null) {
    identifiers.push({
      label: 'Preimage',
      value: detail.preimage,
      sensitive: true,
      hint: 'Proof of payment. Share it only with someone who needs to verify this payment.',
    });
  }
  if (detail.vtxoOutpoint !== null) identifiers.push({ label: 'VTXO outpoint', value: detail.vtxoOutpoint });
  if (detail.invoice !== null) identifiers.push({ label: 'Invoice', value: detail.invoice });
  if (detail.onchainAddress !== null) identifiers.push({ label: 'On-chain address', value: detail.onchainAddress });
  if (detail.arkAddress !== null) identifiers.push({ label: 'Ark address', value: detail.arkAddress });
  identifiers.push({ label: 'Wallet entry id', value: detail.entryId });

  const timeline: ActivityTimelineStep[] = [];
  timeline.push({ label: 'Created', at: createdAt, state: 'done' });
  const unfinished = status === 'pending' || status === 'open';
  if (unfinished && detail.phase !== null) {
    timeline.push({
      label: PHASE_LABEL[detail.phase],
      at: updatedAt,
      state: 'current',
      detail: 'Latest phase reported by the wallet',
    });
  }
  if (detail.confirmationHeight !== null) {
    timeline.push({
      label: 'Confirmed on-chain',
      at: null,
      state: 'done',
      detail: `Block ${detail.confirmationHeight}`,
    });
  }
  if (!unfinished) timeline.push(statusStep(status, updatedAt, detail.failureReason));
  else if (detail.phase === null) timeline.push(statusStep(status, null, null));

  const fields: ActivityField[] = [];
  if (detail.counterparty !== null) {
    fields.push({ label: 'Counterparty', value: { kind: 'text', text: counterpartyLabel(detail.counterparty) } });
  }
  if (detail.failureCode !== null) {
    fields.push({ label: 'Failure code', value: { kind: 'text', text: detail.failureCode, mono: true } });
  }

  return {
    id: `wl:${detail.entryId}`,
    source: 'wavelength',
    direction: record.direction,
    rail: detail.rail,
    title: detail.entryKind === 'receive' ? receiveTitle(status, detail.phase) : ENTRY_TITLE[detail.entryKind],
    amountSat: record.amountSat,
    status,
    at: parseTime(record.at) ?? createdAt,
    memo: detail.note,
    fee: { kind: 'amount', sats: detail.feeSat },
    failureReason: detail.failureReason,
    identifiers,
    timeline,
    fields,
    searchText: searchTextOf(detail.note, identifiers),
  };
}

/** A Lightning receive is an invoice until money arrives; "Received" only once settled. */
function receiveTitle(status: ActivityStatus, phase: WavelengthActivityDetail['phase']): string {
  if (status === 'settled') return 'Received';
  if (status === 'pending' && (phase === 'payment_detected' || phase === 'settling')) return 'Receiving';
  return 'Invoice';
}

function counterpartyLabel(raw: string): string {
  if (raw === 'swap-server') return 'Swap service';
  if (raw === 'chain') return 'Bitcoin network';
  if (raw === 'ark-server' || raw === 'operator') return 'Ark operator';
  return raw;
}

function statusStep(
  status: ActivityStatus,
  at: number | null,
  failureReason: string | null,
): ActivityTimelineStep {
  switch (status) {
    case 'settled':
      return { label: 'Completed', at, state: 'done' };
    case 'failed':
      return failureReason === null
        ? { label: 'Failed', at, state: 'failed' }
        : { label: 'Failed', at, state: 'failed', detail: failureReason };
    case 'pending':
      return { label: 'Pending', at, state: 'current' };
    case 'open':
      return { label: 'Awaiting payment', at, state: 'current' };
    case 'canceled':
      return { label: 'Canceled or expired', at, state: 'failed' };
  }
}

// ——— Mode B (remote LND) ———

/** Mode B items from the node's Lightning payments and invoices. */
export function remoteActivityItems(records: readonly RemoteActivityRecord[] | null): ActivityItem[] {
  if (records === null) return [];
  return uniqueIds(records.map(itemFromRemote));
}

function itemFromRemote(record: RemoteActivityRecord): ActivityItem {
  const at = parseTime(record.createdAt);
  const memo = record.memo === null || record.memo === '' ? null : record.memo;
  const identifiers: ActivityIdentifier[] = [{ label: 'Payment hash', value: record.paymentHash }];
  if (record.paymentRequest !== null && record.paymentRequest !== '') {
    identifiers.push({ label: 'Payment request', value: record.paymentRequest });
  }
  const outgoing = record.direction === 'out';
  const timeline: ActivityTimelineStep[] = [
    { label: outgoing ? 'Payment started' : 'Invoice created', at, state: 'done' },
  ];
  switch (record.status) {
    case 'settled':
      timeline.push({ label: outgoing ? 'Paid' : 'Payment received', at: null, state: 'done' });
      break;
    case 'pending':
      timeline.push({
        label: outgoing ? 'In flight' : 'Payment accepted, settling',
        at: null,
        state: 'current',
      });
      break;
    case 'failed':
      timeline.push({ label: 'Failed', at: null, state: 'failed' });
      break;
    case 'open':
      timeline.push({ label: 'Awaiting payment', at: null, state: 'current' });
      break;
    case 'canceled':
      timeline.push({ label: 'Canceled or expired', at: null, state: 'failed' });
      break;
  }
  const fee: ActivityFieldValue = !outgoing
    ? { kind: 'missing', reason: 'No routing fee applies to a payment you receive' }
    : record.feeSat === null
      ? { kind: 'missing', reason: 'Not reported by your node' }
      : { kind: 'amount', sats: record.feeSat };
  return {
    id: `ln:${record.direction}:${record.paymentHash}`,
    source: 'remote-lnd',
    direction: record.direction,
    rail: 'lightning',
    title: outgoing ? 'Sent' : record.status === 'settled' ? 'Received' : 'Invoice',
    amountSat: record.amountSat,
    status: record.status,
    at,
    memo,
    fee,
    failureReason: null,
    identifiers,
    timeline,
    fields: [
      {
        label: outgoing ? 'Preimage' : 'Settled at',
        value: { kind: 'missing', reason: 'Not reported over this connection' },
      },
    ],
    searchText: searchTextOf(memo, identifiers),
  };
}

// ——— Ordering, filtering, search, grouping ———

/** Newest first; items without a time keep their source order, after dated ones. */
export function sortNewestFirst(items: readonly ActivityItem[]): ActivityItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.at === null && b.item.at === null) return a.index - b.index;
      if (a.item.at === null) return 1;
      if (b.item.at === null) return -1;
      return b.item.at - a.item.at || a.index - b.index;
    })
    .map(({ item }) => item);
}

export type ActivityStatusFilter = 'all' | 'sent' | 'received' | 'pending' | 'failed';
export type ActivityRailFilter = 'all' | ActivityRail;

export interface ActivityFilter {
  readonly status: ActivityStatusFilter;
  readonly rail: ActivityRailFilter;
  readonly query: string;
}

export const DEFAULT_ACTIVITY_FILTER: ActivityFilter = Object.freeze({
  status: 'all',
  rail: 'all',
  query: '',
});

export const STATUS_FILTERS: ReadonlyArray<{ id: ActivityStatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'sent', label: 'Sent' },
  { id: 'received', label: 'Received' },
  { id: 'pending', label: 'Pending' },
  { id: 'failed', label: 'Failed' },
];

/** Pending covers unfinished items: in-flight payments and invoices awaiting payment. */
export function isUnfinished(item: ActivityItem): boolean {
  return item.status === 'pending' || item.status === 'open';
}

function matchesStatus(item: ActivityItem, filter: ActivityStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'sent':
      return item.direction === 'out';
    case 'received':
      return item.direction === 'in';
    case 'pending':
      return isUnfinished(item);
    case 'failed':
      return item.status === 'failed';
  }
}

/**
 * Amount search: "2100", "2,100" or "2 100" match amounts whose sats digits
 * contain those digits; "0.000021" (a decimal point) matches that exact BTC
 * amount.
 */
function matchesAmount(item: ActivityItem, query: string): boolean {
  const compact = query.replace(/[\s,_]/g, '');
  if (!/^\d*\.?\d*$/.test(compact) || !/\d/.test(compact)) return false;
  if (compact.includes('.')) {
    const [whole = '', frac = ''] = compact.split('.');
    if (frac.length > 8) return false;
    const sats = BigInt(whole === '' ? '0' : whole) * 100_000_000n + BigInt(frac.padEnd(8, '0') || '0');
    return item.amountSat === sats;
  }
  return item.amountSat.toString().includes(compact);
}

export function matchesQuery(item: ActivityItem, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return item.searchText.includes(query) || matchesAmount(item, query);
}

export function filterActivity(items: readonly ActivityItem[], filter: ActivityFilter): ActivityItem[] {
  return items.filter(
    (item) =>
      matchesStatus(item, filter.status) &&
      (filter.rail === 'all' || item.rail === filter.rail) &&
      matchesQuery(item, filter.query),
  );
}

export function isFiltered(filter: ActivityFilter): boolean {
  return filter.status !== 'all' || filter.rail !== 'all' || filter.query.trim() !== '';
}

/** The rails present in the data, in a fixed order — only these get a type filter. */
export function railsPresent(items: readonly ActivityItem[]): ActivityRail[] {
  const order: ActivityRail[] = ['lightning', 'onchain', 'ark', 'asset'];
  return order.filter((rail) => items.some((item) => item.rail === rail));
}

export interface ActivityDayGroup {
  /** "2026-11-05" (UTC), or "unknown" for items without a time. */
  readonly key: string;
  readonly label: string;
  readonly items: readonly ActivityItem[];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Thu 5 Nov 2026" (UTC — every time in the app is shown in UTC). */
export function dayLabel(epochMs: number): string {
  const d = new Date(epochMs);
  return `${WEEKDAYS[d.getUTCDay()] ?? ''} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

function dayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Groups (already sorted) items by UTC day: "Today · Thu 5 Nov 2026", "Yesterday · …", or the date. */
export function groupByDay(items: readonly ActivityItem[], nowMs: number): ActivityDayGroup[] {
  const today = dayKey(nowMs);
  const yesterday = dayKey(nowMs - 86_400_000);
  const groups: { key: string; label: string; items: ActivityItem[] }[] = [];
  for (const item of items) {
    const key = item.at === null ? 'unknown' : dayKey(item.at);
    let group = groups.find((g) => g.key === key);
    if (group === undefined) {
      const date = item.at === null ? '' : dayLabel(item.at);
      const label =
        item.at === null
          ? 'Date not reported'
          : key === today
            ? `Today · ${date}`
            : key === yesterday
              ? `Yesterday · ${date}`
              : date;
      group = { key, label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** "14:02 UTC". */
export function timeOfDay(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 16)} UTC`;
}

/** "2026-11-05 14:02 UTC". */
export function fullTime(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The amount's sign in lists: settled movements, and outgoing payments in
 * flight (the funds are committed). Money not yet received gets no '+'.
 */
export function amountSign(item: ActivityItem): '+' | '−' | null {
  if (item.amountSat === 0n) return null;
  if (item.status === 'settled') return item.direction === 'out' ? '−' : '+';
  if (item.status === 'pending' && item.direction === 'out') return '−';
  return null;
}

/** "Sent · Lightning" — the row title. */
export function rowTitle(item: ActivityItem): string {
  return `${item.title} · ${RAIL_LABEL[item.rail]}`;
}
