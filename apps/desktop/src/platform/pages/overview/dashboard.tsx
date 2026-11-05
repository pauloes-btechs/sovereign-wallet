import { useState, type ReactNode } from 'react';
import type { Accounts } from '../../balances.js';
import { usePlatform, useService } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Badge, Empty, FUND_LABEL, Icon, LiquidityBar, Notice, PageHeader, Panel, Sheet, Skeleton, relativeTime, shortId, type Tone } from '../../ui.js';
import type { ChannelsView } from '../../../modeb/bridge-client.js';
import type { OperatorEndpoint, SwapView } from '../../api.js';
import {
  ActivityDetails,
  ActivityAmount,
  ActivitySourceNotices,
  BalanceSplit,
  HeroFigure,
  RetryButton,
  StateBadge,
  TypeGlyph,
  useActivity,
  useBalances,
  type ActivityItem,
} from './shared.js';

// ——— quick actions ———

const ACTIONS: readonly { to: string; icon: string; title: string; sub: string; primary?: boolean }[] = [
  { to: '/send', icon: 'send', title: 'Send', sub: 'Pay an invoice or an address', primary: true },
  { to: '/receive', icon: 'receive', title: 'Receive', sub: 'Create an invoice or address', primary: true },
  { to: '/receive', icon: 'plus', title: 'Fund wallet', sub: 'Deposit bitcoin on-chain' },
  { to: '/loop/in', icon: 'bolt', title: 'Move to Lightning', sub: 'Loop In on-chain funds' },
  { to: '/loop/out', icon: 'chain', title: 'Move on-chain', sub: 'Loop Out Lightning funds' },
  { to: '/liquidity', icon: 'liquidity', title: 'Manage liquidity', sub: 'Inbound, outbound, channels' },
];

function QuickActions() {
  return (
    <Panel title="Quick actions" className="p-span-4">
      <nav className="ov-actions" aria-label="Quick actions">
        {ACTIONS.map((a) => (
          <Link key={a.title} to={a.to} className="ov-action" data-primary={a.primary ? 'true' : undefined}>
            <span className="ov-action-icon">
              <Icon name={a.icon} />
            </span>
            <span>
              <span className="ov-action-title" style={{ display: 'block' }}>
                {a.title}
              </span>
              <span className="ov-action-sub">{a.sub}</span>
            </span>
            <span className="ov-action-chev">
              <Icon name="chevronRight" size={16} />
            </span>
          </Link>
        ))}
      </nav>
    </Panel>
  );
}

// ——— balance overview ———

function BalanceOverview({ balances }: { balances: ReturnType<typeof useBalances> }) {
  const { accounts, segments } = balances;
  return (
    <Panel className="p-span-8 ov-hero-panel" testId="balance-overview">
      {balances.error && !accounts ? (
        <Notice tone="danger" title="Balances could not be loaded" action={<RetryButton onClick={balances.reload} />}>
          {balances.error}
        </Notice>
      ) : !accounts || !segments ? (
        <div className="p-stack">
          <Skeleton height={14} width={120} />
          <Skeleton height={44} width={320} />
          <Skeleton height={18} />
          <Skeleton height={56} />
        </div>
      ) : (
        <div className="ov-hero">
          <div className="ov-hero-top">
            <HeroFigure sats={accounts.totalSat} label="Total balance" />
            <div className="p-actions">
              <Link to="/accounts" className="p-btn p-btn-ghost p-btn-sm">
                How it&apos;s counted
              </Link>
            </div>
          </div>
          <LiquidityBar
            size="lg"
            segments={segments}
            ariaLabel={`Where your funds sit: ${segments.map((s) => FUND_LABEL[s.kind]).join(', ')}`}
          />
          {balances.error ? (
            <Notice tone="warning" title="Showing the last balances that loaded">
              {balances.error}
            </Notice>
          ) : null}
          <BalanceSplit accounts={accounts} />
        </div>
      )}
    </Panel>
  );
}

// ——— liquidity health ———

function pct(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 100);
}

