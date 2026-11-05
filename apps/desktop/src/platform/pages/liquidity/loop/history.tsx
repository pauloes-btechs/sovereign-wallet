import { useCallback, useMemo, useState } from 'react';
import type { SwapKind, SwapView } from '../../../api.js';
import { usePlatform, usePoll } from '../../../context.js';
import { Amount, Empty, Notice, Panel, relativeTime, Segmented, Sheet, shortId, Skeleton, Timeline } from '../../../ui.js';
import { Link } from '../../../router.js';
import { elapsed, failureCopy, KIND_LABEL, SwapReceipt, SwapStateBadge, swapCostSat, swapTimeline } from './shared.js';

type KindFilter = 'all' | SwapKind;
type StateFilter = 'all' | 'active' | 'success' | 'failed';

export function useSwaps() {
  const { api, refreshKey } = usePlatform();
  return usePoll(() => api.swaps(), 10_000, [api, refreshKey]);
}

export function SwapTable({ swaps, onOpen, compact }: { swaps: readonly SwapView[]; onOpen: (s: SwapView) => void; compact?: boolean }) {
  return (
    <div className="p-table-wrap">
      <table className="p-table">
        <thead>
          <tr>
            <th>Started</th>
            <th>Type</th>
            <th>State</th>
            <th className="p-num">Amount</th>
            <th className="p-num">Cost</th>
            {compact ? null : <th>Elapsed</th>}
            {compact ? null : <th>HTLC address</th>}
            {compact ? null : <th>Failure</th>}
          </tr>
        </thead>
        <tbody>
          {swaps.map((s) => (
            <tr
              key={s.id}
              data-clickable="true"
              tabIndex={0}
              onClick={() => onOpen(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(s);
                }
              }}
              aria-label={`${KIND_LABEL[s.kind]} of ${s.amountSat} sats, ${s.state}. Open details`}
            >
              <td title={new Date(s.initiatedAt).toLocaleString('en-US')}>{relativeTime(s.initiatedAt)}</td>
              <td>{KIND_LABEL[s.kind]}</td>
              <td>
                <SwapStateBadge swap={s} />
              </td>
              <td className="p-num">
                <Amount sats={s.amountSat} />
              </td>
              <td className="p-num">
                <Amount sats={swapCostSat(s)} />
              </td>
              {compact ? null : <td>{elapsed(s)}</td>}
              {compact ? null : <td className="p-mono">{s.htlcAddress ? shortId(s.htlcAddress, 10, 6) : '—'}</td>}
              {compact ? null : <td className="p-muted">{failureCopy(s.failureReason) ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SwapSheet({ swap, onClose }: { swap: SwapView; onClose: () => void }) {
  return (
    <Sheet title={`${KIND_LABEL[swap.kind]} · ${shortId(swap.id)}`} onClose={onClose}>
      <div className="p-stack">
        <div className="p-spread">
          <Amount sats={swap.amountSat} className="p-stat-value" />
          <SwapStateBadge swap={swap} />
        </div>
        <Timeline items={swapTimeline(swap)} />
        <SwapReceipt swap={swap} />
      </div>
    </Sheet>
  );
}

export function SwapHistory() {
  const swaps = useSwaps();
  const [kind, setKind] = useState<KindFilter>('all');
  const [state, setState] = useState<StateFilter>('all');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const open = swaps.data?.find((s) => s.id === openId) ?? null;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (swaps.data ?? []).filter(
      (s) =>
        (kind === 'all' || s.kind === kind) &&
        (state === 'all' || (state === 'active' ? !s.done : s.state === state)) &&
        (needle === '' || s.id.toLowerCase().includes(needle) || s.htlcAddress.toLowerCase().includes(needle) || s.label.toLowerCase().includes(needle)),
    );
  }, [swaps.data, kind, state, q]);

  return (
    <Panel
      flush
      title="Swap history"
      note={swaps.data ? `${swaps.data.length} swap${swaps.data.length === 1 ? '' : 's'} recorded by loopd` : undefined}
      actions={
        <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={() => void swaps.reload()}>
          Refresh
        </button>
      }
    >
      <div className="lp-filters">
        <input className="p-input" type="search" placeholder="Search id, HTLC address or label" aria-label="Search swaps" value={q} onChange={(e) => setQ(e.target.value)} />
        <Segmented
          label="Swap type"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'All types' },
            { value: 'loop-out', label: 'Loop Out' },
            { value: 'loop-in', label: 'Loop In' },
            { value: 'static-loop-in', label: 'Static' },
          ]}
        />
        <Segmented
          label="Swap state"
          value={state}
          onChange={setState}
          options={[
            { value: 'all', label: 'Any state' },
            { value: 'active', label: 'Active' },
            { value: 'success', label: 'Completed' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
      </div>
      {swaps.data === undefined ? (
        swaps.error ? (
          <div style={{ padding: '0 var(--sovl-space-5) var(--sovl-space-5)' }}>
            <Notice tone="danger" title="Could not load swaps" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void swaps.reload()}>Retry</button>}>
              {swaps.error}
            </Notice>
          </div>
        ) : (
          <div style={{ padding: '0 var(--sovl-space-5) var(--sovl-space-5)' }}>
            <Skeleton height={120} />
          </div>
        )
      ) : swaps.data.length === 0 ? (
        <Empty
          title="No swaps yet"
          action={
            <div className="p-row">
              <Link to="/loop/out" className="p-btn p-btn-sm">
                Start Loop Out
              </Link>
              <Link to="/loop/in" className="p-btn p-btn-sm">
                Start Loop In
              </Link>
            </div>
          }
        >
          loopd has no swaps on record for this wallet. Swaps you start here, and any AutoLoop dispatches, appear with their costs and timelines.
        </Empty>
      ) : rows.length === 0 ? (
        <Empty title="No swaps match these filters" />
      ) : (
        <SwapTable swaps={rows} onOpen={(s) => setOpenId(s.id)} />
      )}
      {open ? <SwapSheet swap={open} onClose={close} /> : null}
    </Panel>
  );
}
