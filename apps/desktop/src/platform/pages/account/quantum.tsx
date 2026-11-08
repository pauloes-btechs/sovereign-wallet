/**
 * Quantum exposure — which of this node's funds already have a public key
 * visible on the blockchain (the first target of a future quantum computer's
 * "long-exposure" attack) and which are still behind a hash until spent.
 *
 * Data: GET /lnd/utxos (unspent outputs + addresses already spent from, from
 * the wallet's own history), GET /channels (commitment type per channel),
 * GET /assets (tapd anchor outpoints) and the wallet balance for a
 * reconciliation check. Classification is @sovereign/wallet-core's pure
 * `classifyExposure`; this page adds no numbers of its own.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  classifyExposure,
  REASON_LABEL,
  type ExposureItem,
  type ExposureReason,
  type ScriptFamily,
  type ExposureReport,
  type ExposureStatus,
} from '@sovereign/wallet-core';
import { computeAccounts } from '../../balances.js';
import { usePlatform, usePoll, useService } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Badge, Breakdown, Empty, Icon, Notice, PageHeader, Panel, Segmented, Skeleton, Stat, type Tone } from '../../ui.js';
import type { AssetsView } from '../../api.js';
import { IdCopy, Units } from './components.js';
import './quantum.css';

const STATUS_TEXT: Record<ExposureStatus, { label: string; tone: Tone }> = {
  exposed: { label: 'Exposed now', tone: 'warning' },
  hidden: { label: 'Not exposed yet', tone: 'neutral' },
  unclassified: { label: 'Not classified', tone: 'info' },
};

const SOURCE_TEXT: Record<ExposureItem['source'], string> = {
  onchain: 'On-chain',
  channel: 'Channel',
  asset: 'Asset anchor',
};

const FAMILY_LABEL: Record<ScriptFamily, string> = {
  p2wpkh: 'P2WPKH (bc1q…)',
  p2sh: 'P2SH-wrapped',
  p2pkh: 'P2PKH (legacy)',
  p2wsh: 'P2WSH',
  p2tr: 'Taproot (bc1p…)',
  p2pk: 'Pay-to-public-key',
  unknown: 'Unrecognized',
};

function itemLabel(it: ExposureItem): string {
  const labels: Record<ExposureReason, string> = {
    'taproot-output': 'Taproot output',
    'bare-public-key': 'Pay-to-public-key output',
    'reused-after-spend': 'Address reused after a spend',
    'hashed-unspent': `${FAMILY_LABEL[it.family ?? 'unknown']} output`,
    'taproot-channel': 'Taproot channel',
    'multisig-channel': 'Multisig channel (P2WSH)',
    'asset-anchor': 'Taproot Assets anchor',
    'unknown-script': 'Unrecognized output script',
    'unknown-channel-type': 'Channel of unknown type',
    'channel-closing': 'Closing channel',
  };
  return labels[it.reason];
}

type Filter = 'exposed' | 'hidden' | 'all';

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="p-btn p-btn-sm" onClick={onClick}>
      <Icon name="refresh" />
      Retry
    </button>
  );
}

export default function QuantumPage() {
  const { api, bridge, refreshKey } = usePlatform();
  const tapd = useService('taproot-assets');
  const utxos = usePoll(() => api.utxos(), 30_000, [api, refreshKey]);
  const channels = usePoll(() => bridge.channels(), 30_000, [bridge, refreshKey]);
  const wallet = usePoll(() => bridge.walletBalance(), 30_000, [bridge, refreshKey]);
  const assets = usePoll<AssetsView | null>(
    () => (tapd.running === true ? api.assets() : Promise.resolve(null)),
    60_000,
    [api, refreshKey, tapd.running],
  );

  const report = useMemo<ExposureReport | undefined>(() => {
    if (utxos.data === undefined || channels.data === undefined) return undefined;
    return classifyExposure({
      utxos: utxos.data.utxos.map((u) => ({ outpoint: u.outpoint, address: u.address, pkScript: u.pkScript, addressType: u.addressType, amountSat: u.amountSat })),
      spentFromAddresses: utxos.data.spentFromAddresses,
      channels: [...channels.data.open, ...channels.data.pending].map((c) => ({
        channelPoint: c.channelPoint,
        commitmentType: c.commitmentType,
        state: c.state,
        localBalanceSat: Number(c.localBalanceSat),
        capacitySat: Number(c.capacitySat),
      })),
      assets: assets.data?.assets ?? [],
    });
  }, [utxos.data, channels.data, assets.data]);

  const accounts = useMemo(() => (wallet.data && channels.data ? computeAccounts(wallet.data, channels.data) : undefined), [wallet.data, channels.data]);

  const error = utxos.error ?? channels.error;
  const reload = () => {
    void utxos.reload();
    void channels.reload();
    void wallet.reload();
    void assets.reload();
  };

  return (
    <>
      <PageHeader
        title="Quantum exposure"
        sub="Which of your funds have a public key already visible on the blockchain, and which are still behind a hash until you spend them. From this node's own data."
      />
      {error && report === undefined ? (
        <Notice tone="danger" title="Couldn't load this node's coins and channels" action={<RetryButton onClick={reload} />}>
          {error}
        </Notice>
      ) : report === undefined || utxos.data === undefined ? (
        <div className="p-grid">
          <div className="p-span-8">
            <Skeleton height={190} />
          </div>
          <div className="p-span-4">
            <Skeleton height={190} />
          </div>
          <div className="p-span-12">
            <Skeleton height={260} />
          </div>
        </div>
      ) : (
        <Loaded
          report={report}
          utxoCount={utxos.data.utxos.length}
          onchainUtxoSat={utxos.data.utxos.reduce((s, u) => s + u.amountSat, 0)}
          historyTransactions={utxos.data.historyTransactions}
          unresolvedSpends={utxos.data.unresolvedSpends}
          walletOnchainSat={accounts ? accounts.onchainSpendableSat + accounts.onchainLockedSat + accounts.onchainUnconfirmedSat : null}
          inFlightSat={accounts?.lightningInFlightSat ?? 0}
          tapdRunning={tapd.running}
          assetsError={assets.error}
          staleError={error}
          onRetry={reload}
        />
      )}
    </>
  );
}

function Loaded({
  report,
  utxoCount,
  onchainUtxoSat,
  historyTransactions,
  unresolvedSpends,
  walletOnchainSat,
  inFlightSat,
  tapdRunning,
  assetsError,
  staleError,
  onRetry,
}: {
  report: ExposureReport;
  utxoCount: number;
  onchainUtxoSat: number;
  historyTransactions: number;
  unresolvedSpends: number;
  walletOnchainSat: number | null;
  inFlightSat: number;
  tapdRunning: boolean | null;
  assetsError: string | null;
  staleError: string | null;
  onRetry: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('exposed');
  const counted = report.exposedSat + report.hiddenSat + report.unclassifiedSat;
  const shown = report.items.filter((i) => filter === 'all' || i.status === filter);
  const count = (s: ExposureStatus) => report.items.filter((i) => i.status === s).length;
  const reused = report.byReason.find((g) => g.reason === 'reused-after-spend');
  const taprootOutputs = report.byReason.find((g) => g.reason === 'taproot-output');
  const reconciles = walletOnchainSat === null ? null : walletOnchainSat === onchainUtxoSat;

  if (report.items.length === 0) {
    return (
      <Panel>
        <Empty title="Nothing to check yet">
          This node has no unspent on-chain coins, channels or Taproot Assets. Once you receive funds, this page shows which keys are visible on the
          blockchain.
        </Empty>
      </Panel>
    );
  }

  return (
    <div className="p-stack">
      {staleError ? (
        <Notice tone="warning" title="Showing the last data that loaded" action={<RetryButton onClick={onRetry} />}>
          The latest refresh failed: {staleError}
        </Notice>
      ) : null}

      <div className="p-grid">
        <div className="p-span-8">
          <Panel title="Your funds today" note="Counted once: on-chain coins at their value, channels at your side (local balance).">
            <div className="p-stack">
              <p className="qx-lead" data-testid="quantum-lead">
                <strong>
                  <Amount sats={report.exposedSat} />
                </strong>{' '}
                of the <Amount sats={counted} /> this node holds {report.exposedSat === 0 ? 'has no' : 'has its'} public key visible on the blockchain
                now. <Amount sats={report.hiddenSat} /> is behind a hash until it is spent.
              </p>
              <div className="qx-bar" role="img" aria-label={`Exposed now ${report.exposedSat} sats, not exposed yet ${report.hiddenSat} sats, not classified ${report.unclassifiedSat} sats`}>
                {counted === 0
                  ? null
                  : (['exposed', 'hidden', 'unclassified'] as const).map((s) => {
                      const sats = s === 'exposed' ? report.exposedSat : s === 'hidden' ? report.hiddenSat : report.unclassifiedSat;
                      return sats > 0 ? <div key={s} className="qx-bar-seg" data-status={s} style={{ flexGrow: sats }} title={STATUS_TEXT[s].label} /> : null;
                    })}
              </div>
              <div className="qx-stats">
                <Stat label={<StatusLabel status="exposed" />} foot={`${count('exposed').toLocaleString('en-US')} ${count('exposed') === 1 ? 'item' : 'items'}`}>
                  <Amount sats={report.exposedSat} />
                </Stat>
                <Stat label={<StatusLabel status="hidden" />} foot={`${count('hidden').toLocaleString('en-US')} ${count('hidden') === 1 ? 'item' : 'items'}`}>
                  <Amount sats={report.hiddenSat} />
                </Stat>
                {count('unclassified') > 0 ? (
                  <Stat label={<StatusLabel status="unclassified" />} foot={`${count('unclassified').toLocaleString('en-US')} ${count('unclassified') === 1 ? 'item' : 'items'}`}>
                    <Amount sats={report.unclassifiedSat} />
                  </Stat>
                ) : null}
              </div>
              <p className="p-hint" style={{ margin: 0 }}>
                “Not exposed yet” is not the same as safe from a quantum computer: spending a coin, or closing a channel, puts its key on the blockchain.
              </p>
            </div>
          </Panel>
        </div>
        <div className="p-span-4">
          <Panel title="By reason">
            <Breakdown
              rows={report.byReason.map((g) => ({
                label: (
                  <span className="qx-reason">
                    <span>{REASON_LABEL[g.reason]}</span>
                    <Badge tone={STATUS_TEXT[g.status].tone} plain>
                      {g.count.toLocaleString('en-US')}
                    </Badge>
                  </span>
                ),
                sats: g.uncountedItems === g.count ? null : g.amountSat,
                note:
                  g.reason === 'asset-anchor'
                    ? 'Bitcoin in the anchor outputs; the assets they carry are listed below.'
                    : g.reason === 'taproot-channel' || g.reason === 'multisig-channel'
                      ? 'Your side of the channels.'
                      : g.uncountedItems > 0
                        ? `${g.uncountedItems} without a counted amount.`
                        : undefined,
              }))}
            />
          </Panel>
        </div>
      </div>

      <Panel
        title="Coins and channels"
        note="Exposed items first, largest first. Each row says why and what would reduce it."
        actions={
          <Segmented<Filter>
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'exposed', label: `Exposed (${count('exposed')})` },
              { value: 'hidden', label: `Not exposed yet (${count('hidden')})` },
              { value: 'all', label: `All (${report.items.length})` },
            ]}
          />
        }
        flush
        className="qx-items"
      >
        {shown.length === 0 ? (
          <Empty title={filter === 'exposed' ? 'No exposed funds' : 'Nothing in this view'}>
            {filter === 'exposed' ? 'None of the coins, channels or assets this node holds has a key visible on the blockchain right now.' : null}
          </Empty>
        ) : (
          <div className="p-table-wrap">
            <table className="p-table qx-table">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Outpoint</th>
                  <th className="p-num">Amount</th>
                  <th>Why, and what reduces it</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((it) => (
                  <ItemRow key={`${it.source}-${it.id}`} item={it} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="p-grid">
        <div className="p-span-6">
          <Panel title="What you can do today">
            <ul className="ac-points">
              <li>
                <strong>Don&apos;t reuse addresses.</strong> This wallet gives you a fresh address every time you{' '}
                <Link to="/receive" className="ac-link">
                  receive
                </Link>
                . Never hand out an address again after spending from it: that spend made its key public.
                {reused ? (
                  <>
                    {' '}
                    Right now <Amount sats={reused.amountSat} /> sits at {reused.count === 1 ? 'an address' : 'addresses'} you already spent from; sending it to
                    a fresh address hides its key again.
                  </>
                ) : null}
              </li>
              <li>
                <strong>Prefer hashed addresses for savings.</strong> A bc1q… (P2WPKH) address keeps the key off the blockchain until you spend. A bc1p…
                (taproot) address puts it there from the day it is paid.
                {taprootOutputs ? (
                  <>
                    {' '}
                    This node&apos;s wallet (LND) also returns change from your own sends to taproot addresses, so spending can create new exposed coins.
                  </>
                ) : null}
              </li>
              <li>
                <strong>There is no post-quantum output type to move to yet.</strong> BIP-360 proposes Pay-to-Merkle-Root (P2MR: SegWit v2, bc1z… addresses), an
                output that commits only to a script tree so no key sits on the blockchain at rest. It is a Draft, it is not activated, and it does not
                itself define a post-quantum signature algorithm.
              </li>
              <li>
                <strong>Moving coins costs fees.</strong> Re-sending an exposed coin to a fresh bc1q… address hides its key again until the next spend, for an
                on-chain fee each time. No publicly known quantum computer can derive a Bitcoin key today, so this is a choice, not an emergency.
              </li>
            </ul>
          </Panel>
        </div>
        <div className="p-span-6">
          <Panel title="What this does not mean">
            <ul className="ac-points">
              <li>
                <strong>Nothing here is quantum-safe.</strong> No output type on Bitcoin today is. “Not exposed yet” only means the key is not on the
                blockchain at rest.
              </li>
              <li>
                <strong>Spending reveals the key.</strong> Every spend, and every channel close, publishes the key it uses. Stealing a coin in the minutes
                between broadcast and confirmation would need a far faster machine than one that works on keys at rest.
              </li>
              <li>
                <strong>It only covers what this node knows.</strong> {utxoCount.toLocaleString('en-US')} unspent {utxoCount === 1 ? 'output' : 'outputs'} in
                this node&apos;s wallet, its channels and the Taproot Assets its tapd holds. Not other wallets, and not the mobile everyday wallet.
              </li>
              <li>
                <strong>Address reuse is read from this node&apos;s history</strong> ({historyTransactions.toLocaleString('en-US')} on-chain{' '}
                {historyTransactions === 1 ? 'transaction' : 'transactions'}). A wallet restored from seed may lack old spends, so a reused address could
                show as not exposed.
                {unresolvedSpends > 0
                  ? ` ${unresolvedSpends.toLocaleString('en-US')} ${unresolvedSpends === 1 ? 'spend' : 'spends'} of this wallet could not be matched to an address.`
                  : null}
              </li>
            </ul>
          </Panel>
        </div>
      </div>

      <Panel title="How these numbers were checked">
        <div className="qx-checks">
          <Check
            ok={reconciles}
            title="On-chain coins"
            body={
              reconciles === null ? (
                'The wallet balance did not load, so the coin list was not compared with it.'
              ) : reconciles ? (
                <>
                  The <Amount sats={onchainUtxoSat} /> in unspent outputs matches the wallet&apos;s on-chain balance.
                </>
              ) : (
                <>
                  Unspent outputs add up to <Amount sats={onchainUtxoSat} />, but the wallet reports <Amount sats={walletOnchainSat} /> on-chain. Refresh once
                  pending transactions settle.
                </>
              )
            }
          />
          <Check
            ok={true}
            title="Channels"
            body={
              <>
                Classified by the funding type LND reports for each channel. Closing channels are not counted: their funds return as on-chain coins.
                {inFlightSat > 0 ? (
                  <>
                    {' '}
                    <Amount sats={inFlightSat} /> in payments in flight is not included.
                  </>
                ) : null}
              </>
            }
          />
          <Check
            ok={tapdRunning === true && assetsError === null ? true : tapdRunning === null ? null : false}
            title="Taproot Assets"
            body={
              tapdRunning === false
                ? 'The Taproot Assets service is not running, so asset anchors are not checked. They appear once tapd is up.'
                : assetsError
                  ? `Asset anchors could not be checked: ${assetsError}`
                  : tapdRunning === null
                    ? 'Waiting for the service status.'
                    : 'Anchor outputs come from tapd. An anchor that is also a wallet coin is counted once, as that coin.'
            }
          />
        </div>
      </Panel>
    </div>
  );
}

function StatusLabel({ status }: { status: ExposureStatus }) {
  return (
    <span className="qx-status-label">
      <span className="qx-swatch" data-status={status} aria-hidden />
      {STATUS_TEXT[status].label}
    </span>
  );
}

function Check({ ok, title, body }: { ok: boolean | null; title: string; body: ReactNode }) {
  return (
    <div className="qx-check">
      <Icon name={ok === true ? 'check' : ok === false ? 'warning' : 'info'} size={16} />
      <div>
        <div className="qx-check-title">
          {title}
          <span className="p-faint"> · {ok === true ? 'checked' : ok === false ? 'needs attention' : 'not checked'}</span>
        </div>
        <div className="p-muted">{body}</div>
      </div>
    </div>
  );
}

function ItemRow({ item }: { item: ExposureItem }) {
  return (
    <tr>
      <td className="qx-what">
        <div className="qx-what-title">{itemLabel(item)}</div>
        <div className="qx-what-meta">
          <Badge tone={STATUS_TEXT[item.status].tone}>{STATUS_TEXT[item.status].label}</Badge>
          <span className="p-faint">{SOURCE_TEXT[item.source]}</span>
        </div>
        {item.assets?.map((a) => (
          <div key={a.assetIdHex} className="p-hint">
            {a.name || 'Unnamed asset'}: <Units value={a.amount} />
          </div>
        ))}
      </td>
      <td>
        <IdCopy value={item.id} what={item.source === 'channel' ? 'channel point' : 'outpoint'} head={8} tail={8} />
        {item.address ? (
          <div className="p-hint p-mono" title={item.address}>
            {item.address.length > 26 ? `${item.address.slice(0, 14)}…${item.address.slice(-8)}` : item.address}
          </div>
        ) : null}
      </td>
      <td className="p-num">
        <Amount sats={item.amountSat} />
        {item.source === 'channel' ? <div className="p-hint">your side</div> : item.amountSat === null ? <div className="p-hint">not reported</div> : null}
      </td>
      <td className="qx-text">
        <p>{item.why}</p>
        <p className="qx-reduce">
          <strong>What reduces it:</strong> {item.reduce}
        </p>
      </td>
    </tr>
  );
}
