/**
 * Send: pay a Lightning invoice (decode → review → pay → outcome) or send
 * bitcoin on-chain (address + amount/send-all + fee rate → review →
 * authorize → txid). Every number shown comes from the bridge; the on-chain
 * fee is shown as rate × typical size and labeled as an estimate.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DecodedInvoiceView, FeeEstimateView, PaymentOutcomeView } from '../../../modeb/bridge-client.js';
import { computeAccounts } from '../../balances.js';
import { usePlatform, usePoll, usePrefs } from '../../context.js';
import { Link, useLocation } from '../../router.js';
import { Amount, Breakdown, Field, Icon, Notice, PageHeader, Panel, Skeleton, Stat, formatSats, shortId } from '../../ui.js';
import { CopyValue, Details, addressLooksWrong, errorText, readSats } from './send-kit.js';

type Tab = 'lightning' | 'onchain';

export default function SendPage() {
  const path = useLocation();
  const tab: Tab = path.startsWith('/send/onchain') ? 'onchain' : 'lightning';
  return (
    <>
      <PageHeader title="Send" sub="Pay a Lightning invoice, or send bitcoin to an on-chain address." />
      <nav className="p-tabs" aria-label="Send method">
        <Link to="/send" aria-current={tab === 'lightning' ? 'page' : undefined}>
          Lightning
        </Link>
        <Link to="/send/onchain" aria-current={tab === 'onchain' ? 'page' : undefined}>
          On-chain
        </Link>
      </nav>
      {tab === 'lightning' ? <LightningSend /> : <OnchainSend />}
    </>
  );
}

// ——— shared: what you can spend ———

function useFunds() {
  const { bridge, refreshKey } = usePlatform();
  const wallet = usePoll(() => bridge.walletBalance(), 15_000, [refreshKey]);
  const channels = usePoll(() => bridge.channels(), 15_000, [refreshKey]);
  const accounts = useMemo(() => computeAccounts(wallet.data, channels.data), [wallet.data, channels.data]);
  return { wallet, channels, accounts };
}

function FundsPanel({ focus }: { focus: Tab }) {
  const { wallet, channels, accounts } = useFunds();
  const loading = (wallet.loading && !wallet.data) || (channels.loading && !channels.data);
  const err = wallet.error ?? channels.error;
  return (
    <Panel title="Available to send">
      {loading ? (
        <div className="p-stack">
          <Skeleton height={28} />
          <Skeleton height={28} />
        </div>
      ) : err && !(wallet.data && channels.data) ? (
        <Notice
          tone="danger"
          title="Couldn't load balances"
          action={
            <button type="button" className="p-btn p-btn-sm" onClick={() => void Promise.all([wallet.reload(), channels.reload()])}>
              Retry
            </button>
          }
        >
          {err}
        </Notice>
      ) : (
        <div className="p-stack">
          <div className={`sw-source ${focus === 'lightning' ? 'sw-source-active' : ''}`}>
            <Stat label={<><Icon name="bolt" size={14} /> Lightning, spendable now</>} foot={`${channels.data?.open.length ?? 0} open channel${channels.data?.open.length === 1 ? '' : 's'}`}>
              <Amount sats={accounts.lightningSpendableSat} />
            </Stat>
          </div>
          <div className={`sw-source ${focus === 'onchain' ? 'sw-source-active' : ''}`}>
            <Stat
              label={<><Icon name="chain" size={14} /> On-chain, confirmed and spendable</>}
              foot={accounts.onchainUnconfirmedSat > 0 ? <>Plus <Amount sats={accounts.onchainUnconfirmedSat} /> waiting for confirmation</> : 'Unconfirmed coins are not spent'}
            >
              <Amount sats={accounts.onchainSpendableSat} />
            </Stat>
          </div>
          {accounts.onchainLockedSat > 0 ? (
            <p className="p-hint" style={{ margin: 0 }}>
              <Amount sats={accounts.onchainLockedSat} /> on-chain is held back (anchor-channel fee reserve or leased coins) and can't be sent.
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

// ——— Lightning ———

function defaultFeeCap(amountSat: number): number {
  return Math.max(10, Math.ceil(amountSat * 0.005));
}

function failureExplanation(reason: string | undefined): string {
  switch (reason) {
    case 'no route found':
      return 'No path through the network could carry this amount. Try a smaller amount, raise the fee cap, or open a channel with more outbound liquidity.';
    case 'insufficient liquidity':
      return 'Your channels don\'t have enough outbound liquidity for this amount. Lower the amount or add outbound liquidity.';
    case 'incorrect payment details':
      return 'The recipient rejected the payment: the invoice may be already paid, expired, or for a different amount.';
    case 'payment timeout':
      return 'No route succeeded within the time limit. Nothing was spent; you can try again.';
    default:
      return 'Nothing was spent. You can try again.';
  }
}

function LightningSend() {
  const { bridge, node, toast, bumpRefresh } = usePlatform();
  const { unit } = usePrefs();
  const { accounts, channels } = useFunds();
  const [invoice, setInvoice] = useState('');
  const [decoded, setDecoded] = useState<DecodedInvoiceView | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [feeCap, setFeeCap] = useState('');
  const [busy, setBusy] = useState<'decode' | 'pay' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PaymentOutcomeView | null>(null);
  const [paidFeeSat, setPaidFeeSat] = useState<string | null>(null);

  const reset = () => {
    setDecoded(null);
    setOutcome(null);
    setPaidFeeSat(null);
    setError(null);
  };

  const decode = async () => {
    const pr = invoice.trim().replace(/^lightning:/i, '');
    if (pr === '') {
      setError('Paste a Lightning invoice (it starts with "ln").');
      return;
    }
    setBusy('decode');
    reset();
    try {
      const d = await bridge.decodeInvoice(pr);
      setDecoded(d);
      setInvoice(pr);
      const amt = d.amountSat !== undefined ? Number(d.amountSat) : 0;
      setFeeCap(String(defaultFeeCap(amt)));
      setAmountInput('');
    } catch (err) {
      setError(`Couldn't read this invoice: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const zeroAmount = decoded !== null && (decoded.amountSat === undefined || decoded.amountSat === '0');
  const chosen = readSats(amountInput);
  const amountSat = decoded === null ? 0 : zeroAmount ? chosen.value ?? 0 : Number(decoded.amountSat);
  const cap = readSats(feeCap);
  const capSat = cap.value ?? 0;
  const ownInvoice = decoded !== null && decoded.destination === node.info?.identityPubkey;
  const overSpendable = channels.data !== undefined && amountSat + capSat > accounts.lightningSpendableSat;
  const amountError = zeroAmount ? chosen.error ?? (amountInput.trim() !== '' && amountSat <= 0 ? 'Enter more than 0 sats.' : null) : null;
  const canPay = decoded !== null && amountSat > 0 && cap.error === undefined && cap.value !== undefined && !ownInvoice && amountError === null;

  const pay = async () => {
    if (decoded === null || !canPay) return;
    setBusy('pay');
    setError(null);
    try {
      const res = await bridge.payInvoice({
        paymentRequest: invoice.trim(),
        ...(zeroAmount ? { amountSat: String(amountSat) } : {}),
        feeLimitSat: String(capSat),
      });
      setOutcome(res);
      if (res.status === 'succeeded') {
        toast({ title: 'Payment sent', body: `${formatSats(amountSat, unit)} ${unit === 'btc' ? 'BTC' : 'sats'} over Lightning`, tone: 'positive' });
        bumpRefresh();
        const hash = res.paymentHash || decoded.paymentHashHex;
        bridge
          .payments(50)
          .then(({ payments }) => {
            const p = payments.find((x) => x.paymentHash === hash);
            if (p !== undefined) setPaidFeeSat(p.feeSat);
          })
          .catch(() => undefined);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const steps = outcome ? 2 : decoded ? 1 : 0;

  return (
    <div className="p-grid">
      <div className="p-span-8 p-stack">
        {outcome === null ? (
          <Panel title="Invoice" note={steps === 0 ? 'Paste a BOLT-11 payment request. Nothing is paid until you confirm on the next step.' : undefined}>
            <div className="p-stack">
              <Field label="Invoice (BOLT-11)" hint="Starts with lnbc (mainnet), lntb (testnet) or lnbcrt (regtest).">
                {(id) => (
                  <textarea
                    id={id}
                    className="p-textarea"
                    rows={decoded ? 2 : 4}
                    spellCheck={false}
                    placeholder="lnbc…"
                    value={invoice}
                    onChange={(e) => {
                      setInvoice(e.target.value);
                      reset();
                    }}
                  />
                )}
              </Field>
              {decoded === null ? (
                <div className="p-row">
                  <button type="button" className="p-btn p-btn-primary" disabled={busy !== null} onClick={() => void decode()}>
                    {busy === 'decode' ? 'Decoding…' : 'Decode and review'}
                  </button>
                </div>
              ) : null}
            </div>
          </Panel>
        ) : null}

        {decoded !== null && outcome === null ? (
          <section className="p-panel sw-review" data-testid="payment-review" aria-label="Review payment">
            <div className="p-spread" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="p-stat-label">You pay</div>
                <div className="p-figure">
                  {zeroAmount ? (amountSat > 0 ? <Amount sats={amountSat} /> : <span className="p-muted">Choose an amount</span>) : <Amount sats={decoded.amountSat} />}
                </div>
                <div className="p-muted" style={{ marginTop: 4 }}>{decoded.memo !== '' ? `“${decoded.memo}”` : 'No description in this invoice'}</div>
              </div>
              <span className="p-badge" data-tone="accent" data-plain="true">
                <Icon name="bolt" size={12} /> Lightning
              </span>
            </div>

            <div className="p-divider" />

            <div className="p-grid">
              <div className="p-span-6 p-stack">
                {zeroAmount ? (
                  <Field label="Amount (sats)" hint="This invoice has no amount; you choose what to send." error={amountError}>
                    {(id) => (
                      <div className="p-input-affix">
                        <input id={id} className="p-input" inputMode="numeric" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} aria-invalid={amountError ? true : undefined} />
                        <span>sats</span>
                      </div>
                    )}
                  </Field>
                ) : null}
                <Field
                  label="Fee cap (sats)"
                  error={cap.error ?? (feeCap.trim() === '' ? 'Set a maximum routing fee.' : null)}
                  hint="The most you'll pay routing nodes. If no route fits under it, the payment fails and nothing is spent. Default: 0.5% of the amount, at least 10 sats."
                >
                  {(id) => (
                    <div className="p-input-affix">
                      <input id={id} className="p-input" inputMode="numeric" value={feeCap} onChange={(e) => setFeeCap(e.target.value)} aria-invalid={cap.error ? true : undefined} />
                      <span>sats</span>
                    </div>
                  )}
                </Field>
              </div>
              <div className="p-span-6">
                <Breakdown
                  rows={[
                    { label: 'Recipient receives', sats: amountSat },
                    { label: 'Routing fees, at most', sats: capSat, note: 'Actual fee is known after the payment and is usually lower' },
                  ]}
                  total={{ label: 'Total, at most', sats: amountSat + capSat }}
                />
              </div>
            </div>

            <div className="p-divider" />

            <Details
              rows={[
                { label: 'Destination node', value: shortId(decoded.destination, 12, 10), mono: true },
                { label: 'Payment hash', value: shortId(decoded.paymentHashHex, 12, 10), mono: true },
                { label: 'Final hop time lock', value: `${decoded.cltvExpiry} blocks` },
                { label: 'Paid from', value: 'Lightning channels (outbound balance)' },
                { label: 'Timing', value: 'Usually settles in seconds; the app waits up to 60 s for a final result' },
              ]}
            />

            {ownInvoice ? (
              <div style={{ marginTop: 16 }}>
                <Notice tone="warning" title="This is your own invoice">
                  Paying yourself would route funds around a loop and back. Share this invoice with the payer instead.
                </Notice>
              </div>
            ) : overSpendable && amountSat > 0 ? (
              <div style={{ marginTop: 16 }}>
                <Notice tone="warning" title="This may be more than you can send right now">
                  Your channels can send <Amount sats={accounts.lightningSpendableSat} /> in total, and the amount plus the fee cap is <Amount sats={amountSat + capSat} />. The payment will
                  likely fail. Add outbound liquidity first, or lower the fee cap.
                </Notice>
              </div>
            ) : null}

            <div className="p-row" style={{ marginTop: 20 }}>
              <button type="button" className="p-btn p-btn-primary" disabled={!canPay || busy !== null} onClick={() => void pay()}>
                {busy === 'pay' ? 'Paying…' : amountSat > 0 ? `Pay ${formatSats(amountSat, 'sats')} sats` : 'Pay'}
              </button>
              <button type="button" className="p-btn p-btn-ghost" disabled={busy !== null} onClick={reset}>
                Cancel
              </button>
              {busy === 'pay' ? <span className="p-hint">Finding a route and waiting for the recipient to settle…</span> : null}
            </div>
          </section>
        ) : null}

        {outcome !== null ? (
          <section className="p-panel" data-testid="payment-outcome" aria-live="polite">
            {outcome.status === 'succeeded' ? (
              <>
                <div className="sw-result-head" data-tone="positive">
                  <Icon name="check" size={20} />
                  <div>
                    <h2 className="p-panel-title">Payment succeeded</h2>
                    <div className="p-muted">The recipient released the preimage: proof that they were paid.</div>
                  </div>
                </div>
                <div className="p-grid" style={{ marginTop: 16 }}>
                  <div className="p-span-6">
                    <Breakdown
                      rows={[
                        { label: 'Sent to recipient', sats: amountSat },
                        { label: 'Routing fee paid', sats: paidFeeSat === null ? null : Number(paidFeeSat), note: paidFeeSat === null ? 'Looking up the final fee…' : undefined },
                      ]}
                      total={paidFeeSat === null ? undefined : { label: 'Total spent', sats: amountSat + Number(paidFeeSat) }}
                    />
                  </div>
                  <div className="p-span-6">
                    <Details
                      rows={[
                        { label: 'Memo', value: decoded?.memo || '—' },
                        { label: 'Payment hash', value: shortId(outcome.paymentHash || decoded?.paymentHashHex || '', 10, 8), mono: true },
                      ]}
                    />
                  </div>
                </div>
                {outcome.preimage ? (
                  <div style={{ marginTop: 16 }}>
                    <Field label="Preimage (proof of payment)">{() => <CopyValue value={outcome.preimage ?? ''} label="Preimage" />}</Field>
                  </div>
                ) : null}
                <div className="p-row" style={{ marginTop: 20 }}>
                  <Link to="/activity" className="p-btn">
                    View in activity
                  </Link>
                  <button
                    type="button"
                    className="p-btn p-btn-ghost"
                    onClick={() => {
                      setInvoice('');
                      reset();
                    }}
                  >
                    Pay another invoice
                  </button>
                </div>
              </>
            ) : outcome.status === 'failed' ? (
              <>
                <div className="sw-result-head" data-tone="danger">
                  <Icon name="error" size={20} />
                  <div>
                    <h2 className="p-panel-title">Payment failed: {outcome.failureReason ?? 'unknown reason'}</h2>
                    <div className="p-muted">{failureExplanation(outcome.failureReason)}</div>
                  </div>
                </div>
                <div className="p-row" style={{ marginTop: 20 }}>
                  <button type="button" className="p-btn" onClick={() => setOutcome(null)}>
                    Back to review
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="sw-result-head" data-tone="warning">
                  <Icon name="warning" size={20} />
                  <div>
                    <h2 className="p-panel-title">No final result yet</h2>
                    <div className="p-muted">
                      The payment is still in flight. Don't pay this invoice again: check Activity in a minute, where it will show as succeeded or failed.
                    </div>
                  </div>
                </div>
                <div className="p-row" style={{ marginTop: 20 }}>
                  <Link to="/activity" className="p-btn">
                    View in activity
                  </Link>
                </div>
              </>
            )}
          </section>
        ) : null}

        {error !== null ? (
          <div data-testid="pay-error">
            <Notice tone="danger" title={busy === null && decoded !== null ? 'Payment could not be sent' : 'Something went wrong'}>
              {error}
            </Notice>
          </div>
        ) : null}
      </div>
      <div className="p-span-4 p-stack">
        <FundsPanel focus="lightning" />
        <Panel title="How Lightning payments work">
          <ol className="sw-steps-list">
            <li>The invoice says who to pay, how much, and carries a payment hash.</li>
            <li>Your node finds a route through its channels, capped by your fee limit.</li>
            <li>The recipient settles by revealing the preimage. Until then the payment can't complete, so a failure costs nothing.</li>
          </ol>
        </Panel>
      </div>
    </div>
  );
}

// ——— On-chain ———

/** Virtual size of a typical one-input (P2WPKH) send with change. Used only to illustrate the fee. */
const TYPICAL_VBYTES = 141;

