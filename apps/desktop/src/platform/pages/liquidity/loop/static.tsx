import { useState } from 'react';
import type { QuoteResult } from '../../../api.js';
import { usePlatform, usePoll } from '../../../context.js';
import { Amount, Badge, CopyField, Empty, Notice, Panel, QrCode, shortId, Skeleton, Stat, type Tone } from '../../../ui.js';
import { bip21 } from '../../payments/transfers/routes.js';
import { LoopUnavailableNotice, quoteFailureCopy, SwapProgress, useLoopStatus, type LoopStatus } from './shared.js';

const MIN_DEPOSIT_SAT = 250_000;

const DEPOSIT_TONE: Record<string, Tone> = {
  deposited: 'positive',
  looping_in: 'info',
  looped_in: 'neutral',
  withdrawing: 'info',
  withdrawn: 'neutral',
  expired: 'warning',
};

const depositLabel = (s: string): string => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function StaticAddressView({ status: given }: { status?: LoopStatus }) {
  const own = useLoopStatus();
  const status = given ?? own;
  const { api, refreshKey, toast, bumpRefresh } = usePlatform();
  const view = usePoll(() => api.staticAddress(), 15_000, [api, refreshKey]);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [execErr, setExecErr] = useState<string | null>(null);
  const [swapId, setSwapId] = useState<string | null>(null);

  const create = async () => {
    setCreating(true);
    setCreateErr(null);
    try {
      await api.newStaticAddress();
      toast({ title: 'Static address created', tone: 'positive' });
      await view.reload();
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  if (view.data === undefined) {
    return view.error ? (
      <Notice tone="danger" title="Could not read the static address" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void view.reload()}>Retry</button>}>
        {view.error}
      </Notice>
    ) : (
      <Panel>
        <Skeleton height={180} />
      </Panel>
    );
  }

  const s = view.data.summary;
  const deposits = view.data.deposits;
  const eligible = deposits.filter((d) => d.state === 'deposited');
  const chosen = eligible.filter((d) => selected.includes(d.outpoint));
  const chosenSat = chosen.reduce((sum, d) => sum + d.valueSat, 0);
  const q = quote?.ok ? quote.quote : null;

  const getQuote = async () => {
    setQuoting(true);
    setQuote(null);
    setAgree(false);
    setExecErr(null);
    try {
      setQuote(await api.loopQuote('loop-in', chosenSat));
    } catch (e) {
      setExecErr(e instanceof Error ? e.message : String(e));
    } finally {
      setQuoting(false);
    }
  };

  const start = async () => {
    if (q === null) return;
    setBusy(true);
    setExecErr(null);
    try {
      const r = await api.staticLoopIn({ outpoints: chosen.map((d) => d.outpoint), authorization: { maxTotalFeeSat: q.fees.swapFeeSat } });
      setSwapId(r.swapHashHex);
      toast({ title: 'Static Loop In started', body: `Swap ${shortId(r.swapHashHex)}`, tone: 'positive' });
      bumpRefresh();
      setSelected([]);
      setQuote(null);
    } catch (e) {
      setExecErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rules = (
    <ul className="p-hint" style={{ margin: 0, paddingLeft: 'var(--sovl-space-4)', display: 'grid', gap: 4 }}>
      <li>The address is a 2-of-2 MuSig2 taproot key shared by your node and the swap server. Neither side can spend alone.</li>
      <li>Each deposit must be at least {MIN_DEPOSIT_SAT.toLocaleString('en-US')} sats; smaller deposits can’t be looped in.</li>
      <li>
        Deposits expire {s ? `${s.relativeExpiryBlocks.toLocaleString('en-US')} blocks` : 'a fixed number of blocks'} after confirming. Before then you can Loop them in; after, you can only withdraw them on-chain.
      </li>
      <li>The address is reusable: send from any wallet, any number of times.</li>
    </ul>
  );

  if (s === null) {
    const offline = status.phase !== 'ready';
    return (
      <div className="p-grid">
        <div className="p-span-7">
          <Panel title="Static deposit address" note="Fund your channels straight from another wallet or an exchange.">
            {offline && status.phase !== 'checking' ? (
              <div className="p-stack">
                <Notice tone="warning" title="The address can’t be created yet">
                  <p className="lp-notice-p">Creating it needs the swap server: the address is a key shared between your node and the server, so the server must take part in generating it.</p>
                  <p className="lp-notice-p">{status.reason}</p>
                  {status.fix ? <p className="lp-notice-p p-faint">{status.fix}</p> : null}
                </Notice>
                <div className="p-row">
                  <button type="button" className="p-btn p-btn-primary" disabled>
                    Create static address
                  </button>
                  <span className="p-hint">Disabled until the swap server is reachable.</span>
                </div>
              </div>
            ) : (
              <Empty
                title="No static address yet"
                action={
                  <button type="button" className="p-btn p-btn-primary" disabled={creating || status.phase === 'checking'} onClick={() => void create()}>
                    {creating ? 'Creating…' : 'Create static address'}
                  </button>
                }
              >
                One address per wallet. loopd reported: <span className="p-mono">{view.data.error ?? 'no address'}</span>
              </Empty>
            )}
            {createErr ? (
              <Notice tone="danger" title="The address was not created">
                {createErr}
              </Notice>
            ) : null}
          </Panel>
        </div>
        <div className="p-span-5">
          <Panel title="How it works">{rules}</Panel>
        </div>
      </div>
    );
  }

  return (
    <div className="p-grid">
      <div className="p-span-7">
        <Panel title="Static deposit address" note="Send bitcoin here from any wallet. Confirmed deposits can then be looped into your channels.">
          <div className="lp-addr">
            <QrCode value={bip21(s.address)} size={168} label="Static address QR code" />
            <div className="p-stack">
              <CopyField value={s.address} label="Static address" />
              <CopyField value={bip21(s.address)} label="Payment URI" />
              {rules}
            </div>
          </div>
        </Panel>
      </div>
      <div className="p-span-5">
        <Panel title="Deposits summary">
          <div className="lp-counts" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <Stat label="Available to Loop In">
              <Amount sats={s.depositedSat} />
            </Stat>
            <Stat label="Unconfirmed">
              <Amount sats={s.unconfirmedSat} />
            </Stat>
            <Stat label="Looped in">
              <Amount sats={s.loopedInSat} />
            </Stat>
            <Stat label="Expired or withdrawn" foot={`${s.totalDeposits} deposit${s.totalDeposits === 1 ? '' : 's'} in total`}>
              <Amount sats={s.expiredSat + s.withdrawnSat} />
            </Stat>
          </div>
        </Panel>
      </div>
      <div className="p-span-12">
        <Panel flush title="Deposits" note="Select confirmed deposits to Loop In. Partial amounts are not offered here; the full value of each deposit is swapped.">
          {deposits.length === 0 ? (
            <Empty title="No deposits yet">Send at least {MIN_DEPOSIT_SAT.toLocaleString('en-US')} sats to the address above.</Empty>
          ) : (
            <div className="p-table-wrap">
              <table className="p-table">
                <thead>
                  <tr>
                    <th aria-label="Select" />
                    <th>Outpoint</th>
                    <th>State</th>
                    <th>Confirmed at</th>
                    <th>Expires in</th>
                    <th className="p-num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {deposits.map((d) => {
                    const can = d.state === 'deposited';
                    return (
                      <tr key={d.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select deposit ${d.outpoint}`}
                            disabled={!can}
                            title={can ? undefined : 'Only deposits in the “deposited” state can be looped in'}
                            checked={selected.includes(d.outpoint)}
                            onChange={(e) => {
                              setQuote(null);
                              setSelected((xs) => (e.target.checked ? [...xs, d.outpoint] : xs.filter((x) => x !== d.outpoint)));
                            }}
                          />
                        </td>
                        <td className="p-mono">{shortId(d.outpoint, 12, 8)}</td>
                        <td>
                          <Badge tone={DEPOSIT_TONE[d.state] ?? 'neutral'}>{depositLabel(d.state)}</Badge>
                        </td>
                        <td>{d.confirmationHeight > 0 ? `Block ${d.confirmationHeight}` : 'Unconfirmed'}</td>
                        <td>{d.blocksUntilExpiry > 0 ? `${d.blocksUntilExpiry} blocks` : '—'}</td>
                        <td className="p-num">
                          <Amount sats={d.valueSat} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
      <div className="p-span-12">
        <Panel title="Loop In selected deposits">
          <LoopUnavailableNotice status={status} />
          {swapId ? (
            <SwapProgress swapId={swapId} />
          ) : (
            <div className="p-stack">
              <div className="p-spread">
                <span className="p-muted">
                  {chosen.length} selected · <Amount sats={chosenSat} />
                </span>
                <button type="button" className="p-btn" disabled={chosen.length === 0 || quoting} onClick={() => void getQuote()}>
                  {quoting ? 'Getting fee…' : 'Get swap fee'}
                </button>
              </div>
              {chosen.length === 0 ? <p className="p-hint">Select at least one deposit above to get a fee.</p> : null}
              {quote && !quote.ok ? (
                (() => {
                  const f = quoteFailureCopy(quote.reason, quote.message, status);
                  return (
                    <Notice tone="warning" title={f.title}>
                      {f.body}
                    </Notice>
                  );
                })()
              ) : null}
              {q ? (
                <>
                  <dl className="p-dl">
                    <dt>Deposits</dt>
                    <dd>
                      <Amount sats={chosenSat} />
                    </dd>
                    <dt>
                      Swap fee ceiling
                      <div className="p-hint">From a Loop In quote for the same amount. The bridge quotes these exact deposits again and refuses if the server asks for more.</div>
                    </dt>
                    <dd>
                      <Amount sats={q.fees.swapFeeSat} />
                    </dd>
                    <dt>
                      Miner fee
                      <div className="p-hint">None: the deposits are already on-chain; the server co-signs the sweep.</div>
                    </dt>
                    <dd>
                      <Amount sats={0} />
                    </dd>
                    <dt className="p-dl-total">You receive over Lightning (at least)</dt>
                    <dd className="p-dl-total">
                      <Amount sats={chosenSat - q.fees.swapFeeSat} />
                    </dd>
                  </dl>
                  <label className="p-check">
                    <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                    <span>
                      I authorize looping in {chosen.length} deposit{chosen.length > 1 ? 's' : ''} (<Amount sats={chosenSat} />) with a swap fee of at most <Amount sats={q.fees.swapFeeSat} />.
                    </span>
                  </label>
                  <div className="lp-form-actions">
                    <button type="button" className="p-btn p-btn-primary" disabled={!agree || busy} onClick={() => void start()}>
                      {busy ? 'Starting…' : 'Loop In deposits'}
                    </button>
                  </div>
                </>
              ) : null}
              {execErr ? (
                <Notice tone="danger" title="Static Loop In did not start">
                  {execErr}
                </Notice>
              ) : null}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
