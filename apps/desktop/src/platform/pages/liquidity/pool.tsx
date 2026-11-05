/**
 * Pool — Lightning Labs' non-custodial channel lease marketplace.
 *
 * Everything shown comes from GET /pool (poold via litd) and GET /services.
 * The bridge has no account/order submission routes yet, so the buy, sell
 * and sidecar journeys are guided explanations that end in an honest
 * "not available in this build" step. On regtest the auctioneer is
 * deliberately unreachable, so the market reads as unavailable.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { PoolView, Section } from '../../api.js';
import { computeAccounts } from '../../balances.js';
import { usePlatform, usePoll, useService } from '../../context.js';
import { Link, useLocation } from '../../router.js';
import { Amount, Badge, Empty, Field, Icon, Notice, PageHeader, Panel, Skeleton, Steps, relativeTime, type Tone } from '../../ui.js';
import { blocksToText, Fact, Facts, IdCopy, sentence, Unavailable } from '../account/components.js';

type Tab = 'overview' | 'buy' | 'sell' | 'sidecar' | 'settings';
const TABS: readonly { id: Tab; label: string; path: string }[] = [
  { id: 'overview', label: 'Overview', path: '/pool' },
  { id: 'buy', label: 'Buy liquidity', path: '/pool/buy' },
  { id: 'sell', label: 'Sell liquidity', path: '/pool/sell' },
  { id: 'sidecar', label: 'Sidecar channels', path: '/pool/sidecar' },
  { id: 'settings', label: 'Pool settings', path: '/pool/settings' },
];

/** One Pool unit is 100,000 sats — the smallest tradeable lot. */
const UNIT_SAT = 100_000;

function tabFor(path: string): Tab {
  const seg = path.split('/')[2];
  return TABS.find((t) => t.id === seg)?.id ?? 'overview';
}

