/**
 * Channel manager: liquidity summary, open + pending channels (with fee
 * policy), the open-channel form, and closed channels. Row → detail sheet
 * with the fee policy editor and close flow (channels-sheet.tsx).
 */
import { useMemo, useRef, useState } from 'react';
import type { ChannelRowView } from '../../../modeb/bridge-client.js';
import { computeAccounts } from '../../balances.js';
import { usePlatform, usePoll } from '../../context.js';
import { Amount, Breakdown, Empty, Field, Icon, LiquidityBar, Notice, PageHeader, Panel, Skeleton, Stat, relativeTime, shortId } from '../../ui.js';
import { ChannelSheet } from './channels-sheet.js';
import { RowNote, SplitBar, StateBadge, errorText, formatMsatAsSats, scid } from './channels-kit.js';

export default function ChannelsPage() {
  const { bridge, api, refreshKey } = usePlatform();
  const channels = usePoll(() => bridge.channels(), 10_000, [refreshKey]);
  const fees = usePoll(() => api.feeReport(), 30_000, [refreshKey]);
  const diag = usePoll(() => bridge.diagnostics(), 60_000, [refreshKey]);
  const wallet = usePoll(() => bridge.walletBalance(), 15_000, [refreshKey]);
  const [selected, setSelected] = useState<string | null>(null);
  const formRef = useRef<HTMLInputElement>(null);

  const accounts = useMemo(() => computeAccounts(wallet.data, channels.data), [wallet.data, channels.data]);
  const open = channels.data?.open ?? [];
  const pending = channels.data?.pending ?? [];
  const capacity = open.reduce((s, c) => s + Number(c.capacitySat), 0);
  const active = open.filter((c) => c.state === 'open').length;
  const policyFor = (cp: string) => fees.data?.policies.find((p) => p.channelPoint === cp);
  const current = [...open, ...pending].find((c) => c.channelPoint === selected);

  return (
    <>
      <PageHeader
        title="Channels"
        sub="Your Lightning channels: how liquidity is split, what each charges to route, and how to open or close them."
        actions={
          <button
            type="button"
            className="p-btn p-btn-primary"
            onClick={() => {
              formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              formRef.current?.focus({ preventScroll: true });
            }}
          >
            <Icon name="plus" /> New channel
          </button>
        }
      />

      <div className="p-stack">
        <Panel title="Lightning liquidity" note={channels.updatedAt ? `Updated ${relativeTime(channels.updatedAt)}` : undefined}>
          {channels.loading && !channels.data ? (
            <Skeleton height={96} />
          ) : channels.error && !channels.data ? (
            <Notice tone="danger" title="Couldn't load channels" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void channels.reload()}>Retry</button>}>
              {channels.error}
            </Notice>
          ) : (
            <div data-testid="channel-balance">
              <div className="ch-summary">
                <Stat label="Spendable" foot="Your side: what you can send">
                  <Amount sats={accounts.lightningSpendableSat} />
                </Stat>
                <Stat label="Receivable" foot="Peers' side: what you can receive">
                  <Amount sats={accounts.lightningReceivableSat} />
                </Stat>
                <Stat label="Total capacity" foot={`${open.length} channel${open.length === 1 ? '' : 's'}`}>
                  <Amount sats={capacity} />
                </Stat>
                <Stat label="Active" foot={open.length - active > 0 ? `${open.length - active} with peer offline` : 'All peers online'}>
                  {active} of {open.length}
                </Stat>
                <Stat label="Pending" foot={accounts.channelsOpeningSat > 0 ? <>Opening: <Amount sats={accounts.channelsOpeningSat} /></> : 'Opening or closing'}>
                  {pending.length}
                </Stat>
              </div>
              <LiquidityBar
                size="lg"
                segments={[
                  { kind: 'outbound', sats: accounts.lightningSpendableSat, label: 'Spendable (local)' },
                  { kind: 'locked', sats: accounts.channelsOpeningSat + accounts.lightningInFlightSat, label: 'Opening or in flight' },
                  { kind: 'inbound', sats: accounts.lightningReceivableSat, label: 'Receivable (remote)' },
                ]}
              />
            </div>
          )}
        </Panel>

        <Panel flush title="Open channels" note="Select a channel to see details, change its routing fees, or close it." testId="open-channels">
          {channels.loading && !channels.data ? (
            <div style={{ padding: 20 }} className="p-stack">
              <Skeleton height={20} />
              <Skeleton height={20} />
            </div>
          ) : open.length === 0 ? (
            <div style={{ padding: '8px 20px 24px' }}>
              <Empty title="No open channels yet">Open a channel below to send and receive over Lightning. Its capacity starts on your side; you receive once you've spent some or a peer opens to you.</Empty>
            </div>
          ) : (
            <ChannelTable rows={open} policyFor={policyFor} feesError={fees.error} onSelect={setSelected} />
          )}
        </Panel>

        {pending.length > 0 ? (
          <Panel flush title="Pending channels" note="Waiting for on-chain confirmations. Funds here are yours but can't move until the channel opens or the close settles." testId="pending-channels">
            <ChannelTable rows={pending} pending onSelect={setSelected} />
          </Panel>
        ) : null}

        <OpenChannelForm inputRef={formRef} spendableOnchain={accounts.onchainSpendableSat} onOpened={() => void channels.reload()} />

        <Panel flush title="Closed channels" note="Channels this node has closed or that peers closed, from lnd's history.">
          {diag.loading && !diag.data ? (
            <div style={{ padding: 20 }}>
              <Skeleton height={20} />
            </div>
          ) : diag.error && !diag.data ? (
            <div style={{ padding: 20 }}>
              <Notice tone="danger" title="Couldn't load closed channels" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void diag.reload()}>Retry</button>}>
                {diag.error}
              </Notice>
            </div>
          ) : (diag.data?.closed.length ?? 0) === 0 ? (
            <div style={{ padding: '8px 20px 24px' }}>
              <Empty title="No closed channels">Channels you or your peers close show up here with how their funds were settled.</Empty>
            </div>
          ) : (
            <div className="p-table-wrap">
              <table className="p-table">
                <thead>
                  <tr>
                    <th>Peer</th>
                    <th>How it closed</th>
                    <th>Closed at block</th>
                    <th className="p-num">Settled to you</th>
                    <th className="p-num">Time-locked</th>
                    <th>Closing transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {diag.data?.closed.map((c) => (
                    <tr key={c.channelPoint}>
                      <td className="p-mono">{shortId(c.remotePubkey, 10, 6)}</td>
                      <td>{c.closeType}</td>
                      <td>{c.closeHeight.toLocaleString('en-US')}</td>
                      <td className="p-num">
                        <Amount sats={c.settledBalanceSat} />
                      </td>
                      <td className="p-num">
                        <Amount sats={c.timeLockedBalanceSat} />
                      </td>
                      <td className="p-mono">{shortId(c.closingTxHash, 10, 6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {current ? <ChannelSheet channel={current} policy={policyFor(current.channelPoint)} onClose={() => setSelected(null)} onChanged={() => void Promise.all([channels.reload(), fees.reload()])} /> : null}
    </>
  );
}

function ChannelTable({
  rows,
  pending,
  policyFor,
  feesError,
  onSelect,
}: {
  rows: readonly ChannelRowView[];
  pending?: boolean;
  policyFor?: (cp: string) => { baseFeeMsat: number; feePpm: number } | undefined;
  feesError?: string | null;
  onSelect: (cp: string) => void;
}) {
  return (
    <div className="p-table-wrap">
      <table className="p-table">
        <thead>
          <tr>
            <th>Peer</th>
            <th>Status</th>
            <th className="p-num">Capacity</th>
            <th>Local / remote (sats)</th>
            {pending ? <th>Progress</th> : <th>Routing fee</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => {
            const pol = policyFor?.(c.channelPoint);
            return (
              <tr
                key={`${c.channelPoint}-${i}`}
                data-testid="channel-row"
                data-channel-point={c.channelPoint}
                data-clickable="true"
                tabIndex={0}
                onClick={() => onSelect(c.channelPoint)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(c.channelPoint);
                  }
                }}
              >
                <td>
                  <div className="ch-peer">
                    <span className="p-mono">{shortId(c.remotePubkey, 10, 6)}</span>
                    <small>{pending ? shortId(c.channelPoint, 10, 4) : `${c.initiatorLabel}${scid(c.chanId) ? ` · ${scid(c.chanId)}` : ''}`}</small>
                  </div>
                </td>
                <td>
                  <StateBadge state={c.state} />
                </td>
                <td className="p-num">
                  <Amount sats={c.capacitySat} />
                </td>
                <td>
                  <SplitBar local={Number(c.localBalanceSat)} remote={Number(c.remoteBalanceSat)} />
                </td>
                {pending ? (
                  <td className="p-muted">
                    <RowNote label={c.initiatorLabel} />
                  </td>
                ) : (
                  <td className="ch-policy">
                    {pol ? (
                      <>
                        {formatMsatAsSats(pol.baseFeeMsat)} sat + {pol.feePpm.toLocaleString('en-US')} ppm
                      </>
                    ) : feesError ? (
                      <span className="p-faint" title={feesError}>Unavailable</span>
                    ) : (
                      <span className="p-faint">—</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ——— open channel ———

/** Virtual size of a typical funding transaction (one P2WPKH input, channel output + change). Illustrative only. */
const FUNDING_VBYTES = 154;
const MIN_FUNDING = 20_000;
const MAX_FUNDING = 16_777_215;

function OpenChannelForm({ inputRef, spendableOnchain, onOpened }: { inputRef: React.RefObject<HTMLInputElement>; spendableOnchain: number; onOpened: () => void }) {
  const { bridge, node, toast, bumpRefresh } = usePlatform();
  const [pubkey, setPubkey] = useState('');
  const [host, setHost] = useState('');
  const [amount, setAmount] = useState('');
  const [feeRate, setFeeRate] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  // Accept "pubkey@host:port" pasted into the pubkey field.
  const onPubkey = (v: string) => {
    const m = /^\s*([0-9a-fA-F]{66})@(\S+)\s*$/.exec(v);
    if (m) {
      setPubkey(m[1] ?? '');
      setHost(m[2] ?? '');
    } else setPubkey(v);
  };

  const pk = pubkey.trim();
  const pkError = pk === '' ? 'Enter the peer’s node public key.' : !/^(02|03)[0-9a-fA-F]{64}$/.test(pk) ? 'A node public key is 66 hex characters starting with 02 or 03.' : pk === node.info?.identityPubkey ? 'That’s your own node.' : null;
  const hostError = host.trim() !== '' && !/^[^\s:]+(:\d{1,5})?$/.test(host.trim()) && !/^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(host.trim()) ? 'Use host:port, for example 203.0.113.5:9735.' : null;
  const amtRaw = amount.trim().replace(/[,_\s]/g, '');
  const amt = /^\d+$/.test(amtRaw) ? Number(amtRaw) : NaN;
  const amtError = amtRaw === '' ? 'Enter how much to put in the channel.' : !Number.isSafeInteger(amt) ? 'Enter a whole number of sats.' : amt < MIN_FUNDING ? 'Channels need at least 20,000 sats.' : amt > MAX_FUNDING ? 'lnd caps standard channels at 16,777,215 sats.' : null;
  const rate = Number(feeRate.trim());
  const rateError = feeRate.trim() === '' ? 'Enter a fee rate for the funding transaction.' : !Number.isInteger(rate) || rate < 1 ? 'Use a whole number of sat/vbyte, 1 or more.' : null;
  const valid = pkError === null && hostError === null && amtError === null && rateError === null;
  const estFee = rateError === null ? rate * FUNDING_VBYTES : null;
  const overBalance = amtError === null && amt + (estFee ?? 0) > spendableOnchain;

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    setOpened(null);
    try {
      const request = { nodePubkeyHex: pk.toLowerCase(), localFundingSat: String(amt), satPerVbyte: rate, isPrivate };
      let res: { readonly channelPoint: string };
      try {
        res = await bridge.openChannel({ ...request, ...(host.trim() === '' ? {} : { host: host.trim() }) });
      } catch (err) {
        // lnd refuses to connect twice; if we're already connected, the host isn't needed.
        if (host.trim() !== '' && /already connected/i.test(errorText(err))) res = await bridge.openChannel(request);
        else throw err;
      }
      setOpened(res.channelPoint);
      toast({ title: 'Channel opening', body: 'Funding transaction broadcast. It shows as pending until it confirms.', tone: 'positive' });
      bumpRefresh();
      onOpened();
      setAmount('');
      setTouched(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Open a channel" note="Funds come from your confirmed on-chain balance. The peer must be online and accept the channel.">
      <div className="ch-open-grid">
        <div className="p-stack">
          <Field label="Peer node pubkey (66 hex)" error={touched ? pkError : null} hint="You can paste pubkey@host:port and both fields fill in.">
            {(id) => <input ref={inputRef} id={id} className="p-input p-mono" spellCheck={false} autoComplete="off" placeholder="02… or 03…" value={pubkey} onChange={(e) => onPubkey(e.target.value)} aria-invalid={touched && pkError ? true : undefined} />}
          </Field>
          <Field label="Peer host (needed to connect, e.g. 1.2.3.4:9735)" error={hostError} hint="Leave empty if you're already connected to this peer.">
            {(id) => <input id={id} className="p-input p-mono" spellCheck={false} autoComplete="off" value={host} onChange={(e) => setHost(e.target.value)} aria-invalid={hostError ? true : undefined} />}
          </Field>
          <div className="p-grid">
            <div className="p-span-6">
              <Field label="Funding amount (sats, min 20,000)" error={touched ? amtError : null} hint={<>On-chain spendable: <Amount sats={spendableOnchain} /></>}>
                {(id) => (
                  <div className="p-input-affix">
                    <input id={id} className="p-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={touched && amtError ? true : undefined} />
                    <span>sats</span>
                  </div>
                )}
              </Field>
            </div>
            <div className="p-span-6">
              <Field label="Fee rate (sat/vbyte)" error={touched ? rateError : null} hint="For the funding transaction. Higher confirms sooner.">
                {(id) => (
                  <div className="p-input-affix">
                    <input id={id} className="p-input" inputMode="numeric" value={feeRate} onChange={(e) => setFeeRate(e.target.value)} aria-invalid={touched && rateError ? true : undefined} />
                    <span>sat/vB</span>
                  </div>
                )}
              </Field>
            </div>
          </div>
          <label className="p-check">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            <span>Private channel: not announced to the network, so other nodes won't route through it. Good for a wallet; bad for earning routing fees.</span>
          </label>
          <div className="p-row">
            <button type="button" className="p-btn p-btn-primary" disabled={busy} onClick={() => void submit()}>
              {busy ? 'Opening…' : 'Open channel'}
            </button>
            {busy ? <span className="p-hint">Connecting to the peer and negotiating the channel…</span> : null}
          </div>
        </div>
        <div className="ch-summary-box" aria-label="What opening this channel does">
          <div className="p-stat-label">Before you open</div>
          <Breakdown
            rows={[
              { label: 'Locked into the channel', sats: amtError === null ? amt : null, note: 'Starts on your side: spendable over Lightning once open' },
              { label: 'Funding fee, estimated', sats: estFee, note: rateError === null ? `${rate} sat/vbyte × ~${FUNDING_VBYTES} vbytes; lnd picks the coins` : 'Enter a fee rate' },
            ]}
            total={amtError === null && estFee !== null ? { label: 'Leaves your on-chain wallet', sats: amt + estFee } : undefined}
          />
          <div className="p-hint">
            Reserve: about 1% of the channel ({amtError === null ? <Amount sats={Math.round(amt / 100)} /> : '—'}) stays unspendable on your side while it's open. Ready after the funding transaction
            has enough confirmations (typically 3 to 6 blocks, about 30 to 60 minutes on mainnet). Closing later costs another on-chain fee.
          </div>
          {overBalance ? (
            <Notice tone="warning" title="Not enough confirmed on-chain funds">
              You have <Amount sats={spendableOnchain} /> spendable. Deposit more or lower the amount.
            </Notice>
          ) : null}
        </div>
        <div className="ch-explain-col">
          <div className="p-stat-label">How channels work</div>
          <ol className="ch-explain">
            <li>A channel locks bitcoin in a 2-of-2 output shared with one peer. Its capacity is fixed until it closes.</li>
            <li>Your side (local) is what you can send; the peer's side (remote) is what you can receive. Payments move sats between the sides.</li>
            <li>Closing cooperatively takes one on-chain transaction. A force close works without the peer, but your funds wait out a time lock first.</li>
          </ol>
        </div>
      </div>
      {opened !== null ? (
        <div style={{ marginTop: 16 }} data-testid="channel-opened">
          <Notice tone="positive" title="Channel opening: funding transaction broadcast">
            It appears under pending channels above until the funding transaction confirms, then moves to open channels.
          </Notice>
        </div>
      ) : null}
      {error !== null ? (
        <div style={{ marginTop: 16 }}>
          <Notice tone="danger" title="Channel not opened">
            {error}
          </Notice>
        </div>
      ) : null}
    </Panel>
  );
}
