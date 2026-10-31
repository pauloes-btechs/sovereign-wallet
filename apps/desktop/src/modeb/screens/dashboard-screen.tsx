/**
 * Mode B overview: node health, on-chain and channel balances, recent
 * Lightning payments. Everything rendered comes from the bridge's declared
 * state — sync lag and pending funds are shown, never hidden.
 */
import { useEffect, useState } from 'react';
import { Badge, Button, Card } from '@sovereign/ui';

import {
  BridgeHttpError,
  type BridgeClient,
  type NodeHealthView,
  type PaymentView,
  type WalletBalanceView,
} from '../bridge-client.js';
import { formatSats, shortHash } from '../sats.js';

function BalanceRow({ label, sat, tone }: { readonly label: string; readonly sat: string; readonly tone?: 'positive' | 'warning' | 'neutral' }): React.ReactNode {
  return (
    <div data-testid={`balance-${label.toLowerCase().replace(/\s+/g, '-')}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
      <span style={{ color: '#9aa0a6' }}>{label}</span>
      <span>{formatSats(sat)} sats</span>
      {tone !== undefined && tone !== 'neutral' ? <Badge tone={tone}>{tone}</Badge> : null}
    </div>
  );
}

function RecentPayments({ client }: { readonly client: BridgeClient }): React.ReactNode {
  const [payments, setPayments] = useState<readonly PaymentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .payments(10)
      .then((res) => {
        if (!cancelled) setPayments(res.payments);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof BridgeHttpError ? err.message : 'failed to load payments');
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (error !== null) return <p style={{ color: '#ff6b6b' }}>{error}</p>;
  if (payments === null) return <p style={{ color: '#9aa0a6' }}>Loading payments…</p>;
  if (payments.length === 0) {
    return <p style={{ color: '#9aa0a6' }}>No Lightning payments yet.</p>;
  }
  return (
    <table data-testid="recent-payments" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <tbody>
        {payments.map((p) => (
          <tr key={p.paymentHash} style={{ borderTop: '1px solid #2a2a30' }}>
            <td style={{ padding: '6px 4px', fontFamily: 'monospace' }}>{shortHash(p.paymentHash, 6)}</td>
            <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatSats(p.valueSat)} sats</td>
            <td style={{ padding: '6px 4px', textAlign: 'right' }}>
              <Badge tone={p.status === 'succeeded' ? 'positive' : p.status === 'in-flight' ? 'warning' : 'neutral'}>{p.status}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DashboardScreen(props: {
  readonly client: BridgeClient;
  readonly info: NodeHealthView;
}): React.ReactNode {
  const [balance, setBalance] = useState<WalletBalanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    props.client
      .walletBalance()
      .then((b) => {
        if (!cancelled) {
          setBalance(b);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof BridgeHttpError ? err.message : 'failed to load balance');
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, reloadTick]);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card title="Node">
        <div data-testid="node-health" style={{ display: 'grid', gap: 4 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontWeight: 600 }}>{props.info.alias || 'litd node'}</span>
            <Badge tone={props.info.syncedToChain ? 'positive' : 'warning'}>
              {props.info.syncedToChain ? 'synced to chain' : 'syncing…'}
            </Badge>
            <Badge tone={props.info.syncedToGraph ? 'positive' : 'warning'}>
              {props.info.syncedToGraph ? 'graph synced' : 'graph syncing…'}
            </Badge>
          </div>
          <div style={{ color: '#9aa0a6', fontSize: 13 }}>
            {props.info.version} · height {props.info.blockHeight} · {props.info.numPeers} peers ·{' '}
            {props.info.numActiveChannels} active channels
          </div>
          <div style={{ color: '#9aa0a6', fontSize: 12, fontFamily: 'monospace' }}>
            {props.info.identityPubkey.slice(0, 24)}…
          </div>
        </div>
      </Card>

      <Card title="On-chain balance">
        {error !== null ? (
          <>
            <p style={{ color: '#ff6b6b' }}>{error}</p>
            <Button variant="secondary" onClick={() => setReloadTick((t) => t + 1)}>
              Retry
            </Button>
          </>
        ) : balance === null ? (
          <p style={{ color: '#9aa0a6' }}>Loading…</p>
        ) : (
          <>
            <BalanceRow label="Total" sat={balance.totalSat} />
            <BalanceRow label="Confirmed" sat={balance.confirmedSat} />
            {balance.unconfirmedSat !== '0' ? <BalanceRow label="Unconfirmed" sat={balance.unconfirmedSat} tone="warning" /> : null}
            {balance.lockedSat !== '0' ? <BalanceRow label="Locked (channel reserves)" sat={balance.lockedSat} tone="warning" /> : null}
            {balance.reservedAnchorSat !== '0' ? <BalanceRow label="Reserved (anchors)" sat={balance.reservedAnchorSat} /> : null}
          </>
        )}
      </Card>

      <Card title="Recent Lightning payments">
        <RecentPayments client={props.client} />
      </Card>
    </div>
  );
}
