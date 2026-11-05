/**
 * Shared data hooks + building blocks for the overview pages (dashboard,
 * activity, accounts) and the Bitcoin asset page. Every number comes from a
 * bridge response; balance math is delegated to ../../balances.ts.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChannelsView, DecodedInvoiceView, PaymentView, WalletBalanceView } from '../../../modeb/bridge-client.js';
import type { InvoiceView, OnchainTxView, PoolView, SwapView } from '../../api.js';
import { computeAccounts, fundSegments, type Accounts } from '../../balances.js';
import { usePlatform, usePoll, usePrefs, useService, type Poll } from '../../context.js';
import { Amount, Badge, CopyField, Icon, Notice, type Tone } from '../../ui.js';
import './overview.css';

// ——— balances ———

export interface BalancesState {
  readonly wallet: Poll<WalletBalanceView>;
  readonly channels: Poll<ChannelsView>;
  /** null when the Pool sub-server is not running (nothing was asked). */
  readonly pool: Poll<PoolView | null>;
  readonly accounts: Accounts | undefined;
  readonly segments: ReturnType<typeof fundSegments> | undefined;
  readonly error: string | null;
  readonly reload: () => void;
}

export function useBalances(): BalancesState {
  const { bridge, api, refreshKey } = usePlatform();
  const poolSvc = useService('pool');
  const wallet = usePoll(() => bridge.walletBalance(), 15_000, [bridge, refreshKey]);
  const channels = usePoll(() => bridge.channels(), 15_000, [bridge, refreshKey]);
  const pool = usePoll<PoolView | null>(
    () => (poolSvc.running === true ? api.pool() : Promise.resolve(null)),
    60_000,
    [api, refreshKey, poolSvc.running],
  );
  const poolAccounts = pool.data?.accounts.ok === true ? pool.data.accounts.data : undefined;
  const accounts = useMemo(
    () => (wallet.data && channels.data ? computeAccounts(wallet.data, channels.data, poolAccounts ?? []) : undefined),
    [wallet.data, channels.data, poolAccounts],
  );
  const segments = useMemo(() => (accounts ? fundSegments(accounts) : undefined), [accounts]);
  return {
    wallet,
    channels,
    pool,
    accounts,
    segments,
    error: wallet.error ?? channels.error,
    reload: () => {
      void wallet.reload();
      void channels.reload();
      void pool.reload();
    },
  };
}

/**
 * Groups the disjoint fields of `Accounts` into the four headline buckets.
 * Each Accounts field appears in exactly one bucket, so
 * spendable + pending + locked === accounts.totalSat. Receivable is the
 * peers' side of your channels and is never part of the total.
 */
export function balanceSplit(a: Accounts) {
  return {
    spendable: a.onchainSpendableSat + a.lightningSpendableSat,
    pending: a.onchainUnconfirmedSat + a.channelsOpeningSat + a.lightningInFlightSat,
    locked: a.onchainLockedSat + a.poolAccountsSat,
    receivable: a.lightningReceivableSat,
  };
}

/** On-chain holdings (confirmed spendable + locked/anchor + unconfirmed), from Accounts. */
export function onchainHeld(a: Accounts): number {
  return a.onchainSpendableSat + a.onchainLockedSat + a.onchainUnconfirmedSat;
}

/** Lightning holdings you own (spendable + in flight + opening), from Accounts. */
export function lightningHeld(a: Accounts): number {
  return a.lightningSpendableSat + a.lightningInFlightSat + a.channelsOpeningSat;
}

/** The headline figure: big number in the viewer's unit, the other unit underneath. */
export function HeroFigure({ sats, label }: { sats: number; label: ReactNode }) {
  return (
    <div className="ov-hero-figure">
      <div className="p-stat-label">{label}</div>
      <div className="p-figure ov-figure">
        <Amount sats={sats} />
      </div>
      <AltUnit sats={sats} />
    </div>
  );
}

/** Same amount in the unit the viewer is not using (hidden with privacy mode). */
export function AltUnit({ sats }: { sats: number }) {
  const { unit } = usePrefs();
  return (
    <div className="p-muted ov-alt-unit">
      <Amount sats={sats} unit={unit === 'btc' ? 'sats' : 'btc'} />
    </div>
  );
}

