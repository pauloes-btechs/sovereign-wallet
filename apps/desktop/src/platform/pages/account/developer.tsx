/**
 * Developer tools — bridge route reference (a static list mirroring
 * services/litd-adapter/src/bridge/server.ts + subserver-routes.ts and the
 * client methods in modeb/bridge-client.ts + platform/api.ts), live service
 * status, versions, and a raw JSON inspector for a few read-only GET routes.
 */
import { useEffect, useState } from 'react';
import { usePlatform, usePoll } from '../../context.js';
import { Badge, Empty, Field, Icon, Notice, PageHeader, Panel, Segmented, Skeleton, relativeTime } from '../../ui.js';
import { CopyButton, Fact, Facts } from './components.js';

type Area = 'Wallet' | 'On-chain' | 'Channels' | 'Payments' | 'Node' | 'Backups' | 'Loop' | 'LND extras' | 'Pool' | 'Assets';

interface RouteRef {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly area: Area;
  readonly purpose: string;
  readonly client: string;
  /** Moves money or changes node state. */
  readonly writes?: boolean;
}

const ROUTES: readonly RouteRef[] = [
  { method: 'GET', path: '/livez', area: 'Node', purpose: 'Liveness probe (no auth)', client: '—' },
  { method: 'GET', path: '/state', area: 'Node', purpose: 'Wallet phase and node health', client: 'bridge.state()' },
  { method: 'POST', path: '/wallet/seed', area: 'Wallet', purpose: 'Generate an aezeed mnemonic', client: 'bridge.generateSeed()' },
  { method: 'POST', path: '/wallet/init', area: 'Wallet', purpose: 'Create or restore the wallet', client: 'bridge.initWallet()', writes: true },
  { method: 'POST', path: '/wallet/unlock', area: 'Wallet', purpose: 'Unlock the wallet with its password', client: 'bridge.unlockWallet()', writes: true },
  { method: 'GET', path: '/onchain/balance', area: 'On-chain', purpose: 'Wallet balance (confirmed, unconfirmed, locked)', client: 'bridge.walletBalance()' },
  { method: 'POST', path: '/onchain/address', area: 'On-chain', purpose: 'New receive address', client: 'bridge.newAddress()' },
  { method: 'POST', path: '/onchain/estimate-fee', area: 'On-chain', purpose: 'Fee rate for a confirmation target', client: 'bridge.estimateFee()' },
  { method: 'POST', path: '/onchain/send', area: 'On-chain', purpose: 'Send coins on-chain', client: 'bridge.sendCoins()', writes: true },
  { method: 'GET', path: '/channels', area: 'Channels', purpose: 'Open and pending channels + channel balance', client: 'bridge.channels()' },
  { method: 'POST', path: '/channels', area: 'Channels', purpose: 'Open a channel', client: 'bridge.openChannel()', writes: true },
  { method: 'POST', path: '/channels/close', area: 'Channels', purpose: 'Start a cooperative or force close', client: 'bridge.closeChannel()', writes: true },
  { method: 'GET', path: '/channels/close/:id', area: 'Channels', purpose: 'Close job status', client: 'bridge.closeJob()' },
  { method: 'POST', path: '/invoices', area: 'Payments', purpose: 'Create an invoice', client: 'bridge.createInvoice()' },
  { method: 'POST', path: '/invoices/decode', area: 'Payments', purpose: 'Decode a BOLT 11 invoice', client: 'bridge.decodeInvoice()' },
  { method: 'POST', path: '/payments', area: 'Payments', purpose: 'Pay an invoice', client: 'bridge.payInvoice()', writes: true },
  { method: 'GET', path: '/payments', area: 'Payments', purpose: 'Recent payments (?max=)', client: 'bridge.payments()' },
  { method: 'GET', path: '/diagnostics', area: 'Node', purpose: 'Node health, closed channels, forwards, Faraday', client: 'bridge.diagnostics()' },
  { method: 'GET', path: '/channel-backups', area: 'Backups', purpose: 'Export the multi-channel backup', client: 'bridge.exportChannelBackups()' },
  { method: 'POST', path: '/channel-backups/restore', area: 'Backups', purpose: 'Restore a backup (peers force-close)', client: 'bridge.restoreChannelBackups()', writes: true },
  { method: 'GET', path: '/services', area: 'Node', purpose: 'litd sub-server status + operator endpoints', client: 'api.services()' },
  { method: 'GET', path: '/loop/terms', area: 'Loop', purpose: 'Min/max swap sizes', client: 'api.loopTerms()' },
  { method: 'POST', path: '/loop/quote', area: 'Loop', purpose: 'Quote a Loop In or Loop Out', client: 'api.loopQuote()' },
  { method: 'GET', path: '/loop/swaps', area: 'Loop', purpose: 'All swaps, newest first', client: 'api.swaps()' },
  { method: 'GET', path: '/loop/swaps/:id', area: 'Loop', purpose: 'One swap', client: 'api.swap()' },
  { method: 'POST', path: '/loop/out', area: 'Loop', purpose: 'Start a Loop Out (re-quotes, enforces authorization)', client: 'api.loopOut()', writes: true },
  { method: 'POST', path: '/loop/in', area: 'Loop', purpose: 'Start a Loop In (re-quotes, enforces authorization)', client: 'api.loopIn()', writes: true },
  { method: 'GET', path: '/loop/static', area: 'Loop', purpose: 'Static address summary + deposits', client: 'api.staticAddress()' },
  { method: 'POST', path: '/loop/static/address', area: 'Loop', purpose: 'Create the static Loop In address', client: 'api.newStaticAddress()' },
  { method: 'POST', path: '/loop/static/loop-in', area: 'Loop', purpose: 'Loop In selected static deposits', client: 'api.staticLoopIn()', writes: true },
  { method: 'GET', path: '/loop/autoloop', area: 'Loop', purpose: 'AutoLoop params + this app’s budget policy', client: 'api.autoloop()' },
  { method: 'POST', path: '/loop/autoloop', area: 'Loop', purpose: 'Enable or disable AutoLoop', client: 'api.setAutoloop()', writes: true },
  { method: 'GET', path: '/loop/suggestions', area: 'Loop', purpose: 'AutoLoop dry run (SuggestSwaps)', client: 'api.suggestions()' },
  { method: 'GET', path: '/lnd/invoices', area: 'LND extras', purpose: 'Received payments, newest first', client: 'api.invoices()' },
  { method: 'GET', path: '/lnd/peers', area: 'LND extras', purpose: 'Connected peers', client: 'api.peers()' },
  { method: 'GET', path: '/lnd/fees', area: 'LND extras', purpose: 'Fee policies + fees earned', client: 'api.feeReport()' },
  { method: 'POST', path: '/lnd/fees', area: 'LND extras', purpose: 'Update routing fee policy', client: 'api.updateFeePolicy()', writes: true },
  { method: 'GET', path: '/pool', area: 'Pool', purpose: 'Market, accounts, orders, leases, durations', client: 'api.pool()' },
  { method: 'GET', path: '/assets', area: 'Assets', purpose: 'Assets, balances, tapd info', client: 'api.assets()' },
  { method: 'GET', path: '/assets/transfers', area: 'Assets', purpose: 'Asset transfer history', client: 'api.assetTransfers()' },
  { method: 'POST', path: '/assets/address', area: 'Assets', purpose: 'New Taproot Assets address', client: 'api.newAssetAddress()' },
  { method: 'POST', path: '/assets/decode', area: 'Assets', purpose: 'Decode a Taproot Assets address', client: 'api.decodeAssetAddress()' },
  { method: 'POST', path: '/assets/mint', area: 'Assets', purpose: 'Mint an asset (on-chain)', client: 'api.mintAsset()', writes: true },
  { method: 'POST', path: '/assets/send', area: 'Assets', purpose: 'Send to a Taproot Assets address', client: 'api.sendAsset()', writes: true },
];

