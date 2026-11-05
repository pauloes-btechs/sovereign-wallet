/**
 * Privacy — who this app and node talk to, from live data where the bridge
 * reports it (services operators, peers, node URIs, tapd info) and from the
 * wallet's documented design (docs/PRIVACY.md, packages/privacy) otherwise.
 */
import type { ReactNode } from 'react';
import { devBridgeBootstrap } from '../../../modeb/bridge-client.js';
import { usePlatform, usePoll, usePrefs } from '../../context.js';
import { Link } from '../../router.js';
import { Badge, Notice, PageHeader, Panel, Skeleton, type Tone } from '../../ui.js';
import { Fact, Facts } from './components.js';

export default function PrivacyPage() {
  const { api, node, services } = usePlatform();
  const prefs = usePrefs();
  const peers = usePoll(() => api.peers(), 30_000, [api]);
  const assets = usePoll(() => api.assets(), null, [api]);
  const svc = services.data;
  const boot = devBridgeBootstrap(window.location.search);
  const bridgeWhere = boot === null ? '127.0.0.1 (set by the desktop app)' : boot.bridgeUrl.startsWith('/') ? `${boot.bridgeUrl} (dev proxy to 127.0.0.1)` : boot.bridgeUrl;
  const network = svc?.network ?? node.info?.chains[0]?.network ?? '';

  const opBadge = (o: { mode: string; host?: string } | undefined): { tone: Tone; label: string; where: string } =>
    o === undefined
      ? { tone: 'neutral', label: 'Unknown', where: '—' }
      : o.mode === 'offline'
        ? { tone: 'positive', label: 'No connection', where: `${o.host ?? ''} (unroutable on purpose)` }
        : o.mode === 'configured'
          ? { tone: 'warning', label: 'Configured server', where: o.host ?? '' }
          : { tone: 'warning', label: 'Lightning Labs', where: `Default ${network} server` };

  const loop = opBadge(svc?.operators.loop);
  const pool = opBadge(svc?.operators.pool);
  const peerList = peers.data ?? [];

  const rows: { who: string; to: string; where: ReactNode; when: string; sees: string; status: ReactNode }[] = [
    {
      who: 'This app',
      to: 'Local bridge',
      where: <span className="p-mono">{bridgeWhere}</span>,
      when: 'Always',
      sees: 'Everything; it is your own process on this computer.',
      status: <Badge tone="positive">Loopback only</Badge>,
    },
    {
      who: 'LND',
      to: 'Lightning peers',
      where: peers.data === undefined ? (peers.error ? 'Unavailable' : <Skeleton width={120} />) : peerList.length === 0 ? 'None connected' : (
        <span>
          {peerList.slice(0, 3).map((p) => (
            <span key={p.pubkey} className="p-mono" style={{ display: 'block' }}>
              {p.address} <span className="p-faint">{p.inbound ? 'inbound' : 'outbound'}</span>
            </span>
          ))}
          {peerList.length > 3 ? <span className="p-faint">and {peerList.length - 3} more</span> : null}
        </span>
      ),
      when: 'While the node runs',
      sees: 'Your IP address, your node key, and payments you route or send through them.',
      status: <Badge tone="info">{peers.data ? `${peerList.length} connected` : 'Checking'}</Badge>,
    },
    {
      who: 'LND',
      to: 'Bitcoin network',
      where: 'Chain backend set in lit.conf (lnd.bitcoin.node)',
      when: 'While the node runs',
      sees: 'Your IP address and, with light clients, which blocks you download. Transactions you broadcast.',
      status: <Badge tone="info">{network || '—'}</Badge>,
    },
    {
      who: 'loopd',
      to: 'Loop swap server',
      where: loop.where,
      when: 'Only when you quote or start a swap',
      sees: 'Swap amounts, your node key and the on-chain addresses involved.',
      status: <Badge tone={loop.tone}>{loop.label}</Badge>,
    },
    {
      who: 'poold',
      to: 'Pool auctioneer',
      where: pool.where,
      when: 'While poold runs (it polls the auctioneer)',
      sees: 'Your accounts, orders and node key. Your node’s rating is public to the market.',
      status: <Badge tone={pool.tone}>{pool.label}</Badge>,
    },
    {
      who: 'tapd',
      to: 'Proof courier and universe',
      where: assets.data?.universe ? `tapd ${assets.data.universe.version} defaults` : 'tapd defaults',
      when: 'Only for asset transfers with other wallets',
      sees: 'The asset proofs you send or receive.',
      status: <Badge tone="neutral">On demand</Badge>,
    },
  ];

  return (
    <>
      <PageHeader title="Privacy" sub="Every network connection this app and your node make, what each party can see, and what never leaves this computer." />
      <div className="p-stack">
        <div className="p-grid">
          <div className="p-span-8">
            <Panel title="What this wallet never does">
              <ul className="ac-points">
                <li><strong>No telemetry.</strong> No analytics, crash reporting or usage metrics.</li>
                <li><strong>No account.</strong> No email, sign-in or sync service.</li>
                <li>
                  <strong>No undisclosed connections.</strong> The app&apos;s outbound requests go through a deny-by-default policy; the registry of allowed remote
                  hosts ships empty, and a CI test fails the build if source code names a remote host.
                </li>
                <li><strong>The interface never leaves this computer.</strong> It reaches the node only through the bridge on 127.0.0.1.</li>
              </ul>
            </Panel>
          </div>
          <div className="p-span-4">
            <Panel title="Amount privacy">
              <div className="p-stack" style={{ gap: 12 }}>
                <label className="p-check">
                  <input type="checkbox" checked={prefs.hideAmounts} onChange={(e) => prefs.set({ hideAmounts: e.target.checked })} />
                  <span>
                    Hide amounts on screen
                    <span className="ac-cell-note">Masks bitcoin and asset amounts everywhere. Also on the eye button in the top bar.</span>
                  </span>
                </label>
                <Facts>
                  <Fact label="Right now">{prefs.hideAmounts ? <Badge tone="info">Hidden</Badge> : <Badge tone="neutral">Shown</Badge>}</Fact>
                </Facts>
              </div>
            </Panel>
          </div>
        </div>

        <Panel title="Network connections" note="Live from the node where the bridge reports it." flush>
          <div className="p-table-wrap">
            <table className="p-table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Endpoint</th>
                  <th>What they can see</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.who}-${r.to}`}>
                    <td className="p-muted" style={{ whiteSpace: 'nowrap' }}>{r.who}</td>
                    <td>
                      <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{r.to}</span>
                      <span className="ac-cell-note">{r.when}</span>
                    </td>
                    <td style={{ fontSize: 13 }}>{r.where}</td>
                    <td className="p-muted" style={{ fontSize: 13, maxWidth: 280 }}>{r.sees}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="p-grid">
          <div className="p-span-6">
            <Panel title="Tor">
              <div className="p-stack">
                <Notice tone="warning" title="Node traffic doesn't use Tor in this build">
                  Connections to Lightning peers, the Bitcoin network and Loop or Pool servers use your normal internet connection, so they can see your IP
                  address.
                </Notice>
                <Facts>
                  <Fact label="Lightning node" help="LND supports Tor (tor.active in lit.conf, with a local Tor daemon). This app doesn't set it up.">
                    Not configured
                  </Fact>
                  <Fact label="App requests" help="The privacy package includes a Tor SOCKS5 transport for the app's own requests. The advanced wallet makes none beyond the local bridge.">
                    Available, not needed here
                  </Fact>
                  <Fact label="Advertised addresses" help="Addresses this node announces to the network.">
                    {node.info === undefined ? '—' : node.info.uris.length === 0 ? 'None. Your IP isn’t published in the graph.' : node.info.uris.join(', ')}
                  </Fact>
                </Facts>
              </div>
            </Panel>
          </div>
          <div className="p-span-6">
            <Panel title="Data on this computer">
              <Facts>
                <Fact label="Node data" help="Wallet, channel state, swaps, Pool accounts and asset proofs. The wallet's private keys are encrypted with your wallet password; the other databases are not encrypted by the app.">
                  litd data directory
                </Fact>
                <Fact label="Display preferences" help="Unit, amount hiding and sidebar state, in this app's local storage. Never sent anywhere.">
                  <span className="p-mono">sovereign.platform.prefs.v1</span>
                </Fact>
                <Fact label="Recovery seed" help="Shown once at creation; never stored by this app.">Not stored</Fact>
                <Fact label="Session token" help="Random per launch; held in memory and the page URL during development.">Not persisted</Fact>
              </Facts>
              <p className="p-hint" style={{ margin: '12px 0 0' }}>
                Change display preferences in <Link to="/settings" className="ac-link">Settings</Link>.
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
