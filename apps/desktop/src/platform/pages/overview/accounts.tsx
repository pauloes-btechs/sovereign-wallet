import type { ReactNode } from 'react';
import type { Accounts } from '../../balances.js';
import { usePlatform, usePoll, usePrefs, useService } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Badge, Empty, Icon, LiquidityBar, Notice, PageHeader, Panel, Skeleton, shortId } from '../../ui.js';
import { BalanceSplit, HeroFigure, KV, RetryButton, balanceSplit, lightningHeld, onchainHeld, useBalances, type BalancesState } from './shared.js';

function AccountCard({
  icon,
  fund,
  name,
  status,
  total,
  children,
  actions,
}: {
  icon: string;
  fund?: 'onchain' | 'outbound';
  name: string;
  status?: ReactNode;
  total?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Panel className="p-span-6">
      <div className="ov-acct">
        <div className="ov-acct-head">
          <span className="ov-acct-icon" data-fund={fund}>
            <Icon name={icon} />
          </span>
          <div style={{ flex: 1 }}>
            <div className="ov-acct-name">{name}</div>
          </div>
          {status}
        </div>
        {total !== undefined ? <div className="ov-acct-total">{total}</div> : null}
        <div className="ov-acct-body">{children}</div>
        {actions ? <div className="ov-acct-actions">{actions}</div> : null}
      </div>
    </Panel>
  );
}

function OnchainCard({ a, b }: { a: Accounts; b: BalancesState }) {
  const w = b.wallet.data;
  const leased = Number(w?.lockedSat ?? 0);
  const anchor = Number(w?.reservedAnchorSat ?? 0);
  return (
    <AccountCard
      icon="chain"
      fund="onchain"
      name="On-chain wallet"
      status={<Badge plain>LND wallet</Badge>}
      total={<Amount sats={onchainHeld(a)} />}
      actions={
        <>
          <Link to="/receive" className="p-btn p-btn-sm">
            <Icon name="receive" />
            Receive
          </Link>
          <Link to="/send" className="p-btn p-btn-sm">
            <Icon name="send" />
            Send
          </Link>
          <Link to="/loop/in" className="p-btn p-btn-ghost p-btn-sm">
            Move to Lightning
          </Link>
        </>
      }
    >
      <KV
        rows={[
          { k: 'Spendable', hint: 'Confirmed and free to spend now', v: <Amount sats={a.onchainSpendableSat} /> },
          { k: 'Unconfirmed', hint: 'Waiting for a block (incoming or change)', v: <Amount sats={a.onchainUnconfirmedSat} /> },
          {
            k: 'Locked and anchor reserve',
            hint: (
              <>
                <Amount sats={anchor} /> anchor reserve · <Amount sats={leased} /> leased outputs
                {anchor + leased > a.onchainLockedSat ? ' · leased outputs that are still unconfirmed are counted under Unconfirmed' : ''}
              </>
            ),
            v: <Amount sats={a.onchainLockedSat} />,
          },
        ]}
      />
      <p className="ov-explain">
        LND keeps a small reserve on-chain so it can fee-bump (CPFP) an anchor channel close if one is ever needed. Leased outputs are held by an in-progress operation such as a channel open or a Pool account.
      </p>
    </AccountCard>
  );
}

function LightningCard({ a, b }: { a: Accounts; b: BalancesState }) {
  const ch = b.channels.data;
  const active = ch?.open.filter((c) => c.state === 'open').length ?? 0;
  const inactive = ch?.open.filter((c) => c.state === 'open-inactive').length ?? 0;
  return (
    <AccountCard
      icon="bolt"
      fund="outbound"
      name="Lightning"
      status={
        <Badge tone={inactive > 0 ? 'warning' : active > 0 ? 'positive' : 'neutral'}>
          {active} active{inactive > 0 ? ` · ${inactive} inactive` : ''} · {ch?.pending.length ?? 0} pending
        </Badge>
      }
      total={<Amount sats={lightningHeld(a)} />}
      actions={
        <>
          <Link to="/send" className="p-btn p-btn-sm">
            <Icon name="send" />
            Pay
          </Link>
          <Link to="/receive" className="p-btn p-btn-sm">
            <Icon name="receive" />
            Request
          </Link>
          <Link to="/channels" className="p-btn p-btn-ghost p-btn-sm">
            Channels
          </Link>
          <Link to="/loop/out" className="p-btn p-btn-ghost p-btn-sm">
            Move on-chain
          </Link>
        </>
      }
    >
      <KV
        rows={[
          { k: 'Spendable', hint: 'Your side of active channels', v: <Amount sats={a.lightningSpendableSat} /> },
          { k: 'Opening', hint: 'Your side of channels waiting to confirm', v: <Amount sats={a.channelsOpeningSat} /> },
          { k: 'In flight', hint: 'Outgoing payments not yet settled', v: <Amount sats={a.lightningInFlightSat} /> },
          {
            k: 'Receivable',
            hint: "Your peers' side: what you can receive. Not counted in your total",
            v: <span className="p-muted"><Amount sats={a.lightningReceivableSat} /></span>,
          },
        ]}
      />
      <div style={{ marginTop: 'var(--sovl-space-3)' }}>
        <LiquidityBar
          legend={false}
          segments={[
            { kind: 'outbound', sats: a.lightningSpendableSat },
            { kind: 'locked', sats: a.channelsOpeningSat + a.lightningInFlightSat, label: 'Opening or in flight' },
            { kind: 'inbound', sats: a.lightningReceivableSat },
          ]}
        />
      </div>
    </AccountCard>
  );
}

