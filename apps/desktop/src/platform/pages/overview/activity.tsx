import { useEffect, useMemo, useState } from 'react';
import { Link } from '../../router.js';
import { Amount, Empty, Field, Icon, PageHeader, Panel, Segmented, Sheet, Skeleton, relativeTime } from '../../ui.js';
import {
  ActivityAmount,
  ActivityDetails,
  ActivitySourceNotices,
  PAYMENTS_LOADED,
  StateBadge,
  TypeGlyph,
  formatDate,
  formatShortDate,
  useActivity,
  type ActivityItem,
  type ActivityState,
  type ActivityType,
} from './shared.js';

const PAGE_SIZE = 25;

type TypeFilter = 'all' | ActivityType;
type StateFilter = 'all' | ActivityState;
type SortKey = 'date' | 'amount';
type SortDir = 'desc' | 'asc';

const TYPE_OPTIONS: readonly { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'sent', label: 'Sent' },
  { value: 'received', label: 'Received' },
  { value: 'swap', label: 'Swaps' },
];

const STATE_OPTIONS: readonly { value: StateFilter; label: string }[] = [
  { value: 'all', label: 'Any state' },
  { value: 'completed', label: 'Completed' },
  { value: 'pending', label: 'Pending or in flight' },
  { value: 'open', label: 'Open (unpaid)' },
  { value: 'failed', label: 'Failed' },
  { value: 'canceled', label: 'Canceled' },
];

function matches(it: ActivityItem, q: string): boolean {
  if (q === '') return true;
  const r = it.ref;
  const hay = [
    it.title,
    it.description,
    it.stateLabel,
    String(it.amountSat),
    r.kind === 'payment' ? r.payment.paymentHash : r.kind === 'invoice' ? `${r.invoice.paymentHashHex} ${r.invoice.memo}` : `${r.swap.id} ${r.swap.htlcAddress} ${r.swap.label}`,
  ]
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <th className={className} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(k)} aria-label={`Sort by ${label.toLowerCase()}`}>
        {label}
        <span className="ov-sort-ind" data-active={active ? 'true' : undefined} aria-hidden>
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '▼'}
        </span>
      </button>
    </th>
  );
}

function Totals({ items }: { items: readonly ActivityItem[] }) {
  let sent = 0;
  let received = 0;
  let fees = 0;
  let pending = 0;
  for (const it of items) {
    if (it.state === 'completed' && it.type === 'sent') sent += it.amountSat;
    if (it.state === 'completed' && it.type === 'received') received += it.amountSat;
    if (it.feeSat !== null && (it.state === 'completed' || it.type === 'swap')) fees += it.feeSat;
    if (it.state === 'pending') pending += 1;
  }
  return (
    <div className="ov-stats" aria-label="Totals for the history loaded on this page">
      <div>
        <div className="p-stat-label">Sent over Lightning</div>
        <div className="p-stat-value">
          <Amount sats={sent} />
        </div>
        <div className="p-stat-foot">Completed payments, before fees</div>
      </div>
      <div>
        <div className="p-stat-label">Received over Lightning</div>
        <div className="p-stat-value">
          <Amount sats={received} />
        </div>
        <div className="p-stat-foot">Settled invoices</div>
      </div>
      <div>
        <div className="p-stat-label">Fees paid</div>
        <div className="p-stat-value">
          <Amount sats={fees} />
        </div>
        <div className="p-stat-foot">Routing fees plus Loop swap costs</div>
      </div>
      <div>
        <div className="p-stat-label">In progress</div>
        <div className="p-stat-value">{pending.toLocaleString('en-US')}</div>
        <div className="p-stat-foot">Payments in flight, accepted invoices, active swaps</div>
      </div>
    </div>
  );
}

