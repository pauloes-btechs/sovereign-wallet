import type { ReactNode } from 'react';
import type { ChannelRowView } from '../../../modeb/bridge-client.js';
import { computeAccounts } from '../../balances.js';
import { usePlatform, usePoll, useService } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Badge, Empty, LiquidityBar, Notice, PageHeader, Panel, shortId, Skeleton, Stat, type Tone } from '../../ui.js';
import { isRange, OperatorBadge, useLoopStatus, type LoopStatus } from './loop/shared.js';
import './loop/loop.css';

/** A channel is lopsided outside 20–80% outbound; the target is an even split. */
const LOW = 0.2;
const HIGH = 0.8;
const roundK = (n: number): number => Math.max(1000, Math.round(n / 1000) * 1000);

interface Rec {
  readonly key: string;
  readonly tone: Tone;
  readonly title: string;
  readonly body: ReactNode;
  readonly action?: { readonly to: string; readonly label: string };
}

function recommend(open: readonly ChannelRowView[], onchainSat: number, loop: LoopStatus): Rec[] {
  const recs: Rec[] = [];
  const outRange = loop.terms?.loopOut;
  const inRange = loop.terms?.loopIn;
  for (const c of open) {
    const cap = Number(c.capacitySat);
    const local = Number(c.localBalanceSat);
    if (cap <= 0) continue;
    const share = local / cap;
    const name = `Channel ${shortId(c.chanId, 6, 4)} with ${shortId(c.remotePubkey, 6, 4)}`;
    if (share > HIGH) {
      let amt = roundK(local - cap / 2);
      let cap_note = '';
      if (isRange(outRange) && amt > outRange.maxSat) {
        amt = outRange.maxSat;
        cap_note = ' (capped at the swap server’s maximum)';
      } else if (isRange(outRange) && amt < outRange.minSat) {
        cap_note = `, but that is below the swap server’s ${outRange.minSat.toLocaleString('en-US')}-sat minimum, so a Loop Out alone can’t do it precisely`;
      }
      recs.push({
        key: c.chanId,
        tone: 'info',
        title: `${name} is ${Math.round(share * 100)}% outbound`,
        body: (
          <>
            You can send through it but receive only <Amount sats={c.remoteBalanceSat} />. A Loop Out of about <Amount sats={amt} />
            {cap_note} would bring it near an even split.
          </>
        ),
        action: { to: `/loop/out?amount=${amt}&chan=${c.chanId}`, label: 'Plan Loop Out' },
      });
    } else if (share < LOW) {
      let amt = roundK(cap / 2 - local);
      let note = '';
      if (amt > onchainSat) {
        amt = Math.floor(onchainSat / 1000) * 1000;
        note = ' (limited by your on-chain balance)';
      }
      if (isRange(inRange) && amt > inRange.maxSat) {
        amt = inRange.maxSat;
        note = ' (capped at the swap server’s maximum)';
      } else if (isRange(inRange) && amt > 0 && amt < inRange.minSat) {
        note = `, but that is below the swap server’s ${inRange.minSat.toLocaleString('en-US')}-sat minimum`;
      }
      recs.push({
        key: c.chanId,
        tone: 'info',
        title: `${name} is ${Math.round(share * 100)}% outbound`,
        body:
          amt > 0 ? (
            <>
              You can receive through it but send only <Amount sats={local} />. A Loop In of about <Amount sats={amt} />
              {note} would bring it near an even split.
            </>
          ) : (
            <>You can receive through it but send only <Amount sats={local} />. Add on-chain funds to Loop In.</>
          ),
        ...(amt > 0 ? { action: { to: `/loop/in?amount=${amt}&peer=${c.remotePubkey}`, label: 'Plan Loop In' } } : {}),
      });
    }
  }
  return recs;
}

