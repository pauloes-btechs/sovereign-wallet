/**
 * Channel detail sheet: balances, identifiers, the routing fee policy editor
 * (POST /lnd/fees), and the cooperative / force close flow with job polling.
 */
import { useEffect, useState } from 'react';
import type { ChannelRowView, CloseJobView } from '../../../modeb/bridge-client.js';
import type { FeeReportView } from '../../api.js';
import { usePlatform } from '../../context.js';
import { Amount, CopyField, Field, LiquidityBar, Notice, Segmented, Sheet, Stat, shortId } from '../../ui.js';
import { RowNote, StateBadge, errorText, forwardFeeSat, formatMsatAsSats, scid } from './channels-kit.js';

type Policy = FeeReportView['policies'][number];

export function ChannelSheet({ channel, policy, onClose, onChanged }: { channel: ChannelRowView; policy: Policy | undefined; onClose: () => void; onChanged: () => void }) {
  const isOpen = channel.state === 'open' || channel.state === 'open-inactive';
  const short = scid(channel.chanId);
  const local = Number(channel.localBalanceSat);
  const remote = Number(channel.remoteBalanceSat);
  return (
    <Sheet title="Channel" onClose={onClose}>
      <div className="p-stack" style={{ gap: 20 }}>
        <div className="p-spread">
          <div>
            <div className="p-stat-label">Capacity</div>
            <div className="p-figure">
              <Amount sats={channel.capacitySat} />
            </div>
          </div>
          <StateBadge state={channel.state} />
        </div>

        <LiquidityBar
          segments={[
            { kind: 'outbound', sats: local, label: 'Your side (spendable)' },
            { kind: 'inbound', sats: remote, label: 'Peer side (receivable)' },
          ]}
        />

        {channel.state === 'open-inactive' ? (
          <Notice tone="warning" title="Peer is offline">
            Payments can't use this channel until the peer reconnects. Your funds are safe. If the peer never returns, a force close recovers them.
          </Notice>
        ) : null}
        {!isOpen ? (
          <Notice tone="info" title={channel.state === 'opening' ? 'Waiting for the funding transaction to confirm' : 'This channel is closing'}>
            <RowNote label={channel.initiatorLabel} />
          </Notice>
        ) : null}

        <dl className="ch-kv">
          <div>
            <dt>Peer</dt>
            <dd className="p-mono">{shortId(channel.remotePubkey, 14, 10)}</dd>
          </div>
          {isOpen ? (
            <div>
              <dt>Opened by</dt>
              <dd>{channel.initiatorLabel === 'opened by you' ? 'You' : channel.initiatorLabel === 'opened by peer' ? 'Peer' : channel.initiatorLabel}</dd>
            </div>
          ) : null}
          {short ? (
            <div>
              <dt>Short channel id</dt>
              <dd className="p-mono" title={`lnd chan id ${channel.chanId}`}>
                {short}
              </dd>
            </div>
          ) : null}
          {channel.chanId !== '' ? (
            <div>
              <dt>lnd channel id</dt>
              <dd className="p-mono">{channel.chanId}</dd>
            </div>
          ) : null}
        </dl>

        <Field label="Channel point (funding txid:output)">{() => <CopyField value={channel.channelPoint} label="Channel point" />}</Field>
        <Field label="Peer public key">{() => <CopyField value={channel.remotePubkey} label="Peer public key" />}</Field>

        {isOpen ? <FeePolicyEditor key={policy ? 'reported' : 'unreported'} channel={channel} policy={policy} onChanged={onChanged} /> : null}
        {isOpen ? <CloseChannel channel={channel} onChanged={onChanged} /> : null}
      </div>
    </Sheet>
  );
}

// ——— fee policy ———

const EXAMPLE_SAT = 100_000;