export default function ActivityPage() {
  const activity = useActivity();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [state, setState] = useState<StateFilter>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'date', dir: 'desc' });
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<ActivityItem | null>(null);

  const counts = useMemo(() => {
    const c: Record<TypeFilter, number> = { all: activity.items.length, sent: 0, received: 0, swap: 0 };
    for (const it of activity.items) c[it.type] += 1;
    return c;
  }, [activity.items]);

  const rows = useMemo(() => {
    const filtered = activity.items.filter((it) => (type === 'all' || it.type === type) && (state === 'all' || it.state === state) && matches(it, query.trim()));
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => (sort.key === 'date' ? a.at - b.at : a.amountSat - b.amountSat || a.at - b.at) * dir);
  }, [activity.items, type, state, query, sort]);

  useEffect(() => setPage(0), [type, state, query, sort]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
  const onSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: 'desc' }));
  const filtersOn = type !== 'all' || state !== 'all' || query.trim() !== '';

  return (
    <>
      <PageHeader
        title="Activity"
        sub="Every Lightning payment you sent, every invoice you created, and every Loop swap, newest first."
        actions={
          <button type="button" className="p-btn" onClick={activity.reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <div className="p-stack">
        <ActivitySourceNotices activity={activity} />
        {activity.loading ? <Skeleton height={86} /> : <Totals items={activity.items} />}
        <Panel flush>
          <div className="ov-toolbar" role="search">
            <div className="ov-search">
              <Field label="Search">
                {(id) => (
                  <div className="ov-search-wrap">
                    <Icon name="search" size={16} />
                    <input
                      id={id}
                      className="p-input"
                      type="search"
                      placeholder="Memo, payment hash, swap id, amount"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                )}
              </Field>
            </div>
            <div className="p-field">
              <span className="p-label" aria-hidden>
                Type
              </span>
              <Segmented
                label="Type"
                value={type}
                onChange={setType}
                options={TYPE_OPTIONS.map((o) => ({ value: o.value, label: `${o.label} ${counts[o.value]}` }))}
              />
            </div>
            <Field label="State">
              {(id) => (
                <select id={id} className="p-select" value={state} onChange={(e) => setState(STATE_OPTIONS.find((o) => o.value === e.target.value)?.value ?? 'all')}>
                  {STATE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {filtersOn ? (
              <button
                type="button"
                className="p-btn p-btn-ghost"
                onClick={() => {
                  setQuery('');
                  setType('all');
                  setState('all');
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>

          {activity.loading ? (
            <div className="p-stack" style={{ padding: 'var(--sovl-space-4) var(--sovl-space-5)' }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} height={36} />
              ))}
            </div>
          ) : activity.items.length === 0 ? (
            <Empty title="No activity yet" action={<Link to="/receive" className="p-btn p-btn-sm">Receive bitcoin</Link>}>
              Payments you send, invoices you create and swaps you start will appear here.
            </Empty>
          ) : rows.length === 0 ? (
            <Empty title="Nothing matches these filters">Try a different search, or clear the filters to see all {activity.items.length} items.</Empty>
          ) : (
            <div className="p-table-wrap">
              <table className="p-table ov-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Description</th>
                    <th className="ov-tight">State</th>
                    <th className="p-num ov-tight">Fee</th>
                    <SortHeader label="Amount" k="amount" sort={sort} onSort={onSort} className="p-num ov-tight" />
                    <SortHeader label="Date" k="date" sort={sort} onSort={onSort} className="p-num ov-tight" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((it) => (
                    <tr
                      key={it.key}
                      data-clickable="true"
                      tabIndex={0}
                      onClick={() => setOpen(it)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setOpen(it);
                        }
                      }}
                      aria-label={`${it.title}, ${it.stateLabel}, ${formatDate(it.at)}. Open details`}
                    >
                      <td className="ov-tight">
                        <div className="ov-type-cell">
                          <TypeGlyph item={it} />
                          <span className="ov-type-title">{it.title}</span>
                        </div>
                      </td>
                      <td>
                        <span className="ov-desc">{it.description}</span>
                      </td>
                      <td className="ov-tight">
                        <StateBadge item={it} />
                      </td>
                      <td className="p-num p-muted">{it.feeSat === null ? <span className="p-faint" aria-label="No fee">—</span> : <Amount sats={it.feeSat} />}</td>
                      <td className="p-num">
                        <ActivityAmount item={it} />
                      </td>
                      <td className="p-num ov-date">
                        <div title={formatDate(it.at)}>{formatShortDate(it.at)}</div>
                        <div className="p-hint">{relativeTime(it.at)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 0 ? (
            <div className="ov-pager">
              <span>
                {current * PAGE_SIZE + 1}–{Math.min(rows.length, (current + 1) * PAGE_SIZE)} of {rows.length}
                {filtersOn ? ` (filtered from ${activity.items.length})` : ''}
              </span>
              <div className="p-row" style={{ gap: 8 }}>
                <span className="p-faint">
                  Page {current + 1} of {pages}
                </span>
                <button type="button" className="p-btn p-btn-sm" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label="Previous page">
                  Previous
                </button>
                <button type="button" className="p-btn p-btn-sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} aria-label="Next page">
                  Next
                </button>
              </div>
            </div>
          ) : null}
          <div className="ov-foot-note">
            <Icon name="info" size={14} />
            On-chain transaction history is not available from this node&apos;s API yet, so on-chain deposits and sends are not listed. Showing up to the latest {PAYMENTS_LOADED} payments and 100 invoices.
          </div>
        </Panel>
      </div>
      {open ? (
        <Sheet title={open.title} onClose={() => setOpen(null)}>
          <ActivityDetails item={open} />
        </Sheet>
      ) : null}
    </>
  );
}