function PoolCard({ a, b }: { a: Accounts; b: BalancesState }) {
  const svc = useService('pool');
  const { services } = usePlatform();
  const op = services.data?.operators.pool;
  const network = services.data?.network ?? '';
  const view = b.pool.data;
  const accts = view?.accounts.ok ? view.accounts.data ?? [] : null;
  let body: ReactNode;
  let status: ReactNode = null;
  if (svc.running === false) {
    status = <Badge tone="danger">Stopped</Badge>;
    body = (
      <Empty title="Pool is not running">
        The Pool sub-server is not running in litd{svc.error ? ` (${svc.error})` : ''}, so Pool accounts cannot be read.
      </Empty>
    );
  } else if (b.pool.error) {
    status = <Badge tone="danger">Error</Badge>;
    body = (
      <Notice tone="danger" title="Pool could not be read" action={<RetryButton onClick={() => void b.pool.reload()} />}>
        {b.pool.error}
      </Notice>
    );
  } else if (view === undefined || svc.running === null) {
    body = <Skeleton height={60} />;
  } else if (accts === null) {
    status = <Badge tone="warning">Auctioneer unreachable</Badge>;
    body = (
      <>
        <p className="ov-explain" style={{ marginTop: 0 }}>
          Pool accounts are listed by asking the Pool auctioneer, and it cannot be reached
          {op?.mode === 'offline' ? ` because no auctioneer is configured${network ? ` for ${network}` : ''}` : ''}. Any Pool account you have is not counted in your total until it can be read.
        </p>
        <details className="ov-details" style={{ marginTop: 'var(--sovl-space-3)' }}>
          <summary>Error from poold</summary>
          <pre>{view?.accounts.error ?? 'No error text returned'}</pre>
        </details>
      </>
    );
  } else if (accts.length === 0) {
    status = <Badge tone="positive">Connected</Badge>;
    body = (
      <Empty title="No Pool accounts" action={<Link to="/pool" className="p-btn p-btn-sm">Open Pool</Link>}>
        A Pool account holds funds you use to buy or sell channel leases.
      </Empty>
    );
  } else {
    status = <Badge tone="positive">Connected</Badge>;
    body = (
      <KV
        rows={accts.map((x) => ({
          k: <span className="p-mono">{shortId(x.traderKeyHex, 10, 6)}</span>,
          hint: (
            <>
              {x.state.replace(/_/g, ' ')} · expires at block {x.expirationHeight.toLocaleString('en-US')} · <Amount sats={x.availableSat} /> available
            </>
          ),
          v: <Amount sats={x.valueSat} />,
        }))}
      />
    );
  }
  return (
    <AccountCard
      icon="pool"
      name="Pool account"
      status={status}
      total={accts && accts.length > 0 ? <Amount sats={a.poolAccountsSat} /> : undefined}
      actions={
        <Link to="/pool" className="p-btn p-btn-sm">
          Go to Pool
        </Link>
      }
    >
      {body}
    </AccountCard>
  );
}

