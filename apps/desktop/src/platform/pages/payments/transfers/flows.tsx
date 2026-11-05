/**
 * One flow per rail: details → preview → status. Each flow calls only the
 * bridge route its rail uses and shows only numbers the bridge returned.
 */
import { useState, type ReactNode } from 'react';
import type { LoopQuote, QuoteResult } from '../../../api.js';
import type { DecodedInvoiceView, PaymentOutcomeView } from '../../../../modeb/bridge-client.js';
import { usePlatform, usePoll } from '../../../context.js';
import { Link } from '../../../router.js';
import { Amount, CopyField, Field, Notice, QrCode, Segmented, shortId, Skeleton, Steps, Timeline } from '../../../ui.js';
import { looksLikeAddress, LoopReview } from '../../liquidity/loop/loop-out.js';
import { parseSats, SwapProgress, useLoopStatus } from '../../liquidity/loop/shared.js';
import { bip21, type RouteAdapter, type RouteEnv } from './routes.js';

const STEPS = ['Details', 'Preview', 'Status'] as const;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function amountErr(raw: string, max: number | null, what: string): string | null {
  if (raw.trim() === '') return null;
  const n = parseSats(raw);
  if (n === null) return 'Enter a whole number of sats.';
  if (max !== null && n > max) return `That is more than your ${what} (${max.toLocaleString('en-US')} sats).`;
  return null;
}

function SatsInput({ id, value, onChange, invalid, placeholder }: { id: string; value: string; onChange: (v: string) => void; invalid: boolean; placeholder?: string }) {
  return (
    <div className="p-input-affix">
      <input id={id} className="p-input" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? 'e.g. 25000'} aria-invalid={invalid} />
      <span>sats</span>
    </div>
  );
}