function LiquidityHealth({ accounts, channels }: { accounts: Accounts | undefined; channels: ChannelsView | undefined }) {
  if (!accounts || !channels) {
    return (
      <Panel title="Liquidity health" className="p-span-4">
        <div className="p-stack">
          <Skeleton height={12} />
          <Skeleton height={48} />
        </div>
      </Panel>
    );
  }
  const out = accounts.lightningSpendableSat;
  const inb = accounts.lightningReceivableSat;
  const total = out + inb;
  const active = channels.open.filter((c) => c.state === 'open').length;
  const inactive = channels.open.filter((c) => c.state === 'open-inactive').length;
  const pending = channels.pending.length;
  return (
    <Panel
      title="Liquidity health"
      note={total > 0 ? `${pct(out, total)}% outbound · ${pct(inb, total)}% inbound` : 'No channel capacity yet'}
      actions={
        <Link to="/liquidity" className="p-btn p-btn-ghost p-btn-sm">
          Details
        </Link>
      }
      className="p-span-4"
    >
      {total === 0 ? (
        <Empty title="No Lightning capacity" action={<Link to="/channels" className="p-btn p-btn-sm">Open a channel</Link>}>
          Open a channel to send and receive over Lightning.
        </Empty>
      ) : (
        <>
          <LiquidityBar
            legend={false}
            segments={[
              { kind: 'outbound', sats: out },
              { kind: 'inbound', sats: inb },
            ]}
          />
          <div className="ov-cap">
            <div className="ov-cap-cell" data-side="outbound">
              <div className="p-stat-label">
                <span className="p-legend-swatch p-lbar-seg" data-fund="outbound" aria-hidden />
                Outbound
              </div>
              <div className="ov-cap-value">
                <Amount sats={out} />
              </div>
              <div className="ov-cap-explain">The most you can send over Lightning right now.</div>
            </div>
            <div className="ov-cap-cell" data-side="inbound">
              <div className="p-stat-label">
                Inbound
                <span className="p-legend-swatch p-lbar-seg" data-fund="inbound" aria-hidden />
              </div>
              <div className="ov-cap-value">
                <Amount sats={inb} />
              </div>
              <div className="ov-cap-explain">The most you can receive. It is your peers&apos; side, not your money.</div>
            </div>
          </div>
        </>
      )}
      {channels.open.length > 0 ? (
        <div className="ov-mini-chans">
          <div className="ov-section-label">Largest channels</div>
          {[...channels.open]
            .sort((x, y) => Number(y.capacitySat) - Number(x.capacitySat))
            .slice(0, 3)
            .map((c) => (
              <div className="ov-mini-chan" key={c.channelPoint}>
                <div className="p-spread">
                  <span className="p-mono p-muted" title={c.remotePubkey}>
                    {shortId(c.remotePubkey, 10, 6)}
                  </span>
                  <span className="p-hint">
                    <Amount sats={c.capacitySat} /> capacity
                  </span>
                </div>
                <LiquidityBar
                  legend={false}
                  ariaLabel={`Channel with ${shortId(c.remotePubkey)}: ${c.localBalanceSat} sats outbound, ${c.remoteBalanceSat} sats inbound`}
                  segments={[
                    { kind: 'outbound', sats: Number(c.localBalanceSat) },
                    { kind: 'inbound', sats: Number(c.remoteBalanceSat) },
                  ]}
                />
              </div>
            ))}
        </div>
      ) : null}
      <div className="ov-chan-counts" aria-label="Channel states">
        <Badge tone={active > 0 ? 'positive' : 'neutral'}>{active} active</Badge>
        <Badge tone={inactive > 0 ? 'warning' : 'neutral'}>{inactive} inactive</Badge>
        <Badge tone={pending > 0 ? 'info' : 'neutral'}>{pending} pending</Badge>
      </div>
    </Panel>
  );
}

// ——— network & service health ———

const SUBSERVERS: readonly { key: 'loop' | 'pool' | 'taproot-assets' | 'faraday'; name: string; what: string }[] = [
  { key: 'loop', name: 'Loop', what: 'Swaps between on-chain and Lightning' },
  { key: 'pool', name: 'Pool', what: 'Channel lease marketplace' },
  { key: 'taproot-assets', name: 'Taproot Assets', what: 'Assets on Bitcoin and Lightning' },
  { key: 'faraday', name: 'Faraday', what: 'Channel and revenue analytics' },
];

function operatorText(op: OperatorEndpoint | undefined, network: string, server: string): { tone: Tone; label: string; detail: string } {
  if (!op) return { tone: 'neutral', label: 'Unknown', detail: '' };
  if (op.mode === 'offline') {
    return {
      tone: 'warning',
      label: 'Not configured',
      detail: network === 'regtest' ? `No ${server} configured for regtest` : `No ${server} configured for ${network}`,
    };
  }
  if (op.mode === 'configured') return { tone: 'positive', label: 'Custom', detail: op.host ? `Using ${op.host}` : 'Using a configured server' };
  return { tone: 'positive', label: 'Default', detail: `Lightning Labs default ${server}` };
}