/** One cell of the balance split strip. */
export function SplitCell({ label, sats, hint, swatch }: { label: string; sats: number; hint: ReactNode; swatch?: 'onchain' | 'outbound' | 'inbound' | 'locked' }) {
  return (
    <div className="ov-split-cell">
      <div className="p-stat-label ov-split-label">
        {swatch ? <span className="p-legend-swatch p-lbar-seg" data-fund={swatch} aria-hidden /> : null}
        {label}
      </div>
      <div className="ov-split-value">
        <Amount sats={sats} />
      </div>
      <div className="p-hint">{hint}</div>
    </div>
  );
}

/** Spendable / receivable / pending / locked, explained in one line each. */
export function BalanceSplit({ accounts }: { accounts: Accounts }) {
  const s = balanceSplit(accounts);
  return (
    <div className="ov-split" role="list" aria-label="Balance split">
      <div role="listitem">
        <SplitCell label="Spendable now" sats={s.spendable} hint="Confirmed on-chain plus your Lightning balance" />
      </div>
      <div role="listitem">
        <SplitCell label="Pending" sats={s.pending} hint="Unconfirmed, channels opening, payments in flight" />
      </div>
      <div role="listitem">
        <SplitCell label="Locked" sats={s.locked} hint="Anchor reserve, leased outputs, Pool accounts" />
      </div>
      <div role="listitem">
        <SplitCell label="Receivable" sats={s.receivable} hint="Inbound capacity. Not your funds" swatch="inbound" />
      </div>
    </div>
  );
}

// ——— key/value rows ———