/** The transaction-specific preview every money-moving rail renders before confirm. */
export function PreviewTable({ rows }: { rows: readonly { label: string; value: ReactNode; strong?: boolean; mono?: boolean }[] }) {
  return (
    <dl className="tf-preview">
      {rows.map((r) => (
        <div key={r.label} className="tf-preview-row" data-strong={r.strong ? 'true' : undefined}>
          <dt>{r.label}</dt>
          <dd className={r.mono ? 'p-mono lp-break' : undefined}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const Risks = ({ adapter }: { adapter: RouteAdapter }) => (
  <ul className="tf-list">
    {adapter.risks.map((r) => (
      <li key={r}>{r}</li>
    ))}
  </ul>
);

function Actions({ children }: { children: ReactNode }) {
  return <div className="lp-form-actions">{children}</div>;
}

// ——— on-chain send ———

export function OnchainSendFlow({ adapter, env }: { adapter: RouteAdapter; env: RouteEnv }) {
  const { bridge, toast, bumpRefresh } = usePlatform();
  const [step, setStep] = useState(0);
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [label, setLabel] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  // LND's own suggestion for a 6-block target, when the bridge can provide one.
  const estimate = usePoll(() => bridge.estimateFee(6), null, [bridge]);

  const addrErr = address.trim() !== '' && !looksLikeAddress(address.trim()) ? 'That doesn’t look like a Bitcoin address.' : null;
  const aErr = amountErr(amount, env.onchainSpendableSat, 'spendable on-chain balance');
  const sats = parseSats(amount);
  const rateNum = Number(rate);
  const rateErr = rate !== '' && (!Number.isInteger(rateNum) || rateNum < 1) ? 'Enter a whole number of at least 1 sat/vB.' : null;
  const ready = address.trim() !== '' && addrErr === null && sats !== null && aErr === null && rate !== '' && rateErr === null;
  const suggestion: ReactNode = estimate.data ? (
    <>
      LND suggests {estimate.data.satPerVbyte} sat/vB for confirmation within about 6 blocks.{' '}
      <button type="button" className="tf-link" onClick={() => setRate(String(estimate.data?.satPerVbyte ?? ''))}>
        Use it
      </button>
    </>
  ) : estimate.error ? (
    <>No suggestion available: the bridge’s fee estimate returned “{estimate.error}”. Choose a rate yourself; the bridge requires one.</>
  ) : (
    'Checking LND’s fee suggestion…'
  );

  const send = async () => {
    if (sats === null) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await bridge.sendCoins({ address: address.trim(), amountSat: String(sats), satPerVbyte: rateNum, ...(label.trim() ? { label: label.trim() } : {}) });
      setTxid(r.txid);
      setStep(2);
      toast({ title: 'On-chain payment sent', body: `Transaction ${shortId(r.txid)}`, tone: 'positive' });
      bumpRefresh();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Steps steps={STEPS} current={step} />
      {step === 0 ? (
        <div className="lp-form">
          <Field label="Destination address" error={addrErr} hint="Checked for format here; LND validates it for this network.">
            {(id) => <input id={id} className="p-input p-mono" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoComplete="off" placeholder="bc1… / tb1… / bcrt1…" />}
          </Field>
          <Field label="Amount" error={aErr} hint={<>Spendable now: <Amount sats={env.onchainSpendableSat} /></>}>
            {(id) => <SatsInput id={id} value={amount} onChange={setAmount} invalid={aErr !== null} />}
          </Field>
          <Field label="Network fee rate" error={rateErr} hint={suggestion}>
            {(id) => (
              <div className="p-input-affix" style={{ maxWidth: 220 }}>
                <input id={id} className="p-input" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 5" aria-invalid={rateErr !== null} />
                <span>sat/vB</span>
              </div>
            )}
          </Field>
          <Field label="Label" hint="Optional, stored in this wallet only.">
            {(id) => <input id={id} className="p-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />}
          </Field>
          <Actions>
            <button type="button" className="p-btn p-btn-primary" disabled={!ready} onClick={() => { setStep(1); setAgree(false); setErr(null); }}>
              Preview
            </button>
          </Actions>
        </div>
      ) : null}
      {step === 1 && sats !== null ? (
        <div className="p-stack">
          <PreviewTable
            rows={[
              { label: 'From', value: 'This wallet’s on-chain funds' },
              { label: 'To', value: address.trim(), mono: true },
              { label: 'Rail', value: `${adapter.label} · ${adapter.provider}` },
              { label: 'Amount', value: <Amount sats={sats} /> },
              { label: 'Network fee', value: <>{rateNum} sat/vB × the transaction’s size <span className="p-faint">(LND picks the coins and sets the exact fee when it signs; the bridge has no pre-sign estimate for this payment)</span></> },
              { label: 'Provider fee', value: 'None' },
              { label: 'Total cost', value: <><Amount sats={sats} /> plus the network fee</>, strong: true },
              { label: 'Recipient receives', value: <Amount sats={sats} />, strong: true },
              { label: 'Timing', value: adapter.timing },
              { label: 'Depends on', value: adapter.dependencies.join(', ') },
              { label: 'Risks', value: <Risks adapter={adapter} /> },
            ]}
          />
          <label className="p-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>
              Send <Amount sats={sats} /> to <span className="p-mono">{shortId(address.trim(), 10, 8)}</span> at {rateNum} sat/vB. I checked the address; on-chain payments can’t be reversed.
            </span>
          </label>
          {err ? <Notice tone="danger" title="Nothing was sent">{err}</Notice> : null}
          <Actions>
            <button type="button" className="p-btn p-btn-ghost" onClick={() => setStep(0)} disabled={busy}>
              Back
            </button>
            <button type="button" className="p-btn p-btn-primary" disabled={!agree || busy} onClick={() => void send()}>
              {busy ? 'Sending…' : 'Send on-chain'}
            </button>
          </Actions>
        </div>
      ) : null}
      {step === 2 && txid ? (
        <div className="p-stack">
          <Timeline
            items={[
              { title: 'Signed and broadcast', body: 'LND signed the transaction and handed it to the Bitcoin network.', state: 'done' },
              { title: 'Waiting for the first confirmation', body: 'Usually the next block. This page can’t watch confirmations yet (the bridge has no transaction lookup); balances update when it confirms.', state: 'current' },
              { title: 'Final', body: 'Treat it as final after about 6 confirmations.', state: 'pending' },
            ]}
          />
          <PreviewTable
            rows={[
              { label: 'Sent', value: <Amount sats={sats ?? 0} /> },
              { label: 'To', value: address.trim(), mono: true },
              { label: 'Fee rate', value: `${rateNum} sat/vB` },
              { label: 'Transaction id', value: <CopyField value={txid} label="Transaction id" /> },
            ]}
          />
          <Actions>
            <button type="button" className="p-btn" onClick={() => { setStep(0); setTxid(null); setAmount(''); setAddress(''); }}>
              Send another
            </button>
          </Actions>
        </div>
      ) : null}
    </>
  );
}

// ——— Lightning payment ———

export function LightningPayFlow({ adapter, env }: { adapter: RouteAdapter; env: RouteEnv }) {
  const { bridge, toast, bumpRefresh } = usePlatform();
  const [step, setStep] = useState(0);
  const [invoice, setInvoice] = useState('');
  const [decoded, setDecoded] = useState<DecodedInvoiceView | null>(null);
  const [decodeErr, setDecodeErr] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [amount, setAmount] = useState('');
  const [feeLimit, setFeeLimit] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PaymentOutcomeView | null>(null);
  const [paidFee, setPaidFee] = useState<string | null>(null);

  const pr = invoice.trim().replace(/^lightning:/i, '');
  const fixed = decoded?.amountSat !== undefined && decoded.amountSat !== '0' ? Number(decoded.amountSat) : null;
  const sats = fixed ?? parseSats(amount);
  const aErr = fixed === null ? amountErr(amount, env.lightningSpendableSat, 'spendable Lightning balance') : fixed > env.lightningSpendableSat ? `This invoice asks for more than your spendable Lightning balance (${env.lightningSpendableSat.toLocaleString('en-US')} sats).` : null;
  const limit = parseSats(feeLimit) ?? (feeLimit.trim() === '0' ? 0 : null);
  const defaultLimit = sats === null ? null : Math.max(10, Math.ceil(sats / 100));
  const effLimit = feeLimit.trim() === '' ? defaultLimit : limit;
  const limitErr = feeLimit.trim() !== '' && limit === null ? 'Enter a whole number of sats.' : null;

  const decode = async () => {
    setDecoding(true);
    setDecodeErr(null);
    setDecoded(null);
    try {
      setDecoded(await bridge.decodeInvoice(pr));
    } catch (e) {
      setDecodeErr(errText(e));
    } finally {
      setDecoding(false);
    }
  };

  const pay = async () => {
    if (sats === null || effLimit === null) return;
    setBusy(true);
    setErr(null);
    try {
      const o = await bridge.payInvoice({ paymentRequest: pr, ...(fixed === null ? { amountSat: String(sats) } : {}), feeLimitSat: String(effLimit) });
      setOutcome(o);
      setStep(2);
      if (o.status === 'succeeded') {
        toast({ title: 'Payment sent', body: `${sats.toLocaleString('en-US')} sats`, tone: 'positive' });
        bumpRefresh();
        try {
          const list = await bridge.payments(25);
          const p = list.payments.find((x) => x.paymentHash === o.paymentHash);
          if (p) setPaidFee(p.feeSat);
        } catch {
          // The fee row says it couldn't be read; the payment itself succeeded.
        }
      }
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Steps steps={STEPS} current={step} />
      {step === 0 ? (
        <div className="lp-form">
          <Field label="Lightning invoice" error={decodeErr} hint="Paste a BOLT 11 payment request (lnbc…, lntb…, lnbcrt…).">
            {(id) => (
              <textarea
                id={id}
                className="p-textarea p-mono"
                rows={3}
                value={invoice}
                spellCheck={false}
                onChange={(e) => {
                  setInvoice(e.target.value);
                  setDecoded(null);
                }}
                onBlur={() => {
                  if (pr !== '' && decoded === null) void decode();
                }}
              />
            )}
          </Field>
          {decoding ? <Skeleton height={60} /> : null}
          {decoded ? (
            <div className="tf-decoded">
              <dl className="lp-kv lp-kv-wide">
                <dt>Amount</dt>
                <dd>{fixed !== null ? <Amount sats={fixed} /> : 'Not set: you choose'}</dd>
                <dt>Description</dt>
                <dd>{decoded.memo || <span className="p-faint">None</span>}</dd>
                <dt>Recipient node</dt>
                <dd className="p-mono">{shortId(decoded.destination, 12, 8)}</dd>
                <dt>Payment hash</dt>
                <dd className="p-mono">{shortId(decoded.paymentHashHex, 12, 8)}</dd>
              </dl>
            </div>
          ) : null}
          {decoded && fixed === null ? (
            <Field label="Amount" error={aErr} hint={<>Spendable now: <Amount sats={env.lightningSpendableSat} /></>}>
              {(id) => <SatsInput id={id} value={amount} onChange={setAmount} invalid={aErr !== null} />}
            </Field>
          ) : decoded && aErr ? (
            <p className="p-error-text">{aErr}</p>
          ) : null}
          {decoded ? (
            <Field label="Maximum routing fee" error={limitErr} hint={defaultLimit !== null ? `Empty uses 1% of the amount, at least 10 sats (${defaultLimit.toLocaleString('en-US')} sats here). The payment fails rather than pay more.` : 'The payment fails rather than pay more than this.'}>
              {(id) => <SatsInput id={id} value={feeLimit} onChange={setFeeLimit} invalid={limitErr !== null} placeholder={defaultLimit !== null ? String(defaultLimit) : ''} />}
            </Field>
          ) : null}
          <Actions>
            {decoded === null ? (
              <button type="button" className="p-btn p-btn-primary" disabled={pr === '' || decoding} onClick={() => void decode()}>
                Read invoice
              </button>
            ) : (
              <button type="button" className="p-btn p-btn-primary" disabled={sats === null || aErr !== null || limitErr !== null || effLimit === null} onClick={() => { setStep(1); setAgree(false); setErr(null); }}>
                Preview
              </button>
            )}
          </Actions>
        </div>
      ) : null}
      {step === 1 && decoded && sats !== null && effLimit !== null ? (
        <div className="p-stack">
          <PreviewTable
            rows={[
              { label: 'From', value: 'This wallet’s Lightning balance' },
              { label: 'To', value: <><span className="p-mono">{shortId(decoded.destination, 12, 8)}</span>{decoded.memo ? <span className="p-faint"> · {decoded.memo}</span> : null}</> },
              { label: 'Rail', value: `${adapter.label} · ${adapter.provider}` },
              { label: 'Amount', value: <Amount sats={sats} /> },
              { label: 'Network fee', value: 'None (off-chain)' },
              { label: 'Routing fee', value: <>Set by the route found; at most <Amount sats={effLimit} /></> },
              { label: 'Total cost', value: <>At most <Amount sats={sats + effLimit} /></>, strong: true },
              { label: 'Recipient receives', value: <Amount sats={sats} />, strong: true },
              { label: 'Timing', value: adapter.timing },
              { label: 'Depends on', value: adapter.dependencies.join(', ') },
              { label: 'Risks', value: <Risks adapter={adapter} /> },
            ]}
          />
          <label className="p-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>
              Pay <Amount sats={sats} /> to this invoice, with routing fees of at most <Amount sats={effLimit} />.
            </span>
          </label>
          {err ? <Notice tone="danger" title="The payment was not sent">{err}</Notice> : null}
          <Actions>
            <button type="button" className="p-btn p-btn-ghost" onClick={() => setStep(0)} disabled={busy}>
              Back
            </button>
            <button type="button" className="p-btn p-btn-primary" disabled={!agree || busy} onClick={() => void pay()}>
              {busy ? 'Paying…' : 'Pay invoice'}
            </button>
          </Actions>
        </div>
      ) : null}
      {step === 2 && outcome ? (
        <div className="p-stack">
          <Timeline
            items={[
              { title: 'Route found and payment sent', body: 'LND locked HTLCs along a route to the recipient.', state: outcome.status === 'failed' ? 'failed' : 'done' },
              {
                title: outcome.status === 'succeeded' ? 'Settled' : outcome.status === 'failed' ? 'Payment failed' : 'No result yet',
                body:
                  outcome.status === 'succeeded'
                    ? 'The recipient released the preimage: proof of payment.'
                    : outcome.status === 'failed'
                      ? `Reason: ${outcome.failureReason ?? 'none reported'}. Nothing was spent.`
                      : 'LND has not reported a final result. Check Activity before trying again, so you don’t pay twice.',
                state: outcome.status === 'succeeded' ? 'done' : outcome.status === 'failed' ? 'failed' : 'current',
              },
            ]}
          />
          {outcome.status === 'succeeded' ? (
            <PreviewTable
              rows={[
                { label: 'Amount paid', value: sats !== null ? <Amount sats={sats} /> : '—' },
                { label: 'Routing fee paid', value: paidFee !== null ? <Amount sats={paidFee} /> : 'Not reported yet; see Activity' },
                { label: 'Payment hash', value: outcome.paymentHash, mono: true },
                ...(outcome.preimage ? [{ label: 'Preimage (proof)', value: outcome.preimage, mono: true }] : []),
              ]}
            />
          ) : null}
          <Actions>
            <button type="button" className="p-btn" onClick={() => { setStep(0); setOutcome(null); setInvoice(''); setDecoded(null); setPaidFee(null); setFeeLimit(''); setAmount(''); }}>
              Pay another invoice
            </button>
          </Actions>
        </div>
      ) : null}
    </>
  );
}

// ——— Loop Out / Loop In ———

export function LoopFlow({ adapter, env, destination }: { adapter: RouteAdapter; env: RouteEnv; destination: 'onchain' | 'external-address' | 'lightning' }) {
  const { api, toast, bumpRefresh } = usePlatform();
  const status = useLoopStatus();
  const out = adapter.rail === 'loop-out';
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState('');
  const [dest, setDest] = useState('');
  const [speed, setSpeed] = useState<'2' | '9' | '30'>('9');
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [execErr, setExecErr] = useState<string | null>(null);
  const [swap, setSwap] = useState<{ id: string; dest?: string } | null>(null);

  const ceiling = out ? env.lightningSpendableSat : Math.min(env.onchainSpendableSat, env.lightningReceivableSat);
  const range = out ? status.terms?.loopOut : status.terms?.loopIn;
  const sats = parseSats(amount);
  let aErr = amountErr(amount, ceiling, out ? 'spendable Lightning balance' : 'on-chain balance or inbound room, whichever is lower');
  if (aErr === null && sats !== null && range !== undefined && !('error' in range)) {
    if (sats < range.minSat) aErr = `The swap server’s minimum is ${range.minSat.toLocaleString('en-US')} sats.`;
    else if (sats > range.maxSat) aErr = `The swap server’s maximum is ${range.maxSat.toLocaleString('en-US')} sats.`;
  }
  const external = destination === 'external-address';
  const destErr = external && dest.trim() !== '' && !looksLikeAddress(dest.trim()) ? 'That doesn’t look like a Bitcoin address.' : null;
  const ready = sats !== null && aErr === null && (!external || (dest.trim() !== '' && destErr === null));

  const getQuote = async () => {
    if (sats === null) return;
    setQuoting(true);
    setQuote(null);
    setQuoteErr(null);
    setAgree(false);
    setExecErr(null);
    try {
      setQuote(await api.loopQuote(out ? 'loop-out' : 'loop-in', sats, out ? Number(speed) : undefined));
    } catch (e) {
      setQuoteErr(errText(e));
    } finally {
      setQuoting(false);
    }
  };

  const start = async (q: LoopQuote) => {
    setBusy(true);
    setExecErr(null);
    try {
      if (out) {
        const r = await api.loopOut({
          amountSat: q.amountSat,
          ...(external ? { destAddress: dest.trim() } : {}),
          sweepConfTarget: Number(speed),
          authorization: { amountSat: q.amountSat, maxTotalFeeSat: q.fees.totalSat },
        });
        setSwap({ id: r.swapId, dest: r.destAddress });
        toast({ title: 'Loop Out started', body: `Swap ${shortId(r.swapId)}`, tone: 'positive' });
      } else {
        const r = await api.loopIn({ amountSat: q.amountSat, authorization: { amountSat: q.amountSat, maxTotalFeeSat: q.fees.totalSat } });
        setSwap({ id: r.swapId });
        toast({ title: 'Loop In started', body: `Swap ${shortId(r.swapId)}`, tone: 'positive' });
      }
      bumpRefresh();
      setStep(2);
    } catch (e) {
      setExecErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Steps steps={STEPS} current={step} />
      {step === 0 ? (
        <div className="lp-form">
          <Field
            label="Amount"
            error={aErr}
            hint={
              <>
                {out ? 'Spendable over Lightning' : 'Spendable on-chain'}: <Amount sats={out ? env.lightningSpendableSat : env.onchainSpendableSat} />
                {!out ? <> · room to receive: <Amount sats={env.lightningReceivableSat} /></> : null}
              </>
            }
          >
            {(id) => <SatsInput id={id} value={amount} onChange={setAmount} invalid={aErr !== null} placeholder="e.g. 500000" />}
          </Field>
          {external ? (
            <Field label="External Bitcoin address" error={destErr} hint="On-chain payments are final; check it carefully.">
              {(id) => <input id={id} className="p-input p-mono" value={dest} onChange={(e) => setDest(e.target.value)} spellCheck={false} autoComplete="off" />}
            </Field>
          ) : out ? (
            <p className="p-hint">The bridge creates a fresh taproot address in this wallet when the swap starts.</p>
          ) : null}
          {out ? (
            <Field label="Sweep speed" hint="Confirmation target for the sweep to your address.">
              {() => (
                <Segmented
                  label="Sweep speed"
                  value={speed}
                  onChange={setSpeed}
                  options={[
                    { value: '2', label: 'Fast · 2 blocks' },
                    { value: '9', label: 'Standard · 9 blocks' },
                    { value: '30', label: 'Economy · 30 blocks' },
                  ]}
                />
              )}
            </Field>
          ) : null}
          <Actions>
            <Link to={out ? '/loop/out' : '/loop/in'} className="p-btn p-btn-ghost">
              More options in Loop
            </Link>
            <button
              type="button"
              className="p-btn p-btn-primary"
              disabled={!ready}
              onClick={() => {
                setStep(1);
                void getQuote();
              }}
            >
              Preview
            </button>
          </Actions>
        </div>
      ) : null}
      {step === 1 && sats !== null ? (
        <LoopReview
          direction={out ? 'loop-out' : 'loop-in'}
          status={status}
          amountSat={sats}
          quote={quote}
          quoting={quoting}
          quoteErr={quoteErr}
          rows={
            out
              ? [
                  ['Source', 'This wallet’s Lightning balance'],
                  ['Destination', external ? dest.trim() : 'This wallet (new taproot address)'],
                  ['Sweep target', `${speed} blocks`],
                  ['Rail', `${adapter.label} · ${adapter.provider}`],
                ]
              : [
                  ['Source', 'This wallet’s on-chain funds'],
                  ['Destination', 'This wallet’s Lightning outbound'],
                  ['Rail', `${adapter.label} · ${adapter.provider}`],
                ]
          }
          agree={agree}
          setAgree={setAgree}
          busy={busy}
          execErr={execErr}
          onBack={() => setStep(0)}
          onRequote={() => void getQuote()}
          onConfirm={(q) => void start(q)}
          confirmLabel={out ? 'Start Loop Out' : 'Start Loop In'}
        />
      ) : null}
      {step === 2 && swap ? (
        <div className="p-stack">
          {swap.dest ? (
            <Notice tone="positive" title="Loop Out started">
              Funds will arrive at <span className="p-mono lp-break">{swap.dest}</span>
            </Notice>
          ) : null}
          <SwapProgress swapId={swap.id} />
        </div>
      ) : null}
    </>
  );
}

// ——— funding from an external wallet ———

export function FundingAddressFlow() {
  const { bridge } = usePlatform();
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sats = amount.trim() === '' ? undefined : parseSats(amount) ?? null;

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      setAddress((await bridge.newAddress('p2wkh')).address);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const uri = address ? bip21(address, sats ?? undefined) : null;
  return (
    <>
      <Steps steps={['Details', 'Deposit instructions']} current={address ? 1 : 0} />
      <div className="lp-form">
        <Field label="Amount to request" error={sats === null ? 'Enter a whole number of sats.' : null} hint="Optional. Added to the payment link and QR so the sending wallet fills it in.">
          {(id) => <SatsInput id={id} value={amount} onChange={setAmount} invalid={sats === null} placeholder="Any amount" />}
        </Field>
        {address === null ? (
          <Actions>
            <button type="button" className="p-btn p-btn-primary" disabled={busy || sats === null} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create deposit address'}
            </button>
          </Actions>
        ) : null}
        {err ? <Notice tone="danger" title="No address was created">{err}</Notice> : null}
      </div>
      {address && uri ? (
        <div className="tf-deposit">
          <QrCode value={uri} size={176} label="Deposit QR code" />
          <div className="p-stack">
            <Field label="Address">{() => <CopyField value={address} label="Deposit address" />}</Field>
            <Field label="Payment link">{() => <CopyField value={uri} label="Payment link" />}</Field>
            <ul className="tf-list">
              <li>Send only bitcoin on this network. Funds are spendable after 1 confirmation.</li>
              <li>A fresh address each time keeps your payments unlinkable; this one stays valid.</li>
            </ul>
            <div>
              <button type="button" className="p-btn p-btn-sm" disabled={busy} onClick={() => void create()}>
                New address
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function FundingInvoiceFlow({ env }: { env: RouteEnv }) {
  const { bridge, api, bumpRefresh } = usePlatform();
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [inv, setInv] = useState<{ paymentRequest: string; rHashHex: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const aErr = amountErr(amount, env.lightningReceivableSat, 'inbound capacity');
  const sats = parseSats(amount);
  const watch = usePoll(async () => (inv ? (await api.invoices()).find((i) => i.paymentHashHex === inv.rHashHex) ?? null : null), inv ? 3_000 : null, [inv?.rHashHex]);
  const settled = watch.data?.state === 'settled';

  const create = async () => {
    if (sats === null) return;
    setBusy(true);
    setErr(null);
    try {
      setInv(await bridge.createInvoice({ amountSat: String(sats), ...(memo.trim() ? { memo: memo.trim() } : {}) }));
      bumpRefresh();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Steps steps={['Details', 'Invoice', 'Received']} current={inv === null ? 0 : settled ? 2 : 1} />
      {inv === null ? (
        <div className="lp-form">
          <Field label="Amount" error={aErr} hint={<>Your channels can receive up to <Amount sats={env.lightningReceivableSat} /></>}>
            {(id) => <SatsInput id={id} value={amount} onChange={setAmount} invalid={aErr !== null} />}
          </Field>
          <Field label="Description" hint="Optional. Shown to the payer.">
            {(id) => <input id={id} className="p-input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={120} />}
          </Field>
          {err ? <Notice tone="danger" title="No invoice was created">{err}</Notice> : null}
          <Actions>
            <button type="button" className="p-btn p-btn-primary" disabled={sats === null || aErr !== null || busy} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create invoice'}
            </button>
          </Actions>
        </div>
      ) : (
        <div className="tf-deposit">
          <QrCode value={`lightning:${inv.paymentRequest.toUpperCase()}`} size={176} label="Invoice QR code" />
          <div className="p-stack">
            <Field label="Invoice">{() => <CopyField value={inv.paymentRequest} label="Invoice" />}</Field>
            <Timeline
              items={[
                { title: 'Invoice created', body: sats !== null ? `${sats.toLocaleString('en-US')} sats, valid for 24 h by default.` : undefined, state: 'done' },
                {
                  title: settled ? 'Paid' : 'Waiting for payment',
                  body: settled ? `Received ${watch.data?.paidSat.toLocaleString('en-US') ?? ''} sats.` : watch.error ? `Status check failed: ${watch.error}` : 'Checking every 3 seconds.',
                  state: settled ? 'done' : 'current',
                },
              ]}
            />
            <div>
              <button type="button" className="p-btn p-btn-sm" onClick={() => { setInv(null); setAmount(''); }}>
                New invoice
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ——— Taproot Assets ———

export function AssetSendFlow({ adapter, balances }: { adapter: RouteAdapter; balances: readonly { assetIdHex: string; name: string; balance: string }[] }) {
  const { api, toast, bumpRefresh } = usePlatform();
  const [step, setStep] = useState(0);
  const [address, setAddress] = useState('');
  const [decoded, setDecoded] = useState<{ assetIdHex: string; amount: string } | null>(null);
  const [decodeErr, setDecodeErr] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const addr = address.trim();
  const held = decoded ? balances.find((b) => b.assetIdHex === decoded.assetIdHex) : undefined;
  const short = decoded !== null && held !== undefined && BigInt(decoded.amount) > BigInt(held.balance);

  const decode = async () => {
    setDecoding(true);
    setDecodeErr(null);
    setDecoded(null);
    try {
      setDecoded(await api.decodeAssetAddress(addr));
    } catch (e) {
      setDecodeErr(errText(e));
    } finally {
      setDecoding(false);
    }
  };

  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.sendAsset(addr);
      setTxid(r.txid);
      setStep(2);
      toast({ title: 'Asset sent', body: `Anchor transaction ${shortId(r.txid)}`, tone: 'positive' });
      bumpRefresh();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Steps steps={STEPS} current={step} />
      {step === 0 ? (
        <div className="lp-form">
          <Field label="Taproot Assets address" error={decodeErr} hint="The address fixes the asset and the amount.">
            {(id) => (
              <textarea
                id={id}
                className="p-textarea p-mono"
                rows={3}
                spellCheck={false}
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setDecoded(null);
                }}
              />
            )}
          </Field>
          {decoding ? <Skeleton height={48} /> : null}
          {decoded ? (
            <div className="tf-decoded">
              <dl className="lp-kv lp-kv-wide">
                <dt>Asset</dt>
                <dd>{held ? held.name : <span className="tf-warn">Not held by this node</span>}</dd>
                <dt>Asset id</dt>
                <dd className="p-mono">{shortId(decoded.assetIdHex, 12, 8)}</dd>
                <dt>Amount</dt>
                <dd>{BigInt(decoded.amount).toLocaleString('en-US')} units</dd>
                <dt>You hold</dt>
                <dd>{held ? `${BigInt(held.balance).toLocaleString('en-US')} units` : '0 units'}</dd>
              </dl>
            </div>
          ) : null}
          {short ? <p className="p-error-text">This node doesn’t hold enough of this asset.</p> : null}
          <Actions>
            {decoded === null ? (
              <button type="button" className="p-btn p-btn-primary" disabled={addr === '' || decoding} onClick={() => void decode()}>
                Read address
              </button>
            ) : (
              <button type="button" className="p-btn p-btn-primary" disabled={held === undefined || short} onClick={() => { setStep(1); setAgree(false); setErr(null); }}>
                Preview
              </button>
            )}
          </Actions>
        </div>
      ) : null}
      {step === 1 && decoded && held ? (
        <div className="p-stack">
          <PreviewTable
            rows={[
              { label: 'From', value: `This node’s ${held.name}` },
              { label: 'To', value: addr, mono: true },
              { label: 'Rail', value: `${adapter.label} · ${adapter.provider}` },
              { label: 'Amount', value: `${BigInt(decoded.amount).toLocaleString('en-US')} units of ${held.name}` },
              { label: 'Network fee', value: 'Anchor transaction fee in BTC, chosen by tapd when it sends. The bridge doesn’t quote it.' },
              { label: 'Provider fee', value: 'None' },
              { label: 'Recipient receives', value: `${BigInt(decoded.amount).toLocaleString('en-US')} units`, strong: true },
              { label: 'Timing', value: adapter.timing },
              { label: 'Depends on', value: adapter.dependencies.join(', ') },
              { label: 'Risks', value: <Risks adapter={adapter} /> },
            ]}
          />
          <label className="p-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>
              Send {BigInt(decoded.amount).toLocaleString('en-US')} units of {held.name} to this address. Asset transfers can’t be reversed.
            </span>
          </label>
          {err ? <Notice tone="danger" title="Nothing was sent">{err}</Notice> : null}
          <Actions>
            <button type="button" className="p-btn p-btn-ghost" onClick={() => setStep(0)} disabled={busy}>
              Back
            </button>
            <button type="button" className="p-btn p-btn-primary" disabled={!agree || busy} onClick={() => void send()}>
              {busy ? 'Sending…' : 'Send asset'}
            </button>
          </Actions>
        </div>
      ) : null}
      {step === 2 && txid ? (
        <div className="p-stack">
          <Timeline
            items={[
              { title: 'Anchor transaction broadcast', body: 'tapd signed the transfer and broadcast the Bitcoin transaction that carries it.', state: 'done' },
              { title: 'Waiting for confirmation', body: 'The recipient can import the proof once it confirms. Follow it in Asset activity.', state: 'current' },
            ]}
          />
          <Field label="Anchor transaction id">{() => <CopyField value={txid} label="Anchor transaction id" />}</Field>
        </div>
      ) : null}
    </>
  );
}

// ——— handoff rails ———

export function HandoffFlow({ adapter }: { adapter: RouteAdapter }) {
  if (adapter.handoff === undefined) return null;
  return (
    <div className="p-stack">
      <p className="p-muted" style={{ margin: 0 }}>
        {adapter.summary}
      </p>
      <p className="p-hint" style={{ margin: 0 }}>
        This rail has its own page with the extra choices it needs (
        {adapter.rail === 'channel-open' ? 'peer, channel size, privacy' : 'address creation, deposit selection, expiry'}).
      </p>
      <div>
        <Link to={adapter.handoff.to} className="p-btn p-btn-primary">
          {adapter.handoff.label}
        </Link>
      </div>
    </div>
  );
}
