/**
 * Network & peers: the nodes this node is connected to right now
 * (GET /lnd/peers), cross-referenced with channels (GET /channels).
 */
import { useMemo, useState } from 'react';
import type { PeerView } from '../../api.js';
import { usePlatform, usePoll } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Badge, CopyField, Empty, Notice, PageHeader, Panel, Sheet, Skeleton, Stat, relativeTime, shortId } from '../../ui.js';
import { KV, LoadError } from './infra-kit.js';

export default function NetworkPage() {
  const { api, bridge, node, refreshKey } = usePlatform();
  const peers = usePoll(() => api.peers(), 10_000, [refreshKey]);
  const channels = usePoll(() => bridge.channels(), 30_000, [refreshKey]);
  const [selected, setSelected] = useState<string | null>(null);

  const list = peers.data ?? [];
  const chanCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of [...(channels.data?.open ?? []), ...(channels.data?.pending ?? [])]) m.set(c.remotePubkey, (m.get(c.remotePubkey) ?? 0) + 1);
    return m;
  }, [channels.data]);
  const inbound = list.filter((p) => p.inbound).length;
  const sent = list.reduce((s, p) => s + p.satSent, 0);
  const received = list.reduce((s, p) => s + p.satReceived, 0);
  const current = list.find((p) => p.pubkey === selected);

  return (
    <>
      <PageHeader title="Network & peers" sub="Lightning nodes connected to yours right now. A connection is needed before you can open a channel or route through a peer." />
      <div className="p-stack">
        <Panel>
          {peers.loading && !peers.data ? (
            <Skeleton height={56} />
          ) : (
            <div className="in-statrow">
              <Stat label="Connected peers" foot={`${inbound} dialed in · ${list.length - inbound} dialed out`}>
                {list.length}
              </Stat>
              <Stat label="With a channel" foot="Peers you share a channel with">
                {list.filter((p) => (chanCount.get(p.pubkey) ?? 0) > 0).length}
              </Stat>
              <Stat label="Sent to peers" foot="Over current connections">
                <Amount sats={sent} />
              </Stat>
              <Stat label="Received from peers" foot="Over current connections">
                <Amount sats={received} />
              </Stat>
              <Stat label="Graph" foot="Public channel map for routing">
                {node.info?.syncedToGraph ? 'Synced' : 'Syncing'}
              </Stat>
            </div>
          )}
        </Panel>

        <Panel flush title="Peers" note={peers.updatedAt ? `Live connections from lnd · updated ${relativeTime(peers.updatedAt)}` : 'Live connections from lnd'}>
          {peers.error && !peers.data ? (
            <div className="in-pad">
              <LoadError what="peers" error={peers.error} onRetry={() => void peers.reload()} />
            </div>
          ) : peers.loading && !peers.data ? (
            <div className="in-pad p-stack">
              <Skeleton height={20} />
              <Skeleton height={20} />
            </div>
          ) : list.length === 0 ? (
            <div className="in-pad">
              <Empty title="Not connected to any peers">
                Your node connects to a peer when you open a channel with it (enter its host on the <Link className="in-link" to="/channels">Channels</Link> page). Without peers, payments
                can't leave this node.
              </Empty>
            </div>
          ) : (
            <div className="p-table-wrap">
              <table className="p-table">
                <thead>
                  <tr>
                    <th>Peer</th>
                    <th>Address</th>
                    <th>Direction</th>
                    <th>Channels</th>
                    <th className="p-num">Ping</th>
                    <th className="p-num">Sent</th>
                    <th className="p-num">Received</th>
                    <th className="p-num">Reconnects</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr
                      key={p.pubkey}
                      data-clickable="true"
                      tabIndex={0}
                      onClick={() => setSelected(p.pubkey)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelected(p.pubkey);
                        }
                      }}
                    >
                      <td className="p-mono">{shortId(p.pubkey, 10, 6)}</td>
                      <td className="p-mono">{p.address || '—'}</td>
                      <td>{p.inbound ? 'They connected' : 'We connected'}</td>
                      <td>{chanCount.get(p.pubkey) ?? 0}</td>
                      <td className="p-num">{p.pingMs.toLocaleString('en-US')} ms</td>
                      <td className="p-num">
                        <Amount sats={p.satSent} />
                      </td>
                      <td className="p-num">
                        <Amount sats={p.satReceived} />
                      </td>
                      <td className="p-num">{p.flapCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="p-grid">
          <div className="p-span-6">
            <Panel title="Connecting to a new peer">
              <p className="p-muted" style={{ margin: 0 }}>
                This app connects to peers as part of opening a channel: on <Link className="in-link" to="/channels">Channels</Link>, enter the peer's public key and host
                (pubkey@host:port) and lnd dials it first. A separate connect-only action isn't available yet. lnd reconnects to peers you have channels with automatically.
              </p>
            </Panel>
          </div>
          <div className="p-span-6">
            <Panel title="Reading this table">
              <ul className="in-list">
                <li>Sent and received are the sats that moved in payments over each connection since it started. They are not your balance.</li>
                <li>Reconnects (flaps) count how often the connection dropped. A high number means an unreliable peer.</li>
                <li>Ping is the round trip time lnd last measured.</li>
              </ul>
            </Panel>
          </div>
        </div>
      </div>
      {current ? <PeerSheet peer={current} channels={chanCount.get(current.pubkey) ?? 0} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function PeerSheet({ peer, channels, onClose }: { peer: PeerView; channels: number; onClose: () => void }) {
  return (
    <Sheet title="Peer" onClose={onClose}>
      <div className="p-stack">
        <div className="p-row">
          <Badge tone="positive">Connected</Badge>
          <Badge tone="neutral">{peer.inbound ? 'Inbound connection' : 'Outbound connection'}</Badge>
        </div>
        <div>
          <div className="p-label" style={{ marginBottom: 6 }}>
            Public key
          </div>
          <CopyField value={peer.pubkey} label="Peer public key" />
        </div>
        {peer.address ? (
          <div>
            <div className="p-label" style={{ marginBottom: 6 }}>
              Connection string
            </div>
            <CopyField value={`${peer.pubkey}@${peer.address}`} label="Peer connection string" />
          </div>
        ) : null}
        <KV
          rows={[
            { label: 'Address', value: peer.address || '—', mono: true },
            { label: 'Channels with this peer', value: channels },
            { label: 'Ping', value: `${peer.pingMs} ms` },
            { label: 'Sent', value: <Amount sats={peer.satSent} /> },
            { label: 'Received', value: <Amount sats={peer.satReceived} /> },
            { label: 'Reconnects', value: peer.flapCount },
          ]}
        />
        {channels === 0 ? (
          <Notice tone="info" title="No channel with this peer">
            You're connected but share no channel, so payments can't flow through it. Open one on <Link className="in-link" to="/channels">Channels</Link>.
          </Notice>
        ) : null}
      </div>
    </Sheet>
  );
}