function AssetsCard() {
  const { api, refreshKey } = usePlatform();
  const { hideAmounts } = usePrefs();
  const svc = useService('taproot-assets');
  const assets = usePoll(() => (svc.running === true ? api.assets() : Promise.resolve(null)), 60_000, [api, refreshKey, svc.running]);
  let body: ReactNode;
  if (svc.running === false) {
    body = (
      <Empty title="Taproot Assets is not running">
        The tapd sub-server is not running in litd{svc.error ? ` (${svc.error})` : ''}, so asset balances cannot be read.
      </Empty>
    );
  } else if (assets.error) {
    body = (
      <Notice tone="danger" title="Asset balances could not be loaded" action={<RetryButton onClick={() => void assets.reload()} />}>
        {assets.error}
      </Notice>
    );
  } else if (!assets.data) {
    body = <Skeleton height={60} />;
  } else if (assets.data.balances.length === 0) {
    body = (
      <Empty title="No assets yet" action={<Link to="/assets" className="p-btn p-btn-sm">Taproot Assets</Link>}>
        Assets you mint or receive will be listed here, in their own units.
      </Empty>
    );
  } else {
    body = (
      <div>
        {assets.data.balances.map((x) => (
          <div className="ov-asset-row" key={x.assetIdHex}>
            <span className="ov-health-name">{x.name}</span>
            <span className="ov-asset-units">
              {hideAmounts ? <span className="p-hidden-amount" aria-label="Amount hidden">••••••</span> : Number(x.balance).toLocaleString('en-US')}
              <span className="p-faint" style={{ fontWeight: 400 }}> units</span>
            </span>
            <span className="p-hint p-mono" title={x.assetIdHex}>
              {shortId(x.assetIdHex, 12, 8)}
            </span>
            <span className="p-hint" style={{ textAlign: 'right' }}>
              {x.type === 'normal' ? 'Fungible' : x.type === 'collectible' ? 'Collectible' : x.type}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <AccountCard
      icon="assets"
      name="Taproot Assets"
      status={assets.data ? <Badge plain>{assets.data.balances.length} {assets.data.balances.length === 1 ? 'asset' : 'assets'}</Badge> : null}
      actions={
        <Link to="/assets" className="p-btn p-btn-sm">
          Manage assets
        </Link>
      }
    >
      {body}
      <p className="ov-explain">Shown in each asset&apos;s own units. Assets are never converted to BTC or USD and are not part of your bitcoin total.</p>
    </AccountCard>
  );
}

function HowCounted({ a }: { a: Accounts }) {
  const rows: { label: string; sats: number; why: string }[] = [
    { label: 'On-chain, spendable', sats: a.onchainSpendableSat, why: 'Confirmed wallet balance, minus locked and reserved outputs' },
    { label: 'On-chain, locked and anchor reserve', sats: a.onchainLockedSat, why: 'Still yours, just not spendable right now' },
    { label: 'On-chain, unconfirmed', sats: a.onchainUnconfirmedSat, why: 'Counted now; spendable after confirmation' },
    { label: 'Lightning, spendable', sats: a.lightningSpendableSat, why: 'Your side of active channels' },
    { label: 'Lightning, in flight', sats: a.lightningInFlightSat, why: 'Outgoing HTLCs, already excluded from spendable' },
    { label: 'Lightning, channels opening', sats: a.channelsOpeningSat, why: 'Left the on-chain wallet when the funding transaction was broadcast' },
    { label: 'Pool accounts', sats: a.poolAccountsSat, why: 'Separate on-chain outputs owned by your Pool trader key' },
  ];
  return (
    <Panel title="How your total is counted" note="Every sat is counted once, in exactly one place" className="p-span-12">
      <div className="ov-count">
        <div>
          <ul className="ov-count-list" aria-label="Included in your total">
            {rows.map((r) => (
              <li key={r.label}>
                <span>{r.label}</span>
                <Amount sats={r.sats} />
                <span className="ov-count-why">{r.why}</span>
              </li>
            ))}
          </ul>
          <dl className="p-dl" style={{ marginTop: 'var(--sovl-space-4)' }}>
            <dt className="p-dl-total">Total balance</dt>
            <dd className="p-dl-total">
              <Amount sats={a.totalSat} />
            </dd>
          </dl>
        </div>
        <div className="p-stack">
          <div>
            <div className="p-label ov-sub-label">Not counted</div>
            <ul className="ov-count-list">
              <li>
                <span>Lightning receivable</span>
                <span className="p-muted">
                  <Amount sats={a.lightningReceivableSat} />
                </span>
                <span className="ov-count-why">
                  This is your peers&apos; side of your channels: how much they could send you. It becomes yours only when you are paid.
                </span>
              </li>
              <li>
                <span>Loop swaps in progress</span>
                <span className="p-muted">Not added</span>
                <span className="ov-count-why">
                  A Loop Out&apos;s funds stay in your Lightning balance until it settles; a Loop In&apos;s HTLC leaves the on-chain wallet when published. Adding swaps would count them twice.
                </span>
              </li>
              <li>
                <span>Taproot Assets</span>
                <span className="p-muted">Separate units</span>
                <span className="ov-count-why">Assets are not bitcoin and are never converted into this total.</span>
              </li>
            </ul>
          </div>
          <Notice tone="info" title="Unconfirmed is counted, but not spendable">
            Your spendable amount right now is <Amount sats={balanceSplit(a).spendable} /> across on-chain and Lightning.
          </Notice>
        </div>
      </div>
    </Panel>
  );
}

export default function AccountsPage() {
  const b = useBalances();
  const a = b.accounts;
  return (
    <>
      <PageHeader
        title="Accounts & balances"
        sub="Where your bitcoin sits, what each account can do, and exactly how your total is counted."
        actions={
          <button type="button" className="p-btn" onClick={b.reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      {b.error && !a ? (
        <Notice tone="danger" title="Balances could not be loaded" action={<RetryButton onClick={b.reload} />}>
          {b.error}
        </Notice>
      ) : !a || !b.segments ? (
        <div className="p-grid">
          <div className="p-span-12">
            <Skeleton height={140} />
          </div>
          <div className="p-span-6">
            <Skeleton height={260} />
          </div>
          <div className="p-span-6">
            <Skeleton height={260} />
          </div>
        </div>
      ) : (
        <div className="p-grid">
          <Panel className="p-span-12">
            <div className="ov-hero">
              <HeroFigure sats={a.totalSat} label="Total balance" />
              <LiquidityBar size="lg" segments={b.segments} />
              <BalanceSplit accounts={a} />
            </div>
          </Panel>
          <OnchainCard a={a} b={b} />
          <LightningCard a={a} b={b} />
          <PoolCard a={a} b={b} />
          <AssetsCard />
          <HowCounted a={a} />
        </div>
      )}
    </>
  );
}
