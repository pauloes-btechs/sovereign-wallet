import { useCallback, useState } from 'react';
import { Link, useLocation } from '../../router.js';
import { usePlatform } from '../../context.js';
import { Amount, Empty, Icon, Notice, PageHeader, Panel, Skeleton, Stat } from '../../ui.js';
import { AutoLoopView } from './loop/autoloop.js';
import { SwapHistory, SwapSheet, SwapTable, useSwaps } from './loop/history.js';
import { LoopInWizard } from './loop/loop-in.js';
import { LoopOutWizard } from './loop/loop-out.js';
import { isRange, LoopUnavailableNotice, OperatorBadge, useLoopStatus, type LoopStatus } from './loop/shared.js';
import { StaticAddressView } from './loop/static.js';

const TABS = [
  { path: '/loop', label: 'Overview' },
  { path: '/loop/out', label: 'Loop Out' },
  { path: '/loop/in', label: 'Loop In' },
  { path: '/loop/static', label: 'Static address' },
  { path: '/loop/history', label: 'History' },
  { path: '/loop/autoloop', label: 'AutoLoop' },
] as const;

export default function LoopPage() {
  const path = useLocation();
  const status = useLoopStatus();
  const tab = TABS.find((t) => t.path === path) ?? TABS[0];
  return (
    <>
      <PageHeader
        title="Loop"
        sub="Non-custodial swaps between Lightning and on-chain bitcoin, by Lightning Labs."
        actions={<OperatorBadge status={status} />}
      />
      <nav className="p-tabs" aria-label="Loop sections">
        {TABS.map((t) => (
          <Link key={t.path} to={t.path} aria-current={t.path === tab.path ? 'page' : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      {tab.path === '/loop' ? <LoopOverview status={status} /> : null}
      {tab.path === '/loop/out' ? <LoopOutWizard status={status} /> : null}
      {tab.path === '/loop/in' ? <LoopInWizard status={status} /> : null}
      {tab.path === '/loop/static' ? <StaticAddressView status={status} /> : null}
      {tab.path === '/loop/history' ? <SwapHistory /> : null}
      {tab.path === '/loop/autoloop' ? <AutoLoopView status={status} /> : null}
    </>
  );
}

function LoopOverview({ status }: { status: LoopStatus }) {
  const { services } = usePlatform();
  const swaps = useSwaps();
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const list = swaps.data ?? [];
  const open = list.find((s) => s.id === openId) ?? null;
  const active = list.filter((s) => !s.done).length;
  const completed = list.filter((s) => s.state === 'success').length;
  const failed = list.filter((s) => s.state === 'failed').length;
  const loopd = services.data?.subServers?.['loop'];
  const op = services.data?.operators.loop;
  const t = status.terms;

  return (
    <div className="p-grid">
      <div className="p-span-12">
        <LoopUnavailableNotice status={status} />
      </div>
      <div className="p-span-8">
        <Panel title="What Loop does">
          <div className="lp-explain">
            <div className="lp-explain-item">
              <h3>
                <Icon name="send" /> Loop Out
              </h3>
              <div className="lp-flow">
                <Icon name="bolt" /> Lightning <Icon name="chevronRight" /> <Icon name="chain" /> on-chain
              </div>
              <p>Send Lightning balance to an on-chain address. Frees up receiving capacity in your channels, or moves earnings to cold storage, without closing anything.</p>
              <Link to="/loop/out" className="p-btn p-btn-sm">
                Start Loop Out
              </Link>
            </div>
            <div className="lp-explain-item">
              <h3>
                <Icon name="receive" /> Loop In
              </h3>
              <div className="lp-flow">
                <Icon name="chain" /> on-chain <Icon name="chevronRight" /> <Icon name="bolt" /> Lightning
              </div>
              <p>Turn on-chain bitcoin in this wallet into spendable Lightning balance in an existing channel. Refills outbound capacity without opening a channel.</p>
              <Link to="/loop/in" className="p-btn p-btn-sm">
                Start Loop In
              </Link>
            </div>
            <div className="lp-explain-item">
              <h3>
                <Icon name="wallets" /> Static address
              </h3>
              <div className="lp-flow">
                <Icon name="external" /> any wallet <Icon name="chevronRight" /> <Icon name="bolt" /> Lightning
              </div>
              <p>A reusable deposit address shared with the swap server. Fund it from an exchange or another wallet, then Loop the deposits into your channels.</p>
              <Link to="/loop/static" className="p-btn p-btn-sm">
                Open static address
              </Link>
            </div>
          </div>
          <p className="p-hint" style={{ marginTop: 'var(--sovl-space-4)', marginBottom: 0 }}>
            Every swap is atomic: an on-chain HTLC and a Lightning payment are locked to the same secret, so neither you nor the swap server can take the funds without the other side completing. You never give up your keys.
          </p>
        </Panel>
      </div>
      <div className="p-span-4">
        <Panel title="Service status">
          <dl className="lp-kv">
            <dt>loopd (in litd)</dt>
            <dd>{loopd === undefined ? '—' : loopd.running ? 'Running' : `Stopped${loopd.error ? `: ${loopd.error}` : ''}`}</dd>
            <dt>Swap server</dt>
            <dd>
              {op === undefined ? '—' : op.mode === 'offline' ? `Not configured (${op.host ?? 'unroutable'})` : op.mode === 'configured' ? op.host : 'Lightning Labs (default)'}
            </dd>
            <dt>Loop Out limits</dt>
            <dd>
              {t === undefined ? <Skeleton width={120} /> : isRange(t.loopOut) ? (
                <>
                  <Amount sats={t.loopOut.minSat} /> – <Amount sats={t.loopOut.maxSat} />
                </>
              ) : (
                'Unavailable'
              )}
            </dd>
            <dt>Loop In limits</dt>
            <dd>
              {t === undefined ? <Skeleton width={120} /> : isRange(t.loopIn) ? (
                <>
                  <Amount sats={t.loopIn.minSat} /> – <Amount sats={t.loopIn.maxSat} />
                </>
              ) : (
                'Unavailable'
              )}
            </dd>
            <dt>Network</dt>
            <dd>{services.data?.network ?? '—'}</dd>
          </dl>
          {t !== undefined && !isRange(t.loopOut) ? <p className="p-hint" style={{ marginBottom: 0 }}>Limits come from the swap server and appear once it answers.</p> : null}
        </Panel>
      </div>
      <div className="p-span-12">
        <Panel>
          <div className="lp-counts">
            <Stat label="Swaps on record">{swaps.data ? list.length : <Skeleton width={40} />}</Stat>
            <Stat label="Active">{swaps.data ? active : <Skeleton width={40} />}</Stat>
            <Stat label="Completed">{swaps.data ? completed : <Skeleton width={40} />}</Stat>
            <Stat label="Failed">{swaps.data ? failed : <Skeleton width={40} />}</Stat>
          </div>
        </Panel>
      </div>
      <div className="p-span-12">
        <Panel
          flush
          title="Recent swaps"
          actions={
            <Link to="/loop/history" className="p-btn p-btn-ghost p-btn-sm">
              All swaps
            </Link>
          }
        >
          {swaps.data === undefined ? (
            swaps.error ? (
              <div style={{ padding: '0 var(--sovl-space-5) var(--sovl-space-5)' }}>
                <Notice tone="danger" title="Could not load swaps" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void swaps.reload()}>Retry</button>}>
                  {swaps.error}
                </Notice>
              </div>
            ) : (
              <div style={{ padding: '0 var(--sovl-space-5) var(--sovl-space-5)' }}>
                <Skeleton height={80} />
              </div>
            )
          ) : list.length === 0 ? (
            <Empty title="No swaps yet">loopd has no swaps on record for this wallet. They appear here with costs and live status once you start one.</Empty>
          ) : (
            <SwapTable swaps={list.slice(0, 5)} onOpen={(s) => setOpenId(s.id)} compact />
          )}
        </Panel>
      </div>
      {open ? <SwapSheet swap={open} onClose={close} /> : null}
    </div>
  );
}