export function KV({ rows }: { rows: readonly { k: ReactNode; v: ReactNode; hint?: ReactNode }[] }) {
  return (
    <dl className="ov-kv">
      {rows.map((r, i) => (
        <div className="ov-kv-row" key={i}>
          <dt>
            {r.k}
            {r.hint ? <div className="p-hint">{r.hint}</div> : null}
          </dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ——— activity (payments + invoices + swaps, merged) ———

export type ActivityType = 'sent' | 'received' | 'swap' | 'onchain';
export type ActivityState = 'completed' | 'pending' | 'failed' | 'open' | 'canceled';

export type ActivityRef =
  | { readonly kind: 'payment'; readonly payment: PaymentView }
  | { readonly kind: 'invoice'; readonly invoice: InvoiceView }
  | { readonly kind: 'swap'; readonly swap: SwapView }
  | { readonly kind: 'onchain'; readonly tx: OnchainTxView };

export interface ActivityItem {
  readonly key: string;
  readonly type: ActivityType;
  readonly title: string;
  readonly description: string;
  readonly amountSat: number;
  readonly sign: '+' | '-' | undefined;
  readonly feeSat: number | null;
  readonly state: ActivityState;
  readonly stateLabel: string;
  /** Epoch ms. */
  readonly at: number;
  readonly ref: ActivityRef;
}

export const STATE_TONE: Record<ActivityState, Tone> = {
  completed: 'positive',
  pending: 'warning',
  failed: 'danger',
  open: 'info',
  canceled: 'neutral',
};

const num = (s: string | number): number => {
  const v = typeof s === 'number' ? s : Number(s);
  return Number.isFinite(v) ? v : 0;
};

export const humanize = (s: string): string => {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function fromPayment(p: PaymentView): ActivityItem {
  const state: ActivityState = p.status === 'succeeded' ? 'completed' : p.status === 'failed' ? 'failed' : 'pending';
  return {
    key: `pay:${p.paymentHash}`,
    type: 'sent',
    title: 'Lightning payment',
    description: p.failureReason ? humanize(p.failureReason) : 'Outgoing payment',
    amountSat: num(p.valueSat),
    sign: state === 'completed' ? '-' : undefined,
    feeSat: state === 'failed' ? null : num(p.feeSat),
    state,
    stateLabel: state === 'completed' ? 'Sent' : state === 'failed' ? 'Failed' : 'In flight',
    at: Math.floor(num(p.creationTimeNs) / 1e6),
    ref: { kind: 'payment', payment: p },
  };
}

function fromInvoice(i: InvoiceView): ActivityItem {
  const state: ActivityState =
    i.state === 'settled' ? 'completed' : i.state === 'canceled' ? 'canceled' : i.state === 'accepted' ? 'pending' : 'open';
  return {
    key: `inv:${i.paymentHashHex}`,
    type: 'received',
    title: i.isKeysend ? 'Keysend received' : 'Lightning invoice',
    description: i.memo || (i.isKeysend ? 'Spontaneous payment' : 'No memo'),
    amountSat: state === 'completed' ? i.paidSat : i.valueSat,
    sign: state === 'completed' ? '+' : undefined,
    feeSat: null,
    state,
    stateLabel: state === 'completed' ? 'Received' : state === 'canceled' ? 'Canceled' : state === 'pending' ? 'Accepted' : 'Open',
    at: i.settledAt ?? i.createdAt,
    ref: { kind: 'invoice', invoice: i },
  };
}

export const SWAP_TITLE: Record<SwapView['kind'], string> = {
  'loop-out': 'Loop Out',
  'loop-in': 'Loop In',
  'static-loop-in': 'Static address Loop In',
};

export const SWAP_DIRECTION: Record<SwapView['kind'], string> = {
  'loop-out': 'Lightning to on-chain',
  'loop-in': 'On-chain to Lightning',
  'static-loop-in': 'Static address deposit to Lightning',
};

export function swapCost(s: SwapView): number {
  return s.costServerSat + s.costOnchainSat + s.costOffchainSat;
}

function fromSwap(s: SwapView): ActivityItem {
  const state: ActivityState = !s.done ? 'pending' : s.state === 'success' ? 'completed' : 'failed';
  return {
    key: `swap:${s.id}`,
    type: 'swap',
    title: SWAP_TITLE[s.kind],
    description: s.label || SWAP_DIRECTION[s.kind],
    amountSat: s.amountSat,
    sign: undefined,
    feeSat: s.done || swapCost(s) > 0 ? swapCost(s) : null,
    state,
    stateLabel: state === 'completed' ? 'Completed' : state === 'failed' ? 'Failed' : humanize(s.state),
    at: s.initiatedAt,
    ref: { kind: 'swap', swap: s },
  };
}

/** What lnd's own transaction labels mean, in plain words. */
export function onchainTitle(t: OnchainTxView): string {
  const l = t.label.toLowerCase();
  if (l.includes('openchannel')) return 'Channel funding';
  if (l.includes('closechannel')) return 'Channel close';
  if (l.includes('sweep')) return 'Sweep';
  if (l.includes('tapd') || l.includes('asset')) return 'Taproot Assets anchor';
  if (l.includes('loop')) return 'Loop swap transaction';
  return t.amountSat < 0 ? 'On-chain send' : 'On-chain deposit';
}

function fromOnchain(t: OnchainTxView): ActivityItem {
  const out = t.amountSat < 0;
  const state: ActivityState = t.confirmations > 0 ? 'completed' : 'pending';
  // lnd's amount for an outgoing transaction includes the miner fee; show the two apart.
  const amount = out ? Math.max(0, -t.amountSat - t.feeSat) : t.amountSat;
  const userLabel = t.label && !/^\d+:/.test(t.label) ? t.label : '';
  return {
    key: `tx:${t.txid}`,
    type: 'onchain',
    title: onchainTitle(t),
    description: userLabel || (out ? 'Bitcoin sent from this wallet' : 'Bitcoin received by this wallet'),
    amountSat: amount,
    sign: state === 'completed' ? (out ? '-' : '+') : undefined,
    feeSat: out ? t.feeSat : null,
    state,
    stateLabel: state === 'completed' ? `${t.confirmations.toLocaleString('en-US')} confirmation${t.confirmations === 1 ? '' : 's'}` : 'Unconfirmed',
    at: t.at,
    ref: { kind: 'onchain', tx: t },
  };
}

export interface ActivityData {
  readonly items: readonly ActivityItem[];
  readonly loading: boolean;
  readonly payments: Poll<readonly PaymentView[]>;
  readonly invoices: Poll<readonly InvoiceView[]>;
  /** null when the Loop sub-server is not running (nothing was asked). */
  readonly swaps: Poll<readonly SwapView[] | null>;
  readonly onchain: Poll<readonly OnchainTxView[]>;
  readonly reload: () => void;
}

export const PAYMENTS_LOADED = 200;

export function useActivity(): ActivityData {
  const { api, bridge, refreshKey } = usePlatform();
  const loop = useService('loop');
  const payments = usePoll(async () => (await bridge.payments(PAYMENTS_LOADED)).payments, 20_000, [bridge, refreshKey]);
  const invoices = usePoll(() => api.invoices(), 20_000, [api, refreshKey]);
  const swaps = usePoll<readonly SwapView[] | null>(
    () => (loop.running === true ? api.swaps() : Promise.resolve(null)),
    20_000,
    [api, refreshKey, loop.running],
  );
  const onchain = usePoll(() => api.transactions(), 20_000, [api, refreshKey]);
  const items = useMemo(() => {
    const all: ActivityItem[] = [
      ...(payments.data ?? []).map(fromPayment),
      ...(invoices.data ?? []).map(fromInvoice),
      ...(swaps.data ?? []).map(fromSwap),
      ...(onchain.data ?? []).map(fromOnchain),
    ];
    return all.sort((a, b) => b.at - a.at);
  }, [payments.data, invoices.data, swaps.data, onchain.data]);
  return {
    items,
    loading: payments.loading && invoices.loading,
    payments,
    invoices,
    swaps,
    onchain,
    reload: () => {
      void onchain.reload();
      void payments.reload();
      void invoices.reload();
      void swaps.reload();
    },
  };
}

/** Problems loading any activity source, each stated plainly. */
export function ActivitySourceNotices({ activity }: { activity: ActivityData }) {
  const loop = useService('loop');
  const out: ReactNode[] = [];
  if (activity.payments.error) {
    out.push(
      <Notice key="p" tone="danger" title="Outgoing payments could not be loaded" action={<RetryButton onClick={() => void activity.payments.reload()} />}>
        {activity.payments.error}
      </Notice>,
    );
  }
  if (activity.invoices.error) {
    out.push(
      <Notice key="i" tone="danger" title="Incoming invoices could not be loaded" action={<RetryButton onClick={() => void activity.invoices.reload()} />}>
        {activity.invoices.error}
      </Notice>,
    );
  }
  if (activity.swaps.error) {
    out.push(
      <Notice key="s" tone="warning" title="Loop swaps could not be loaded" action={<RetryButton onClick={() => void activity.swaps.reload()} />}>
        {activity.swaps.error}
      </Notice>,
    );
  }
  if (activity.onchain.error) {
    out.push(
      <Notice key="o" tone="danger" title="On-chain transactions could not be loaded" action={<RetryButton onClick={() => void activity.onchain.reload()} />}>
        {activity.onchain.error}
      </Notice>,
    );
  }
  if (!activity.swaps.error && loop.running === false) {
    out.push(
      <Notice key="l" tone="info" title="Loop swaps are not shown">
        The Loop sub-server is not running in litd{loop.error ? ` (${loop.error})` : ''}, so swap history is unavailable until it starts.
      </Notice>,
    );
  }
  return out.length ? <div className="p-stack">{out}</div> : null;
}

export function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="p-btn p-btn-sm" onClick={onClick}>
      <Icon name="refresh" />
      Retry
    </button>
  );
}

export function TypeGlyph({ item }: { item: ActivityItem }) {
  const icon = item.type === 'sent' ? 'send' : item.type === 'received' ? 'receive' : item.type === 'onchain' ? 'bitcoin' : 'loop';
  return (
    <span className="ov-glyph" data-type={item.type} aria-hidden>
      <Icon name={icon} size={16} />
    </span>
  );
}

export function ActivityAmount({ item }: { item: ActivityItem }) {
  return <Amount sats={item.amountSat} sign={item.sign} className={item.sign === '+' ? 'ov-amount-in' : undefined} />;
}

export function StateBadge({ item }: { item: ActivityItem }) {
  return <Badge tone={STATE_TONE[item.state]}>{item.stateLabel}</Badge>;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Compact date for table cells: the year only when it is not this year. */
export function formatShortDate(ms: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Full details for one activity row, shown in a Sheet. Never shows a preimage. */
export function ActivityDetails({ item }: { item: ActivityItem }) {
  const head = (
    <div className="ov-detail-head">
      <TypeGlyph item={item} />
      <div>
        <div className="ov-detail-amount">
          <Amount sats={item.amountSat} sign={item.sign} />
        </div>
        <div className="p-row" style={{ gap: 8 }}>
          <StateBadge item={item} />
          <span className="p-muted">{formatDate(item.at)}</span>
        </div>
      </div>
    </div>
  );
  const ref = item.ref;
  if (ref.kind === 'payment') {
    const p = ref.payment;
    const fee = num(p.feeSat);
    return (
      <div className="p-stack">
        {head}
        <KV
          rows={[
            { k: 'Type', v: 'Outgoing Lightning payment' },
            { k: 'Status', v: humanize(p.status) },
            { k: 'Amount', v: <Amount sats={num(p.valueSat)} /> },
            { k: 'Routing fee', v: <Amount sats={fee} /> },
            ...(item.state === 'completed' ? [{ k: 'Total paid', v: <Amount sats={num(p.valueSat) + fee} /> }] : []),
            { k: 'Created', v: formatDate(item.at) },
            ...(p.failureReason ? [{ k: 'Failure reason', v: humanize(p.failureReason) }] : []),
          ]}
        />
        <div className="p-field">
          <span className="p-label">Payment hash</span>
          <CopyField value={p.paymentHash} label="Payment hash" />
        </div>
        <PaymentRequestDetails paymentRequest={p.paymentRequest} />
      </div>
    );
  }
  if (ref.kind === 'onchain') {
    const t = ref.tx;
    const out = t.amountSat < 0;
    return (
      <div className="p-stack">
        {head}
        <KV
          rows={[
            { k: 'Type', v: onchainTitle(t) },
            { k: 'Direction', v: out ? 'Sent from this wallet' : 'Received by this wallet' },
            { k: out ? 'Amount sent' : 'Amount received', v: <Amount sats={item.amountSat} /> },
            ...(out ? [{ k: 'Miner fee', v: <Amount sats={t.feeSat} /> }, { k: 'Total leaving the wallet', v: <Amount sats={-t.amountSat} /> }] : []),
            { k: 'Confirmations', v: t.confirmations > 0 ? `${t.confirmations.toLocaleString('en-US')} (block ${t.blockHeight.toLocaleString('en-US')})` : 'Not yet confirmed' },
            { k: 'Time', v: formatDate(t.at) },
            ...(t.label ? [{ k: 'Wallet label', v: <span className="p-mono">{t.label}</span>, hint: 'Set by lnd or the app that made this transaction' }] : []),
          ]}
        />
        <div className="p-field">
          <span className="p-label">Transaction id</span>
          <CopyField value={t.txid} label="Transaction id" />
        </div>
        {t.addresses.length ? (
          <div className="p-field">
            <span className="p-label">{out ? 'Change address (this wallet)' : 'Receiving address'}</span>
            {t.addresses.map((a) => (
              <CopyField key={a} value={a} label="Address" />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (ref.kind === 'invoice') {
    const i = ref.invoice;
    return (
      <div className="p-stack">
        {head}
        <KV
          rows={[
            { k: 'Type', v: i.isKeysend ? 'Keysend (spontaneous) payment' : 'Lightning invoice' },
            { k: 'Memo', v: i.memo || <span className="p-faint">None</span> },
            { k: 'State', v: humanize(i.state) },
            { k: 'Requested', v: i.valueSat > 0 ? <Amount sats={i.valueSat} /> : <span className="p-faint">Any amount</span> },
            { k: 'Received', v: <Amount sats={i.paidSat} /> },
            { k: 'Created', v: formatDate(i.createdAt) },
            ...(i.settledAt !== null ? [{ k: 'Settled', v: formatDate(i.settledAt) }] : []),
            ...(i.state === 'open' ? [{ k: 'Expires', v: formatDate(i.expiresAt) }] : []),
          ]}
        />
        <div className="p-field">
          <span className="p-label">Payment hash</span>
          <CopyField value={i.paymentHashHex} label="Payment hash" />
        </div>
        {i.paymentRequest ? (
          <div className="p-field">
            <span className="p-label">Payment request</span>
            <CopyField value={i.paymentRequest} label="Payment request" />
          </div>
        ) : null}
      </div>
    );
  }
  const s = ref.swap;
  return (
    <div className="p-stack">
      {head}
      <KV
        rows={[
          { k: 'Type', v: `${SWAP_TITLE[s.kind]} (${SWAP_DIRECTION[s.kind].toLowerCase()})` },
          { k: 'State', v: humanize(s.state) },
          ...(s.failureReason ? [{ k: 'Failure reason', v: humanize(s.failureReason) }] : []),
          { k: 'Swap amount', v: <Amount sats={s.amountSat} /> },
          { k: 'Started', v: formatDate(s.initiatedAt) },
          { k: 'Last update', v: formatDate(s.updatedAt) },
          ...(s.label ? [{ k: 'Label', v: s.label }] : []),
        ]}
      />
      <div>
        <div className="p-label ov-sub-label">Costs{s.done ? '' : ' so far'}</div>
        <dl className="p-dl">
          <dt>Server fee</dt>
          <dd><Amount sats={s.costServerSat} /></dd>
          <dt>On-chain fee</dt>
          <dd><Amount sats={s.costOnchainSat} /></dd>
          <dt>Off-chain (routing) fee</dt>
          <dd><Amount sats={s.costOffchainSat} /></dd>
          <dt className="p-dl-total">Total cost</dt>
          <dd className="p-dl-total"><Amount sats={swapCost(s)} /></dd>
        </dl>
      </div>
      <div className="p-field">
        <span className="p-label">Swap id</span>
        <CopyField value={s.id} label="Swap id" />
      </div>
      {s.htlcAddress ? (
        <div className="p-field">
          <span className="p-label">HTLC address</span>
          <CopyField value={s.htlcAddress} label="HTLC address" />
        </div>
      ) : null}
      {s.outgoingChanIds.length ? (
        <KV rows={[{ k: 'Outgoing channels', v: <span className="p-mono">{s.outgoingChanIds.join(', ')}</span> }]} />
      ) : null}
      {s.lastHopHex ? (
        <div className="p-field">
          <span className="p-label">Last hop</span>
          <CopyField value={s.lastHopHex} label="Last hop public key" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Memo and destination of an outgoing payment, decoded from its payment
 * request on demand (lnd's payment list keeps the request, not its fields).
 */
function PaymentRequestDetails({ paymentRequest }: { paymentRequest: string | undefined }) {
  const { bridge } = usePlatform();
  const [decoded, setDecoded] = useState<DecodedInvoiceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDecoded(null);
    setError(null);
    if (!paymentRequest) return;
    let live = true;
    bridge.decodeInvoice(paymentRequest).then(
      (d) => live && setDecoded(d),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [bridge, paymentRequest]);
  if (!paymentRequest) {
    return <p className="p-hint">This payment was made without an invoice (for example keysend), so there is no memo or invoice destination to show.</p>;
  }
  return (
    <>
      {error ? (
        <Notice tone="warning" title="The invoice for this payment could not be decoded">
          {error}
        </Notice>
      ) : (
        <KV
          rows={[
            { k: 'Memo', v: decoded === null ? <span className="p-faint">Decoding…</span> : decoded.memo || <span className="p-faint">None</span> },
            { k: 'Destination node', v: decoded === null ? <span className="p-faint">Decoding…</span> : <span className="p-mono">{decoded.destination}</span> },
          ]}
        />
      )}
      <div className="p-field">
        <span className="p-label">Payment request</span>
        <CopyField value={paymentRequest} label="Payment request" />
      </div>
    </>
  );
}
