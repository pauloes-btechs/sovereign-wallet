/**
 * Connections: how this app reaches the node (webview → loopback bridge →
 * litd), with live reachability, plus an honest account of remote access
 * (LNC pairing exists in the adapter, no desktop UI yet; remote lnd is a
 * bridge launch option). No toggles for things the app can't do.
 */
import { usePlatform, usePoll } from '../../context.js';
import { Link } from '../../router.js';
import { Badge, Icon, Notice, PageHeader, Panel, relativeTime } from '../../ui.js';
import { KV } from './infra-kit.js';

export default function ConnectionsPage() {
  const { bridge, services } = usePlatform();
  const state = usePoll(() => bridge.state(), 10_000, []);
  const bridgeOk = state.data !== undefined && state.error === null;
  const svc = services.data;
  const running = svc?.subServers ? Object.values(svc.subServers).filter((s) => s.running).length : null;
  const total = svc?.subServers ? Object.keys(svc.subServers).length : null;

  return (
    <>
      <PageHeader title="Connections" sub="How this app talks to your node, and what remote access is and isn't available today." />
      <div className="p-stack">
        <Panel title="This app's connection" note={state.updatedAt ? `Checked ${relativeTime(state.updatedAt)} · every 10 s` : undefined}>
          <div className="in-flow">
            <div className="in-flow-node">
              <h3>
                <Icon name="dashboard" size={16} /> Wallet app
              </h3>
              <p>This window. It holds no keys, macaroons or node credentials; it only knows a per-launch session token for the bridge.</p>
              <div>
                <Badge tone="positive">Running</Badge>
              </div>
            </div>
            <div className="in-flow-arrow" aria-hidden>
              HTTP
              <br />
              loopback
            </div>
            <div className="in-flow-node">
              <h3>
                <Icon name="connections" size={16} /> Local bridge
              </h3>
              <p>A small process on this computer that listens on 127.0.0.1 only and checks a random bearer token on every request. Nothing else on your network can reach it.</p>
              <div>
                {bridgeOk ? <Badge tone="positive">Reachable</Badge> : state.error ? <Badge tone="danger">Unreachable</Badge> : <Badge tone="neutral">Checking</Badge>}
              </div>
            </div>
            <div className="in-flow-arrow" aria-hidden>
              gRPC
              <br />
              TLS + macaroon
            </div>
            <div className="in-flow-node">
              <h3>
                <Icon name="node" size={16} /> litd
              </h3>
              <p>Lightning Terminal: lnd plus Loop, Pool, Taproot Assets and Faraday in one process. The bridge holds its credentials in memory.</p>
              <div className="p-row" style={{ gap: 6 }}>
                {state.data?.phase === 'ready' ? <Badge tone="positive">Wallet ready</Badge> : state.data ? <Badge tone="warning">Wallet {state.data.phase}</Badge> : null}
                {running !== null && total !== null ? <Badge tone={running === total ? 'positive' : 'warning'}>{`${running} of ${total} services running`}</Badge> : null}
              </div>
            </div>
          </div>
          {state.error ? (
            <div style={{ marginTop: 16 }}>
              <Notice tone="danger" title="The bridge isn't answering">
                {state.error}. The wallet can't read or move funds until it's back. Restart the app; your funds stay safe on the node.
              </Notice>
            </div>
          ) : null}
          <div style={{ marginTop: 20 }}>
            <KV
              rows={[
                { label: 'Network', value: svc?.network ?? '—' },
                { label: 'Bridge address', value: '127.0.0.1 (loopback only)', hint: 'The port is chosen at launch and isn’t exposed to this page' },
                { label: 'Authentication', value: 'Per-launch random bearer token', hint: 'A new token every time the app starts; never written into the page' },
                { label: 'Node services', value: <Link className="in-link" to="/node">Node overview</Link> },
              ]}
            />
          </div>
        </Panel>

        <div className="p-grid">
          <div className="p-span-6">
            <Panel title="Pair a phone or web app (Lightning Node Connect)">
              <div className="p-stack">
                <div className="p-row">
                  <Badge tone="neutral">Not available in this app yet</Badge>
                </div>
                <p className="p-muted" style={{ margin: 0 }}>
                  Lightning Node Connect lets another device control this node through an encrypted relay, using a 10-word pairing phrase instead of opening ports. The node side
                  (creating and revoking pairing sessions through litd) is built into this wallet's node adapter, but the desktop app has no screen or bridge route for it yet.
                </p>
                <p className="p-muted" style={{ margin: 0 }}>
                  Until it ships, you can't create a pairing phrase from here, and no remote session is active through this app.
                </p>
              </div>
            </Panel>
          </div>
          <div className="p-span-6">
            <Panel title="Use your own remote lnd instead">
              <div className="p-stack">
                <p className="p-muted" style={{ margin: 0 }}>
                  The bridge can drive an lnd you already run (v0.19 or later) instead of the bundled node. Credentials stay in the bridge process, never in this window. It's a launch
                  option, not a setting:
                </p>
                <pre className="in-code">{`sovereign-litd-bridge \\
  --assume-running \\
  --dataDir=/path/to/node-data \\
  --backend=remote-lnd \\
  --remoteRpcServer=your-node.example.com:10009 \\
  --remoteTlsCert=/path/to/tls.cert \\
  --remoteMacaroon=/path/to/admin.macaroon`}</pre>
                <p className="p-hint" style={{ margin: 0 }}>A remote node is a separate wallet identity. It's never merged with the bundled node's funds.</p>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