function ServiceRow({ k, name, what }: { k: 'loop' | 'pool' | 'taproot-assets' | 'faraday'; name: string; what: string }) {
  const s = useService(k);
  return (
    <div className="ov-health-row" title={what}>
      <span className="ov-health-name">{name}</span>
      {s.running === null ? <Skeleton height={20} width={70} /> : <Badge tone={s.running ? 'positive' : 'danger'}>{s.running ? 'Running' : 'Stopped'}</Badge>}
      {s.running === false ? <span className="ov-health-detail">{s.error ?? `${what} is unavailable until it starts.`}</span> : null}
    </div>
  );
}

function ServiceHealth() {
  const { node, services } = usePlatform();
  const info = node.info;
  const network = services.data?.network ?? info?.chains[0]?.network ?? 'unknown';
  const loopOp = operatorText(services.data?.operators.loop, network, 'swap server');
  const poolOp = operatorText(services.data?.operators.pool, network, 'auctioneer');
  return (
    <Panel
      title="Network and services"
      note={services.updatedAt ? `Checked ${relativeTime(services.updatedAt)}` : undefined}
      actions={
        <Link to="/node" className="p-btn p-btn-ghost p-btn-sm">
          Node
        </Link>
      }
      className="p-span-4"
    >
      <div className="ov-health">
        <div className="ov-health-row">
          <span className="ov-health-name">Bitcoin chain</span>
          <Badge tone={info?.syncedToChain ? 'positive' : 'warning'}>{info?.syncedToChain ? 'Synced' : 'Syncing'}</Badge>
          <span className="ov-health-detail">
            {info ? `Block ${info.blockHeight.toLocaleString('en-US')} on ${network} · ${info.numPeers} ${info.numPeers === 1 ? 'peer' : 'peers'}` : 'Waiting for node info'}
            {info && !info.syncedToGraph ? ' · graph still syncing' : ''}
          </span>
        </div>
      </div>
      <div className="ov-section-label">litd sub-servers</div>
      <div className="ov-health">
        {services.error && !services.data ? (
          <div className="ov-health-row">
            <span className="ov-health-name">litd services</span>
            <Badge tone="danger">Unknown</Badge>
            <span className="ov-health-detail">{services.error}</span>
          </div>
        ) : (
          SUBSERVERS.map((s) => <ServiceRow key={s.key} k={s.key} name={s.name} what={s.what} />)
        )}
      </div>
      <div className="ov-section-label">Operators</div>
      <div className="ov-health">
        <div className="ov-health-row">
          <span className="ov-health-name">Loop swap server</span>
          <Badge tone={loopOp.tone}>{loopOp.label}</Badge>
          {loopOp.detail ? <span className="ov-health-detail">{loopOp.detail}</span> : null}
        </div>
        <div className="ov-health-row">
          <span className="ov-health-name">Pool auctioneer</span>
          <Badge tone={poolOp.tone}>{poolOp.label}</Badge>
          {poolOp.detail ? <span className="ov-health-detail">{poolOp.detail}</span> : null}
        </div>
      </div>
    </Panel>
  );
}

// ——— insights (computed only from live state) ———

interface Insight {
  readonly key: string;
  readonly tone: 'warning' | 'info' | 'danger' | 'positive';
  readonly title: ReactNode;
  readonly body: ReactNode;
  readonly to?: string;
  readonly cta?: string;
}

