/**
 * Routing & analytics: fees earned (GET /lnd/fees), the last 7 days of
 * forwards (GET /diagnostics → forwarding), and Faraday channel insights and
 * revenue (GET /diagnostics → faraday). Charts draw only real events.
 */
import { useMemo, useState } from 'react';
import type { ChannelRowView, DiagnosticsView } from '../../../modeb/bridge-client.js';
import { usePlatform, usePoll } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Empty, Notice, PageHeader, Panel, Segmented, Skeleton, Stat, formatSats, relativeTime, shortId } from '../../ui.js';
import { LoadError, duration, forwardTimeMs, msatToSat } from './infra-kit.js';

type Metric = 'fees' | 'volume' | 'count';
const DAY_MS = 24 * 3600 * 1000;

export default function RoutingPage() {
  const { api, bridge, refreshKey } = usePlatform();
  const fees = usePoll(() => api.feeReport(), 30_000, [refreshKey]);
  const diag = usePoll(() => bridge.diagnostics(), 30_000, [refreshKey]);
  const channels = usePoll(() => bridge.channels(), 60_000, [refreshKey]);

  const forwards = useMemo(
    () => (diag.data?.forwarding ?? []).map((f) => ({ at: forwardTimeMs(f.timestampNs), inSat: Number(f.amtInSat), outSat: Number(f.amtOutSat), feeSat: Number(f.feeSat) })).sort((a, b) => b.at - a.at),
    [diag.data],
  );
  const volume = forwards.reduce((s, f) => s + f.outSat, 0);
  const feeSum = forwards.reduce((s, f) => s + f.feeSat, 0);

  return (
    <>
      <PageHeader title="Routing & analytics" sub="What your node earns by forwarding other people's payments, and how each channel performs." />
      <div className="p-stack">
        <Panel>
          {fees.loading && !fees.data && diag.loading && !diag.data ? (
            <Skeleton height={56} />
          ) : (
            <div className="in-statrow">
              <Stat label="Earned today" foot="Routing fees, from lnd">
                {fees.data ? <Amount sats={fees.data.earnedDaySat} /> : <span className="p-faint">—</span>}
              </Stat>
              <Stat label="Earned this week">{fees.data ? <Amount sats={fees.data.earnedWeekSat} /> : <span className="p-faint">—</span>}</Stat>
              <Stat label="Earned this month">{fees.data ? <Amount sats={fees.data.earnedMonthSat} /> : <span className="p-faint">—</span>}</Stat>
              <Stat label="Forwards, last 7 days" foot={forwards.length > 0 ? <>Volume <Amount sats={volume} /></> : 'None yet'}>
                {diag.data ? forwards.length : <span className="p-faint">—</span>}
              </Stat>
              <Stat label="Effective fee rate" foot="Fees ÷ volume, last 7 days">
                {volume > 0 ? `${Math.round((feeSum / volume) * 1_000_000).toLocaleString('en-US')} ppm` : <span className="p-faint">No volume</span>}
              </Stat>
            </div>
          )}
          {fees.error && !fees.data ? (
            <div style={{ marginTop: 16 }}>
              <LoadError what="the fee report" error={fees.error} onRetry={() => void fees.reload()} />
            </div>
          ) : null}
        </Panel>

        <div className="p-grid">
          <div className={forwards.length > 0 ? 'p-span-7' : 'p-span-12'}>
            <ForwardChart diag={diag.data} error={diag.error} loading={diag.loading} reload={diag.reload} forwards={forwards} />
          </div>
          {forwards.length > 0 ? (
          <div className="p-span-5">
            <Panel flush title="Recent forwards" note="Newest first, last 7 days">
              {diag.loading && !diag.data ? (
                <div className="in-pad">
                  <Skeleton height={80} />
                </div>
              ) : forwards.length === 0 ? (
                <div className="in-pad">
                  <p className="p-muted" style={{ margin: 0 }}>Each payment your node routes for others is listed here with the fee it earned.</p>
                </div>
              ) : (
                <div className="p-table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <table className="p-table" data-testid="forwarding-events">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th className="p-num">Forwarded</th>
                        <th className="p-num">Fee</th>
                      </tr>
                    </thead>
                    <tbody>
                      {forwards.map((f, i) => (
                        <tr key={i}>
                          <td>{f.at ? relativeTime(f.at) : '—'}</td>
                          <td className="p-num">
                            <Amount sats={f.outSat} />
                          </td>
                          <td className="p-num">
                            <Amount sats={f.feeSat} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {forwards.length >= 100 ? (
                <div className="in-pad">
                  <p className="p-hint" style={{ margin: 0 }}>lnd returned its 100-event page limit for this window, so some forwards may be missing.</p>
                </div>
              ) : null}
            </Panel>
          </div>
          ) : null}
        </div>

        <Insights diag={diag.data} channels={channels.data?.open ?? []} loading={diag.loading && !diag.data} error={diag.data ? null : diag.error} reload={diag.reload} />
      </div>
    </>
  );
}

// ——— chart ———

function ForwardChart({
  diag,
  error,
  loading,
  reload,
  forwards,
}: {
  diag: DiagnosticsView | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  forwards: readonly { at: number; outSat: number; feeSat: number }[];
}) {
  const [metric, setMetric] = useState<Metric>('fees');
  const days = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = today.getTime() - 6 * DAY_MS;
    const buckets = Array.from({ length: 7 }, (_, i) => ({ start: start + i * DAY_MS, fees: 0, volume: 0, count: 0 }));
    for (const f of forwards) {
      const idx = Math.floor((f.at - start) / DAY_MS);
      const b = buckets[idx];
      if (b) {
        b.fees += f.feeSat;
        b.volume += f.outSat;
        b.count += 1;
      }
    }
    return buckets;
  }, [forwards]);

  return (
    <Panel
      title="Forwarding activity"
      note="Last 7 days (the window this node's bridge reports)"
      actions={
        forwards.length > 0 ? (
          <Segmented<Metric>
            label="Chart metric"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'fees', label: 'Fees' },
              { value: 'volume', label: 'Volume' },
              { value: 'count', label: 'Forwards' },
            ]}
          />
        ) : undefined
      }
    >
      {loading && !diag ? (
        <Skeleton height={200} />
      ) : error && !diag ? (
        <LoadError what="forwarding history" error={error} onRetry={() => void reload()} />
      ) : forwards.length === 0 ? (
        <Empty title="No forwarded payments in the last 7 days">
          Forwards happen when other nodes route payments through yours. That needs public channels with liquidity on both sides, peers that are well connected, and fees routers will
          pay. Adjust fees per channel on <Link className="in-link" to="/channels">Channels</Link>.
        </Empty>
      ) : (
        <BarChart
          values={days.map((d) => d[metric])}
          labels={days.map((d) => new Date(d.start).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' }))}
          format={(v) => (metric === 'count' ? String(v) : `${formatSats(v, 'sats')}`)}
          unit={metric === 'count' ? 'forwards' : 'sats'}
        />
      )}
    </Panel>
  );
}

function BarChart({ values, labels, format, unit }: { values: readonly number[]; labels: readonly string[]; format: (v: number) => string; unit: string }) {
  const W = 640;
  const H = 200;
  const top = 18;
  const bottom = 24;
  const max = Math.max(...values, 0);
  const slot = W / values.length;
  const barW = Math.min(48, slot * 0.56);
  const plotH = H - top - bottom;
  return (
    <svg className="in-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily ${unit}: ${values.map((v, i) => `${labels[i]} ${format(v)}`).join(', ')}`}>
      <line className="in-chart-grid" x1={0} x2={W} y1={H - bottom} y2={H - bottom} />
      {values.map((v, i) => {
        const h = max === 0 ? 0 : (v / max) * plotH;
        const x = i * slot + (slot - barW) / 2;
        const y = H - bottom - Math.max(h, v > 0 ? 2 : 1);
        return (
          <g key={i}>
            <rect className={v > 0 ? 'in-chart-bar' : 'in-chart-bar-zero'} x={x} y={y} width={barW} height={Math.max(h, v > 0 ? 2 : 1)} rx={3} />
            {v > 0 ? (
              <text className="in-chart-value" x={x + barW / 2} y={y - 5} textAnchor="middle">
                {format(v)}
              </text>
            ) : null}
            <text className="in-chart-label" x={x + barW / 2} y={H - 6} textAnchor="middle">
              {labels[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ——— Faraday ———

function Insights({ diag, channels, loading, error, reload }: { diag: DiagnosticsView | undefined; channels: readonly ChannelRowView[]; loading: boolean; error: string | null; reload: () => Promise<void> }) {
  const byPoint = new Map(channels.map((c) => [c.channelPoint, c]));
  const f = diag?.faraday;
  if (loading) {
    return (
      <Panel title="Channel insights">
        <Skeleton height={100} />
      </Panel>
    );
  }
  if (error) {
    return (
      <Panel title="Channel insights">
        <div data-testid="faraday-unavailable">
          <LoadError what="Faraday insights" error={error} onRetry={() => void reload()} />
        </div>
      </Panel>
    );
  }
  if (!f?.available) {
    return (
      <Panel title="Channel insights">
        <div data-testid="faraday-unavailable">
          <Notice tone="warning" title="Faraday is unavailable">
            {f?.error ?? 'The Faraday service is not running.'} Per-channel uptime, volume and revenue come from Faraday. Fees earned and forwarding history above come straight from lnd and
            still work.
          </Notice>
        </div>
      </Panel>
    );
  }
  const insights = f.insights ?? [];
  const revenue = (f.revenue ?? []).filter((r) => r.pairs.length > 0);
  return (
    <>
      <Panel flush title="Channel insights" note="From Faraday: how reliably each channel is online and how hard its capacity works." testId="faraday-available">
        {insights.length === 0 ? (
          <div className="in-pad">
            <Empty title="No channels monitored yet">Faraday starts tracking a channel once it's open. Uptime and volume build up from then.</Empty>
          </div>
        ) : (
          <div className="p-table-wrap">
            <table className="p-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="p-num">Capacity</th>
                  <th>Uptime</th>
                  <th>Monitored</th>
                  <th className="p-num">Volume in</th>
                  <th className="p-num">Volume out</th>
                  <th className="p-num">Fees earned</th>
                  <th className="p-num" title="Volume in + out divided by capacity, over the monitored period">
                    Turnover
                  </th>
                </tr>
              </thead>
              <tbody>
                {insights.map((ins) => {
                  const ch = byPoint.get(ins.chanPoint);
                  const cap = ch ? Number(ch.capacitySat) : 0;
                  const vin = msatToSat(ins.volumeIncomingMsat);
                  const vout = msatToSat(ins.volumeOutgoingMsat);
                  const ratio = ins.uptimeRatio;
                  return (
                    <tr key={ins.chanPoint}>
                      <td>
                        <div className="p-mono">{ch ? shortId(ch.remotePubkey, 10, 6) : shortId(ins.chanPoint, 10, 4)}</div>
                        <div className="p-hint">
                          {ins.isPrivate ? 'Private' : 'Public'}
                          {ch ? '' : ' · closed or unknown'}
                        </div>
                      </td>
                      <td className="p-num">{ch ? <Amount sats={cap} /> : <span className="p-faint">—</span>}</td>
                      <td>
                        {ratio === undefined ? (
                          <span className="p-faint">Not measured</span>
                        ) : (
                          <div className="p-row" style={{ gap: 8 }}>
                            <div className="in-bar" aria-hidden>
                              <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                            </div>
                            <span>{(ratio * 100).toFixed(ratio === 1 ? 0 : 1)}%</span>
                          </div>
                        )}
                      </td>
                      <td className="p-muted">{duration(Number(ins.monitoredSeconds))}</td>
                      <td className="p-num">
                        <Amount sats={vin} />
                      </td>
                      <td className="p-num">
                        <Amount sats={vout} />
                      </td>
                      <td className="p-num">
                        <Amount sats={msatToSat(ins.feesEarnedMsat)} />
                      </td>
                      <td className="p-num">{cap > 0 ? `${(((vin + vout) / cap) * 100).toFixed(1)}%` : <span className="p-faint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="in-pad" style={{ paddingTop: 12 }}>
          <p className="p-hint" style={{ margin: 0 }}>
            Turnover shows how much traffic a channel carries relative to its size. Low turnover with high uptime suggests fees are too high or the channel's liquidity sits on the wrong
            side.
          </p>
        </div>
      </Panel>

      <Panel flush title="Revenue by channel pair" note="From Faraday: which incoming and outgoing channels earned fees together.">
        {revenue.length === 0 ? (
          <div className="in-pad">
            <p className="p-muted" style={{ margin: 0 }}>
              No routing revenue recorded yet. Once payments are forwarded, Faraday attributes each fee to the channel pair that carried it.
            </p>
          </div>
        ) : (
          <div className="p-table-wrap">
            <table className="p-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Paired with</th>
                  <th className="p-num">Out volume</th>
                  <th className="p-num">Out fees</th>
                  <th className="p-num">In volume</th>
                  <th className="p-num">In fees</th>
                </tr>
              </thead>
              <tbody>
                {revenue.flatMap((r) =>
                  r.pairs.map((p) => (
                    <tr key={`${r.targetChannel}-${p.peerChannelPoint}`}>
                      <td className="p-mono">{shortId(r.targetChannel, 10, 4)}</td>
                      <td className="p-mono">{shortId(p.peerChannelPoint, 10, 4)}</td>
                      <td className="p-num">
                        <Amount sats={msatToSat(p.amountOutgoingMsat)} />
                      </td>
                      <td className="p-num">
                        <Amount sats={msatToSat(p.feesOutgoingMsat)} />
                      </td>
                      <td className="p-num">
                        <Amount sats={msatToSat(p.amountIncomingMsat)} />
                      </td>
                      <td className="p-num">
                        <Amount sats={msatToSat(p.feesIncomingMsat)} />
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
