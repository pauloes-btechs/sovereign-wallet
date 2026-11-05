/**
 * Shared Loop building blocks: service availability, amount parsing and
 * validation against live terms, the quote breakdown, swap state copy and
 * the live swap status view. Used by the Loop section, the liquidity pages
 * and Transfers & swaps.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { LoopQuote, LoopTermsView, Range, SwapKind, SwapView } from '../../../api.js';
import { usePlatform, usePoll, useService } from '../../../context.js';
import { Amount, Badge, Breakdown, Notice, relativeTime, shortId, Skeleton, Timeline, formatSats, type StepState, type Tone } from '../../../ui.js';
import { Link } from '../../../router.js';
import './loop.css';

// ——— availability ———

export type LoopPhase = 'checking' | 'down' | 'offline' | 'unreachable' | 'ready';

export interface LoopStatus {
  readonly phase: LoopPhase;
  readonly terms: LoopTermsView | undefined;
  readonly operatorMode: 'offline' | 'configured' | 'upstream-default' | undefined;
  readonly operatorHost: string | undefined;
  /** What is wrong, in plain words (null when ready / checking). */
  readonly reason: string | null;
  readonly fix: string | null;
  readonly reload: () => Promise<void>;
}

export const LOOP_SERVER_FIX =
  'On regtest, run Lightning Labs’ regtest swap server (the lightninglabs/loopserver image) and restart the bridge with --loopServer <host:port>. On signet and mainnet, loopd uses Lightning Labs’ hosted swap server automatically.';

export const isRange = (r: Range | undefined): r is { minSat: number; maxSat: number } => r !== undefined && !('error' in r);

export function useLoopStatus(): LoopStatus {
  const { api, services, refreshKey } = usePlatform();
  const loopd = useService('loop');
  const terms = usePoll(() => api.loopTerms(), 30_000, [api, refreshKey]);
  const op = services.data?.operators.loop;
  const base = { terms: terms.data, operatorMode: op?.mode, operatorHost: op?.host, reload: terms.reload };

  if (services.data === undefined || (terms.data === undefined && terms.error === null)) {
    return { ...base, phase: 'checking', reason: null, fix: null };
  }
  if (loopd.running === false) {
    return {
      ...base,
      phase: 'down',
      reason: `The Loop sub-server (loopd) inside litd is not running${loopd.error ? `: ${loopd.error}` : '.'}`,
      fix: 'litd starts loopd with the node; check Node overview for the error.',
    };
  }
  if (op?.mode === 'offline') {
    return {
      ...base,
      phase: 'offline',
      reason: `loopd is running, but this node has no Loop swap server configured: it points at ${op.host ?? 'an unroutable address'} on purpose, so nothing can contact Lightning Labs’ servers by accident. Terms, quotes, swaps, the static address and AutoLoop changes all need the server.`,
      fix: LOOP_SERVER_FIX,
    };
  }
  const t = terms.data;
  if (terms.error !== null || t === undefined || (!isRange(t.loopOut) && !isRange(t.loopIn))) {
    const err = terms.error ?? (t !== undefined && 'error' in t.loopOut ? t.loopOut.error : 'unknown error');
    return {
      ...base,
      phase: 'unreachable',
      reason: `loopd could not reach the swap server${op?.host ? ` at ${op.host}` : ''}: ${err}`,
      fix: 'Check the server is running and reachable from this machine, then retry.',
    };
  }
  return { ...base, phase: 'ready', reason: null, fix: null };
}

/** The one notice every Loop surface shows when the swap server can't be used. */
export function LoopUnavailableNotice({ status, action }: { status: LoopStatus; action?: ReactNode }) {
  if (status.phase === 'ready' || status.phase === 'checking') return null;
  const title =
    status.phase === 'down' ? 'Loop is not running' : status.phase === 'offline' ? 'Loop swap server not configured' : 'Loop swap server unreachable';
  return (
    <Notice
      tone="warning"
      title={title}
      action={
        action ?? (
          <button type="button" className="p-btn p-btn-sm" onClick={() => void status.reload()}>
            Retry
          </button>
        )
      }
    >
      <p className="lp-notice-p">{status.reason}</p>
      {status.fix ? <p className="lp-notice-p p-faint">{status.fix}</p> : null}
    </Notice>
  );
}