const FEE_TARGETS = [
  { conf: 2, label: 'Fast', timing: 'about 20 min' },
  { conf: 6, label: 'Normal', timing: 'about 1 hour' },
  { conf: 144, label: 'Economy', timing: 'about 1 day' },
] as const;

function OnchainSend() {
  const { bridge, services, toast, bumpRefresh } = usePlatform();
  const { accounts, wallet, channels } = useFunds();
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [sendAll, setSendAll] = useState(false);
  const [feeRate, setFeeRate] = useState('');
  const [label, setLabel] = useState('');
  const [suggest, setSuggest] = useState<{ conf: number; est?: FeeEstimateView; error?: string }[] | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [sent, setSent] = useState<{ address: string; amountSat: number | null; rate: number } | null>(null);

  // Fee suggestions from lnd's estimator (targets in blocks — NOT a fee rate).
  // Asked one at a time; if the node can't estimate at all, stop after the first.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: { conf: number; est?: FeeEstimateView; error?: string }[] = [];
      for (const t of FEE_TARGETS) {
        try {
          out.push({ conf: t.conf, est: await bridge.estimateFee(t.conf) });
        } catch (err) {
          out.push({ conf: t.conf, error: errorText(err) });
          if (out.every((x) => x.est === undefined)) break;
        }
      }
      if (alive) setSuggest(out);
    })();
    return () => {
      alive = false;
    };
  }, [bridge]);

  const network = services.data?.network;
  const addrProblem = addressLooksWrong(address, network);
  const amt = readSats(amount);
  const rate = Number(feeRate.trim());
  const rateError = feeRate.trim() === '' ? 'Enter a fee rate.' : !Number.isInteger(rate) || rate < 1 ? 'Use a whole number of sat/vbyte, 1 or more.' : rate > 1000 ? 'That rate is unusually high. Use 1,000 sat/vbyte or less.' : null;
  const amountError = sendAll
    ? null
    : amt.error ?? (amt.value === undefined ? 'Enter an amount, or choose to send everything.' : amt.value <= 546 ? 'Amounts of 546 sats or less are below the dust limit and are rejected.' : null);
  const estFeeSat = rateError === null ? rate * TYPICAL_VBYTES : null;
  const overBalance = !sendAll && amt.value !== undefined && wallet.data !== undefined && amt.value + (estFeeSat ?? 0) > accounts.onchainSpendableSat;
  const valid = addrProblem === null && amountError === null && rateError === null;
  const anchorReserve = Number(wallet.data?.reservedAnchorSat ?? 0);
  const hasChannels = (channels.data?.open.length ?? 0) + (channels.data?.pending.length ?? 0) > 0;

  const review = () => {
    setTouched(true);
    setError(null);
    if (valid) setReviewing(true);
  };

  const authorize = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.sendCoins({
        address: address.trim(),
        ...(sendAll ? { sendAll: true } : { amountSat: String(amt.value) }),
        satPerVbyte: rate,
        ...(label.trim() === '' ? {} : { label: label.trim() }),
      });
      setTxid(res.txid);
      setSent({ address: address.trim(), amountSat: sendAll ? null : amt.value ?? null, rate });
      setReviewing(false);
      toast({ title: 'Bitcoin sent', body: 'Broadcast to the network; waiting for the first confirmation.', tone: 'positive' });
      bumpRefresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setTxid(null);
    setSent(null);
    setAddress('');
    setAmount('');
    setSendAll(false);
    setLabel('');
    setTouched(false);
  };

  const suggestOk = suggest?.filter((s) => s.est !== undefined) ?? [];
  const suggestErr = suggest !== null && suggestOk.length === 0 ? suggest[0]?.error : undefined;

  return (
    <div className="p-grid">
      <div className="p-span-8 p-stack">
        {txid !== null && sent !== null ? (
          <section className="p-panel" aria-live="polite">
            <div className="sw-result-head" data-tone="positive">
              <Icon name="check" size={20} />
              <div>
                <h2 className="p-panel-title">Transaction broadcast</h2>
                <div className="p-muted">It's in the mempool. It counts as confirmed once a miner includes it in a block; a higher fee rate gets there sooner.</div>
              </div>
            </div>
            <div className="p-stack" style={{ marginTop: 16 }}>
              <div data-testid="send-txid">
                <Field label="Transaction id">{() => <CopyValue value={txid} label="Transaction id" />}</Field>
              </div>
              <Details
                rows={[
                  { label: 'To', value: shortId(sent.address, 14, 10), mono: true },
                  { label: 'Amount', value: sent.amountSat === null ? 'Entire on-chain balance, less the network fee' : <Amount sats={sent.amountSat} /> },
                  { label: 'Fee rate', value: `${sent.rate} sat/vbyte` },
                ]}
              />
            </div>
            <div className="p-row" style={{ marginTop: 20 }}>
              <Link to="/activity" className="p-btn">
                View in activity
              </Link>
              <button type="button" className="p-btn p-btn-ghost" onClick={startOver}>
                Send again
              </button>
            </div>
          </section>
        ) : (
          <Panel title={reviewing ? 'Review on-chain send' : 'Send on-chain'} note={reviewing ? 'Check every detail. On-chain sends cannot be reversed.' : undefined}>
            {!reviewing ? (
              <div className="p-stack">
                <Field label="Bitcoin address" error={touched ? addrProblem : null}>
                  {(id) => (
                    <input
                      id={id}
                      className="p-input p-mono"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={network === 'regtest' ? 'bcrt1q…' : network === 'mainnet' ? 'bc1q…' : 'tb1q…'}
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      aria-invalid={touched && addrProblem ? true : undefined}
                    />
                  )}
                </Field>
                <div className="p-grid">
                  <div className="p-span-6">
                    {sendAll ? (
                      <Field label="Amount" hint="Everything spendable on-chain, minus the network fee.">
                        {(id) => <input id={id} className="p-input" disabled value="Entire balance" />}
                      </Field>
                    ) : (
                      <Field label="Amount (sats)" error={touched ? amountError : null} hint={<>Spendable now: <Amount sats={accounts.onchainSpendableSat} /></>}>
                        {(id) => (
                          <div className="p-input-affix">
                            <input id={id} className="p-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={touched && amountError ? true : undefined} />
                            <span>sats</span>
                          </div>
                        )}
                      </Field>
                    )}
                    <label className="p-check" style={{ marginTop: 10 }}>
                      <input type="checkbox" checked={sendAll} onChange={(e) => setSendAll(e.target.checked)} />
                      <span>Send entire on-chain balance</span>
                    </label>
                  </div>
                  <div className="p-span-6">
                    <Field
                      label="Fee rate (sat/vbyte)"
                      error={touched ? rateError : null}
                      hint={estFeeSat !== null ? <>About <Amount sats={estFeeSat} /> for a typical single-input send ({TYPICAL_VBYTES} vbytes)</> : 'What you pay miners per virtual byte. Higher confirms sooner.'}
                    >
                      {(id) => (
                        <div className="p-input-affix">
                          <input id={id} className="p-input" inputMode="numeric" value={feeRate} onChange={(e) => setFeeRate(e.target.value)} aria-invalid={touched && rateError ? true : undefined} />
                          <span>sat/vB</span>
                        </div>
                      )}
                    </Field>
                    <div className="sw-fee-chips" aria-label="Fee suggestions from your node">
                      {suggest === null ? (
                        <span className="p-hint">Asking your node for fee suggestions…</span>
                      ) : suggestOk.length > 0 ? (
                        suggestOk.map((s) => {
                          const t = FEE_TARGETS.find((x) => x.conf === s.conf);
                          const r = Number(s.est?.satPerVbyte ?? 0);
                          return (
                            <button key={s.conf} type="button" className="p-btn p-btn-sm" aria-pressed={rate === r} onClick={() => setFeeRate(String(r))}>
                              {t?.label} · {r} sat/vB · {t?.timing}
                            </button>
                          );
                        })
                      ) : (
                        <span className="p-hint">Your node couldn't suggest a fee rate ({suggestErr}). Enter one yourself; 1–2 sat/vbyte is typical on regtest and quiet mainnet periods.</span>
                      )}
                    </div>
                  </div>
                </div>
                <Field label="Label (optional)" hint="Stored in your node's wallet with the transaction. Never sent on-chain.">
                  {(id) => <input id={id} className="p-input" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />}
                </Field>
                {overBalance ? (
                  <Notice tone="warning" title="Amount plus fee is more than your spendable on-chain balance">
                    You have <Amount sats={accounts.onchainSpendableSat} /> confirmed and spendable. lnd will refuse this send.
                  </Notice>
                ) : null}
                <div className="p-row">
                  <button type="button" className="p-btn p-btn-primary" onClick={review}>
                    Review send
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-stack">
                <div>
                  <div className="p-stat-label">You send</div>
                  <div className="p-figure">{sendAll ? <>Entire balance</> : <Amount sats={amt.value} />}</div>
                </div>
                <Details
                  rows={[
                    { label: 'From', value: 'On-chain wallet (confirmed coins only)' },
                    { label: 'To', value: address.trim(), mono: true },
                    { label: 'Fee rate', value: `${rate} sat/vbyte` },
                    ...(label.trim() !== '' ? [{ label: 'Label', value: label.trim() }] : []),
                    { label: 'Timing', value: 'Broadcast immediately; confirms when a miner includes it' },
                  ]}
                />
                <Breakdown
                  rows={[
                    { label: 'Recipient receives', sats: sendAll ? null : amt.value ?? null, note: sendAll ? 'Your spendable balance minus the fee; lnd computes it exactly when it builds the transaction' : undefined },
                    {
                      label: 'Network fee, estimated',
                      sats: estFeeSat,
                      note: `${rate} sat/vbyte × ${TYPICAL_VBYTES} vbytes (one input, with change). More inputs cost more; lnd picks the coins.`,
                    },
                  ]}
                  total={sendAll ? undefined : { label: 'Total, estimated', sats: (amt.value ?? 0) + (estFeeSat ?? 0) }}
                />
                {sendAll && hasChannels && anchorReserve > 0 ? (
                  <Notice tone="info" title="Anchor reserve stays in the wallet">
                    Because you have channels, lnd keeps <Amount sats={anchorReserve} /> on-chain to fee-bump channel closes. Sending everything sends the rest.
                  </Notice>
                ) : null}
                <Notice tone="warning" title="On-chain sends are final">
                  Bitcoin sent to the wrong address can't be recovered. Compare the first and last characters with the recipient's address.
                </Notice>
                <div className="p-row">
                  <button type="button" className="p-btn p-btn-primary" disabled={busy} onClick={() => void authorize()}>
                    {busy ? 'Sending…' : 'Authorize and send'}
                  </button>
                  <button type="button" className="p-btn p-btn-ghost" disabled={busy} onClick={() => setReviewing(false)}>
                    Edit
                  </button>
                </div>
              </div>
            )}
          </Panel>
        )}
        {error !== null ? (
          <div data-testid="send-error">
            <Notice tone="danger" title="lnd didn't send the transaction">
              {error}
            </Notice>
          </div>
        ) : null}
      </div>
      <div className="p-span-4 p-stack">
        <FundsPanel focus="onchain" />
        <Panel title="Fees and confirmations">
          <ol className="sw-steps-list">
            <li>The fee depends on the transaction's size in vbytes, not on the amount you send.</li>
            <li>Miners pick the highest-paying transactions first, so a higher rate confirms sooner.</li>
            <li>Most recipients treat a payment as final after 1–6 confirmations (about 10–60 minutes).</li>
          </ol>
        </Panel>
      </div>
    </div>
  );
}
