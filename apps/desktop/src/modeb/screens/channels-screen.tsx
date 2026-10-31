/**
 * Mode B channels: open/pending lists with visual states, the open-channel
 * form (peer pubkey + host + funding amount), and close with forced-close
 * disclosure. Every state string comes from the bridge's mapping — the UI
 * never guesses what "pending" means for funds.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, TextField } from '@sovereign/ui';

import {
  BridgeHttpError,
  type BridgeClient,
  type ChannelBalanceView,
  type ChannelRowView,
  type CloseJobView,
} from '../bridge-client.js';
import { formatSats, parseSatsInput, shortHash } from '../sats.js';

const STATE_TONES: Record<ChannelRowView['state'], 'positive' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  open: 'positive',
  'open-inactive': 'warning',
  opening: 'info',
  closing: 'warning',
  'closing-force': 'danger',
  'waiting-close': 'warning',
};

const STATE_LABELS: Record<ChannelRowView['state'], string> = {
  open: 'open',
  'open-inactive': 'open — peer offline',
  opening: 'opening',
  closing: 'closing',
  'closing-force': 'force closing',
  'waiting-close': 'waiting to close',
};

function errorMessage(err: unknown): string {
  return err instanceof BridgeHttpError ? err.message : err instanceof Error ? err.message : String(err);
}

function ChannelRow({ channel, onClose }: { readonly channel: ChannelRowView; readonly onClose?: (channelPoint: string, force: boolean) => void }): React.ReactNode {
  const [confirming, setConfirming] = useState(false);
  const closable = onClose !== undefined && (channel.state === 'open' || channel.state === 'open-inactive');
  return (
    <div data-testid="channel-row" data-channel-point={channel.channelPoint} style={{ borderBottom: '1px solid #2a2a30', padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Badge tone={STATE_TONES[channel.state]}>{STATE_LABELS[channel.state]}</Badge>
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{shortHash(channel.remotePubkey, 8)}</span>
        <span style={{ color: '#9aa0a6', fontSize: 12 }}>{channel.initiatorLabel}</span>
      </div>
      <div style={{ color: '#9aa0a6', fontSize: 13, margin: '4px 0' }}>
        capacity {formatSats(channel.capacitySat)} sats · local {formatSats(channel.localBalanceSat)} · remote{' '}
        {formatSats(channel.remoteBalanceSat)}
      </div>
      {closable ? (
        confirming ? (
          <div style={{ marginTop: 6 }}>
            <p style={{ color: '#f7b955', fontSize: 13 }}>
              Closing keeps your funds safe but on-chain fees apply. Force close is slower and may
              take days — use it when the peer is unreachable.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirming(false);
                  onClose(channel.channelPoint, false);
                }}
              >
                Cooperative close
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirming(false);
                  onClose(channel.channelPoint, true);
                }}
              >
                Force close
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 6 }}>
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Close channel
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

function ChannelBalanceCard({ balance }: { readonly balance: ChannelBalanceView }): React.ReactNode {
  return (
    <Card title="Lightning balance (channel funds)">
      <div data-testid="channel-balance" style={{ display: 'grid', gap: 2, fontSize: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#9aa0a6' }}>Spendable</span>
          <span>{formatSats(balance.localSat)} sats</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#9aa0a6' }}>Receivable</span>
          <span>{formatSats(balance.remoteSat)} sats</span>
        </div>
        {balance.localUnsettledSat !== '0' ? (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#9aa0a6' }}>In-flight (unsettled)</span>
            <span>{formatSats(balance.localUnsettledSat)} sats</span>
          </div>
        ) : null}
        {balance.pendingOpenLocalSat !== '0' || balance.pendingOpenRemoteSat !== '0' ? (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#9aa0a6' }}>Pending open</span>
            <span>
              {formatSats(balance.pendingOpenLocalSat)} / {formatSats(balance.pendingOpenRemoteSat)} sats
            </span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function OpenChannelForm({ client, onOpened }: { readonly client: BridgeClient; readonly onOpened: () => void }): React.ReactNode {
  const [pubkey, setPubkey] = useState('');
  const [host, setHost] = useState('');
  const [amount, setAmount] = useState('');
  const [feeRate, setFeeRate] = useState('5');
  const [privateChannel, setPrivateChannel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    let amountSat: string | undefined;
    try {
      amountSat = parseSatsInput(amount);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    if (amountSat === undefined || BigInt(amountSat) < 20000n) {
      setError('Channels need at least 20,000 sats (lnd minimum).');
      return;
    }
    if (!/^[0-9a-fA-F]{66}$/.test(pubkey.trim())) {
      setError('Node pubkey must be 66 hex characters.');
      return;
    }
    const feeRateSat = Number(feeRate);
    if (!Number.isInteger(feeRateSat) || feeRateSat < 1) {
      setError('Fee rate must be a whole number of satoshis per vbyte (≥ 1).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.openChannel({
        nodePubkeyHex: pubkey.trim(),
        ...(host.trim() === '' ? {} : { host: host.trim() }),
        localFundingSat: amountSat,
        satPerVbyte: feeRateSat,
        isPrivate: privateChannel,
      });
      setOpened('Channel opening — it appears as pending until the funding transaction confirms.');
      onOpened();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Open a channel">
      <TextField label="Peer node pubkey (66 hex)" value={pubkey} onChange={setPubkey} placeholder="03a5…" />
      <TextField label="Peer host (needed to connect, e.g. 1.2.3.4:9735)" value={host} onChange={setHost} />
      <TextField label="Funding amount (sats, min 20,000)" value={amount} onChange={setAmount} />
      <TextField label="Fee rate (sat/vbyte)" value={feeRate} onChange={setFeeRate} />
      <label style={{ display: 'block', margin: '8px 0', color: '#9aa0a6' }}>
        <input type="checkbox" checked={privateChannel} onChange={(e) => setPrivateChannel(e.target.checked)} /> Private
        channel (unannounced — other nodes won't route through it)
      </label>
      <Button disabled={busy} onClick={() => void submit()}>
        Open channel
      </Button>
      {opened !== null ? (
        <p data-testid="channel-opened" style={{ color: '#3ddc97' }}>{opened}</p>
      ) : null}
      {error !== null ? (
        <p data-testid="channel-open-error" style={{ color: '#ff6b6b' }}>{error}</p>
      ) : null}
    </Card>
  );
}

function CloseStatus({ job, onDismiss }: { readonly job: CloseJobView; readonly onDismiss: () => void }): React.ReactNode {
  if (job.error !== undefined) {
    return (
      <Card title="Channel close failed">
        <p data-testid="close-job-error" style={{ color: '#ff6b6b' }}>{job.error}</p>
        <Button variant="secondary" onClick={onDismiss}>Dismiss</Button>
      </Card>
    );
  }
  return (
    <Card title="Channel closing">
      <p data-testid="close-job-status" style={{ color: '#9aa0a6' }}>
        {job.state === 'closed'
          ? `Closed on-chain. Closing transaction: ${job.closingTxid ?? 'pending broadcast'}`
          : 'Waiting for the closing transaction to broadcast…'}
      </p>
      {job.closingTxid !== undefined ? (
        <p style={{ fontFamily: 'monospace', fontSize: 12, color: '#9aa0a6' }}>{shortHash(job.closingTxid, 12)}</p>
      ) : null}
    </Card>
  );
}

export function ChannelsScreen({ client }: { readonly client: BridgeClient }): React.ReactNode {
  const [open, setOpen] = useState<readonly ChannelRowView[] | null>(null);
  const [pending, setPending] = useState<readonly ChannelRowView[] | null>(null);
  const [balance, setBalance] = useState<ChannelBalanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closeJob, setCloseJob] = useState<CloseJobView | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    client
      .channels()
      .then((view) => {
        if (!cancelled) {
          setOpen(view.open);
          setPending(view.pending);
          setBalance(view.balance);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, reloadTick]);

  // Close jobs settle on-chain: poll until terminal, then refresh the list.
  useEffect(() => {
    if (closeJob === null || closeJob.state !== 'closing') return;
    let cancelled = false;
    const interval = setInterval(() => {
      void (async () => {
        try {
          const next = await client.closeJob(closeJob.id);
          if (cancelled) return;
          if (next.state === 'closed' || next.error !== undefined) {
            setCloseJob(next);
            reload();
          }
        } catch {
          // transient — keep polling
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [closeJob, client, reload]);

  const doClose = async (channelPoint: string, force: boolean): Promise<void> => {
    setError(null);
    try {
      const job = await client.closeChannel({ channelPoint, force });
      setCloseJob(job);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (error !== null && open === null) {
    return (
      <Card title="Channels">
        <p data-testid="channels-error" style={{ color: '#ff6b6b' }}>{error}</p>
        <Button variant="secondary" onClick={reload}>Retry</Button>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {closeJob !== null ? <CloseStatus job={closeJob} onDismiss={() => setCloseJob(null)} /> : null}
      {balance !== null ? <ChannelBalanceCard balance={balance} /> : null}
      <OpenChannelForm client={client} onOpened={reload} />
      <Card title="Open channels">
        {open === null ? (
          <p style={{ color: '#9aa0a6' }}>Loading…</p>
        ) : open.length === 0 ? (
          <p style={{ color: '#9aa0a6' }}>
            No channels yet. Open one to start routing Lightning payments — channel capacity is
            split between what you can spend (local) and what you can receive (remote).
          </p>
        ) : (
          <div data-testid="open-channels">
            {open.map((c) => (
              <ChannelRow key={c.channelPoint} channel={c} onClose={(cp, f) => void doClose(cp, f)} />
            ))}
          </div>
        )}
      </Card>
      {pending !== null && pending.length > 0 ? (
        <Card title="Pending channels">
          <div data-testid="pending-channels">
            {pending.map((c, i) => (
              <ChannelRow key={`${c.channelPoint}-${i}`} channel={c} />
            ))}
          </div>
        </Card>
      ) : null}
      {error !== null ? <p data-testid="channels-error" style={{ color: '#ff6b6b' }}>{error}</p> : null}
    </div>
  );
}