export default function LiquidityOverviewPage() {
  const { bridge, api, services, refreshKey } = usePlatform();
  const loop = useLoopStatus();
  const pooldUp = useService('pool');
  const wallet = usePoll(() => bridge.walletBalance(), 20_000, [bridge, refreshKey]);
  const channels = usePoll(() => bridge.channels(), 20_000, [bridge, refreshKey]);
  const pool = usePoll(() => (pooldUp.running === true ? api.pool() : Promise.resolve(null)), 60_000, [api, pooldUp.running]);

  const acc = computeAccounts(wallet.data, channels.data);
  const open = channels.data?.open ?? [];
  const pending = channels.data?.pending ?? [];
  const capacity = open.reduce((s, c) => s + Number(c.capacitySat), 0);
  const recs = channels.data ? recommend(open.filter((c) => c.state === 'open'), acc.onchainSpendableSat, loop) : [];
  const loaded = channels.data !== undefined && wallet.data !== undefined;
  const poolOp = services.data?.operators.pool;

  return (
    <>
      <PageHeader
        title="Liquidity overview"
        sub="How much you can send and receive over Lightning, per channel, and what would rebalance it."
        actions={
          <>
            <Link to="/loop/out" className="p-btn p-btn-sm">
              Loop Out
            </Link>
            <Link to="/loop/in" className="p-btn p-btn-sm">
              Loop In
            </Link>
          </>
        }
      />
      {channels.error ? (
        <div style={{ marginBottom: 'var(--sovl-space-4)' }}>
          <Notice tone="danger" title="Channels could not be loaded" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void channels.reload()}>Retry</button>}>
            {channels.error}
          </Notice>
        </div>
      ) : null}
      <div className="p-grid">
        <div className="p-span-12">
          <Panel>
            <div className="lp-counts">
              <Stat label="Can send (outbound)" foot="Your side of open channels">
                {loaded ? <Amount sats={acc.lightningSpendableSat} /> : <Skeleton width={120} />}
              </Stat>
              <Stat label="Can receive (inbound)" foot="Peers’ side; not your funds">
                {loaded ? <Amount sats={acc.lightningReceivableSat} /> : <Skeleton width={120} />}
              </Stat>
              <Stat label="On-chain, spendable" foot="Available to Loop In or open channels">
                {loaded ? <Amount sats={acc.onchainSpendableSat} /> : <Skeleton width={120} />}
              </Stat>
              <Stat label="Open channels" foot={loaded ? <>Total capacity <Amount sats={capacity} /></> : undefined}>
                {loaded ? `${open.length}${pending.length ? ` + ${pending.length} pending` : ''}` : <Skeleton width={40} />}
              </Stat>
            </div>
            <div style={{ marginTop: 'var(--sovl-space-5)' }}>
              {loaded ? (
                <LiquidityBar
                  size="lg"
                  segments={[
                    { kind: 'outbound', sats: acc.lightningSpendableSat, label: 'Outbound (can send)' },
                    { kind: 'locked', sats: acc.lightningInFlightSat + acc.channelsOpeningSat, label: 'In flight or opening' },
                    { kind: 'inbound', sats: acc.lightningReceivableSat, label: 'Inbound (can receive)' },
                  ]}
                />
              ) : (
                <Skeleton height={40} />
              )}
            </div>
          </Panel>
        </div>

        <div className="p-span-8">
          <Panel flush title="Per channel" note="Local balance is outbound, remote balance is inbound." actions={<Link to="/channels" className="p-btn p-btn-ghost p-btn-sm">Manage channels</Link>}>
            {!loaded ? (
              <div style={{ padding: 'var(--sovl-space-5)' }}>
                <Skeleton height={64} />
              </div>
            ) : open.length + pending.length === 0 ? (
              <Empty title="No channels" action={<Link to="/channels" className="p-btn p-btn-sm">Open a channel</Link>}>
                Lightning liquidity lives in channels. Open one to start sending and receiving.
              </Empty>
            ) : (
              <div style={{ marginTop: 'var(--sovl-space-4)' }}>
                {[...open, ...pending].map((c) => {
                  const cap = Number(c.capacitySat);
                  const share = cap > 0 ? Number(c.localBalanceSat) / cap : 0;
                  return (
                    <div className="lp-chan" key={c.channelPoint}>
                      <div className="lp-choice-main">
                        <span>
                          <span className="p-mono">{c.chanId !== '0' ? c.chanId : shortId(c.channelPoint, 8, 4)}</span>{' '}
                          {c.state === 'open' ? null : <Badge tone={c.state === 'opening' ? 'info' : c.state === 'open-inactive' ? 'warning' : 'neutral'}>{c.state.replace('-', ' ')}</Badge>}
                        </span>
                        <span className="p-faint p-mono">{shortId(c.remotePubkey, 10, 6)}</span>
                      </div>
                      <div>
                        <LiquidityBar
                          legend={false}
                          segments={[
                            { kind: 'outbound', sats: Number(c.localBalanceSat), label: 'Outbound' },
                            { kind: 'inbound', sats: Number(c.remoteBalanceSat), label: 'Inbound' },
                          ]}
                        />
                        <div className="lp-chan-ends">
                          <span>
                            <Amount sats={c.localBalanceSat} /> out
                          </span>
                          <span>
                            <Amount sats={c.remoteBalanceSat} /> in
                          </span>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div>
                          <Amount sats={c.capacitySat} />
                        </div>
                        <div className="p-hint">{Math.round(share * 100)}% outbound</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        <div className="p-span-4">
          <div className="p-stack">
            <Panel title="Recommendations" note="Guidance from your balances. Nothing runs on its own.">
              {!loaded ? (
                <Skeleton height={80} />
              ) : open.length === 0 ? (
                <p className="p-hint" style={{ margin: 0 }}>
                  Open a channel first; Loop needs an existing channel in either direction.
                </p>
              ) : recs.length === 0 ? (
                <p className="p-muted" style={{ margin: 0, fontSize: 'var(--sovl-text-sm)' }}>
                  Every open channel is between {LOW * 100}% and {HIGH * 100}% outbound, so you can both send and receive. No rebalancing needed.
                </p>
              ) : (
                <div>
                  {recs.map((r) => (
                    <div className="lp-rec" key={r.key}>
                      <div>
                        <div style={{ fontWeight: 500 }}>{r.title}</div>
                        <div className="p-hint">{r.body}</div>
                      </div>
                      {r.action ? (
                        <Link to={r.action.to} className="p-btn p-btn-sm">
                          {r.action.label}
                        </Link>
                      ) : null}
                    </div>
                  ))}
                  {loop.phase !== 'ready' && loop.phase !== 'checking' ? (
                    <p className="p-hint" style={{ marginBottom: 0 }}>
                      Loop can’t quote right now ({loop.phase === 'offline' ? 'no swap server configured' : loop.phase === 'down' ? 'loopd is not running' : 'swap server unreachable'}), so these are plans only. The wizard shows why.
                    </p>
                  ) : null}
                </div>
              )}
            </Panel>
            <Panel title="Liquidity services">
              <dl className="lp-kv">
                <dt>Loop (swaps)</dt>
                <dd>
                  <OperatorBadge status={loop} />
                </dd>
                <dt>Pool (channel leases)</dt>
                <dd>
                  {pooldUp.running === false ? (
                    <Badge tone="danger">poold not running</Badge>
                  ) : poolOp?.mode === 'offline' ? (
                    <Badge tone="warning">Auctioneer offline</Badge>
                  ) : pool.data ? (
                    <Badge tone={pool.data.market.state === 'available' ? 'positive' : 'warning'}>{pool.data.market.state === 'available' ? 'Market available' : pool.data.market.state === 'thin' ? 'Thin market' : 'Market unavailable'}</Badge>
                  ) : pool.error ? (
                    <Badge tone="danger">Error</Badge>
                  ) : (
                    <Skeleton width={80} />
                  )}
                </dd>
              </dl>
              <p className="p-hint" style={{ marginBottom: 0 }}>
                {loop.phase === 'offline' ? 'Loop has no swap server configured on this node. ' : loop.reason ? `${loop.reason} ` : ''}
                {poolOp?.mode === 'offline'
                  ? `Pool’s auctioneer points at ${poolOp.host ?? 'an unroutable address'}; Lightning Labs runs no public regtest auctioneer.`
                  : pool.data
                    ? pool.data.market.message
                    : pool.error ?? ''}
              </p>
              <div className="p-row" style={{ marginTop: 'var(--sovl-space-3)' }}>
                <Link to="/loop" className="p-btn p-btn-ghost p-btn-sm">
                  Open Loop
                </Link>
                <Link to="/pool" className="p-btn p-btn-ghost p-btn-sm">
                  Open Pool
                </Link>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
