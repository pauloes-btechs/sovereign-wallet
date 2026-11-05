/**
 * Payment requests: every Lightning invoice lnd holds, filterable by state,
 * with a detail sheet (QR, copy, timestamps) and a create sheet.
 */
import { useMemo, useState } from 'react';
import type { InvoiceView } from '../../api.js';
import { usePlatform, usePoll } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Empty, Field, Icon, Notice, PageHeader, Panel, QrCode, Segmented, Sheet, Skeleton, Stat, relativeTime } from '../../ui.js';
import { InvoiceCreator, InvoiceLive, type CreatedInvoice } from './receive-invoice.js';
import { CopyValue, Details, InvoiceStatusBadge, dateTime, invoiceStatus, timeUntil, type InvoiceStatus } from './send-kit.js';

type Filter = 'all' | InvoiceStatus;

export default function RequestsPage() {
  const { api, refreshKey } = usePlatform();
  const invoices = usePoll(() => api.invoices(), 10_000, [refreshKey]);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedInvoice | null>(null);
  const now = Date.now();

  const rows = useMemo(() => [...(invoices.data ?? [])].sort((a, b) => b.createdAt - a.createdAt), [invoices.data]);
  const counts = useMemo(() => {
    const c: Record<InvoiceStatus, number> = { open: 0, expired: 0, settled: 0, canceled: 0, accepted: 0 };
    for (const r of rows) c[invoiceStatus(r, now)] += 1;
    return c;
  }, [rows, now]);
  const visible = filter === 'all' ? rows : rows.filter((r) => invoiceStatus(r, now) === filter);
  const settledSum = rows.filter((r) => r.state === 'settled').reduce((s, r) => s + r.paidSat, 0);
  const openSum = rows.filter((r) => invoiceStatus(r, now) === 'open').reduce((s, r) => s + r.valueSat, 0);
  const current = rows.find((r) => r.paymentHashHex === selected);

  return (
    <>
      <PageHeader
        title="Payment requests"
        sub="Lightning invoices created by this node: what's waiting to be paid, what's been paid, and what expired."
        actions={
          <button
            type="button"
            className="p-btn p-btn-primary"
            onClick={() => {
              setCreated(null);
              setCreating(true);
            }}
          >
            <Icon name="plus" /> New request
          </button>
        }
      />
      <div className="p-stack">
        <Panel>
          {invoices.loading && !invoices.data ? (
            <Skeleton height={56} />
          ) : (
            <div className="sw-stats">
              <Stat label="Awaiting payment" foot={counts.open === 0 ? 'Nothing outstanding' : `${counts.open} invoice${counts.open === 1 ? '' : 's'}`}>
                <Amount sats={openSum} />
              </Stat>
              <Stat label="Received via invoices" foot={`${counts.settled} paid`}>
                <Amount sats={settledSum} />
              </Stat>
              <Stat label="Expired unpaid" foot="No longer payable">
                {counts.expired}
              </Stat>
              <Stat label="Total invoices" foot="As reported by lnd">
                {rows.length}
              </Stat>
            </div>
          )}
        </Panel>

        <Panel flush>
          <div className="sw-filters">
            <Segmented<Filter>
              label="Filter by state"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `All ${rows.length}` },
                { value: 'open', label: `Awaiting ${counts.open}` },
                { value: 'settled', label: `Paid ${counts.settled}` },
                { value: 'expired', label: `Expired ${counts.expired}` },
                { value: 'canceled', label: `Canceled ${counts.canceled}` },
              ]}
            />
            <span className="p-hint">{invoices.updatedAt ? `Updated ${relativeTime(invoices.updatedAt)} · refreshes every 10 s` : null}</span>
          </div>
          {invoices.error && !invoices.data ? (
            <div style={{ padding: 20 }}>
              <Notice tone="danger" title="Couldn't load invoices" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void invoices.reload()}>Retry</button>}>
                {invoices.error}
              </Notice>
            </div>
          ) : invoices.loading && !invoices.data ? (
            <div style={{ padding: 20 }} className="p-stack">
              <Skeleton height={20} />
              <Skeleton height={20} />
              <Skeleton height={20} />
            </div>
          ) : visible.length === 0 ? (
            <div className="sw-empty-cell">
              <Empty title={rows.length === 0 ? 'No payment requests yet' : 'Nothing in this view'}>
                {rows.length === 0 ? 'Create an invoice to request a Lightning payment. It shows up here with its status.' : 'Try another filter.'}
              </Empty>
            </div>
          ) : (
            <div className="p-table-wrap">
              <table className="p-table">
                <thead>
                  <tr>
                    <th>Created</th>
                    <th>Memo</th>
                    <th>Status</th>
                    <th className="p-num">Requested</th>
                    <th className="p-num">Received</th>
                    <th>Expiry</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const st = invoiceStatus(r, now);
                    return (
                      <tr
                        key={r.paymentHashHex}
                        data-clickable="true"
                        tabIndex={0}
                        onClick={() => setSelected(r.paymentHashHex)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelected(r.paymentHashHex);
                          }
                        }}
                      >
                        <td title={dateTime(r.createdAt)}>{relativeTime(r.createdAt)}</td>
                        <td>
                          <div className="sw-truncate">{r.memo || <span className="p-faint">{r.isKeysend ? 'Keysend (spontaneous) payment' : 'No memo'}</span>}</div>
                        </td>
                        <td>
                          <InvoiceStatusBadge status={st} />
                        </td>
                        <td className="p-num">{r.valueSat > 0 ? <Amount sats={r.valueSat} /> : <span className="p-faint">Any amount</span>}</td>
                        <td className="p-num">{r.paidSat > 0 ? <Amount sats={r.paidSat} /> : <span className="p-faint">—</span>}</td>
                        <td className="p-muted">{st === 'settled' ? (r.settledAt ? `Paid ${relativeTime(r.settledAt)}` : 'Paid') : st === 'open' ? `Expires ${timeUntil(r.expiresAt, now)}` : st === 'expired' ? `Expired ${relativeTime(r.expiresAt)}` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {current ? <InvoiceSheet invoice={current} onClose={() => setSelected(null)} /> : null}

      {creating ? (
        <Sheet title={created ? 'Lightning invoice' : 'New payment request'} onClose={() => setCreating(false)}>
          {created ? (
            <div className="p-stack">
              <InvoiceLive key={created.rHashHex} invoice={created} onNew={() => setCreated(null)} />
            </div>
          ) : (
            <div className="p-stack">
              <p className="p-muted" style={{ margin: 0 }}>
                Creates a BOLT-11 invoice on your node. Share it as a QR code or text; it can be paid once.
              </p>
              <InvoiceCreator compact onCreated={(inv) => {
                setCreated(inv);
                void invoices.reload();
              }} />
            </div>
          )}
        </Sheet>
      ) : null}
    </>
  );
}

