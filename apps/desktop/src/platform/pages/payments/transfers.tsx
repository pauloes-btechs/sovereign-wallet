import { useEffect, useState, type ReactNode } from 'react';
import { computeAccounts, fundSegments } from '../../balances.js';
import { usePlatform, usePoll, useService } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Badge, Icon, LiquidityBar, Notice, PageHeader, Panel, Skeleton } from '../../ui.js';
import { AssetSendFlow, FundingAddressFlow, FundingInvoiceFlow, HandoffFlow, LightningPayFlow, LoopFlow, OnchainSendFlow } from './transfers/flows.js';
import {
  DESTINATIONS,
  hasRail,
  preferredCandidate,
  resolveRoutes,
  SOURCES,
  type DestinationId,
  type RailId,
  type RouteCandidate,
  type RouteEnv,
  type SourceId,
} from './transfers/routes.js';
import '../liquidity/loop/loop.css';
import './transfers/transfers.css';

const SOURCE_ICON: Record<SourceId, string> = { onchain: 'chain', lightning: 'bolt', 'external-btc': 'external', 'taproot-asset': 'assets' };
const DEST_ICON: Record<DestinationId, string> = {
  onchain: 'chain',
  lightning: 'bolt',
  'external-address': 'send',
  invoice: 'request',
  'asset-address': 'assets',
  'other-chain': 'network',
};

