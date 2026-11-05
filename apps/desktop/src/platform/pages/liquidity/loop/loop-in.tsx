import { useState } from 'react';
import type { LoopQuote, QuoteResult } from '../../../api.js';
import { computeAccounts } from '../../../balances.js';
import { usePlatform, usePoll } from '../../../context.js';
import { Amount, Field, Icon, Notice, Panel, shortId, Skeleton, Steps } from '../../../ui.js';
import { LoopReview } from './loop-out.js';
import { amountError, hashParam, LoopUnavailableNotice, parseSats, RangeHint, SwapProgress, useLoopStatus, type LoopStatus } from './shared.js';

const STEPS = ['Amount', 'Last hop', 'Review', 'Status'] as const;

export function LoopInWizard({ status: given }: { status?: LoopStatus }) {
  const own = useLoopStatus();
  const status = given ?? own;
  const { api, bridge, refreshKey, toast, bumpRefresh } = usePlatform();
  const channels = usePoll(() => bridge.channels(), 30_000, [bridge, refreshKey]);
  const wallet = usePoll(() => bridge.walletBalance(), 30_000, [bridge, refreshKey]);
  const accounts = computeAccounts(wallet.data, channels.data);

  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState(hashParam('amount') ?? '');
  const [lastHop, setLastHop] = useState<string>(hashParam('peer') ?? '');
  const [label, setLabel] = useState('');
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [execErr, setExecErr] = useState<string | null>(null);
  const [swapId, setSwapId] = useState<string | null>(null);

  const range = status.terms?.loopIn;
  const open = channels.data?.open.filter((c) => c.state === 'open') ?? [];
  const peers = [...new Map(open.map((c) => [c.remotePubkey, open.filter((x) => x.remotePubkey === c.remotePubkey)])).entries()];
  const amtErr = amountError(amount, range, { sats: accounts.onchainSpendableSat, what: 'spendable on-chain balance' });
  const sats = parseSats(amount);
  const inboundErr =
    sats !== null && sats > accounts.lightningReceivableSat ? `Your channels can only receive ${accounts.lightningReceivableSat.toLocaleString('en-US')} sats right now; the server could not pay you this much.` : null;
  const peerInbound = lastHop === '' ? null : open.filter((c) => c.remotePubkey === lastHop).reduce((s, c) => s + Number(c.remoteBalanceSat), 0);
  const hopErr = peerInbound !== null && sats !== null && sats > peerInbound ? 'Channels with this peer don’t have that much inbound room.' : null;

  const getQuote = async () => {
    if (sats === null) return;
    setQuoting(true);
    setQuoteErr(null);
    setQuote(null);
    setAgree(false);
    setExecErr(null);
    try {
      setQuote(await api.loopQuote('loop-in', sats));
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
      const r = await api.loopIn({
        amountSat: q.amountSat,
        ...(lastHop ? { lastHopPubkeyHex: lastHop } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
        authorization: { amountSat: q.amountSat, maxTotalFeeSat: q.fees.totalSat },
      });
      setSwapId(r.swapId);
      setStep(3);
      toast({ title: 'Loop In started', body: `Swap ${shortId(r.swapId)}`, tone: 'positive' });
      bumpRefresh();
    } catch (e) {
      setExecErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Loop In" note="Move on-chain bitcoin into your channels as spendable Lightning balance.">
      <Steps steps={STEPS} current={step} />
      {step < 2 ? <LoopUnavailableNotice status={status} /> : null}
      <div className={step < 2 ? 'lp-wizard' : undefined} style={{ marginTop: step < 2 && status.phase !== 'ready' && status.phase !== 'checking' ? 'var(--sovl-space-5)' : undefined }}>
        <div>
          {step === 0 ? (
            <div className="lp-form">
              <Field label="Amount" hint={<RangeHint range={range} />} error={amtErr ?? inboundErr}>
                {(id) => (
                  <div className="p-input-affix">
                    <input id={id} className="p-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 500000" aria-invalid={amtErr !== null || inboundErr !== null} />
                    <span>sats</span>
                  </div>
                )}
              </Field>
              <div className="lp-kv">
                <dt>Spendable on-chain now</dt>
                <dd>{wallet.data ? <Amount sats={accounts.onchainSpendableSat} /> : <Skeleton width={90} />}</dd>
                <dt>Room to receive over Lightning</dt>
                <dd>{channels.data ? <Amount sats={accounts.lightningReceivableSat} /> : <Skeleton width={90} />}</dd>
              </div>
              <div className="lp-form-actions">
                <button type="button" className="p-btn p-btn-primary" disabled={sats === null || amtErr !== null || inboundErr !== null} onClick={() => setStep(1)}>
                  Continue
                </button>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="lp-form">
              <Field label="Receive through" hint="Optional. Pins the last hop so the funds land in channels with this peer.">
                {() =>
                  channels.data === undefined ? (
                    <Skeleton height={56} />
                  ) : open.length === 0 ? (
                    <Notice tone="warning" title="No open channels">Loop In pays you over a channel; open one first.</Notice>
                  ) : (
                    <div className="lp-choices" role="radiogroup" aria-label="Last hop">
                      <label className="lp-choice">
                        <input type="radio" name="lasthop" checked={lastHop === ''} onChange={() => setLastHop('')} />
                        <span className="lp-choice-main">
                          <span>Any channel</span>
                          <span className="p-faint">The server picks the route</span>
                        </span>
                        <span className="p-num">
                          <Amount sats={accounts.lightningReceivableSat} /> <span className="p-faint">inbound</span>
                        </span>
                      </label>
                      {peers.map(([pk, chans]) => (
                        <label className="lp-choice" key={pk}>
                          <input type="radio" name="lasthop" checked={lastHop === pk} onChange={() => setLastHop(pk)} />
                          <span className="lp-choice-main">
                            <span className="p-mono">{shortId(pk, 12, 8)}</span>
                            <span className="p-faint">
                              {chans.length} channel{chans.length > 1 ? 's' : ''}
                            </span>
                          </span>
                          <span className="p-num">
                            <Amount sats={chans.reduce((s, c) => s + Number(c.remoteBalanceSat), 0)} /> <span className="p-faint">inbound</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )
                }
              </Field>
              {hopErr ? <p className="p-error-text">{hopErr}</p> : null}
              <Field label="Label" hint="Optional, stored by loopd with the swap.">
                {(id) => <input id={id} className="p-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />}
              </Field>
              <p className="p-hint">The HTLC confirmation target uses loopd’s default; the bridge does not expose it for Loop In.</p>
              <div className="lp-form-actions">
                <button type="button" className="p-btn p-btn-ghost" onClick={() => setStep(0)}>
                  Back
                </button>
                <button
                  type="button"
                  className="p-btn p-btn-primary"
                  disabled={hopErr !== null}
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
              direction="loop-in"
              status={status}
              amountSat={sats}
              quote={quote}
              quoting={quoting}
              quoteErr={quoteErr}
              rows={[
                ['Source', 'This wallet’s on-chain funds'],
                ['Destination', lastHop ? `Lightning, via peer ${shortId(lastHop, 10, 6)}` : 'Lightning, any channel'],
                ['Rail', 'Loop In via loopd and the Loop swap server'],
              ]}
              agree={agree}
              setAgree={setAgree}
              busy={busy}
              execErr={execErr}
              onBack={() => setStep(1)}
              onRequote={() => void getQuote()}
              onConfirm={(q) => void start(q)}
              confirmLabel="Start Loop In"
            />
          ) : null}

          {step === 3 && swapId ? (
            <div className="p-stack">
              <SwapProgress swapId={swapId} />
              <div className="lp-form-actions">
                <button
                  type="button"
                  className="p-btn"
                  onClick={() => {
                    setStep(0);
                    setSwapId(null);
                    setQuote(null);
                  }}
                >
                  Start another Loop In
                </button>
              </div>
            </div>
          ) : null}
        </div>
        {step < 2 ? (
          <aside className="lp-aside">
            <h3>What happens</h3>
            <div className="lp-flow">
              <Icon name="chain" /> on-chain HTLC <Icon name="chevronRight" /> swap server <Icon name="chevronRight" /> <Icon name="bolt" /> Lightning
            </div>
            <p>Your wallet locks the amount in an on-chain HTLC. The swap server pays you the amount over Lightning, then claims the HTLC with the payment’s preimage.</p>
            <h3>Not the same as a deposit</h3>
            <p>A deposit adds on-chain funds. Loop In converts on-chain funds you already have into outbound capacity in an existing channel, without opening a new one.</p>
            <p>To fund directly from another wallet, use the static address instead.</p>
          </aside>
        ) : null}
      </div>
    </Panel>
  );
}