const INSPECT = ['/state', '/services', '/channels', '/diagnostics'] as const;
type InspectPath = (typeof INSPECT)[number];

export default function DeveloperPage() {
  const { api, bridge, node, services } = usePlatform();
  const assets = usePoll(() => api.assets(), null, [api]);
  const [filter, setFilter] = useState('');
  const svc = services.data;

  const q = filter.trim().toLowerCase();
  const routes = ROUTES.filter((r) => q === '' || `${r.method} ${r.path} ${r.area} ${r.purpose} ${r.client}`.toLowerCase().includes(q));

  return (
    <>
      <PageHeader title="Developer tools" sub="The local bridge API this interface is built on, live service status, and raw responses from read-only routes." />
      <div className="p-stack">
        <div className="p-grid">
          <div className="p-span-7">
            <Panel
              title="Services"
              note={services.updatedAt ? `litd status service · updated ${relativeTime(services.updatedAt)}` : 'litd status service'}
              actions={
                <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={() => void services.reload()}>
                  <Icon name="refresh" />
                  Refresh
                </button>
              }
              flush
            >
              {svc === undefined ? (
                <div style={{ padding: 24 }}>{services.error ? <Notice tone="danger" title="Couldn't load services">{services.error}</Notice> : <Skeleton height={100} />}</div>
              ) : svc.subServers === null ? (
                <div style={{ padding: 24 }}>
                  <Notice tone="warning" title="litd status unavailable">{svc.statusError ?? 'litd did not report sub-server status.'}</Notice>
                </div>
              ) : (
                <div className="p-table-wrap">
                  <table className="p-table">
                    <thead>
                      <tr>
                        <th>Sub-server</th>
                        <th>Status</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(svc.subServers)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([name, s]) => (
                          <tr key={name}>
                            <td className="p-mono">{name}</td>
                            <td>
                              <Badge tone={s.running ? 'positive' : s.disabled ? 'neutral' : 'danger'}>{s.running ? 'Running' : s.disabled ? 'Disabled' : 'Stopped'}</Badge>
                            </td>
                            <td className="p-muted" style={{ fontSize: 13 }}>{s.error || s.customStatus || '—'}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
          <div className="p-span-5">
            <Panel title="Versions and endpoints">
              <Facts>
                <Fact label="Bridge phase">{node.phase}</Fact>
                <Fact label="LND / litd"><span className="p-mono">{node.info?.version ?? '—'}</span></Fact>
                <Fact label="tapd">
                  <span className="p-mono">{assets.data?.universe?.version ?? (assets.error ? 'Unavailable' : '…')}</span>
                </Fact>
                <Fact label="Network">{svc?.network ?? '—'}</Fact>
                <Fact label="Loop server">
                  {svc ? <span><Badge tone={svc.operators.loop.mode === 'offline' ? 'warning' : 'info'}>{svc.operators.loop.mode}</Badge> <span className="p-mono">{svc.operators.loop.host ?? ''}</span></span> : '—'}
                </Fact>
                <Fact label="Pool auctioneer">
                  {svc ? <span><Badge tone={svc.operators.pool.mode === 'offline' ? 'warning' : 'info'}>{svc.operators.pool.mode}</Badge> <span className="p-mono">{svc.operators.pool.host ?? ''}</span></span> : '—'}
                </Fact>
              </Facts>
            </Panel>
          </div>
        </div>

        <Inspector request={(path) => bridge.request<unknown>('GET', path)} />

        <Panel
          title="Bridge routes"
          note={`${ROUTES.length} routes. Every route except /livez needs the per-launch bearer token. Bodies are JSON.`}
          actions={
            <div style={{ width: 280 }}>
              <Field label="Filter routes">
                {(id) => <input id={id} className="p-input" type="search" placeholder="Path, purpose or method" value={filter} onChange={(e) => setFilter(e.target.value)} />}
              </Field>
            </div>
          }
          flush
        >
          {routes.length === 0 ? (
            <div style={{ padding: 24 }}><Empty title="No routes match" /></div>
          ) : (
            <div className="p-table-wrap">
              <table className="p-table">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Purpose</th>
                    <th>Client</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map((r) => (
                    <tr key={`${r.method} ${r.path}`}>
                      <td>
                        <Badge tone={r.method === 'GET' ? 'info' : 'accent'} plain>{r.method}</Badge>
                      </td>
                      <td className="p-mono">{r.path}</td>
                      <td>
                        {r.purpose}
                        {r.writes ? <span className="ac-cell-note">Changes node state or moves funds</span> : null}
                      </td>
                      <td className="p-mono p-muted" style={{ fontSize: 12 }}>{r.client}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function Inspector({ request }: { request: (path: string) => Promise<unknown> }) {
  const [path, setPath] = useState<InspectPath>('/state');
  const [result, setResult] = useState<{ path: string; json: string; ms: number; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (p: InspectPath) => {
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      const data = await request(p);
      setResult({ path: p, json: JSON.stringify(data, null, 2), ms: Math.round(performance.now() - t0), at: Date.now() });
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run('/state');
    // load the default route once on open
  }, []);

  return (
    <Panel
      title="Response inspector"
      note="Read-only GET routes, sent through the same client the app uses."
      actions={
        <>
          <Segmented
            label="Route"
            value={path}
            options={INSPECT.map((p) => ({ value: p, label: `GET ${p}` }))}
            onChange={(p) => {
              setPath(p);
              void run(p);
            }}
          />
          <button type="button" className="p-btn p-btn-primary p-btn-sm" disabled={busy} onClick={() => void run(path)}>
            {busy ? 'Sending…' : 'Send request'}
          </button>
        </>
      }
    >
      {error ? <Notice tone="danger" title={`GET ${path} failed`}>{error}</Notice> : null}
      {result === null && error === null ? (
        <Empty title="No response yet">Pick a route and send the request to see the bridge&apos;s JSON.</Empty>
      ) : null}
      {result ? (
        <div className="p-stack" style={{ gap: 8 }}>
          <div className="p-spread">
            <span className="p-muted" style={{ fontSize: 13 }}>
              <span className="p-mono">GET {result.path}</span> · 200 · {result.ms} ms · {(result.json.length / 1024).toFixed(1)} KB · {relativeTime(result.at)}
            </span>
            <CopyButton value={result.json} label="Copy JSON" />
          </div>
          <pre className="ac-pre" data-testid="json-inspector">{result.json}</pre>
        </div>
      ) : null}
    </Panel>
  );
}