export default function TransfersPage() {
  const { bridge, api, services, refreshKey } = usePlatform();
  const loopd = useService('loop');
  const tapd = useService('taproot-assets');
  const wallet = usePoll(() => bridge.walletBalance(), 20_000, [bridge, refreshKey]);
  const channels = usePoll(() => bridge.channels(), 20_000, [bridge, refreshKey]);
  const assets = usePoll(() => (tapd.running === true ? api.assets() : Promise.resolve(null)), 60_000, [api, refreshKey, tapd.running]);

  const [source, setSource] = useState<SourceId>('lightning');
  const [dest, setDest] = useState<DestinationId>('onchain');
  const [rail, setRail] = useState<RailId | null>(null);

  const acc = computeAccounts(wallet.data, channels.data);
  const heldAssets = (assets.data?.balances ?? []).filter((b) => b.balance !== '0');
  const op = services.data?.operators.loop;
  const env: RouteEnv = {
    onchainSpendableSat: acc.onchainSpendableSat,
    lightningSpendableSat: acc.lightningSpendableSat,
    lightningReceivableSat: acc.lightningReceivableSat,
    openChannels: channels.data?.open.filter((c) => c.state === 'open').length ?? 0,
    loopRunning: loopd.running,
    loopOperator: op?.mode ?? null,
    loopOperatorHost: op?.host,
    tapdRunning: tapd.running,
    assetCount: heldAssets.length,
  };
  const loaded = wallet.data !== undefined && channels.data !== undefined && services.data !== undefined;

  const resolution = resolveRoutes(source, dest, env);
  const chosen: RouteCandidate | undefined = resolution.candidates.find((c) => c.adapter.rail === rail) ?? preferredCandidate(resolution);

  // Re-pick the preferred rail whenever the pair changes.
  useEffect(() => setRail(null), [source, dest]);

  const srcBalance = (id: SourceId): ReactNode => {
    if (!loaded) return <Skeleton width={90} />;
    switch (id) {
      case 'onchain':
        return <Amount sats={acc.onchainSpendableSat} />;
      case 'lightning':
        return <Amount sats={acc.lightningSpendableSat} />;
      case 'external-btc':
        return <span className="p-faint">Not visible here</span>;
      case 'taproot-asset':
        return tapd.running === false ? <span className="p-faint">tapd offline</span> : assets.data === undefined ? <Skeleton width={60} /> : `${heldAssets.length} asset${heldAssets.length === 1 ? '' : 's'}`;
    }
  };
  const srcFoot = (id: SourceId): string | null =>
    id === 'onchain' ? 'spendable' : id === 'lightning' ? 'outbound' : null;

  const destBalance = (id: DestinationId): ReactNode => {
    if (!loaded) return <Skeleton width={90} />;
    switch (id) {
      case 'onchain':
        return <Amount sats={acc.onchainSpendableSat} />;
      case 'lightning':
        return <Amount sats={acc.lightningSpendableSat} />;
      case 'external-address':
        return <span className="p-faint">Any address</span>;
      case 'invoice':
        return <span className="p-faint">Paid from Lightning</span>;
      case 'asset-address':
        return <span className="p-faint">Asset units</span>;
      case 'other-chain':
        return <span className="p-faint">Not supported</span>;
    }
  };
  const destFoot = (id: DestinationId): ReactNode =>
    id === 'onchain' ? 'current balance' : id === 'lightning' && loaded ? <>room to add <Amount sats={acc.lightningReceivableSat} /></> : null;

  const srcDef = SOURCES.find((s) => s.id === source);
  const destDef = DESTINATIONS.find((d) => d.id === dest);

  return (
    <>
      <PageHeader
        title="Transfers & swaps"
        sub="Move value between this wallet’s accounts and the outside world. Only rails this node can really run are offered."
        actions={
          <Link to="/loop/history" className="p-btn p-btn-ghost p-btn-sm">
            Swap history
          </Link>
        }
      />
      {wallet.error || channels.error ? (
        <div style={{ marginBottom: 'var(--sovl-space-4)' }}>
          <Notice tone="danger" title="Balances could not be loaded" action={<button type="button" className="p-btn p-btn-sm" onClick={() => { void wallet.reload(); void channels.reload(); }}>Retry</button>}>
            {wallet.error ?? channels.error}
          </Notice>
        </div>
      ) : null}
      <div className="p-grid">
        <div className="p-span-12">
          <div className="tf-pickers">
            <Panel title="From" className="tf-picker">
              <div className="tf-opts" role="radiogroup" aria-label="Transfer source">
                {SOURCES.map((s) => (
                  <button key={s.id} type="button" role="radio" aria-checked={s.id === source} className="tf-opt" onClick={() => setSource(s.id)}>
                    <span className="tf-opt-icon">
                      <Icon name={SOURCE_ICON[s.id]} />
                    </span>
                    <span className="tf-opt-main">
                      <span className="tf-opt-label">{s.label}</span>
                      <span className="tf-opt-detail">{s.detail}</span>
                    </span>
                    <span className="tf-opt-value">
                      {srcBalance(s.id)}
                      {srcFoot(s.id) ? <span className="tf-opt-foot">{srcFoot(s.id)}</span> : null}
                    </span>
                  </button>
                ))}
              </div>
              <div className="tf-funds">
                <div className="p-stat-label">Where this wallet’s bitcoin sits now</div>
                {loaded ? <LiquidityBar segments={fundSegments(acc)} /> : <Skeleton height={40} />}
              </div>
            </Panel>
            <div className="tf-arrow" aria-hidden>
              <Icon name="send" />
            </div>
            <Panel title="To" className="tf-picker">
              <div className="tf-opts" role="radiogroup" aria-label="Transfer destination">
                {DESTINATIONS.map((d) => {
                  const routed = hasRail(source, d.id);
                  return (
                    <button key={d.id} type="button" role="radio" aria-checked={d.id === dest} className="tf-opt" data-norail={routed ? undefined : 'true'} onClick={() => setDest(d.id)}>
                      <span className="tf-opt-icon">
                        <Icon name={DEST_ICON[d.id]} />
                      </span>
                      <span className="tf-opt-main">
                        <span className="tf-opt-label">{d.label}</span>
                        <span className="tf-opt-detail">{d.detail}</span>
                      </span>
                      <span className="tf-opt-value">
                        {routed ? destBalance(d.id) : <span className="tf-norail">No route</span>}
                        {routed && destFoot(d.id) ? <span className="tf-opt-foot">{destFoot(d.id)}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Panel>
          </div>
        </div>

        <div className="p-span-4">
          <Panel title="Route" note={`From ${srcDef?.label ?? ''} · to ${destDef?.label ?? ''}`}>
            {!loaded ? (
              <Skeleton height={160} />
            ) : resolution.noRoute ? (
              <div className="p-stack">
                <div className="p-spread">
                  <span className="p-panel-title">No rail</span>
                  <Badge tone="neutral">Unavailable</Badge>
                </div>
                <div>
                  <div className="lp-section-title">From {srcDef?.label ?? 'here'} you can reach</div>
                  <div className="tf-reach">
                    {DESTINATIONS.filter((d) => hasRail(source, d.id)).map((d) => (
                      <button key={d.id} type="button" className="p-btn p-btn-sm" onClick={() => setDest(d.id)}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-stack">
                {resolution.candidates.length > 1 ? (
                  <div className="lp-choices" role="radiogroup" aria-label="Rail">
                    {resolution.candidates.map((c) => (
                      <label className="lp-choice tf-cand" key={c.adapter.rail}>
                        <input type="radio" name="rail" checked={chosen?.adapter.rail === c.adapter.rail} onChange={() => setRail(c.adapter.rail)} />
                        <span className="lp-choice-main">
                          <span className="p-spread">
                            <span>{c.adapter.label}</span>
                            <RailBadge c={c} />
                          </span>
                          <span className="p-faint">{c.adapter.provider}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : null}
                {chosen ? (
                  <>
                    <div className="p-spread">
                      <span className="p-panel-title">{chosen.adapter.label}</span>
                      {resolution.candidates.length === 1 ? <RailBadge c={chosen} /> : null}
                    </div>
                    <p className="p-muted tf-p">{chosen.adapter.summary}</p>
                    <dl className="lp-kv tf-facts">
                      <dt>Provider</dt>
                      <dd>{chosen.adapter.provider}</dd>
                      <dt>Timing</dt>
                      <dd>{chosen.adapter.timing}</dd>
                      <dt>Depends on</dt>
                      <dd>{chosen.adapter.dependencies.join(', ')}</dd>
                    </dl>
                    <div>
                      <div className="lp-section-title">Risks</div>
                      <ul className="tf-list">
                        {chosen.adapter.risks.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </Panel>
        </div>

        <div className="p-span-8">
          <Panel title={chosen && !resolution.noRoute ? chosen.adapter.label : 'No route'}>
            {!loaded ? (
              <Skeleton height={220} />
            ) : resolution.noRoute || chosen === undefined ? (
              <div className="p-stack">
                <Notice tone="info" title={`No route from ${srcDef?.label ?? 'this source'} to ${destDef?.label ?? 'this destination'}`}>
                  <p className="lp-notice-p">{resolution.noRoute?.reason}</p>
                  {resolution.noRoute?.fix ? <p className="lp-notice-p p-faint">{resolution.noRoute.fix}</p> : null}
                </Notice>
                <p className="p-hint" style={{ margin: 0 }}>
                  Rails this wallet can run: on-chain send to an external address, Lightning payment of an invoice, Loop Out (Lightning to on-chain), Loop In or a new channel (on-chain to Lightning), deposits from an external wallet, and Taproot Assets sends. Nothing is routed through a bridge or a custodian.
                </p>
              </div>
            ) : (
              <div className="p-stack">
                {chosen.blocker && !(chosen.blocker.kind === 'provider' && chosen.adapter.inline) ? (
                  <Notice tone={chosen.blocker.kind === 'funds' ? 'info' : 'warning'} title="This rail can’t run right now">
                    <p className="lp-notice-p">{chosen.blocker.reason}</p>
                    {chosen.blocker.fix ? <p className="lp-notice-p p-faint">{chosen.blocker.fix}</p> : null}
                  </Notice>
                ) : null}
                {chosen.blocker && chosen.blocker.kind === 'provider' && chosen.adapter.inline ? (
                  <Notice tone="warning" title="The swap server is offline, so this route can’t be quoted">
                    <p className="lp-notice-p">{chosen.blocker.reason}</p>
                    <p className="lp-notice-p p-faint">You can still enter the details: the preview asks loopd for a real quote and shows exactly what it answers. Nothing is sent without a quote.</p>
                  </Notice>
                ) : null}
                <RailFlow candidate={chosen} env={env} dest={dest} assets={heldAssets} />
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function RailFlow({ candidate, env, dest, assets }: { candidate: RouteCandidate; env: RouteEnv; dest: DestinationId; assets: readonly { assetIdHex: string; name: string; balance: string }[] }) {
  const { adapter, blocker } = candidate;
  // Provider-offline Loop rails still render (the preview reports the real quote failure); other blockers stop here.
  if (blocker && !(blocker.kind === 'provider' && adapter.inline)) {
    return adapter.handoff ? <HandoffFlow adapter={adapter} /> : null;
  }
  switch (adapter.rail) {
    case 'onchain-send':
      return <OnchainSendFlow key="onchain" adapter={adapter} env={env} />;
    case 'lightning-payment':
      return <LightningPayFlow key="ln" adapter={adapter} env={env} />;
    case 'loop-out':
    case 'loop-in':
      return <LoopFlow key={`${adapter.rail}-${dest}`} adapter={adapter} env={env} destination={dest === 'external-address' ? 'external-address' : dest === 'lightning' ? 'lightning' : 'onchain'} />;
    case 'funding-address':
      return <FundingAddressFlow />;
    case 'funding-invoice':
      return <FundingInvoiceFlow env={env} />;
    case 'asset-send':
      return <AssetSendFlow adapter={adapter} balances={assets} />;
    case 'channel-open':
    case 'static-loop-in':
      return <HandoffFlow adapter={adapter} />;
  }
}

function RailBadge({ c }: { c: RouteCandidate }) {
  if (c.blocker === null) return <Badge tone="positive">Available</Badge>;
  const label = c.blocker.kind === 'provider' ? 'Provider offline' : c.blocker.kind === 'service' ? 'Service down' : 'Not possible now';
  return <Badge tone={c.blocker.kind === 'funds' ? 'neutral' : 'warning'}>{label}</Badge>;
}