function InvoiceSheet({ invoice, onClose }: { invoice: InvoiceView; onClose: () => void }) {
  const st = invoiceStatus(invoice);
  return (
    <Sheet title="Payment request" onClose={onClose}>
      <div className="p-stack">
        <div className="p-spread">
          <div>
            <div className="p-stat-label">{st === 'settled' ? 'Received' : 'Requested'}</div>
            <div className="p-figure">{st === 'settled' ? <Amount sats={invoice.paidSat} /> : invoice.valueSat > 0 ? <Amount sats={invoice.valueSat} /> : 'Any amount'}</div>
          </div>
          <InvoiceStatusBadge status={st} />
        </div>
        {st === 'open' && invoice.paymentRequest !== '' ? (
          <>
            <QrCode value={`lightning:${invoice.paymentRequest}`.toUpperCase()} size={248} label="Lightning invoice QR code" />
            <Field label="Invoice">{() => <CopyValue value={invoice.paymentRequest} label="Lightning invoice" />}</Field>
          </>
        ) : st === 'expired' ? (
          <Notice tone="info" title="Expired unpaid">
            This invoice can't be paid any more. Create a <Link className="sw-link" to="/receive">new invoice</Link> if you still want the payment.
          </Notice>
        ) : null}
        <Details
          rows={[
            { label: 'Memo', value: invoice.memo || '—' },
            { label: 'Created', value: dateTime(invoice.createdAt) },
            ...(invoice.settledAt ? [{ label: 'Paid', value: dateTime(invoice.settledAt) }] : []),
            { label: st === 'expired' ? 'Expired' : 'Expires', value: invoice.expiresAt ? dateTime(invoice.expiresAt) : '—' },
            { label: 'Type', value: invoice.isKeysend ? 'Keysend (spontaneous, no invoice shared)' : 'BOLT-11 invoice' },
            ...(invoice.valueSat > 0 && invoice.paidSat > invoice.valueSat ? [{ label: 'Overpaid by', value: <Amount sats={invoice.paidSat - invoice.valueSat} /> }] : []),
          ]}
        />
        <Field label="Payment hash">{() => <CopyValue value={invoice.paymentHashHex} label="Payment hash" />}</Field>
        {st === 'settled' && invoice.paymentRequest !== '' ? (
          <Field label="Invoice (paid)">{() => <CopyValue value={invoice.paymentRequest} label="Paid Lightning invoice" clamp />}</Field>
        ) : null}
      </div>
    </Sheet>
  );
}
