/**
 * Lightning invoice creation + live status, shared by Receive and Payment
 * requests. Status comes from polling lnd's invoice list until the invoice
 * settles, is canceled, or expires.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InvoiceView } from '../../api.js';
import { computeAccounts } from '../../balances.js';
import { usePlatform, usePoll, usePrefs } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Field, Icon, Notice, QrCode, Skeleton, formatSats } from '../../ui.js';
import { CopyValue, Details, InvoiceStatusBadge, dateTime, errorText, invoiceStatus, readSats, timeUntil } from './send-kit.js';

export interface CreatedInvoice {
  readonly paymentRequest: string;
  readonly rHashHex: string;
  readonly amountSat: number | null;
  readonly memo: string;
}

/** Inbound capacity, from the channel list (no balance math beyond max()). */
export function useReceiveCapacity() {
  const { bridge, refreshKey } = usePlatform();
  const channels = usePoll(() => bridge.channels(), 15_000, [refreshKey]);
  const accounts = useMemo(() => computeAccounts(undefined, channels.data), [channels.data]);
  const active = channels.data?.open.filter((c) => c.state === 'open') ?? [];
  const largestSat = active.reduce((m, c) => Math.max(m, Number(c.remoteBalanceSat)), 0);
  return { channels, receivableSat: accounts.lightningReceivableSat, largestSat, activeCount: active.length };
}

export function InvoiceCreator({ onCreated, compact }: { onCreated: (inv: CreatedInvoice) => void; compact?: boolean }) {
  const { bridge, toast, bumpRefresh } = usePlatform();
  const cap = useReceiveCapacity();
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amt = readSats(amount);
  const over = amt.value !== undefined && cap.channels.data !== undefined && amt.value > cap.largestSat;

  const create = async () => {
    if (amt.error !== undefined) {
      setError(amt.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.createInvoice({
        ...(amt.value === undefined || amt.value === 0 ? {} : { amountSat: String(amt.value) }),
        ...(memo.trim() === '' ? {} : { memo: memo.trim() }),
      });
      toast({ title: 'Invoice created', body: 'Share it with the payer. This page updates when it is paid.', tone: 'info' });
      bumpRefresh();
      onCreated({ paymentRequest: res.paymentRequest, rHashHex: res.rHashHex, amountSat: amt.value ?? null, memo: memo.trim() });
      setAmount('');
      setMemo('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-stack">
      <div className={compact ? 'p-stack' : 'p-grid'}>
        <div className={compact ? undefined : 'p-span-6'}>
          <Field label="Amount (sats — leave empty for a zero-amount invoice)" error={amt.error ?? null} hint="A zero-amount invoice lets the payer choose how much to send.">
            {(id) => (
              <div className="p-input-affix">
                <input id={id} className="p-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amt.error ? true : undefined} />
                <span>sats</span>
              </div>
            )}
          </Field>
        </div>
        <div className={compact ? undefined : 'p-span-6'}>
          <Field label="Memo (optional)" hint="Shown to the payer and stored with the invoice. Visible to anyone who sees the invoice.">
            {(id) => <input id={id} className="p-input" maxLength={300} value={memo} onChange={(e) => setMemo(e.target.value)} />}
          </Field>
        </div>
      </div>
      {over ? (
        <Notice tone="warning" title="Larger than any single channel can receive">
          Your largest channel can receive <Amount sats={cap.largestSat} /> (before the peer's reserve). A payer whose wallet can split payments across channels may still succeed; otherwise
          add inbound liquidity first.
        </Notice>
      ) : null}
      <div className="p-row">
        <button type="button" className="p-btn p-btn-primary" disabled={busy} onClick={() => void create()}>
          {busy ? 'Creating…' : 'Create invoice'}
        </button>
        <span className="p-hint">lnd sets the expiry: 24 hours from creation.</span>
      </div>
      {error !== null ? (
        <Notice tone="danger" title="Couldn't create the invoice">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}

/** QR + copy + live state for one invoice. */
export function InvoiceLive({ invoice, onNew }: { invoice: CreatedInvoice; onNew?: () => void }) {
  const { api, toast, bumpRefresh } = usePlatform();
  const { unit } = usePrefs();
  const [done, setDone] = useState(false);
  const poll = usePoll(() => api.invoices(), done ? null : 2500, [done]);
  const view: InvoiceView | undefined = poll.data?.find((i) => i.paymentHashHex === invoice.rHashHex);
  const status = view ? invoiceStatus(view) : 'open';
  const announced = useRef(false);

  useEffect(() => {
    if (status === 'settled' || status === 'canceled' || status === 'expired') setDone(true);
    if (status === 'settled' && !announced.current && view) {
      announced.current = true;
      toast({ title: 'Payment received', body: `${formatSats(view.paidSat, unit)} ${unit === 'btc' ? 'BTC' : 'sats'} over Lightning`, tone: 'positive' });
      bumpRefresh();
    }
  }, [status, view, toast, bumpRefresh, unit]);

  if (status === 'settled' && view) {
    return (
      <div className="p-stack" aria-live="polite">
        <div className="sw-result-head" data-tone="positive">
          <Icon name="check" size={20} />
          <div>
            <h2 className="p-panel-title">Payment received</h2>
            <div className="p-muted">It's in your Lightning balance now and can be spent immediately.</div>
          </div>
        </div>
        <div className="p-figure">
          <Amount sats={view.paidSat} />
        </div>
        <Details
          rows={[
            { label: 'Memo', value: view.memo || '—' },
            { label: 'Paid', value: view.settledAt ? dateTime(view.settledAt) : '—' },
            { label: 'Payment hash', value: `${view.paymentHashHex.slice(0, 16)}…`, mono: true },
          ]}
        />
        <div className="p-row">
          <Link to="/activity" className="p-btn">
            View in activity
          </Link>
          {onNew ? (
            <button type="button" className="p-btn p-btn-ghost" onClick={onNew}>
              Create another invoice
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="sw-qr-layout">
      <QrCode value={`lightning:${invoice.paymentRequest}`.toUpperCase()} size={232} label="Lightning invoice QR code" />
      <div className="p-stack" style={{ gap: 14 }}>
        <div className="p-spread">
          <div>
            <div className="p-stat-label">Requesting</div>
            <div className="p-stat-value">{invoice.amountSat ? <Amount sats={invoice.amountSat} /> : 'Any amount'}</div>
          </div>
          {status === 'open' ? <span className="sw-live">Waiting for payment</span> : <InvoiceStatusBadge status={status} />}
        </div>
        <Field label="Invoice">{() => <CopyValue value={invoice.paymentRequest} label="Lightning invoice" testId="invoice-request" />}</Field>
        {poll.error && !poll.data ? (
          <Notice tone="warning" title="Can't check the invoice status right now">
            {poll.error}. The invoice is still valid; this page retries automatically.
          </Notice>
        ) : view === undefined ? (
          <Skeleton height={18} width="60%" />
        ) : (
          <Details
            rows={[
              { label: 'Memo', value: view.memo || '—' },
              { label: 'Expires', value: status === 'expired' ? 'Expired' : `${dateTime(view.expiresAt)} (${timeUntil(view.expiresAt)})` },
            ]}
          />
        )}
        {status === 'expired' ? (
          <Notice tone="warning" title="This invoice expired unpaid">
            Payers can no longer use it. Create a new one.
          </Notice>
        ) : status === 'canceled' ? (
          <Notice tone="danger" title="This invoice was canceled" />
        ) : null}
        {onNew ? (
          <div className="p-row">
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={onNew}>
              <Icon name="plus" /> New invoice
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