function intIn(raw: string, min: number, max: number): number | null {
  const t = raw.trim().replace(/[,_\s]/g, '');
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

function FeePolicyEditor({ channel, policy, onChanged }: { channel: ChannelRowView; policy: Policy | undefined; onChanged: () => void }) {
  const { api, toast } = usePlatform();
  const [base, setBase] = useState(String(policy?.baseFeeMsat ?? 1000));
  const [ppm, setPpm] = useState(String(policy?.feePpm ?? 1));
  const [delta, setDelta] = useState('80');
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const b = intIn(base, 0, 1_000_000);
  const p = intIn(ppm, 0, 50_000);
  const d = intIn(delta, 18, 2016);
  const valid = b !== null && p !== null && d !== null;
  const changed = policy === undefined || b !== policy.baseFeeMsat || p !== policy.feePpm;
  const exampleFee = valid ? forwardFeeSat(EXAMPLE_SAT, b, p) : null;

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await api.updateFeePolicy({ ...(all ? {} : { channelPoint: channel.channelPoint }), baseFeeMsat: b, feePpm: p, timeLockDelta: d });
      if (res.failed.length > 0) {
        setError(`lnd didn't update ${res.failed.length} channel${res.failed.length === 1 ? '' : 's'}: ${res.failed.join('; ')}`);
      } else {
        setSaved(all ? 'Fee policy updated on every channel.' : 'Fee policy updated on this channel.');
        toast({ title: 'Fee policy updated', body: `${formatMsatAsSats(b)} sat base + ${p.toLocaleString('en-US')} ppm, ${d}-block time lock`, tone: 'positive' });
        onChanged();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ch-section" aria-labelledby="fee-policy-title">
      <h3 id="fee-policy-title">Routing fee policy</h3>
      <p className="p-hint" style={{ margin: '0 0 12px' }}>
        What you charge other nodes to forward payments out through this channel. It's announced to the network and takes effect within minutes. It doesn't affect payments you send.
      </p>
      {policy ? (
        <div className="p-row" style={{ gap: 24, marginBottom: 12 }}>
          <Stat label="Current base fee">{formatMsatAsSats(policy.baseFeeMsat)} sat</Stat>
          <Stat label="Current fee rate">{policy.feePpm.toLocaleString('en-US')} ppm</Stat>
          <Stat label="Inbound discount" foot="Read-only here">
            {policy.inboundBaseFeeMsat === 0 && policy.inboundFeePpm === 0 ? 'None' : `${formatMsatAsSats(policy.inboundBaseFeeMsat)} sat + ${policy.inboundFeePpm} ppm`}
          </Stat>
        </div>
      ) : (
        <Notice tone="info" title="Current policy not reported">
          lnd's fee report didn't include this channel yet. You can still set a policy.
        </Notice>
      )}
      <div className="ch-fields3">
        <Field label="Base fee" error={b === null ? '0 to 1,000,000 msat' : null} hint="Flat charge per forward, in millisats. 1,000 msat = 1 sat.">
          {(id) => (
            <div className="p-input-affix">
              <input id={id} className="p-input" inputMode="numeric" value={base} onChange={(e) => setBase(e.target.value)} aria-invalid={b === null ? true : undefined} />
              <span>msat</span>
            </div>
          )}
        </Field>
        <Field label="Fee rate" error={p === null ? '0 to 50,000 ppm' : null} hint="Parts per million of the amount forwarded. 1,000 ppm = 0.1%.">
          {(id) => (
            <div className="p-input-affix">
              <input id={id} className="p-input" inputMode="numeric" value={ppm} onChange={(e) => setPpm(e.target.value)} aria-invalid={p === null ? true : undefined} />
              <span>ppm</span>
            </div>
          )}
        </Field>
        <Field label="Time-lock delta" error={d === null ? '18 to 2,016 blocks' : null} hint="Blocks you keep to settle a forward on-chain if a peer misbehaves. lnd's default is 80.">
          {(id) => (
            <div className="p-input-affix">
              <input id={id} className="p-input" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} aria-invalid={d === null ? true : undefined} />
              <span>blocks</span>
            </div>
          )}
        </Field>
      </div>
      <div className="ch-example" style={{ marginTop: 12 }}>
        {exampleFee !== null ? (
          <>
            Forwarding <strong><Amount sats={EXAMPLE_SAT} /></strong> through this channel would earn{' '}
            <strong>{exampleFee.toLocaleString('en-US', { maximumFractionDigits: 3 })} sats</strong> ({formatMsatAsSats(b ?? 0)} sat base + {(p ?? 0).toLocaleString('en-US')} ppm × the amount). Higher fees earn more per
            forward but make routers choose other paths.
          </>
        ) : (
          'Fix the highlighted values to see what a forward would earn.'
        )}
      </div>
      <p className="p-hint" style={{ margin: '8px 0 0' }}>
        The bridge doesn't report this channel's current time-lock delta, so the field starts at lnd's default. Saving sets all three values.
      </p>
      <label className="p-check" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        <span>Apply to all my channels</span>
      </label>
      <div className="p-row" style={{ marginTop: 12 }}>
        <button type="button" className="p-btn p-btn-primary" disabled={!valid || busy || (!changed && !all && delta === '80')} onClick={() => void save()}>
          {busy ? 'Updating…' : 'Update fee policy'}
        </button>
        {!changed && !all && delta === '80' && valid ? <span className="p-hint">Change a value to update.</span> : null}
      </div>
      {saved ? (
        <div style={{ marginTop: 12 }}>
          <Notice tone="positive" title={saved} />
        </div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 12 }}>
          <Notice tone="danger" title="Fee policy not updated">
            {error}
          </Notice>
        </div>
      ) : null}
    </section>
  );
}

// ——— close ———

type CloseMode = 'coop' | 'force';