function computeInsights(input: {
  accounts: Accounts | undefined;
  channels: ChannelsView | undefined;
  swaps: readonly SwapView[] | null | undefined;
  failedRecent: number;
  synced: boolean | undefined;
}): Insight[] {
  const { accounts: a, channels: ch, swaps } = input;
  const out: Insight[] = [];
  if (input.synced === false) {
    out.push({ key: 'sync', tone: 'warning', title: 'Your node is still syncing to the chain', body: 'Balances and channel states may be out of date until sync finishes.', to: '/node', cta: 'View node status' });
  }
  if (ch) {
    const inactive = ch.open.filter((c) => c.state === 'open-inactive').length;
    if (inactive > 0) {
      out.push({
        key: 'inactive',
        tone: 'warning',
        title: `${inactive} ${inactive === 1 ? 'channel is' : 'channels are'} inactive`,
        body: 'The peer is offline, so these channels cannot route your payments until it reconnects.',
        to: '/channels',
        cta: 'Review channels',
      });
    }
    const opening = ch.pending.filter((c) => c.state === 'opening').length;
    const closing = ch.pending.length - opening;
    if (opening > 0) {
      out.push({ key: 'opening', tone: 'info', title: `${opening} ${opening === 1 ? 'channel is' : 'channels are'} opening`, body: 'Usable once the funding transaction confirms.', to: '/channels', cta: 'View channels' });
    }
    if (closing > 0) {
      out.push({ key: 'closing', tone: 'info', title: `${closing} ${closing === 1 ? 'channel is' : 'channels are'} closing`, body: 'Funds return on-chain after the closing transaction confirms (and any timelock ends).', to: '/channels', cta: 'View channels' });
    }
    if (ch.open.length === 0 && ch.pending.length === 0) {
      out.push({ key: 'nochan', tone: 'info', title: 'No Lightning channels yet', body: 'Open a channel to send and receive instant payments.', to: '/channels', cta: 'Open a channel' });
    }
  }
  if (a) {
    if (a.lightningSpendableSat > 0 && a.lightningReceivableSat < a.lightningSpendableSat * 0.25) {
      out.push({
        key: 'inbound',
        tone: 'warning',
        title: 'Receiving capacity is low',
        body: (
          <>
            You can receive up to <Amount sats={a.lightningReceivableSat} /> over Lightning but can send <Amount sats={a.lightningSpendableSat} />. A Loop Out moves funds on-chain and frees inbound capacity.
          </>
        ),
        to: '/loop/out',
        cta: 'Plan a Loop Out',
      });
    }
    if (a.onchainUnconfirmedSat > 0) {
      out.push({
        key: 'unconf',
        tone: 'info',
        title: 'Unconfirmed on-chain funds',
        body: (
          <>
            <Amount sats={a.onchainUnconfirmedSat} /> is waiting for confirmation and is not spendable yet.
          </>
        ),
        to: '/assets/bitcoin',
        cta: 'View Bitcoin',
      });
    }
  }
  if (swaps) {
    const active = swaps.filter((s) => !s.done);
    if (active.length > 0) {
      out.push({ key: 'swaps', tone: 'info', title: `${active.length} Loop ${active.length === 1 ? 'swap' : 'swaps'} in progress`, body: 'Funds in a swap settle when it completes. Track each step on the Loop page.', to: '/loop', cta: 'Track swaps' });
    }
  }
  if (input.failedRecent > 0) {
    out.push({
      key: 'failed',
      tone: 'danger',
      title: `${input.failedRecent} ${input.failedRecent === 1 ? 'payment' : 'payments'} failed in the last 24 hours`,
      body: 'Usually no route with enough capacity was found. No funds left your wallet for a failed payment.',
      to: '/activity',
      cta: 'Review activity',
    });
  }
  return out;
}

/** Checks that passed, stated from the same live state (so the panel shows what was checked). */
function passedChecks(input: { accounts: Accounts | undefined; channels: ChannelsView | undefined; swaps: readonly SwapView[] | null | undefined; synced: boolean | undefined }, flagged: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (input.synced === true) out.push('Synced to chain');
  const ch = input.channels;
  if (ch && ch.open.length > 0 && !flagged.has('inactive')) out.push(`All ${ch.open.length} ${ch.open.length === 1 ? 'channel' : 'channels'} active`);
  if (ch && ch.pending.length === 0) out.push('No channels opening or closing');
  if (input.accounts && !flagged.has('unconf')) out.push('No unconfirmed on-chain funds');
  if (input.swaps && !flagged.has('swaps')) out.push('No Loop swaps in progress');
  if (!flagged.has('failed')) out.push('No failed payments in the last 24 hours');
  return out;
}

