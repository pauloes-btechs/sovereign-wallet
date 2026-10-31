/**
 * Mode B diagnostics: node health detail, closed-channel history, 7-day
 * forwarding events, and Faraday channel insights/revenue — rendered with an
 * explicit "Faraday unavailable" state when the subsystem has no data.
 */
import { useEffect, useState } from 'react';
import { Badge, Button, Card } from '@sovereign/ui';

import {
  BridgeHttpError,
  type BridgeClient,
  type DiagnosticsView,
} from '../bridge-client.js';
import { formatSats, shortHash } from '../sats.js';

function errorMessage(err: unknown): string {
  return err instanceof BridgeHttpError ? err.message : err instanceof Error ? err.message : String(err);
}

function msat(sat: string): string {
  return (Number(sat) / 1000).toFixed(3);
}

function Forwarding({ view: d }: { readonly view: DiagnosticsView }): React.ReactNode {
  if (d.forwarding.length === 0) {
    return <p style={{ color: '#9aa0a6' }}>No forwarded payments in the last 7 days.</p>;
  }
  return (
    <table data-testid="forwarding-events" style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
      <tbody>
        {d.forwarding.slice(0, 25).map((f, i) => (
          <tr key={`${f.timestampNs}-${i}`} style={{ borderTop: '1px solid #2a2a30' }}>
            <td style={{ padding: '4px' }}>{new Date(Number(f.timestampNs) / 1e6).toLocaleString()}</td>
            <td style={{ padding: '4px', textAlign: 'right' }}>in {formatSats(f.amtInSat)}</td>
            <td style={{ padding: '4px', textAlign: 'right' }}>out {formatSats(f.amtOutSat)}</td>
            <td style={{ padding: '4px', textAlign: 'right' }}>fee {msat(f.feeSat)} sats</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FaradaySection({ view: d }: { readonly view: DiagnosticsView }): React.ReactNode {
  if (!d.faraday.available) {
    return (
      <div data-testid="faraday-unavailable">
        <Badge tone="warning">Faraday unavailable</Badge>
        <p style={{ color: '#9aa0a6', fontSize: 13, marginTop: 4 }}>{d.faraday.error ?? 'no data'}</p>
        <p style={{ color: '#9aa0a6', fontSize: 12 }}>
          Channel revenue analytics come from the Faraday subsystem bundled in litd. The rest of
          this page remains fully functional without it.
        </p>
      </div>
    );
  }
  const insights = d.faraday.insights ?? [];
  const revenue = d.faraday.revenue ?? [];
  return (
    <div data-testid="faraday-available">
      {revenue.length === 0 ? null : (
        <div style={{ marginBottom: 8 }}>
          <strong>Routing revenue by channel</strong>
          {revenue.map((r) => (
            <div key={r.targetChannel} style={{ color: '#9aa0a6', fontSize: 13 }}>
              {shortHash(r.targetChannel, 6)}: {r.pairs.length} peer pair(s) ·{' '}
              {r.pairs.reduce((acc, p) => acc + Number(p.feesOutgoingMsat) + Number(p.feesIncomingMsat), 0) / 1000}{' '}
              sats earned
            </div>
          ))}
        </div>
      )}
      {insights.length === 0 ? (
        <p style={{ color: '#9aa0a6' }}>Faraday has no channel insights yet — they build up as your channels route.</p>
      ) : (
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <tbody>
            {insights.map((ins) => (
              <tr key={ins.chanPoint} style={{ borderTop: '1px solid #2a2a30' }}>
                <td style={{ padding: '4px', fontFamily: 'monospace' }}>{shortHash(ins.chanPoint, 6)}</td>
                <td style={{ padding: '4px', textAlign: 'right' }}>
                  uptime {ins.uptimeRatio === undefined ? '—' : `${Math.round(ins.uptimeRatio * 100)}%`}
                </td>
                <td style={{ padding: '4px', textAlign: 'right' }}>
                  in-vol {msat(ins.volumeIncomingMsat)} sats
                </td>
                <td style={{ padding: '4px', textAlign: 'right' }}>earned {msat(ins.feesEarnedMsat)} sats</td>
                {ins.isPrivate ? <td><Badge>private</Badge></td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function DiagnosticsScreen({ client }: { readonly client: BridgeClient }): React.ReactNode {
  const [view, setView] = useState<DiagnosticsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    client
      .diagnostics()
      .then((d) => {
        if (!cancelled) {
          setView(d);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, tick]);

  if (error !== null) {
    return (
      <Card title="Diagnostics">
        <p data-testid="diagnostics-error" style={{ color: '#ff6b6b' }}>{error}</p>
        <Button variant="secondary" onClick={() => setTick((t) => t + 1)}>
          Retry
        </Button>
      </Card>
    );
  }
  if (view === null) {
    return (
      <Card title="Diagnostics">
        <p style={{ color: '#9aa0a6' }}>Loading node diagnostics…</p>
      </Card>
    );
  }

  const node = view.node;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card title="Node health">
        <div data-testid="diagnostics-node" style={{ display: 'grid', gap: 4, fontSize: 14 }}>
          <div>
            <Badge tone={node.syncedToChain ? 'positive' : 'warning'}>
              {node.syncedToChain ? 'synced to chain' : 'syncing…'}
            </Badge>{' '}
            <Badge tone={node.syncedToGraph ? 'positive' : 'warning'}>
              {node.syncedToGraph ? 'graph synced' : 'graph syncing…'}
            </Badge>
          </div>
          <div style={{ color: '#9aa0a6', fontSize: 13 }}>
            {node.version} · chain {node.chains.map((c) => `${c.chain}/${c.network}`).join(', ')} · height{' '}
            {node.blockHeight}
          </div>
          <div style={{ color: '#9aa0a6', fontSize: 13 }}>
            peers {node.numPeers} · active {node.numActiveChannels} · pending {node.numPendingChannels} · inactive{' '}
            {node.numInactiveChannels}
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#9aa0a6' }}>{node.identityPubkey}</div>
          {node.uris.map((uri) => (
            <div key={uri} style={{ fontFamily: 'monospace', fontSize: 12, color: '#9aa0a6', wordBreak: 'break-all' }}>
              {uri}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Channel routing (Faraday)">
        <FaradaySection view={view} />
      </Card>

      <Card title="Forwarded payments (7 days)">
        <Forwarding view={view} />
      </Card>

      <Card title="Closed channels">
        {view.closed.length === 0 ? (
          <p style={{ color: '#9aa0a6' }}>No closed channels.</p>
        ) : (
          <div data-testid="closed-channels">
            {view.closed.map((c) => (
              <div key={c.channelPoint} style={{ borderBottom: '1px solid #2a2a30', padding: '6px 0', fontSize: 13 }}>
                <Badge tone={c.closeType === 'cooperative close' ? 'neutral' : 'warning'}>{c.closeType}</Badge>{' '}
                <span style={{ fontFamily: 'monospace' }}>{shortHash(c.remotePubkey, 8)}</span>
                <div style={{ color: '#9aa0a6' }}>
                  settled {formatSats(c.settledBalanceSat)} sats
                  {c.timeLockedBalanceSat !== '0' ? ` · time-locked ${formatSats(c.timeLockedBalanceSat)} sats` : ''} ·
                  closing tx {shortHash(c.closingTxHash, 8)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