function CloseChannel({ channel, onChanged }: { channel: ChannelRowView; onChanged: () => void }) {
  const { bridge, toast, bumpRefresh } = usePlatform();
  const inactive = channel.state === 'open-inactive';
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<CloseMode>(inactive ? 'force' : 'coop');
  const [rate, setRate] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<CloseJobView | null>(null);

  // Poll the close job until the closing transaction is known or it fails.
  useEffect(() => {
    if (job === null || job.state !== 'closing' || job.error !== undefined) return;
    const t = setInterval(() => {
      bridge.closeJob(job.id).then(
        (next) => {
          if (next.state !== job.state || next.error !== undefined || next.closingTxid !== job.closingTxid) {
            setJob(next);
            if (next.state === 'closed') {
              toast({ title: 'Channel closed', body: 'Closing transaction confirmed. Funds return to your on-chain wallet.', tone: 'positive' });
              bumpRefresh();
              onChanged();
            }
          }
        },
        () => undefined,
      );
    }, 3000);
    return () => clearInterval(t);
  }, [job, bridge, toast, bumpRefresh, onChanged]);

  const r = rate.trim() === '' ? undefined : Number(rate.trim());
  const rateError = r !== undefined && (!Number.isInteger(r) || r < 1) ? 'Whole number of sat/vbyte, 1 or more (or leave empty for lnd’s estimate).' : null;
  const coopBlocked = mode === 'coop' && inactive;

  const close = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.closeChannel({ channelPoint: channel.channelPoint, force: mode === 'force', ...(mode === 'coop' && r !== undefined ? { satPerVbyte: r } : {}) });
      setJob(res);
      toast({ title: mode === 'force' ? 'Force close started' : 'Channel closing', body: 'Watching for the closing transaction.', tone: 'info' });
      bumpRefresh();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (job !== null) {
    return (
      <section className="ch-section" aria-live="polite">
        <h3>Closing</h3>
        {job.error ? (
          <Notice tone="danger" title="Close failed">
            {job.error}
          </Notice>
        ) : job.state === 'closed' ? (
          <Notice tone="positive" title="Channel closed">
            Your side returns to the on-chain wallet{mode === 'force' ? ' after the time lock expires' : ''}.
          </Notice>
        ) : (
          <Notice tone="info" title={job.closingTxid ? 'Closing transaction broadcast' : 'Negotiating the close with your peer…'}>
            The channel shows as pending until the closing transaction confirms. Checking every 3 seconds.
          </Notice>
        )}
        {job.closingTxid ? (
          <div style={{ marginTop: 12 }}>
            <Field label="Closing transaction">{() => <CopyField value={job.closingTxid ?? ''} label="Closing transaction id" />}</Field>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="ch-section">
      <h3>Close channel</h3>
      {!expanded ? (
        <>
          <p className="p-hint" style={{ margin: '0 0 12px' }}>
            Closing settles the channel on-chain and returns your side to your wallet. It can't be undone; reopening costs new on-chain fees.
          </p>
          <button type="button" className="p-btn p-btn-danger" onClick={() => setExpanded(true)}>
            Close channel…
          </button>
        </>
      ) : (
        <div className="p-stack">
          <div>
          <Segmented<CloseMode>
            label="Close type"
            value={mode}
            onChange={(v) => {
              setMode(v);
              setAck(false);
            }}
            options={[
              { value: 'coop', label: 'Cooperative close' },
              { value: 'force', label: 'Force close' },
            ]}
          />
          </div>
          {mode === 'coop' ? (
            inactive ? (
              <Notice tone="warning" title="Cooperative close needs the peer online">
                The peer is offline, so it can't sign a cooperative close. Wait for it to come back, or force close.
              </Notice>
            ) : (
              <>
                <Notice tone="warning" title="Both nodes sign one closing transaction">
                  Your side, <Amount sats={channel.localBalanceSat} />, minus your share of the closing fee, returns to your on-chain wallet once it confirms (usually within an hour). This channel's
                  inbound and outbound liquidity is gone.
                </Notice>
                <Field label="Closing fee rate (sat/vbyte, optional)" error={rateError} hint="Leave empty to let lnd estimate.">
                  {(id) => <input id={id} className="p-input" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} style={{ maxWidth: 200 }} />}
                </Field>
              </>
            )
          ) : (
            <Notice tone="danger" title="Force close: use only if the peer is gone">
              Your node broadcasts its latest channel state without the peer. Your <Amount sats={channel.localBalanceSat} /> is time-locked (often 1 to 2 weeks) before you can spend it, and fees
              are higher. Any payments in flight are settled on-chain. Never force close from an old backup: broadcasting an outdated state can lose the whole channel.
            </Notice>
          )}
          <label className="p-check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={coopBlocked} />
            <span>I understand this closes the channel permanently and costs an on-chain fee.</span>
          </label>
          <div className="p-row">
            <button type="button" className="p-btn p-btn-danger" disabled={!ack || busy || coopBlocked || rateError !== null} onClick={() => void close()}>
              {busy ? 'Closing…' : mode === 'force' ? 'Force close channel' : 'Close channel'}
            </button>
            <button type="button" className="p-btn p-btn-ghost" disabled={busy} onClick={() => setExpanded(false)}>
              Keep channel open
            </button>
          </div>
          {!ack && !coopBlocked ? <span className="p-hint">Confirm the checkbox to enable closing.</span> : null}
          {error ? (
            <Notice tone="danger" title="Channel not closed">
              {error}
            </Notice>
          ) : null}
        </div>
      )}
    </section>
  );
}