function Insights({
  accounts,
  channels,
  activity,
}: {
  accounts: Accounts | undefined;
  channels: ChannelsView | undefined;
  activity: ReturnType<typeof useActivity>;
}) {
  const { node } = usePlatform();
  const ready = accounts !== undefined && channels !== undefined;
  const now = Date.now();
  const failedRecent = activity.items.filter((i) => i.type === 'sent' && i.state === 'failed' && now - i.at < 86_400_000).length;
  const state = { accounts, channels, swaps: activity.swaps.data, synced: node.info?.syncedToChain };
  const list = ready ? computeInsights({ ...state, failedRecent }) : [];
  const passed = ready ? passedChecks(state, new Set(list.map((i) => i.key))) : [];
  return (
    <Panel title="Insights" note="From your node's current state" className="p-span-4">
      {!ready ? (
        <div className="p-stack">
          <Skeleton height={64} />
          <Skeleton height={64} />
        </div>
      ) : list.length === 0 ? (
        <ul className="ov-insights">
          <li className="ov-insight" data-tone="positive">
            <Icon name="check" />
            <div>
              <div className="ov-insight-title">Your node looks healthy</div>
              <div className="ov-insight-body">Synced, channels active, and nothing waiting on you.</div>
            </div>
          </li>
        </ul>
      ) : (
        <ul className="ov-insights">
          {list.map((i) => (
            <li className="ov-insight" data-tone={i.tone} key={i.key}>
              <Icon name={i.tone === 'danger' ? 'error' : i.tone === 'warning' ? 'warning' : 'info'} />
              <div>
                <div className="ov-insight-title">{i.title}</div>
                <div className="ov-insight-body">{i.body}</div>
                {i.to ? (
                  <Link to={i.to} className="ov-insight-link">
                    {i.cta}
                    <Icon name="chevronRight" size={14} />
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {ready && passed.length > 0 ? (
        <ul className="ov-checks" aria-label="Checks that passed">
          {passed.map((c) => (
            <li key={c}>
              <Icon name="check" size={14} />
              {c}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

// ——— recent activity ———

function RecentActivity({ activity }: { activity: ReturnType<typeof useActivity> }) {
  const [open, setOpen] = useState<ActivityItem | null>(null);
  const recent = activity.items.slice(0, 8);
  return (
    <Panel
      title="Recent activity"
      note="Lightning payments, invoices and Loop swaps"
      actions={
        <Link to="/activity" className="p-btn p-btn-sm">
          View all
        </Link>
      }
      flush
      className="p-span-12"
    >
      <div style={{ padding: '0 var(--sovl-space-5)' }}>
        <ActivitySourceNotices activity={activity} />
      </div>
      {activity.loading ? (
        <div className="p-stack" style={{ padding: 'var(--sovl-space-4) var(--sovl-space-5)' }}>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : recent.length === 0 ? (
        <Empty title="No activity yet" action={<Link to="/receive" className="p-btn p-btn-sm">Receive bitcoin</Link>}>
          Payments you send, invoices you create and swaps you start will appear here.
        </Empty>
      ) : (
        <div className="p-table-wrap" style={{ marginTop: 'var(--sovl-space-3)' }}>
          <table className="p-table ov-table">
            <thead>
              <tr>
                <th>Type</th>
                <th className="ov-tight">Status</th>
                <th className="p-num ov-tight">Fee</th>
                <th className="p-num ov-tight">Amount</th>
                <th className="p-num ov-tight">When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((it) => (
                <tr
                  key={it.key}
                  data-clickable="true"
                  tabIndex={0}
                  onClick={() => setOpen(it)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setOpen(it);
                    }
                  }}
                  aria-label={`${it.title}, ${it.stateLabel}. Open details`}
                >
                  <td>
                    <div className="ov-type-cell">
                      <TypeGlyph item={it} />
                      <div style={{ minWidth: 0 }}>
                        <div className="ov-type-title">{it.title}</div>
                        <div className="ov-type-sub">{it.description}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <StateBadge item={it} />
                  </td>
                  <td className="p-num p-muted">{it.feeSat === null ? <span className="p-faint">—</span> : <Amount sats={it.feeSat} />}</td>
                  <td className="p-num">
                    <ActivityAmount item={it} />
                  </td>
                  <td className="p-num ov-date" title={new Date(it.at).toLocaleString()}>
                    {relativeTime(it.at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="ov-foot-note">
        <Icon name="info" size={14} />
        On-chain transaction history is not available from this node&apos;s API yet, so on-chain deposits and sends are not listed.
      </div>
      {open ? (
        <Sheet title={open.title} onClose={() => setOpen(null)}>
          <ActivityDetails item={open} />
        </Sheet>
      ) : null}
    </Panel>
  );
}

// ——— page ———

export default function DashboardPage() {
  const balances = useBalances();
  const activity = useActivity();
  const { node } = usePlatform();
  const info = node.info;
  const alias = info && !info.identityPubkey.startsWith(info.alias) ? info.alias : undefined;
  return (
    <>
      <PageHeader
        title="Dashboard"
        sub={alias ? `What ${alias} holds, and how it is doing` : 'What your node holds, and how it is doing'}
        actions={
          <>
            <Link to="/receive" className="p-btn">
              <Icon name="receive" />
              Receive
            </Link>
            <Link to="/send" className="p-btn p-btn-primary">
              <Icon name="send" />
              Send
            </Link>
          </>
        }
      />
      <div className="p-grid">
        <BalanceOverview balances={balances} />
        <QuickActions />
        <LiquidityHealth accounts={balances.accounts} channels={balances.channels.data} />
        <Insights accounts={balances.accounts} channels={balances.channels.data} activity={activity} />
        <ServiceHealth />
        <RecentActivity activity={activity} />
      </div>
    </>
  );
}