export function OperatorBadge({ status }: { status: LoopStatus }) {
  const map: Record<LoopPhase, [Tone, string]> = {
    checking: ['neutral', 'Checking'],
    down: ['danger', 'loopd not running'],
    offline: ['warning', 'Swap server offline'],
    unreachable: ['danger', 'Swap server unreachable'],
    ready: ['positive', 'Swap server online'],
  };
  const [tone, label] = map[status.phase];
  return <Badge tone={tone}>{label}</Badge>;
}

// ——— amounts ———

/** Parse a whole-sats input; null when empty or invalid. */
export function parseSats(input: string): number | null {
  const s = input.replace(/[,_\s]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Validation message for a swap amount against live terms and a balance ceiling. */
export function amountError(raw: string, range: Range | undefined, ceiling: { sats: number; what: string } | null): string | null {
  if (raw.trim() === '') return null;
  const n = parseSats(raw);
  if (n === null) return 'Enter a whole number of sats.';
  if (isRange(range)) {
    if (n < range.minSat) return `The swap server’s minimum is ${formatSats(range.minSat, 'sats')} sats.`;
    if (n > range.maxSat) return `The swap server’s maximum is ${formatSats(range.maxSat, 'sats')} sats.`;
  }
  if (ceiling !== null && n > ceiling.sats) return `That is more than your ${ceiling.what} (${formatSats(ceiling.sats, 'sats')} sats).`;
  return null;
}

export function RangeHint({ range }: { range: Range | undefined }) {
  if (range === undefined) return <>Checking the server’s limits…</>;
  if (!isRange(range)) return <>Server limits unavailable until the swap server answers.</>;
  return (
    <>
      Server limits: <Amount sats={range.minSat} /> to <Amount sats={range.maxSat} />
    </>
  );
}

/** Read `?key=` from the hash (e.g. #/loop/out?amount=500000). */
export function hashParam(key: string): string | null {
  const q = window.location.hash.split('?')[1];
  return q === undefined ? null : new URLSearchParams(q).get(key);
}

// ——— quotes ———

export function QuoteBreakdown({ quote }: { quote: LoopQuote }) {
  const f = quote.fees;
  const out = quote.direction === 'loop-out';
  return (
    <Breakdown
      rows={[
        { label: 'Swap fee', sats: f.swapFeeSat, note: quote.swapFeePpm > 0 ? `${quote.swapFeePpm.toLocaleString('en-US')} ppm, charged by the swap server` : 'Charged by the swap server' },
        ...(out
          ? [{ label: 'Of which paid up front', sats: f.prepayFeeSat, note: 'Part of the swap fee above, not added to it. Paid first over Lightning; the server keeps it if the swap is abandoned.' }]
          : []),
        { label: out ? 'Miner fee (your sweep)' : 'Miner fee (your HTLC)', sats: f.minerFeeSat, note: `Estimate at a ${quote.confTarget}-block target; the bridge refuses if it rises above your ceiling` },
        { label: 'Lightning routing fee', sats: f.routingFeeSat, note: out ? 'Not quoted by Loop; paid at payment time' : 'None: the server pays you' },
      ]}
      total={{ label: 'Fee ceiling you authorize', sats: f.totalSat }}
    />
  );
}

/** What the user ends up with, from the quote's own numbers. */
export function receivedSat(q: LoopQuote): number {
  return q.direction === 'loop-out' ? q.amountSat - q.fees.swapFeeSat - q.fees.minerFeeSat : q.amountSat - q.fees.swapFeeSat;
}

/** Plain-language rendering of a classified quote failure. */
export function quoteFailureCopy(reason: string, message: string, status: LoopStatus): { title: string; body: string; fix: string | null } {
  if (reason === 'unavailable' && (status.phase === 'offline' || status.phase === 'down' || status.phase === 'unreachable')) {
    const why =
      status.phase === 'offline'
        ? `no Loop swap server is configured for this node (loopd points at ${status.operatorHost ?? 'an unroutable address'} on purpose)`
        : status.phase === 'down'
          ? 'loopd is not running'
          : `the swap server${status.operatorHost ? ` at ${status.operatorHost}` : ''} did not answer`;
    return { title: 'No quote: the swap server is not reachable', body: `loopd answered “unavailable” because ${why}.`, fix: status.fix };
  }
  const titles: Record<string, string> = {
    unavailable: 'No quote: Loop is unavailable',
    unauthenticated: 'No quote: not authorized',
    'out-of-terms': 'No quote: amount out of range',
    'insufficient-funds': 'No quote: not enough balance',
    'no-affordable-quote': 'No affordable quote right now',
  };
  return { title: titles[reason] ?? 'No quote', body: message, fix: null };
}

// ——— swap state ———

export const KIND_LABEL: Record<SwapKind, string> = {
  'loop-out': 'Loop Out',
  'loop-in': 'Loop In',
  'static-loop-in': 'Static Loop In',
};

const STATE_LABEL: Record<string, string> = {
  initiated: 'Initiated',
  htlc_published: 'HTLC published',
  preimage_revealed: 'Preimage revealed',
  invoice_settled: 'Invoice settled',
  success: 'Completed',
  failed: 'Failed',
};

export const stateLabel = (s: string): string => STATE_LABEL[s] ?? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function SwapStateBadge({ swap }: { swap: Pick<SwapView, 'state' | 'done'> }) {
  const tone: Tone = swap.state === 'success' ? 'positive' : swap.state === 'failed' ? 'danger' : 'info';
  return <Badge tone={tone}>{stateLabel(swap.state)}</Badge>;
}

export const failureCopy = (r: string | null): string | null => (r === null ? null : r.replace(/^failure_reason_/, '').replace(/_/g, ' '));

export const swapCostSat = (s: SwapView): number => s.costServerSat + s.costOnchainSat + s.costOffchainSat;

export function elapsed(s: SwapView, now = Date.now()): string {
  const end = s.done ? s.updatedAt : now;
  const sec = Math.max(0, Math.round((end - s.initiatedAt) / 1000));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d`;
}

const STEPS: Record<SwapKind, readonly { state: string; title: string; body: string }[]> = {
  'loop-out': [
    { state: 'initiated', title: 'Swap requested', body: 'Prepayment and swap payment are in flight over Lightning; they settle only when you reveal the preimage.' },
    { state: 'htlc_published', title: 'Server published the on-chain HTLC', body: 'The server locked the amount in an HTLC that only your preimage can claim.' },
    { state: 'preimage_revealed', title: 'Sweeping to your address', body: 'loopd revealed the preimage and broadcast the sweep transaction.' },
    { state: 'success', title: 'Completed', body: 'The sweep confirmed. Funds are on-chain at the destination.' },
  ],
  'loop-in': [
    { state: 'initiated', title: 'Swap requested', body: 'loopd agreed terms with the server.' },
    { state: 'htlc_published', title: 'Your on-chain HTLC published', body: 'Your funds are locked in an HTLC the server can claim only after paying you.' },
    { state: 'invoice_settled', title: 'Server paid you over Lightning', body: 'Your channel’s outbound balance increased.' },
    { state: 'success', title: 'Completed', body: 'The server swept the HTLC on-chain.' },
  ],
  'static-loop-in': [
    { state: 'initiated', title: 'Swap requested', body: 'The selected deposits are reserved for this Loop In.' },
    { state: 'invoice_settled', title: 'Server paid you over Lightning', body: 'Your channel’s outbound balance increased.' },
    { state: 'success', title: 'Completed', body: 'The server co-signed the deposit sweep.' },
  ],
};

export function swapTimeline(s: SwapView): { title: ReactNode; body?: ReactNode; state: StepState }[] {
  const steps = STEPS[s.kind];
  const first = steps[0];
  if (s.state === 'failed') {
    // loopd reports the terminal state only, not the step it failed at.
    return [
      ...(first ? [{ title: first.title, body: first.body, state: 'done' as const }] : []),
      {
        title: 'Swap failed',
        body: `Reason: ${failureCopy(s.failureReason) ?? 'none reported'}. Fees actually paid are in the receipt.`,
        state: 'failed' as const,
      },
    ];
  }
  const idx = s.state === 'success' ? steps.length - 1 : Math.max(0, steps.findIndex((x) => x.state === s.state));
  return steps.map((step, i) => {
    const state: StepState = i < idx || (i === idx && i === steps.length - 1) ? 'done' : i === idx ? 'current' : 'pending';
    const body = step.state === 'htlc_published' && s.htlcAddress && state !== 'pending' ? `${step.body} HTLC: ${shortId(s.htlcAddress, 14, 8)}` : step.body;
    return { title: step.title, body, state };
  });
}

export function SwapReceipt({ swap }: { swap: SwapView }) {
  return (
    <dl className="p-dl lp-receipt">
      <dt>Type</dt>
      <dd>{KIND_LABEL[swap.kind]}</dd>
      <dt>Amount</dt>
      <dd>
        <Amount sats={swap.amountSat} />
      </dd>
      <dt>Server fee paid</dt>
      <dd>
        <Amount sats={swap.costServerSat} />
      </dd>
      <dt>On-chain fees paid</dt>
      <dd>
        <Amount sats={swap.costOnchainSat} />
      </dd>
      <dt>Off-chain fees paid</dt>
      <dd>
        <Amount sats={swap.costOffchainSat} />
      </dd>
      <dt className="p-dl-total">Total cost so far</dt>
      <dd className="p-dl-total">
        <Amount sats={swapCostSat(swap)} />
      </dd>
      <dt>Started</dt>
      <dd>{new Date(swap.initiatedAt).toLocaleString('en-US')}</dd>
      <dt>Last update</dt>
      <dd>{relativeTime(swap.updatedAt)}</dd>
      <dt>Elapsed</dt>
      <dd>{elapsed(swap)}</dd>
      {swap.htlcAddress ? (
        <>
          <dt>HTLC address</dt>
          <dd className="p-mono lp-break">{swap.htlcAddress}</dd>
        </>
      ) : null}
      {swap.outgoingChanIds.length > 0 ? (
        <>
          <dt>Outgoing channels</dt>
          <dd className="p-mono">{swap.outgoingChanIds.join(', ')}</dd>
        </>
      ) : null}
      {swap.lastHopHex ? (
        <>
          <dt>Last hop</dt>
          <dd className="p-mono">{shortId(swap.lastHopHex, 10, 8)}</dd>
        </>
      ) : null}
      {swap.label ? (
        <>
          <dt>Label</dt>
          <dd>{swap.label}</dd>
        </>
      ) : null}
      <dt>Swap id</dt>
      <dd className="p-mono lp-break">{swap.id}</dd>
    </dl>
  );
}

/** Live status of one swap: polls until it is done. */
export function SwapProgress({ swapId, onDone }: { swapId: string; onDone?: (s: SwapView) => void }) {
  const { api, bumpRefresh } = usePlatform();
  const [finished, setFinished] = useState(false);
  const poll = usePoll(() => api.swap(swapId), finished ? null : 3_000, [swapId, finished]);
  const s = poll.data;
  useEffect(() => {
    if (s?.done === true && !finished) {
      setFinished(true);
      bumpRefresh();
      onDone?.(s);
    }
  }, [s, finished, bumpRefresh, onDone]);

  if (s === undefined) {
    return poll.error ? (
      <Notice tone="danger" title="Could not read the swap status" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void poll.reload()}>Retry</button>}>
        {poll.error}
      </Notice>
    ) : (
      <div className="p-stack">
        <Skeleton height={20} width="40%" />
        <Skeleton height={120} />
      </div>
    );
  }
  return (
    <div className="lp-progress">
      <div>
        <div className="p-spread lp-progress-head">
          <span className="p-panel-title">{KIND_LABEL[s.kind]} status</span>
          <SwapStateBadge swap={s} />
        </div>
        <Timeline items={swapTimeline(s)} />
        {s.done ? null : <p className="p-hint">Updates every 3 seconds. You can leave this page; the swap continues in loopd.</p>}
        {poll.error ? <p className="p-error-text">Last refresh failed: {poll.error}</p> : null}
      </div>
      <div>
        <div className="p-panel-title lp-progress-head">Receipt</div>
        <SwapReceipt swap={s} />
        <p className="p-hint">
          <Link to="/loop/history">See all swaps</Link>
        </p>
      </div>
    </div>
  );
}