export default function PoolPage() {
  const { api, services, node, refreshKey } = usePlatform();
  const svc = useService('pool');
  const path = useLocation();
  const tab = tabFor(path);
  const pool = usePoll(() => api.pool(), 30_000, [api, refreshKey]);
  const operator = services.data?.operators.pool;
  const height = node.info?.blockHeight ?? null;

  return (
    <>
      <PageHeader
        title="Pool"
        sub="Lease inbound liquidity from other nodes, or earn a premium by leasing out your capital. Matched in sealed-bid batches by Lightning Labs' auctioneer."
        actions={
          <button type="button" className="p-btn p-btn-ghost" onClick={() => void pool.reload()} disabled={pool.loading}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <nav className="p-tabs" aria-label="Pool sections">
        {TABS.map((t) => (
          <Link key={t.id} to={t.path} aria-current={t.id === tab ? 'page' : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>

      {svc.running === false ? (
        <Notice tone="danger" title="The Pool sub-server is not running">
          litd reports poold as stopped{svc.error ? `: ${svc.error}` : ''}. Pool runs inside litd (pool-mode=integrated); restart the node to bring it back.
        </Notice>
      ) : null}

      {pool.error !== null && pool.data === undefined ? (
        <Notice tone="danger" title="Couldn't load Pool" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void pool.reload()}>Retry</button>}>
          {pool.error}
        </Notice>
      ) : null}

      <div className="p-stack">
        {tab === 'overview' ? <Overview data={pool.data} loading={pool.loading} operator={operator} height={height} updatedAt={pool.updatedAt} /> : null}
        {tab === 'buy' ? <BuyFlow data={pool.data} operatorOffline={operator?.mode === 'offline'} /> : null}
        {tab === 'sell' ? <SellFlow data={pool.data} operatorOffline={operator?.mode === 'offline'} /> : null}
        {tab === 'sidecar' ? <Sidecar /> : null}
        {tab === 'settings' ? <PoolSettings data={pool.data} operator={operator} height={height} running={svc.running} /> : null}
      </div>
    </>
  );
}

// ——— market status ———

function MarketNotice({ data, operator }: { data: PoolView; operator: { mode: string; host?: string } | undefined }) {
  const m = data.market;
  if (m.state === 'available') {
    return (
      <Notice tone="positive" title="Pool marketplace is reachable">
        The auctioneer answered and {m.matchedBatches.toLocaleString('en-US')} batches have been matched so far.
      </Notice>
    );
  }
  if (m.state === 'thin') {
    return (
      <Notice tone="warning" title="Pool marketplace is reachable but thin">
        {m.message} Orders can sit unmatched for many batches; matching is never guaranteed.
      </Notice>
    );
  }
  if (operator?.mode === 'offline') {
    return (
      <Notice tone="warning" title="Pool marketplace unavailable: no auctioneer on regtest">
        <p style={{ margin: '0 0 6px' }}>
          This node runs on regtest, where the Pool auctioneer is deliberately not configured. litd&apos;s{' '}
          <span className="p-mono">pool.auctionserver</span> points at <span className="p-mono">{operator.host ?? 'an unroutable address'}</span>, so test runs can
          never reach Lightning Labs&apos; production auctioneer. Lightning Labs does not run a public regtest auctioneer and poold has no signet support, so
          accounts, leases and duration buckets can&apos;t be loaded here.
        </p>
        <p style={{ margin: 0 }}>
          On mainnet the upstream auctioneer is used by default. Pool still runs on mainnet, though market activity has been low recently.
        </p>
      </Notice>
    );
  }
  return (
    <Notice tone="warning" title="Pool marketplace unavailable">
      The auctioneer {operator?.host ? <span className="p-mono">{operator.host}</span> : 'configured for this node'} could not be reached. {m.message}
    </Notice>
  );
}

function stateTone(state: string): Tone {
  if (/open|executed|market_open|accepting/.test(state)) return 'positive';
  if (/pending|submitted|partially|cleared/.test(state)) return 'info';
  if (/fail|cancel|closed|expired|no_market/.test(state)) return 'neutral';
  return 'neutral';
}

function SectionBody<T>({ section, what, children }: { section: Section<T>; what: string; children: (data: T) => ReactNode }) {
  if (!section.ok || section.data === undefined) {
    const auctioneer = /auctioneer|connection refused|Unavailable/i.test(section.error ?? '');
    return (
      <Unavailable title={`${what} unavailable`} raw={section.error ? `poold: ${section.error}` : undefined}>
        {auctioneer
          ? `poold needs the auctioneer to answer this, and the auctioneer can't be reached.`
          : `poold could not answer this request.`}
      </Unavailable>
    );
  }
  return <>{children(section.data)}</>;
}

// ——— overview ———

function Overview({
  data,
  loading,
  operator,
  height,
  updatedAt,
}: {
  data: PoolView | undefined;
  loading: boolean;
  operator: { mode: string; host?: string } | undefined;
  height: number | null;
  updatedAt: number | null;
}) {
  if (data === undefined) {
    return loading ? (
      <Panel>
        <div className="p-stack">
          <Skeleton height={56} />
          <Skeleton height={120} />
        </div>
      </Panel>
    ) : null;
  }
  const accounts = data.accounts.ok ? (data.accounts.data ?? []) : null;
  const orders = data.orders.ok ? (data.orders.data ?? []) : null;
  const leases = data.leases.ok ? data.leases.data : undefined;
  const locked = accounts === null ? null : computeAccounts(undefined, undefined, accounts).poolAccountsSat;
  const activeOrders = orders?.filter((o) => /submitted|partially/.test(o.state)) ?? null;
  const activeLeases = leases?.leases.filter((l) => height === null || l.expiryHeight > height) ?? null;
  const single = accounts !== null && accounts.length === 1 ? accounts[0] : undefined;

  return (
    <>
      <MarketNotice data={data} operator={operator} />

      <Panel title="Marketplace at a glance" note={updatedAt ? `Updated ${relativeTime(updatedAt)}` : undefined}>
        <div className="ac-stats">
          <div>
            <div className="p-stat-label">Market</div>
            <div className="p-stat-value">
              <Badge tone={data.market.state === 'available' ? 'positive' : data.market.state === 'thin' ? 'warning' : 'neutral'}>
                {data.market.state === 'available' ? 'Available' : data.market.state === 'thin' ? 'Thin' : 'Unavailable'}
              </Badge>
            </div>
            <div className="ac-stat-foot">{data.market.matchedBatches.toLocaleString('en-US')} matched batches</div>
          </div>
          <StatOr label="Accounts" value={accounts === null ? null : accounts.length.toLocaleString('en-US')} foot={accounts === null ? 'Needs the auctioneer' : 'Open and closed'} />
          <StatOr label="Active orders" value={activeOrders === null ? null : activeOrders.length.toLocaleString('en-US')} foot={orders === null ? 'Unavailable' : `${orders.length} total`} />
          <StatOr label="Active leases" value={activeLeases === null ? null : activeLeases.length.toLocaleString('en-US')} foot={leases === undefined ? 'Needs the auctioneer' : `${leases.leases.length} total`} />
          <StatOr label="Locked in accounts" value={locked === null ? null : <Amount sats={locked} />} foot="Collateral for bids and asks" />
          <StatOr
            label="Available to trade"
            value={single ? <Amount sats={single.availableSat} /> : accounts !== null && accounts.length === 0 ? <Amount sats={0} /> : accounts === null ? null : 'Per account'}
            foot={accounts !== null && accounts.length > 1 ? 'See accounts below' : 'Not reserved by orders'}
          />
          <StatOr label="Premiums earned" value={leases ? <Amount sats={leases.totalEarnedSat} /> : null} foot="Selling liquidity" />
          <StatOr label="Premiums paid" value={leases ? <Amount sats={leases.totalPaidSat} /> : null} foot="Buying liquidity" />
        </div>
      </Panel>

      <div className="p-grid">
        <div className="p-span-7">
          <Panel title="Accounts" note="Each account is an on-chain output shared with the auctioneer; only you can spend it alone after expiry.">
            <SectionBody section={data.accounts} what="Accounts">
              {(rows) =>
                rows.length === 0 ? (
                  <Empty title="No Pool accounts">An account is funded from your on-chain wallet before you can bid or ask.</Empty>
                ) : (
                  <div className="p-table-wrap">
                    <table className="p-table">
                      <thead>
                        <tr>
                          <th>Trader key</th>
                          <th>State</th>
                          <th className="p-num">Value</th>
                          <th className="p-num">Available</th>
                          <th className="p-num">Expires</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((a) => (
                          <tr key={a.traderKeyHex}>
                            <td><IdCopy value={a.traderKeyHex} what="trader key" /></td>
                            <td><Badge tone={stateTone(a.state)}>{sentence(a.state)}</Badge></td>
                            <td className="p-num"><Amount sats={a.valueSat} /></td>
                            <td className="p-num"><Amount sats={a.availableSat} /></td>
                            <td className="p-num"><ExpiryCell expiry={a.expirationHeight} height={height} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </SectionBody>
          </Panel>
        </div>
        <div className="p-span-5">
          <Panel title="Lease durations" note="Duration buckets the auctioneer currently runs.">
            <SectionBody section={data.leaseDurations} what="Duration buckets">
              {(rows) =>
                rows.length === 0 ? (
                  <Empty title="No duration buckets">The auctioneer reported no lease durations.</Empty>
                ) : (
                  <div className="p-table-wrap">
                    <table className="p-table">
                      <thead>
                        <tr>
                          <th>Duration</th>
                          <th>Approx.</th>
                          <th>State</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...rows].sort((a, b) => a.blocks - b.blocks).map((d) => (
                          <tr key={d.blocks}>
                            <td>{d.blocks.toLocaleString('en-US')} blocks</td>
                            <td className="p-muted">~{blocksToText(d.blocks)}</td>
                            <td><Badge tone={stateTone(d.state)}>{sentence(d.state)}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </SectionBody>
          </Panel>
        </div>
      </div>

      <Panel title="Orders" note="Bids buy inbound liquidity; asks sell it. Orders persist across batches until filled, cancelled or expired.">
        <SectionBody section={data.orders} what="Orders">
          {(rows) =>
            rows.length === 0 ? (
              <Empty title="No orders">poold has no bids or asks on record for this node.</Empty>
            ) : (
              <div className="p-table-wrap">
                <table className="p-table">
                  <thead>
                    <tr>
                      <th>Side</th>
                      <th>State</th>
                      <th className="p-num">Amount</th>
                      <th className="p-num">Rate</th>
                      <th className="p-num">Units filled</th>
                      <th className="p-num">Duration</th>
                      <th>Nonce</th>
                      <th className="p-num">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => (
                      <tr key={o.nonceHex}>
                        <td>{o.side === 'bid' ? 'Buy (bid)' : 'Sell (ask)'}</td>
                        <td><Badge tone={stateTone(o.state)}>{sentence(o.state.replace(/^order_/, ''))}</Badge></td>
                        <td className="p-num"><Amount sats={o.amountSat} /></td>
                        <td className="p-num">{o.rateFixed.toLocaleString('en-US')} <span className="p-faint">ppb/block</span></td>
                        <td className="p-num">{(o.units - o.unitsUnfulfilled).toLocaleString('en-US')} / {o.units.toLocaleString('en-US')}</td>
                        <td className="p-num">{o.leaseDurationBlocks.toLocaleString('en-US')} blocks</td>
                        <td><IdCopy value={o.nonceHex} what="order nonce" head={8} tail={6} /></td>
                        <td className="p-num p-muted">{o.createdAt > 0 ? relativeTime(o.createdAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </SectionBody>
      </Panel>

      <Panel title="Leases" note="Channels bought or sold through Pool, soonest expiry first. A sold channel can't be cooperatively closed by you before its lease ends.">
        <SectionBody section={data.leases} what="Leases">
          {(d) =>
            d.leases.length === 0 ? (
              <Empty title="No leases">No channel has been bought or sold through Pool on this node.</Empty>
            ) : (
              <div className="p-table-wrap">
                <table className="p-table">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th>Role</th>
                      <th className="p-num">Amount</th>
                      <th className="p-num">Duration</th>
                      <th className="p-num">Expires</th>
                      <th className="p-num">Premium</th>
                      <th className="p-num">Execution fee</th>
                      <th className="p-num">Chain fee</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...d.leases].sort((a, b) => a.expiryHeight - b.expiryHeight).map((l) => (
                      <tr key={l.channelPoint}>
                        <td><IdCopy value={l.channelPoint} what="channel point" /></td>
                        <td>
                          {l.purchased ? 'Bought' : 'Sold'}
                          {l.sidecar ? <> · <Badge tone="info" plain>Sidecar</Badge></> : null}
                        </td>
                        <td className="p-num"><Amount sats={l.amountSat} /></td>
                        <td className="p-num">{l.durationBlocks.toLocaleString('en-US')} blocks</td>
                        <td className="p-num"><ExpiryCell expiry={l.expiryHeight} height={height} /></td>
                        <td className="p-num"><Amount sats={l.premiumSat} /></td>
                        <td className="p-num"><Amount sats={l.executionFeeSat} /></td>
                        <td className="p-num"><Amount sats={l.chainFeeSat} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </SectionBody>
      </Panel>
    </>
  );
}

function StatOr({ label, value, foot }: { label: string; value: ReactNode | null; foot?: ReactNode }) {
  return (
    <div>
      <div className="p-stat-label">{label}</div>
      <div className="p-stat-value">{value === null ? <span className="ac-stats-dim">Unavailable</span> : value}</div>
      {foot ? <div className="ac-stat-foot">{foot}</div> : null}
    </div>
  );
}

function ExpiryCell({ expiry, height }: { expiry: number; height: number | null }) {
  if (expiry <= 0) return <span className="p-faint">—</span>;
  const left = height === null ? null : expiry - height;
  return (
    <span>
      Block {expiry.toLocaleString('en-US')}
      {left === null ? null : (
        <span className="ac-cell-note">{left > 0 ? `in ${left.toLocaleString('en-US')} blocks (~${blocksToText(left)})` : 'Expired'}</span>
      )}
    </span>
  );
}

// ——— guided flows ———

function NotInBuild({ action, operatorOffline }: { action: string; operatorOffline: boolean }) {
  return (
    <Notice tone="warning" title={`${action} isn't available in this build`}>
      The bridge exposes Pool read-only (GET /pool): there is no route yet for creating or funding an account (InitAccount, QuoteAccount, DepositAccount),
      quoting or submitting an order (QuoteOrder, SubmitOrder) or cancelling one (CancelOrder).
      {operatorOffline
        ? ' Even with those routes, a submission could not be verified on this regtest node: there is no auctioneer to accept it or match it into a batch.'
        : ''}
    </Notice>
  );
}

function DurationPicker({ data, value, onChange }: { data: PoolView | undefined; value: number | null; onChange: (b: number) => void }) {
  const section = data?.leaseDurations;
  if (section === undefined) return <Skeleton height={56} />;
  if (!section.ok || section.data === undefined || section.data.length === 0) {
    return (
      <Unavailable title="Duration buckets can't be loaded" raw={section.error ? `poold: ${section.error}` : undefined}>
        The auctioneer publishes which lease durations are open for orders. Without it there is nothing to choose from. Each bucket is a separate market with its
        own clearing price.
      </Unavailable>
    );
  }
  return (
    <div className="ac-dur-grid" role="group" aria-label="Lease duration">
      {[...section.data].sort((a, b) => a.blocks - b.blocks).map((d) => (
        <button key={d.blocks} type="button" className="ac-option" aria-pressed={value === d.blocks} onClick={() => onChange(d.blocks)}>
          <span>{d.blocks.toLocaleString('en-US')} blocks</span>
          <span className="ac-option-sub">~{blocksToText(d.blocks)} · {sentence(d.state)}</span>
        </button>
      ))}
    </div>
  );
}

function useAmountField(initial: string) {
  const [raw, setRaw] = useState(initial);
  const n = Number(raw.replace(/[,_\s]/g, ''));
  const error =
    raw.trim() === ''
      ? 'Enter an amount in sats.'
      : !Number.isSafeInteger(n) || n <= 0
        ? 'Enter a whole number of sats.'
        : n % UNIT_SAT !== 0
          ? `Pool trades in units of ${UNIT_SAT.toLocaleString('en-US')} sats. Try ${(Math.max(1, Math.round(n / UNIT_SAT)) * UNIT_SAT).toLocaleString('en-US')}.`
          : null;
  return { raw, setRaw, sats: error === null ? n : null, error };
}

function useRateField(initial: string) {
  const [raw, setRaw] = useState(initial);
  const n = Number(raw.trim());
  const error = raw.trim() === '' ? 'Enter a rate.' : !Number.isSafeInteger(n) || n <= 0 ? 'Enter a whole number of parts per billion per block.' : null;
  return { raw, setRaw, rate: error === null ? n : null, error };
}

function FlowShell({ steps, step, setStep, children, aside }: { steps: readonly string[]; step: number; setStep: (n: number) => void; children: ReactNode; aside: ReactNode }) {
  return (
    <div className="ac-flow">
      <Panel>
        <Steps steps={steps} current={step} />
        <div className="p-stack" style={{ marginTop: 20 }}>
          {children}
        </div>
        <div className="ac-actions-row">
          {step > 0 ? (
            <button type="button" className="p-btn p-btn-ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : null}
          {step < steps.length - 1 ? (
            <button type="button" className="p-btn p-btn-primary" onClick={() => setStep(step + 1)}>
              Continue
            </button>
          ) : null}
        </div>
      </Panel>
      <div className="p-stack">{aside}</div>
    </div>
  );
}

function premiumFor(amountSat: number | null, rate: number | null, blocks: number | null): number | null {
  if (amountSat === null || rate === null || blocks === null) return null;
  return Math.floor((amountSat * rate * blocks) / 1_000_000_000);
}

function BuyFlow({ data, operatorOffline }: { data: PoolView | undefined; operatorOffline: boolean }) {
  const steps = ['Inbound capacity', 'Lease duration', 'Price', 'Account funding', 'Submit'] as const;
  const [step, setStep] = useState(0);
  const amount = useAmountField('1000000');
  const rate = useRateField('1000');
  const [blocks, setBlocks] = useState<number | null>(null);
  const premium = premiumFor(amount.sats, rate.rate, blocks);

  return (
    <FlowShell
      steps={steps}
      step={step}
      setStep={setStep}
      aside={
        <>
          <Panel title="What a bid is">
            <ul className="ac-points">
              <li>A <strong>bid</strong> asks for an inbound channel of a size and duration, at a maximum premium.</li>
              <li>The auctioneer clears bids against asks in <strong>batches</strong> at a single uniform price per duration.</li>
              <li>Matching is <strong>never guaranteed</strong>: a bid can wait many batches or never fill.</li>
              <li>The seller opens the channel and can&apos;t close it cooperatively until the lease ends.</li>
            </ul>
          </Panel>
          <Panel title="Your bid so far">
            <Facts compact>
              <Fact label="Inbound capacity">{amount.sats === null ? <span className="p-faint">—</span> : <Amount sats={amount.sats} />}</Fact>
              <Fact label="Duration">{blocks === null ? <span className="p-faint">Not chosen</span> : `${blocks.toLocaleString('en-US')} blocks`}</Fact>
              <Fact label="Max rate">{rate.rate === null ? <span className="p-faint">—</span> : `${rate.rate.toLocaleString('en-US')} ppb/block`}</Fact>
              <Fact label="Max premium" help="amount × rate × blocks ÷ 10⁹">
                {premium === null ? <span className="p-faint">Pick a duration</span> : <Amount sats={premium} />}
              </Fact>
            </Facts>
          </Panel>
        </>
      }
    >
      {step === 0 ? (
        <>
          <div className="ac-prose">
            <p>
              <strong>Inbound capacity</strong> is how much other nodes can pay you over Lightning. A new node has none: every sat in your channels starts on
              your side. Buying a lease asks a seller to open a channel <em>to</em> you with their funds on their side.
            </p>
          </div>
          <Field label="How much inbound capacity do you want?" hint={`In sats. Pool trades in units of ${UNIT_SAT.toLocaleString('en-US')} sats.`} error={amount.error}>
            {(id) => (
              <div className="p-input-affix">
                <input id={id} className="p-input" inputMode="numeric" value={amount.raw} onChange={(e) => amount.setRaw(e.target.value)} />
                <span>sats</span>
              </div>
            )}
          </Field>
        </>
      ) : null}
      {step === 1 ? (
        <>
          <div className="ac-prose">
            <p>
              A lease lasts a fixed number of blocks. Longer leases cost more in total but keep the channel open for longer. Each duration bucket is its own
              market.
            </p>
          </div>
          <DurationPicker data={data} value={blocks} onChange={setBlocks} />
        </>
      ) : null}
      {step === 2 ? (
        <>
          <div className="ac-prose">
            <p>
              Pool prices a lease as a <strong>fixed rate per block</strong>, in parts per billion of the channel size. The premium you pay the seller is
              amount × rate × duration ÷ 1,000,000,000. If the batch clears below your rate, you pay the lower clearing rate.
            </p>
            <p>
              On top of the premium, the auctioneer charges an <strong>execution fee</strong> and you share the batch&apos;s <strong>chain fee</strong>. Both are
              set per batch and quoted by the auctioneer, which isn&apos;t reachable here, so they aren&apos;t shown.
            </p>
          </div>
          <Field label="Maximum rate" hint="Parts per billion per block." error={rate.error}>
            {(id) => (
              <div className="p-input-affix">
                <input id={id} className="p-input" inputMode="numeric" value={rate.raw} onChange={(e) => rate.setRaw(e.target.value)} />
                <span>ppb/block</span>
              </div>
            )}
          </Field>
        </>
      ) : null}
      {step === 3 ? (
        <div className="ac-prose">
          <p>
            Orders are backed by a <strong>Pool account</strong>: an on-chain output locked to a 2-of-2 between your trader key and the auctioneer, with an expiry
            after which you alone can spend it. You fund it from your on-chain wallet (one transaction, one chain fee) and the premium and fees are paid out of it
            when a batch executes.
          </p>
          <p>
            The account must hold at least the maximum premium plus fees for your bid. Funds sitting in the account are counted as locked in this wallet&apos;s
            balances.
          </p>
        </div>
      ) : null}
      {step === 4 ? (
        <>
          <NotInBuild action="Submitting a bid" operatorOffline={operatorOffline} />
          <div className="ac-actions-row" style={{ marginTop: 0 }}>
            <button type="button" className="p-btn p-btn-primary" disabled aria-describedby="buy-disabled">
              Submit bid
            </button>
            <span id="buy-disabled" className="ac-reason">
              Disabled: this build has no order submission route{operatorOffline ? ', and regtest has no auctioneer' : ''}.
            </span>
          </div>
        </>
      ) : null}
    </FlowShell>
  );
}

function SellFlow({ data, operatorOffline }: { data: PoolView | undefined; operatorOffline: boolean }) {
  const steps = ['Capital', 'Lease duration', 'Price', 'Account funding', 'Submit'] as const;
  const [step, setStep] = useState(0);
  const amount = useAmountField('1000000');
  const rate = useRateField('1000');
  const [blocks, setBlocks] = useState<number | null>(null);
  const premium = premiumFor(amount.sats, rate.rate, blocks);

  return (
    <FlowShell
      steps={steps}
      step={step}
      setStep={setStep}
      aside={
        <>
          <Panel title="What an ask is">
            <ul className="ac-points">
              <li>An <strong>ask</strong> offers to open channels to buyers, funded with your capital.</li>
              <li>Your capital is <strong>locked for the full lease</strong>: the channel script stops you closing it early.</li>
              <li>You earn the premium once, when the batch executes, minus execution and chain fees.</li>
              <li>Buyers route through your channel, so you also earn normal routing fees.</li>
            </ul>
          </Panel>
          <Panel title="Your ask so far">
            <Facts compact>
              <Fact label="Capital offered">{amount.sats === null ? <span className="p-faint">—</span> : <Amount sats={amount.sats} />}</Fact>
              <Fact label="Duration">{blocks === null ? <span className="p-faint">Not chosen</span> : `${blocks.toLocaleString('en-US')} blocks`}</Fact>
              <Fact label="Min rate">{rate.rate === null ? <span className="p-faint">—</span> : `${rate.rate.toLocaleString('en-US')} ppb/block`}</Fact>
              <Fact label="Min premium" help="amount × rate × blocks ÷ 10⁹">
                {premium === null ? <span className="p-faint">Pick a duration</span> : <Amount sats={premium} />}
              </Fact>
            </Facts>
          </Panel>
        </>
      }
    >
      {step === 0 ? (
        <>
          <div className="ac-prose">
            <p>
              Selling liquidity means opening channels <em>from</em> your node to buyers who want inbound capacity. The sats you commit sit on your side of
              those channels for the lease and can only leave by being routed.
            </p>
          </div>
          <Field label="How much capital do you want to offer?" hint={`In sats, in units of ${UNIT_SAT.toLocaleString('en-US')} sats. Can fill across several buyers.`} error={amount.error}>
            {(id) => (
              <div className="p-input-affix">
                <input id={id} className="p-input" inputMode="numeric" value={amount.raw} onChange={(e) => amount.setRaw(e.target.value)} />
                <span>sats</span>
              </div>
            )}
          </Field>
        </>
      ) : null}
      {step === 1 ? (
        <>
          <div className="ac-prose">
            <p>Your capital is committed for the whole duration. Choose the bucket you are willing to be locked into.</p>
          </div>
          <DurationPicker data={data} value={blocks} onChange={setBlocks} />
        </>
      ) : null}
      {step === 2 ? (
        <>
          <div className="ac-prose">
            <p>
              Set the <strong>minimum rate</strong> you&apos;ll accept, in parts per billion per block. If the batch clears above it you earn the higher clearing rate.
              The auctioneer deducts its execution fee and your share of the chain fee from your account when the batch executes.
            </p>
          </div>
          <Field label="Minimum rate" hint="Parts per billion per block." error={rate.error}>
            {(id) => (
              <div className="p-input-affix">
                <input id={id} className="p-input" inputMode="numeric" value={rate.raw} onChange={(e) => rate.setRaw(e.target.value)} />
                <span>ppb/block</span>
              </div>
            )}
          </Field>
        </>
      ) : null}
      {step === 3 ? (
        <div className="ac-prose">
          <p>
            The capital you sell comes from a funded <strong>Pool account</strong>. When an ask matches, channels are opened straight from the account output in the
            batch transaction, so the account must hold the full amount offered plus fees.
          </p>
          <p>Until a match, the funds stay in the account and you can cancel the order. After a match, they are in the channel until the lease expires.</p>
        </div>
      ) : null}
      {step === 4 ? (
        <>
          <NotInBuild action="Submitting an ask" operatorOffline={operatorOffline} />
          <div className="ac-actions-row" style={{ marginTop: 0 }}>
            <button type="button" className="p-btn p-btn-primary" disabled aria-describedby="sell-disabled">
              Submit ask
            </button>
            <span id="sell-disabled" className="ac-reason">
              Disabled: this build has no order submission route{operatorOffline ? ', and regtest has no auctioneer' : ''}.
            </span>
          </div>
        </>
      ) : null}
    </FlowShell>
  );
}

function Sidecar() {
  return (
    <div className="p-grid">
      <div className="p-span-7">
        <Panel title="Sidecar channels">
          <div className="ac-prose">
            <p>
              A <strong>sidecar channel</strong> lets one party buy inbound liquidity <em>for someone else</em>. Typical use: a wallet provider or merchant pays for
              a new user&apos;s first channel, so the user can receive immediately without a Pool account of their own.
            </p>
            <p>The flow passes a ticket between the two parties:</p>
          </div>
          <ol className="ac-points" style={{ marginTop: 8 }}>
            <li><strong>Offer:</strong> the provider creates a ticket for a channel size and duration, and funds it from their Pool account.</li>
            <li><strong>Register:</strong> the recipient adds their node to the ticket.</li>
            <li><strong>Bid:</strong> the provider submits the bid for the ticket.</li>
            <li><strong>Expect:</strong> the recipient&apos;s node waits for the batch that opens the channel to it.</li>
          </ol>
          <div style={{ marginTop: 16 }}>
            <Notice tone="warning" title="Sidecar channels aren't available in this build">
              The bridge has no sidecar routes (OfferSidecar, RegisterSidecar, ExpectSidecarChannel, DecodeSidecarTicket). Leases that were sidecar channels are
              still marked as such on the overview when poold reports them.
            </Notice>
          </div>
        </Panel>
      </div>
      <div className="p-span-5">
        <Panel title="Who pays what">
          <Facts>
            <Fact label="Provider">Pays the premium, execution fee and chain fee from their Pool account.</Fact>
            <Fact label="Recipient">Needs a running node and a ticket. No Pool account and no funds required.</Fact>
            <Fact label="Seller">Opens the channel to the recipient and keeps it open for the lease duration.</Fact>
          </Facts>
        </Panel>
      </div>
    </div>
  );
}

// ——— settings ———

function PoolSettings({
  data,
  operator,
  height,
  running,
}: {
  data: PoolView | undefined;
  operator: { mode: string; host?: string } | undefined;
  height: number | null;
  running: boolean | null;
}) {
  const accounts = useMemo(() => (data?.accounts.ok ? (data.accounts.data ?? []) : null), [data]);
  return (
    <div className="p-grid">
      <div className="p-span-6">
        <Panel title="Pool service" note="Read-only. These come from the node's configuration.">
          <Facts>
            <Fact label="Sub-server" help="poold runs inside litd (pool-mode=integrated).">
              {running === null ? <span className="p-faint">Checking</span> : <Badge tone={running ? 'positive' : 'danger'}>{running ? 'Running' : 'Stopped'}</Badge>}
            </Fact>
            <Fact
              label="Auctioneer"
              help={
                operator?.mode === 'offline'
                  ? 'Deliberately unroutable on regtest so tests never reach Lightning Labs. Set pool.auctionserver in lit.conf (or the bridge override) to use a local auctioneer.'
                  : operator?.mode === 'configured'
                    ? 'Set explicitly with pool.auctionserver in lit.conf (or the bridge override).'
                    : "poold's built-in Lightning Labs auctioneer for this network."
              }
            >
              {operator === undefined ? (
                <span className="p-faint">Unknown</span>
              ) : (
                <span className="p-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Badge tone={operator.mode === 'offline' ? 'warning' : 'info'}>
                    {operator.mode === 'offline' ? 'Offline by design' : operator.mode === 'configured' ? 'Configured' : 'Upstream default'}
                  </Badge>
                  {operator.host ? <span className="p-mono">{operator.host}</span> : null}
                </span>
              )}
            </Fact>
            <Fact label="Market">{data === undefined ? <Skeleton width={120} /> : sentence(data.market.state)}</Fact>
            <Fact label="Order submission" help="Needs InitAccount, QuoteOrder, SubmitOrder and CancelOrder routes in the bridge.">
              Not available in this build
            </Fact>
          </Facts>
        </Panel>
      </div>
      <div className="p-span-6">
        <Panel title="Account expiry" note="Accounts expire at a block height; after that only you can spend the output.">
          {data === undefined ? (
            <Skeleton height={80} />
          ) : accounts === null ? (
            <Unavailable title="Account state unavailable" raw={data.accounts.error ? `poold: ${data.accounts.error}` : undefined}>
              poold checks accounts against the auctioneer before listing them, so with the auctioneer unreachable it can&apos;t report expiry or state.
            </Unavailable>
          ) : accounts.length === 0 ? (
            <Empty title="No accounts">Nothing will expire. A new account&apos;s expiry is chosen when it&apos;s opened.</Empty>
          ) : (
            <Facts>
              {accounts.map((a) => (
                <Fact key={a.traderKeyHex} label={<IdCopy value={a.traderKeyHex} what="trader key" head={8} tail={6} />} help={sentence(a.state)}>
                  <ExpiryCell expiry={a.expirationHeight} height={height} />
                </Fact>
              ))}
            </Facts>
          )}
        </Panel>
      </div>
    </div>
  );
}
