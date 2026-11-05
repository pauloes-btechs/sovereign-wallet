/**
 * Node overview: identity, sync, version, litd sub-servers, operator
 * endpoints and Faraday availability. Sources: GET /state (polled),
 * GET /services (context), GET /diagnostics (Faraday).
 */
import { usePlatform, usePoll } from '../../context.js';
import { Link } from '../../router.js';
import { Badge, CopyField, Icon, Notice, PageHeader, Panel, Skeleton, Stat, relativeTime } from '../../ui.js';
import type { OperatorEndpoint } from '../../api.js';
import { KV, LoadError, SUB_SERVER_INFO } from './infra-kit.js';

export default function NodePage() {
  const { bridge, node, services } = usePlatform();
  const state = usePoll(() => bridge.state(), 10_000, []);
  const diag = usePoll(() => bridge.diagnostics(), 60_000, []);
  const info = state.data?.info ?? node.info;
  const svc = services.data;

  return (
    <>
      <PageHeader title="Node overview" sub="The litd node behind this wallet: who it is on the network, whether it's in sync, and the services running inside it." />
      <div className="p-stack">
        <Panel testId="node-health">
          {info === undefined ? (
            state.error ? <LoadError what="node status" error={state.error} onRetry={() => void state.reload()} /> : <Skeleton height={96} />
          ) : (
            <>
              <div className="in-hero">
                <div className="in-hero-id">
                  <div className="in-hero-mark">
                    <Icon name="node" size={22} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="in-hero-name">{info.alias || 'Unnamed node'}</div>
                    <div className="p-muted">
                      {info.syncedToChain ? `Node is synced to chain at height ${info.blockHeight.toLocaleString('en-US')}` : `Catching up with the chain, at height ${info.blockHeight.toLocaleString('en-US')}`}
                      {state.updatedAt ? <span className="p-faint"> · checked {relativeTime(state.updatedAt)}</span> : null}
                    </div>
                  </div>
                </div>
                <div className="p-row">
                  <Badge tone={info.syncedToChain ? 'positive' : 'warning'}>{info.syncedToChain ? 'Chain synced' : 'Chain syncing'}</Badge>
                  <Badge tone={info.syncedToGraph ? 'positive' : 'warning'}>{info.syncedToGraph ? 'Graph synced' : 'Graph syncing'}</Badge>
                  {state.data?.phase && state.data.phase !== 'ready' ? <Badge tone="warning">Wallet {state.data.phase}</Badge> : null}
                </div>
              </div>
              <div className="in-stats">
                <Stat label="Block height">{info.blockHeight.toLocaleString('en-US')}</Stat>
                <Stat label="Network" foot={info.chains.map((c) => c.chain).join(', ') || undefined}>
                  {info.chains.map((c) => c.network).join(', ') || svc?.network || '—'}
                </Stat>
                <Stat label="Peers" foot={<Link className="in-link" to="/network">Network & peers</Link>}>
                  {info.numPeers}
                </Stat>
                <Stat label="Channels" foot={`${info.numPendingChannels} pending · ${info.numInactiveChannels} inactive`}>
                  {info.numActiveChannels} active
                </Stat>
                <Stat label="lnd version" foot={info.version.includes('commit=') ? info.version.split('commit=')[1] : undefined}>
                  {info.version.split(' ')[0]}
                </Stat>
              </div>
            </>
          )}
        </Panel>

        <div className="p-grid">
          <div className="p-span-7 p-stack">
            <Panel title="Identity" note="How other Lightning nodes know this one.">
              {info === undefined ? (
                <Skeleton height={80} />
              ) : (
                <div className="p-stack">
                  <div>
                    <div className="p-label" style={{ marginBottom: 6 }}>
                      Public key
                    </div>
                    <CopyField value={info.identityPubkey} label="Node public key" />
                  </div>
                  <div>
                    <div className="p-label" style={{ marginBottom: 6 }}>
                      Connection URIs
                    </div>
                    {info.uris.length > 0 ? (
                      <div className="in-uri">
                        {info.uris.map((u) => (
                          <CopyField key={u} value={u} label="Node URI" />
                        ))}
                      </div>
                    ) : (
                      <p className="p-muted" style={{ margin: 0, fontSize: 13 }}>
                        None advertised. lnd only publishes a URI when it knows a public address (its externalip setting). You can still open channels to others and receive
                        payments; peers just can't dial in to this node first.
                      </p>
                    )}
                  </div>
                  <KV
                    rows={[
                      { label: 'Alias', value: info.alias || '—', hint: 'lnd defaults the alias to the start of the public key' },
                      {
                        label: 'Chain backend',
                        value: <span className="p-muted">Not reported</span>,
                        hint: 'This app starts litd with Neutrino (a light client) by default; bitcoind and remote lnd are launch options. The bridge doesn’t report which is active yet.',
                      },
                    ]}
                  />
                </div>
              )}
            </Panel>

            <Panel flush title="litd services" note="Lightning Terminal runs these services in one process, sharing lnd.">
              {services.error && !svc ? (
                <div className="in-pad">
                  <LoadError what="service status" error={services.error} onRetry={() => void services.reload()} />
                </div>
              ) : !svc ? (
                <div className="in-pad">
                  <Skeleton height={120} />
                </div>
              ) : svc.subServers === null ? (
                <div className="in-pad">
                  <Notice tone="warning" title="litd didn't report its services">
                    {svc.statusError ?? 'The status endpoint returned nothing.'}
                  </Notice>
                </div>
              ) : (
                <div className="p-table-wrap">
                  <table className="p-table">
                    <thead>
                      <tr>
                        <th>Service</th>
                        <th>What it does</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(svc.subServers)
                        .sort(([a], [b]) => order(a) - order(b))
                        .map(([key, s]) => {
                          const meta = SUB_SERVER_INFO[key];
                          return (
                            <tr key={key}>
                              <td style={{ whiteSpace: 'nowrap' }}>{meta?.name ?? key}</td>
                              <td className="p-muted">
                                {meta?.role ?? '—'}
                                {s.error ? <div className="p-error-text">{s.error}</div> : s.customStatus ? <div className="p-hint">{s.customStatus}</div> : null}
                              </td>
                              <td>
                                {s.disabled ? (
                                  <Badge tone="neutral">Disabled</Badge>
                                ) : s.error ? (
                                  <Badge tone="danger">Error</Badge>
                                ) : s.running ? (
                                  <Badge tone="positive">Running</Badge>
                                ) : (
                                  <Badge tone="warning">Not running</Badge>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          <div className="p-span-5 p-stack">
            <Panel title="Sync" testId="diagnostics-node">
              {info === undefined ? (
                <Skeleton height={80} />
              ) : (
                <div className="p-stack">
                  <p className="p-muted" style={{ margin: 0 }}>
                    {info.syncedToChain ? 'Wallet is synced to chain' : 'Wallet is not yet synced to chain'} at height {info.blockHeight}.
                  </p>
                  <KV
                    rows={[
                      { label: 'Chain', value: info.syncedToChain ? 'Synced' : 'Syncing', hint: 'Blocks and wallet transactions are up to date' },
                      { label: 'Network graph', value: info.syncedToGraph ? 'Synced' : 'Syncing', hint: 'Map of public channels used to find payment routes' },
                      { label: 'Block height', value: info.blockHeight.toLocaleString('en-US') },
                    ]}
                  />
                  {!info.syncedToGraph ? (
                    <Notice tone="info" title="Routes may be limited until the graph syncs">
                      Payments to your direct peers work now; longer routes need the graph.
                    </Notice>
                  ) : null}
                </div>
              )}
            </Panel>

            <Panel title="Operator services" note="Loop and Pool trade with a Lightning Labs operator server.">
              {!svc ? (
                <Skeleton height={60} />
              ) : (
                <div className="p-stack">
                  <OperatorRow name="Loop" what="swaps" endpoint={svc.operators.loop} />
                  <OperatorRow name="Pool" what="channel lease auctions" endpoint={svc.operators.pool} />
                </div>
              )}
            </Panel>

            <Panel title="Faraday analytics">
              {diag.loading && !diag.data ? (
                <Skeleton height={40} />
              ) : diag.error && !diag.data ? (
                <div data-testid="faraday-unavailable">
                  <LoadError what="Faraday status" error={diag.error} onRetry={() => void diag.reload()} />
                </div>
              ) : diag.data?.faraday.available ? (
                <div data-testid="faraday-available" className="p-stack" style={{ gap: 8 }}>
                  <div className="p-row">
                    <Badge tone="positive">Available</Badge>
                    <span className="p-muted">
                      Tracking {diag.data.faraday.insights?.length ?? 0} channel{diag.data.faraday.insights?.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="p-hint" style={{ margin: 0 }}>
                    Uptime, volume and fee revenue per channel. See <Link className="in-link" to="/routing">Routing & analytics</Link>.
                  </p>
                </div>
              ) : (
                <div data-testid="faraday-unavailable">
                  <Notice tone="warning" title="Faraday isn't answering">
                    {diag.data?.faraday.error ?? 'The Faraday service is not running.'} Channel insights and revenue reports are unavailable until it runs; routing history from lnd still works.
                  </Notice>
                </div>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

const ORDER = ['lnd', 'lit', 'loop', 'pool', 'taproot-assets', 'faraday', 'accounts'];
const order = (k: string) => {
  const i = ORDER.indexOf(k);
  return i === -1 ? ORDER.length : i;
};

function OperatorRow({ name, what, endpoint }: { name: string; what: string; endpoint: OperatorEndpoint }) {
  return (
    <div>
      <div className="p-spread">
        <span style={{ fontWeight: 500 }}>{name}</span>
        {endpoint.mode === 'offline' ? (
          <Badge tone="warning">Offline</Badge>
        ) : endpoint.mode === 'configured' ? (
          <Badge tone="info">Custom server</Badge>
        ) : (
          <Badge tone="positive">Lightning Labs default</Badge>
        )}
      </div>
      <div className="p-hint" style={{ marginTop: 4 }}>
        {endpoint.mode === 'offline'
          ? `No operator is reachable${endpoint.host ? ` (configured host ${endpoint.host})` : ''}, so ${what} are unavailable. The ${name} service itself still runs.`
          : endpoint.mode === 'configured'
            ? `Using ${endpoint.host ?? 'a custom server'} for ${what}.`
            : `Using Lightning Labs' server for this network${endpoint.host ? ` (${endpoint.host})` : ''}.`}
      </div>
    </div>
  );
}
