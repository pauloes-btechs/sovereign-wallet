/**
 * Settings center. Only the General preferences are editable (stored on this
 * device via usePrefs). Everything else is node configuration, shown
 * read-only with its current value and where it is set — no toggle here
 * pretends to change something it doesn't.
 *
 * Reads: GET /services, GET /state (context), GET /assets, GET /loop/autoloop.
 */
import { useState, type ReactNode } from 'react';
import { usePlatform, usePoll, usePrefs } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Badge, Empty, Field, PageHeader, Panel, Segmented, Skeleton } from '../../ui.js';
import { sentence } from './components.js';

type Category = 'General' | 'Lightning' | 'Liquidity' | 'Assets' | 'Networks' | 'Advanced';
const CATEGORIES: readonly Category[] = ['General', 'Lightning', 'Liquidity', 'Assets', 'Networks', 'Advanced'];

interface SettingDef {
  readonly id: string;
  readonly category: Category;
  readonly label: string;
  readonly help: string;
  /** Where a read-only value is configured. Absent for editable preferences. */
  readonly where?: ReactNode;
  readonly keywords?: string;
  readonly control: ReactNode;
}

function ReadOnly({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}

const loading = <Skeleton width={120} />;

export default function SettingsPage() {
  const { api, node, services } = usePlatform();
  const prefs = usePrefs();
  const assets = usePoll(() => api.assets(), null, [api]);
  const autoloop = usePoll(() => api.autoloop(), null, [api]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('General');

  const svc = services.data;
  const info = node.info;
  const operator = (o: { mode: string; host?: string } | undefined) =>
    o === undefined ? (
      loading
    ) : (
      <span className="p-stack" style={{ gap: 4, alignItems: 'flex-end' }}>
        <Badge tone={o.mode === 'offline' ? 'warning' : 'info'}>
          {o.mode === 'offline' ? 'Offline by design' : o.mode === 'configured' ? 'Configured' : 'Upstream default'}
        </Badge>
        {o.host ? <span className="p-mono">{o.host}</span> : <span className="p-muted">Lightning Labs&apos; default for this network</span>}
      </span>
    );

  const settings: SettingDef[] = [
    {
      id: 'unit',
      category: 'General',
      label: 'Bitcoin denomination',
      help: 'How bitcoin amounts are shown across the app. Asset amounts always use their own units.',
      keywords: 'unit sats btc bitcoin display currency',
      control: (
        <>
          <Segmented
            label="Bitcoin denomination"
            value={prefs.unit}
            options={[
              { value: 'sats', label: 'sats' },
              { value: 'btc', label: 'BTC' },
            ]}
            onChange={(unit) => prefs.set({ unit })}
          />
          <span className="p-hint">
            Example: <Amount sats={123456} unit={prefs.unit} />
          </span>
        </>
      ),
    },
    {
      id: 'hide',
      category: 'General',
      label: 'Hide amounts',
      help: 'Masks every bitcoin and asset amount on screen, for screen sharing or working in public. Also toggled with the eye button in the top bar.',
      keywords: 'privacy hide mask balance amounts screen',
      control: (
        <label className="p-check" style={{ justifyContent: 'flex-end' }}>
          <input type="checkbox" checked={prefs.hideAmounts} onChange={(e) => prefs.set({ hideAmounts: e.target.checked })} />
          <span>{prefs.hideAmounts ? 'Amounts hidden' : 'Amounts shown'}</span>
        </label>
      ),
    },
    {
      id: 'sidebar',
      category: 'General',
      label: 'Compact sidebar',
      help: 'Collapses the navigation to icons to give pages more width.',
      keywords: 'navigation menu collapse layout',
      control: (
        <label className="p-check" style={{ justifyContent: 'flex-end' }}>
          <input type="checkbox" checked={prefs.sidebarCollapsed} onChange={(e) => prefs.set({ sidebarCollapsed: e.target.checked })} />
          <span>{prefs.sidebarCollapsed ? 'Collapsed' : 'Expanded'}</span>
        </label>
      ),
    },
    {
      id: 'prefs-storage',
      category: 'General',
      label: 'Where preferences are kept',
      help: 'These preferences stay in this app on this device. They are never sent to the node or anywhere else.',
      where: 'Local storage key sovereign.platform.prefs.v1',
      keywords: 'storage local device sync',
      control: (
        <>
          <button type="button" className="p-btn p-btn-sm" onClick={() => prefs.set({ unit: 'sats', hideAmounts: false, sidebarCollapsed: false })}>
            Reset preferences
          </button>
          <span className="p-hint">Sats, amounts shown, sidebar expanded</span>
        </>
      ),
    },
    {
      id: 'alias',
      category: 'Lightning',
      label: 'Node alias',
      help: 'The name other nodes see in the Lightning graph. Defaults to the start of the public key.',
      where: 'lit.conf: lnd.alias',
      keywords: 'name identity',
      control: <ReadOnly>{info?.alias ?? '—'}</ReadOnly>,
    },
    {
      id: 'lnd-version',
      category: 'Lightning',
      label: 'LND version',
      help: 'The LND build running inside Lightning Terminal.',
      where: 'Bundled with litd',
      control: <ReadOnly><span className="p-mono">{info?.version ?? '—'}</span></ReadOnly>,
    },
    {
      id: 'uris',
      category: 'Lightning',
      label: 'Advertised addresses',
      help: 'Addresses this node announces so peers can connect to it. None means other nodes can’t dial in; you connect out to them.',
      where: 'lit.conf: lnd.externalip / lnd.listen',
      keywords: 'uri public reachable inbound connections',
      control: <ReadOnly>{info === undefined ? '—' : info.uris.length === 0 ? 'None' : info.uris.map((u) => <div key={u} className="p-mono">{u}</div>)}</ReadOnly>,
    },
    {
      id: 'fees',
      category: 'Lightning',
      label: 'Routing fees',
      help: 'Base fee and fee rate charged for forwarding payments, set per channel.',
      where: <>Edited per channel on <Link to="/channels">Channels</Link></>,
      keywords: 'fee policy ppm base forwarding',
      control: <ReadOnly>Per channel</ReadOnly>,
    },
    {
      id: 'loop-server',
      category: 'Liquidity',
      label: 'Loop swap server',
      help: 'Where loopd sends Loop In and Loop Out requests. On regtest it points at an unroutable address unless a local server is configured, so tests never reach Lightning Labs.',
      where: 'lit.conf: loop.server.host (bridge override: loopServer)',
      keywords: 'loop swap operator endpoint server',
      control: operator(svc?.operators.loop),
    },
    {
      id: 'pool-server',
      category: 'Liquidity',
      label: 'Pool auctioneer',
      help: 'Where poold reaches the Pool auctioneer. On regtest it is deliberately unroutable; there is no public regtest auctioneer.',
      where: 'lit.conf: pool.auctionserver (bridge override: poolServer)',
      keywords: 'pool auction marketplace operator endpoint',
      control: operator(svc?.operators.pool),
    },
    {
      id: 'autoloop',
      category: 'Liquidity',
      label: 'AutoLoop',
      help: 'Automatic Loop swaps within a budget. Managed on the Automation page.',
      where: <>Changed on <Link to="/automation">Automation</Link></>,
      keywords: 'automatic rebalancing budget',
      control: (
        <ReadOnly>
          {autoloop.data === undefined ? (
            autoloop.error ? <span className="p-muted">Unavailable: {autoloop.error}</span> : loading
          ) : autoloop.data.params === null ? (
            'Unknown'
          ) : autoloop.data.params.autoloopEnabled ? (
            <Badge tone="positive">On</Badge>
          ) : (
            <Badge tone="neutral">Off</Badge>
          )}
        </ReadOnly>
      ),
    },
    {
      id: 'tapd',
      category: 'Assets',
      label: 'Taproot Assets daemon',
      help: 'tapd version and the network it runs on.',
      where: 'Bundled with litd; data in lit.conf taproot-assets.tapddir',
      keywords: 'tapd version taproot',
      control: (
        <ReadOnly>
          {assets.data === undefined ? (assets.error ? <span className="p-muted">Unavailable: {assets.error}</span> : loading) : assets.data.universe === null ? 'Not reported' : (
            <span className="p-mono">{assets.data.universe.version}</span>
          )}
        </ReadOnly>
      ),
    },
    {
      id: 'courier',
      category: 'Assets',
      label: 'Proof courier',
      help: 'Delivers transfer proofs between wallets for asset sends and receives with other nodes. Not needed for transfers within this wallet. This node creates addresses without checking the courier is reachable.',
      where: 'lit.conf: taproot-assets.proofcourieraddr (not reported by the bridge)',
      keywords: 'proof courier universe delivery',
      control: <ReadOnly>tapd default for this network</ReadOnly>,
    },
    {
      id: 'verification',
      category: 'Assets',
      label: 'Issuer verification',
      help: 'There is no verification source in this build, so every asset is shown as an unverified issuer.',
      keywords: 'verified trust issuer stablecoin',
      control: <ReadOnly>None configured</ReadOnly>,
    },
    {
      id: 'network',
      category: 'Networks',
      label: 'Bitcoin network',
      help: 'The chain this node runs on. A wallet belongs to one network; switching means a different node and data directory.',
      where: 'lit.conf: network',
      keywords: 'mainnet testnet signet regtest chain',
      control: <ReadOnly>{svc ? <Badge tone={svc.network === 'mainnet' ? 'accent' : 'info'}>{svc.network}</Badge> : loading}</ReadOnly>,
    },
    {
      id: 'chain-sync',
      category: 'Networks',
      label: 'Chain sync',
      help: 'Whether LND has caught up with the chain and the Lightning graph.',
      where: 'lit.conf: lnd.bitcoin.node (backend type is not reported by the bridge)',
      keywords: 'sync neutrino bitcoind backend block height',
      control: (
        <ReadOnly>
          {info ? (
            <span>
              {info.syncedToChain ? 'Chain synced' : 'Chain syncing'} · {info.syncedToGraph ? 'graph synced' : 'graph syncing'}
              <span className="ac-cell-note">Block {info.blockHeight.toLocaleString('en-US')}</span>
            </span>
          ) : (
            '—'
          )}
        </ReadOnly>
      ),
    },
    {
      id: 'tor',
      category: 'Networks',
      label: 'Tor',
      help: 'Node traffic to peers, the chain backend and Loop/Pool goes over the clearnet in this build. LND supports Tor, but this app doesn’t configure it.',
      where: <>lit.conf: lnd.tor.active · see <Link to="/privacy">Privacy</Link></>,
      keywords: 'tor onion privacy proxy socks',
      control: <ReadOnly>Not configured</ReadOnly>,
    },
    {
      id: 'subservers',
      category: 'Advanced',
      label: 'Lightning Terminal sub-servers',
      help: 'Daemons running inside litd and whether each is up, as reported by litd’s status service.',
      where: 'lit.conf: loop-mode, pool-mode (integrated)',
      keywords: 'litd loop pool faraday tapd status daemon',
      control: (
        <ReadOnly>
          {svc?.subServers ? (
            <span className="p-row" style={{ flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
              {Object.entries(svc.subServers).map(([name, s]) => (
                <Badge key={name} tone={s.running ? 'positive' : s.disabled ? 'neutral' : 'danger'}>
                  {name}
                </Badge>
              ))}
            </span>
          ) : svc?.statusError ? (
            <span className="p-muted">{svc.statusError}</span>
          ) : (
            loading
          )}
        </ReadOnly>
      ),
    },
    {
      id: 'bridge',
      category: 'Advanced',
      label: 'App to node connection',
      help: 'The interface talks to the node only through a local bridge on 127.0.0.1, authenticated with a token generated at each launch.',
      where: 'Set by the desktop app at launch',
      keywords: 'bridge loopback token api localhost',
      control: <ReadOnly>Loopback only</ReadOnly>,
    },
    {
      id: 'developer',
      category: 'Advanced',
      label: 'Developer tools',
      help: 'Bridge route reference, live service status and a raw JSON inspector.',
      where: <Link to="/developer">Open developer tools</Link>,
      keywords: 'api debug json routes',
      control: <ReadOnly>Available</ReadOnly>,
    },
  ];

  const q = query.trim().toLowerCase();
  const visible = settings.filter((s) =>
    q === '' ? s.category === category : `${s.label} ${s.help} ${s.category} ${s.keywords ?? ''}`.toLowerCase().includes(q),
  );
  const counts = (c: Category) => settings.filter((s) => s.category === c).length;

  return (
    <>
      <PageHeader title="Settings" sub="Display preferences you can change here, and the node configuration this wallet is running with." />
      <div className="ac-settings">
        <div className="p-stack" style={{ gap: 12 }}>
          <Field label="Search settings">
            {(id) => <input id={id} className="p-input" type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />}
          </Field>
          <nav className="ac-catnav" aria-label="Setting categories">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                aria-current={q === '' && c === category ? 'true' : undefined}
                onClick={() => {
                  setQuery('');
                  setCategory(c);
                }}
              >
                {c}
                <span className="ac-count">{counts(c)}</span>
              </button>
            ))}
          </nav>
        </div>
        <Panel
          title={q === '' ? category : `Results for “${query.trim()}”`}
          note={
            q !== ''
              ? `${visible.length} ${visible.length === 1 ? 'setting' : 'settings'}`
              : category === 'General'
                ? 'Saved on this device as soon as you change them.'
                : 'Node configuration, shown read-only with where it is set.'
          }
        >
          {visible.length === 0 ? (
            <Empty title="No settings match">Try another word, such as “fee”, “tor” or “unit”.</Empty>
          ) : (
            <div>
              {visible.map((s) => (
                <div className="ac-setting" key={s.id} data-testid={`setting-${s.id}`}>
                  <div>
                    <div className="ac-setting-label">
                      {s.label}
                      {q !== '' ? <span className="p-faint" style={{ fontWeight: 400 }}> · {sentence(s.category)}</span> : null}
                    </div>
                    <div className="ac-setting-help">{s.help}</div>
                    {s.where ? <div className="ac-setting-where">{s.where}</div> : null}
                  </div>
                  <div className="ac-setting-control">{s.control}</div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
