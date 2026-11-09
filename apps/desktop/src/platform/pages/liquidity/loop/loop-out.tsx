import { useState } from 'react';
import type { LoopQuote, QuoteResult } from '../../../api.js';
import { computeAccounts } from '../../../balances.js';
import { usePlatform, usePoll } from '../../../context.js';
import { Amount, Field, Icon, Notice, Panel, Segmented, shortId, Skeleton, Steps } from '../../../ui.js';
import {
  amountError,
  hashParam,
  LoopUnavailableNotice,
  parseSats,
  QuoteBreakdown,
  quoteFailureCopy,
  RangeHint,
  receivedSat,
  SwapProgress,
  useLoopStatus,
  type LoopStatus,
} from './shared.js';
import { externalAddressProblem } from '../../payments/address-guard.js';

const STEPS = ['Amount', 'Channels and destination', 'Review', 'Status'] as const;

const SPEEDS = [
  { value: '2', label: 'Fast · 2 blocks' },
  { value: '9', label: 'Standard · 9 blocks' },
  { value: '30', label: 'Economy · 30 blocks' },
] as const;
type Speed = (typeof SPEEDS)[number]['value'];


export function LoopOutWizard({ status: given }: { status?: LoopStatus }) {
  const own = useLoopStatus();
  const status = given ?? own;
  const { api, bridge, refreshKey, toast, bumpRefresh } = usePlatform();
  const channels = usePoll(() => bridge.channels(), 30_000, [bridge, refreshKey]);
  const wallet = usePoll(() => bridge.walletBalance(), 30_000, [bridge, refreshKey]);
  const accounts = computeAccounts(wallet.data, channels.data);

  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState(hashParam('amount') ?? '');
  const [chanIds, setChanIds] = useState<string[]>(() => {
    const c = hashParam('chan');
    return c === null ? [] : [c];
  });
  const [destKind, setDestKind] = useState<'wallet' | 'external'>('wallet');
  const [dest, setDest] = useState('');
  const [speed, setSpeed] = useState<Speed>('9');
  const [label, setLabel] = useState('');
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [execErr, setExecErr] = useState<string | null>(null);
  const [started, setStarted] = useState<{ swapId: string; destAddress: string } | null>(null);

  const range = status.terms?.loopOut;
  const open = channels.data?.open.filter((c) => c.state === 'open') ?? [];
  const selectedOutbound = chanIds.length === 0 ? accounts.lightningSpendableSat : open.filter((c) => chanIds.includes(c.chanId)).reduce((s, c) => s + Number(c.localBalanceSat), 0);
  const amtErr = amountError(amount, range, { sats: accounts.lightningSpendableSat, what: 'spendable Lightning balance' });
  const sats = parseSats(amount);
  const chanErr = chanIds.length > 0 && sats !== null && sats > selectedOutbound ? 'The selected channels don’t have that much outbound. Select more channels or none.' : null;
  const destErr = destKind === 'external' ? externalAddressProblem(dest) : null;

  const getQuote = async () => {
    if (sats === null) return;
    setQuoting(true);
    setQuoteErr(null);
    setQuote(null);
    setAgree(false);
    setExecErr(null);
    try {
      setQuote(await api.loopQuote('loop-out', sats, Number(speed)));
    } catch (e) {
      setQuoteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setQuoting(false);
    }
  };

  const start = async (q: LoopQuote) => {
    setBusy(true);
    setExecErr(null);
    try {
      const r = await api.loopOut({
        amountSat: q.amountSat,
        ...(destKind === 'external' ? { destAddress: dest.trim() } : {}),
        sweepConfTarget: Number(speed),
        ...(chanIds.length > 0 ? { outgoingChanIds: chanIds } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
        authorization: { amountSat: q.amountSat, maxTotalFeeSat: q.fees.totalSat },
      });
      setStarted({ swapId: r.swapId, destAddress: r.destAddress });
      setStep(3);
      toast({ title: 'Loop Out started', body: `Swap ${shortId(r.swapId)}`, tone: 'positive' });
      bumpRefresh();
    } catch (e) {
      setExecErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep(0);
    setQuote(null);
    setStarted(null);
    setAgree(false);
    setExecErr(null);
  };

  return (
    <Panel title="Loop Out" note="Move Lightning balance to an on-chain address. Your channel gains the same amount of receiving capacity.">
      <Steps steps={STEPS} current={step} />
      {step < 2 ? <LoopUnavailableNotice status={status} /> : null}
      <div className={step < 2 ? 'lp-wizard' : undefined} style={{ marginTop: step < 2 && status.phase !== 'ready' && status.phase !== 'checking' ? 'var(--sovl-space-5)' : undefined }}>
        <div>
          {step === 0 ? (
            <div className="lp-form">
              <Field label="Amount" hint={<RangeHint range={range} />} error={amtErr}>
                {(id) => (
                  <div className="p-input-affix">
                    <input id={id} className="p-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 500000" aria-invalid={amtErr !== null} />
                    <span>sats</span>
                  </div>
                )}
              </Field>
              <div className="lp-kv">
                <dt>Spendable over Lightning now</dt>
                <dd>{channels.data ? <Amount sats={accounts.lightningSpendableSat} /> : <Skeleton width={90} />}</dd>
                <dt>Receivable now</dt>
                <dd>{channels.data ? <Amount sats={accounts.lightningReceivableSat} /> : <Skeleton width={90} />}</dd>
              </div>
              <div className="lp-form-actions">
                <button type="button" className="p-btn p-btn-primary" disabled={sats === null || amtErr !== null} onClick={() => setStep(1)}>
                  Continue
                </button>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="lp-form">
              <Field label="Outgoing channels" hint="Optional. Leave all unselected to let LND pick the route.">
                {() =>
                  channels.data === undefined ? (
                    <Skeleton height={56} />
                  ) : open.length === 0 ? (
                    <Notice tone="warning" title="No open channels">Loop Out pays the server over a channel; open one first.</Notice>
                  ) : (
                    <div className="lp-choices">
                      {open.map((c) => (
                        <label className="lp-choice" key={c.chanId}>
                          <input
                            type="checkbox"
                            checked={chanIds.includes(c.chanId)}
                            onChange={(e) => setChanIds((ids) => (e.target.checked ? [...ids, c.chanId] : ids.filter((x) => x !== c.chanId)))}
                          />
                          <span className="lp-choice-main">
                            <span>
                              Channel <span className="p-mono">{c.chanId}</span>
                            </span>
                            <span className="p-faint">Peer {shortId(c.remotePubkey, 10, 6)}</span>
                          </span>
                          <span className="p-num">
                            <Amount sats={c.localBalanceSat} /> <span className="p-faint">outbound</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )
                }
              </Field>
              {chanErr ? <p className="p-error-text">{chanErr}</p> : null}
              <Field label="Send the on-chain funds to">
                {() => (
                  <Segmented
                    label="Destination"
                    value={destKind}
                    onChange={setDestKind}
                    options={[
                      { value: 'wallet', label: 'This wallet' },
                      { value: 'external', label: 'An external address' },
                    ]}
                  />
                )}
              </Field>
              {destKind === 'wallet' ? (
                <p className="p-hint">The bridge creates a fresh taproot address in this wallet when the swap starts.</p>
              ) : (
                <Field label="External Bitcoin address" error={destErr} hint="Cold storage or another wallet you control. Check it carefully: on-chain payments are final.">
                  {(id) => <input id={id} className="p-input p-mono" value={dest} onChange={(e) => setDest(e.target.value)} spellCheck={false} autoComplete="off" />}
                </Field>
              )}
              <Field label="Sweep speed" hint="Confirmation target for your sweep transaction. Faster costs more in miner fees.">
                {() => <Segmented label="Sweep speed" value={speed} onChange={setSpeed} options={SPEEDS} />}
              </Field>
              <Field label="Label" hint="Optional, stored by loopd with the swap.">
                {(id) => <input id={id} className="p-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />}
              </Field>
              <div className="lp-form-actions">
                <button type="button" className="p-btn p-btn-ghost" onClick={() => setStep(0)}>
                  Back
                </button>
                <button
                  type="button"
                  className="p-btn p-btn-primary"
                  disabled={chanErr !== null || (destKind === 'external' && (dest.trim() === '' || destErr !== null))}
                  onClick={() => {
                    setStep(2);
                    void getQuote();
                  }}
                >
                  Get quote
                </button>
              </div>
            </div>
          ) : null}

          {step === 2 && sats !== null ? (
            <LoopReview
              direction="loop-out"
              status={status}
              amountSat={sats}
              quote={quote}
              quoting={quoting}
              quoteErr={quoteErr}
              rows={[
                ['Source', chanIds.length > 0 ? `Lightning, channel${chanIds.length > 1 ? 's' : ''} ${chanIds.join(', ')}` : 'Lightning balance (LND picks the channel)'],
                ['Destination', destKind === 'wallet' ? 'This wallet (new taproot address)' : dest.trim()],
                ['Sweep target', `${speed} blocks`],
                ['Rail', 'Loop Out via loopd and the Loop swap server'],
              ]}
              agree={agree}
              setAgree={setAgree}
              busy={busy}
              execErr={execErr}
              onBack={() => setStep(1)}
              onRequote={() => void getQuote()}
              onConfirm={(q) => void start(q)}
              confirmLabel="Start Loop Out"
            />
          ) : null}

          {step === 3 && started ? (
            <div className="p-stack">
              <Notice tone="positive" title="Loop Out started">
                Funds will arrive at <span className="p-mono lp-break">{started.destAddress}</span>
              </Notice>
              <SwapProgress swapId={started.swapId} />
              <div className="lp-form-actions">
                <button type="button" className="p-btn" onClick={reset}>
                  Start another Loop Out
                </button>
              </div>
            </div>
          ) : null}
        </div>
        {step < 2 ? <LoopOutAside /> : null}
      </div>
    </Panel>
  );
}

function LoopOutAside() {
  return (
    <aside className="lp-aside">
      <h3>What happens</h3>
      <div className="lp-flow">
        <Icon name="bolt" /> Lightning <Icon name="chevronRight" /> swap server <Icon name="chevronRight" /> <Icon name="chain" /> on-chain
      </div>
      <p>You pay the swap server over Lightning. It locks the same amount in an on-chain HTLC that only you can claim, then you sweep it to the destination.</p>
      <p>Your Lightning payment only settles when you claim the HTLC, so the server can’t take the funds without delivering.</p>
      <h3>Why</h3>
      <ul>
        <li>Create inbound capacity so you can receive over Lightning.</li>
        <li>Move earnings to cold storage without closing channels.</li>
      </ul>
    </aside>
  );
}

/** Shared review step for Loop Out and Loop In: real quote, costs, confirmation. */
export function LoopReview({
  direction,
  status,
  amountSat,
  quote,
  quoting,
  quoteErr,
  rows,
  agree,
  setAgree,
  busy,
  execErr,
  onBack,
  onRequote,
  onConfirm,
  confirmLabel,
}: {
  direction: 'loop-out' | 'loop-in';
  status: LoopStatus;
  amountSat: number;
  quote: QuoteResult | null;
  quoting: boolean;
  quoteErr: string | null;
  rows: readonly (readonly [string, string])[];
  agree: boolean;
  setAgree: (v: boolean) => void;
  busy: boolean;
  execErr: string | null;
  onBack: () => void;
  onRequote: () => void;
  onConfirm: (q: LoopQuote) => void;
  confirmLabel: string;
}) {
  const out = direction === 'loop-out';
  const q = quote?.ok ? quote.quote : null;
  const fail = quote && !quote.ok ? quoteFailureCopy(quote.reason, quote.message, status) : null;
  return (
    <div className="p-stack">
      <div className="lp-review">
        <div>
          <h3 className="lp-section-title">Swap</h3>
          <dl className="lp-kv lp-kv-wide">
            <dt>Amount</dt>
            <dd>
              <Amount sats={amountSat} />
            </dd>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd className={k === 'Destination' && v.length > 40 ? 'p-mono lp-break' : undefined}>{v}</dd>
              </div>
            ))}
            <dt>Timing</dt>
            <dd>{out ? 'Several blocks: HTLC, then your sweep' : 'About 1–3 blocks for the HTLC to confirm'}</dd>
            <dt>Depends on</dt>
            <dd>loopd, the Loop swap server{out ? ', a route to the server' : ', inbound room on your channel'}</dd>
          </dl>
          <h3 className="lp-section-title" style={{ marginTop: 'var(--sovl-space-5)' }}>
            Risks
          </h3>
          <ul className="p-hint" style={{ margin: 0, paddingLeft: 'var(--sovl-space-4)', display: 'grid', gap: 4 }}>
            {out ? (
              <>
                <li>The swap is atomic: the server is paid only when you claim its HTLC.</li>
                <li>The prepayment is kept by the server if the swap is abandoned.</li>
                <li>If miner fees rise, the bridge re-quotes and refuses above your ceiling.</li>
              </>
            ) : (
              <>
                <li>If the server never pays, your HTLC times out and you reclaim it on-chain, minus miner fees.</li>
                <li>If fees rise, the bridge re-quotes and refuses above your ceiling.</li>
              </>
            )}
          </ul>
        </div>
        <div>
          <h3 className="lp-section-title">Quote</h3>
          {quoting ? (
            <div className="p-stack">
              <Skeleton height={64} />
              <Skeleton height={120} />
            </div>
          ) : quoteErr ? (
            <Notice tone="danger" title="The quote request failed" action={<button type="button" className="p-btn p-btn-sm" onClick={onRequote}>Retry</button>}>
              {quoteErr}
            </Notice>
          ) : fail ? (
            <Notice tone="warning" title={fail.title} action={<button type="button" className="p-btn p-btn-sm" onClick={onRequote}>Retry</button>}>
              <p className="lp-notice-p">{fail.body}</p>
              {fail.fix ? <p className="lp-notice-p p-faint">{fail.fix}</p> : null}
              <p className="lp-notice-p p-faint">No fees are shown because no quote exists. Nothing was sent.</p>
            </Notice>
          ) : q ? (
            <>
              <div className="lp-hero">
                <span className="p-stat-label">{out ? 'You receive on-chain (about)' : 'You receive over Lightning'}</span>
                <span className="lp-hero-value">
                  <Amount sats={receivedSat(q)} />
                </span>
                <span className="p-hint">
                  {out ? 'Amount minus swap fee and estimated sweep fee.' : 'Amount minus swap fee. The HTLC miner fee is paid on top, from on-chain funds.'}
                </span>
              </div>
              <QuoteBreakdown quote={q} />
            </>
          ) : null}
        </div>
      </div>
      {q ? (
        <label className="p-check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>
            I authorize this {out ? 'Loop Out' : 'Loop In'} of <Amount sats={q.amountSat} /> with fees of at most <Amount sats={q.fees.totalSat} />. If the live quote is higher when it starts, the bridge refuses it.
          </span>
        </label>
      ) : null}
      {execErr ? (
        <Notice tone="danger" title={`${out ? 'Loop Out' : 'Loop In'} did not start`} action={<button type="button" className="p-btn p-btn-sm" onClick={onRequote}>Get a new quote</button>}>
          {execErr}
        </Notice>
      ) : null}
      <div className="lp-form-actions">
        <button type="button" className="p-btn p-btn-ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="button" className="p-btn p-btn-primary" disabled={q === null || !agree || busy} onClick={() => q && onConfirm(q)}>
          {busy ? 'Starting…' : confirmLabel}
        </button>
      </div>
      {q === null && !quoting ? <p className="p-hint" style={{ textAlign: 'right' }}>{confirmLabel} needs a live quote first.</p> : null}
    </div>
  );
}
