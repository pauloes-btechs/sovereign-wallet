/**
 * Taproot Assets — assets held by this node's tapd (inside litd).
 *
 *   /assets            asset list + universe info
 *   /assets/<assetId>  one asset: overview, receive, send, transfers, proofs
 *   /assets/mint       advanced: issue a new asset (on-chain transaction)
 *
 * Bridge routes: GET /assets, GET /assets/transfers, POST /assets/address,
 * POST /assets/decode, POST /assets/send, POST /assets/mint. Amounts are asset
 * units (strings), never sats.
 */
import { useState } from 'react';
import type { AssetView } from '../../api.js';
import { usePlatform, useService } from '../../context.js';
import { Link, navigate, useLocation } from '../../router.js';
import { Badge, CopyField, Empty, Field, Icon, Notice, PageHeader, Panel, QrCode, Skeleton, Steps, relativeTime, shortId } from '../../ui.js';
import { CopyButton, Fact, Facts, IdCopy, sentence, Units, Unavailable } from '../account/components.js';
import { summarize, TransferStatus, displayTxid, unlistedTransfers, useAssets, useTransfers, type AssetSummary, type Transfer } from './asset-shared.js';

const HEX64 = /^[0-9a-f]{64}$/i;
const UNITS = /^[1-9][0-9]{0,18}$/;



/** True when the name reads like a currency; we then say the name implies no value. */
const currencyLike = (name: string) => /\b(usd|usdt|usdc|eur|gbp|dollar|euro|stable)/i.test(name);

function initials(name: string): string {
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/);
  return (parts.map((p) => p.charAt(0)).join('').slice(0, 2) || '?').toUpperCase();
}

export default function TaprootPage() {
  const path = useLocation();
  const sub = path.replace(/^\/assets\/?/, '').split('/')[0] ?? '';
  if (sub === 'mint') return <MintView />;
  if (HEX64.test(sub)) return <AssetDetail assetIdHex={sub.toLowerCase()} />;
  return <AssetList />;
}



function PendingNotice({ pending, names }: { pending: readonly Transfer[]; names?: ReadonlyMap<string, string> }) {
  if (pending.length === 0) return null;
  return (
    <Notice tone="info" title="Waiting for an anchor transaction to confirm">
      tapd lists asset outputs only once the Bitcoin transaction anchoring them confirms, so the assets it moves don't appear until then. Transfer:{' '}
      <span className="p-mono">{shortId(pending[0]?.txid ?? '', 12, 8)}</span>
      {names && pending[0] ? ` (${pending[0].outputs.map((o) => names.get(o.assetIdHex) ?? shortId(o.assetIdHex, 6, 4)).filter((v, i, a) => a.indexOf(v) === i).join(', ')})` : ''}.
      {' '}On regtest, mine a block to confirm it.
    </Notice>
  );
}



function ServiceNotice() {
  const svc = useService('taproot-assets');
  if (svc.running !== false) return null;
  return (
    <Notice tone="danger" title="Taproot Assets is not running">
      litd reports tapd as stopped{svc.error ? `: ${svc.error}` : ''}. tapd runs inside litd; restart the node to bring it back.
    </Notice>
  );
}

function UnverifiedBadge() {
  return (
    <span title="No issuer verification source is configured in this build.">
      <Badge tone="warning">Unverified issuer</Badge>
    </span>
  );
}

// ——— list ———

function AssetList() {
  const assets = useAssets();
  const transfers = useTransfers();
  const data = assets.data;
  const rows = data ? summarize(data) : [];
  const pending = unlistedTransfers(data, transfers.data);

  return (
    <>
      <PageHeader
        title="Taproot Assets"
        sub="Assets issued on Bitcoin with the Taproot Assets protocol, held by this node's tapd. Amounts are in each asset's own units, not sats."
        actions={
          <Link to="/assets/mint" className="p-btn p-btn-ghost">
            <Icon name="plus" />
            Mint asset
          </Link>
        }
      />
      <div className="p-stack">
        <ServiceNotice />
        <PendingNotice pending={pending} />
        {assets.error !== null && data === undefined ? (
          <Notice tone="danger" title="Couldn't load assets" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void assets.reload()}>Retry</button>}>
            {assets.error}
          </Notice>
        ) : null}

        <Panel title="Assets" note={assets.updatedAt ? `${rows.length} ${rows.length === 1 ? 'asset' : 'assets'} · updated ${relativeTime(assets.updatedAt)}` : undefined} flush>
          {data === undefined ? (
            <div style={{ padding: 24 }} className="p-stack">
              <Skeleton height={20} />
              <Skeleton height={20} />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24 }}>
              {pending.length > 0 ? (
                <Empty title="No confirmed assets right now">Assets reappear here when the pending transfer confirms.</Empty>
              ) : (
                <Empty title="No assets yet" action={<Link to="/assets/mint" className="p-btn">Mint asset</Link>}>
                  Receive an asset from another wallet, or mint a test asset.
                </Empty>
              )}
            </div>
          ) : (
            <div className="p-table-wrap">
              <table className="p-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Asset ID</th>
                    <th>Group key</th>
                    <th className="p-num">Balance</th>
                    <th>Issuer</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const first = r.outputs[0];
                    return (
                      <tr key={r.assetIdHex} data-clickable="true" onClick={() => navigate(`/assets/${r.assetIdHex}`)}>
                        <td>
                          <span className="p-row" style={{ gap: 10 }}>
                            <span className="ac-asset-mark" aria-hidden>{initials(r.name)}</span>
                            <span style={{ whiteSpace: 'nowrap' }}>
                              <Link to={`/assets/${r.assetIdHex}`} onClick={(e) => e.stopPropagation()} style={{ color: 'inherit', fontWeight: 500 }}>
                                {r.name || 'Unnamed asset'}
                              </Link>
                              <span className="ac-cell-note">
                                {sentence(r.type)}
                                {first ? ` · ${first.version}` : ''} · {r.outputs.length} {r.outputs.length === 1 ? 'output' : 'outputs'}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className="p-mono" title={r.assetIdHex}>{shortId(r.assetIdHex, 8, 6)}</span>
                        </td>
                        <td>{first?.groupKeyHex ? <span className="p-mono" title={first.groupKeyHex}>{shortId(first.groupKeyHex, 8, 6)}</span> : <span className="p-faint">Ungrouped</span>}</td>
                        <td className="p-num"><Units value={r.balance} /></td>
                        <td><UnverifiedBadge /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="p-grid">
          <div className="p-span-6">
            <Panel title="tapd and universe" note="This node's Taproot Assets daemon and the universe it serves.">
              {data === undefined ? (
                <Skeleton height={80} />
              ) : data.universe === null ? (
                <Unavailable title="tapd info unavailable">tapd didn&apos;t answer GetInfo; assets above still come from ListAssets.</Unavailable>
              ) : (
                <Facts>
                  <Fact label="tapd version">{data.universe.version}</Fact>
                  <Fact label="Network">{data.universe.network}</Fact>
                  <Fact label="Synced to block" help="tapd's view of the chain tip.">{data.universe.blockHeight.toLocaleString('en-US')}</Fact>
                  <Fact label="Universe" help="tapd keeps a local universe of issuance and transfer proofs for the assets it knows. Federation peers aren't reported by the bridge.">
                    Local
                  </Fact>
                </Facts>
              )}
            </Panel>
          </div>
          <div className="p-span-6">
            <Panel title="About issuer verification">
              <div className="ac-prose">
                <p>
                  Taproot Assets has no built-in issuer registry: anyone can mint an asset with any name, including names of real currencies. The asset ID is
                  the only thing that identifies an asset.
                </p>
                <p>
                  This build has no verification source (such as a curated universe or an issuer attestation), so every asset is marked{' '}
                  <strong>Unverified issuer</strong>. Confirm an asset ID with its issuer through a channel you trust before accepting it as payment. A name
                  never implies a fixed value or a right to redeem.
                </p>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

// ——— detail ———

type DetailTab = 'overview' | 'receive' | 'send' | 'transfers' | 'proofs';
const DETAIL_TABS: readonly { id: DetailTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'receive', label: 'Receive' },
  { id: 'send', label: 'Send' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'proofs', label: 'Proofs' },
];

function AssetDetail({ assetIdHex }: { assetIdHex: string }) {
  const assets = useAssets();
  const transfers = useTransfers();
  const [tab, setTab] = useState<DetailTab>('overview');
  const summary = assets.data ? summarize(assets.data).find((s) => s.assetIdHex === assetIdHex) : undefined;

  if (assets.data === undefined) {
    return (
      <>
        <PageHeader title="Asset" />
        {assets.error ? (
          <Notice tone="danger" title="Couldn't load the asset" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void assets.reload()}>Retry</button>}>
            {assets.error}
          </Notice>
        ) : (
          <Panel><Skeleton height={120} /></Panel>
        )}
      </>
    );
  }
  if (summary === undefined) {
    const pending = unlistedTransfers(assets.data, transfers.data).filter((t) => t.outputs.some((o) => o.assetIdHex === assetIdHex));
    if (pending.length > 0) {
      return (
        <>
          <PageHeader title="Asset pending confirmation" />
          <div className="p-stack">
            <PendingNotice pending={pending} />
            <Panel>
              <Empty title="No confirmed outputs right now" action={<Link to="/assets/activity" className="p-btn">View asset activity</Link>}>
                This page fills in again once the transfer confirms. <span className="p-mono">{shortId(assetIdHex, 12, 8)}</span>
              </Empty>
            </Panel>
          </div>
        </>
      );
    }
    return (
      <>
        <PageHeader title="Asset not found" />
        <Panel>
          <Empty title="This node holds no asset with that ID" action={<Link to="/assets" className="p-btn">Back to assets</Link>}>
            <span className="p-mono">{assetIdHex}</span>
          </Empty>
        </Panel>
      </>
    );
  }
  const first = summary.outputs[0];
  const height = assets.data.universe?.blockHeight ?? null;

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link to="/assets" className="p-btn p-btn-ghost p-btn-sm">
          <Icon name="collapse" />
          All assets
        </Link>
      </div>
      <PageHeader
        title={summary.name || 'Unnamed asset'}
        sub={
          <span className="p-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Badge tone="neutral" plain>{sentence(summary.type)}</Badge>
            <UnverifiedBadge />
            <span className="p-mono p-faint" title={summary.assetIdHex}>{shortId(summary.assetIdHex, 12, 8)}</span>
          </span>
        }
        actions={
          <>
            <button type="button" className="p-btn" onClick={() => setTab('receive')}>
              <Icon name="receive" />
              Receive
            </button>
            <button type="button" className="p-btn p-btn-primary" onClick={() => setTab('send')}>
              <Icon name="send" />
              Send
            </button>
          </>
        }
      />
      <div className="p-tabs" role="tablist" aria-label="Asset sections">
        {DETAIL_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-stack">
        <ServiceNotice />
        {tab === 'overview' && currencyLike(summary.name) ? (
          <Notice tone="info" title="The name doesn't set a value">
            This asset&apos;s name mentions a currency. Nothing on this node establishes a fixed value, a peg or a right to redeem it; the bridge exposes no issuer
            or redemption metadata for it. Treat it as whatever its issuer has committed to off-chain.
          </Notice>
        ) : null}
        {tab === 'overview' ? <Overview summary={summary} height={height} /> : null}
        {tab === 'receive' ? <Receive summary={summary} /> : null}
        {tab === 'send' ? <Send summary={summary} onDone={() => void assets.reload()} /> : null}
        {tab === 'transfers' ? <AssetTransfers assetIdHex={summary.assetIdHex} outputs={summary.outputs} /> : null}
        {tab === 'proofs' ? <Proofs summary={summary} first={first} /> : null}
      </div>
    </>
  );
}

function Overview({ summary, height }: { summary: AssetSummary; height: number | null }) {
  const first = summary.outputs[0];
  return (
    <>
      <div className="p-grid">
        <div className="p-span-4">
          <Panel title="Balance">
            <div className="ac-big">
              <Units value={summary.balance} unit="" />
              <span className="ac-big-unit">units</span>
            </div>
            <div className="p-hint" style={{ marginTop: 8 }}>
              Base units as recorded by tapd, across {summary.outputs.length} {summary.outputs.length === 1 ? 'output' : 'outputs'}. Decimal display metadata isn&apos;t
              exposed by the bridge, so no decimal point is applied.
            </div>
          </Panel>
        </div>
        <div className="p-span-8">
          <Panel title="Asset details">
            <Facts>
              <Fact label="Asset ID" help="The only identifier that uniquely names this asset.">
                <span className="ac-inline-copy">
                  <span className="p-mono" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{summary.assetIdHex}</span>
                  <CopyButton value={summary.assetIdHex} ariaLabel="Copy asset ID" />
                </span>
              </Fact>
              <Fact label="Type" help={summary.type === 'normal' ? 'Fungible: units are interchangeable.' : 'Collectible: each unit is unique.'}>
                {sentence(summary.type)}
              </Fact>
              <Fact label="Asset version">{first?.version ?? '—'}</Fact>
              <Fact label="Group key" help={first?.groupKeyHex ? 'More units can be issued under this key.' : 'Ungrouped: the supply was fixed at issuance.'}>
                {first?.groupKeyHex ? <IdCopy value={first.groupKeyHex} what="group key" /> : 'None'}
              </Fact>
              <Fact label="Genesis point" help="The outpoint spent by the issuance transaction.">
                {first ? <IdCopy value={first.genesisPoint} what="genesis point" /> : '—'}
              </Fact>
              <Fact label="Issuer">
                <UnverifiedBadge /> <span className="p-muted" style={{ marginLeft: 6 }}>No verification source in this build</span>
              </Fact>
            </Facts>
          </Panel>
        </div>
      </div>
      <Panel title="Outputs" note="Each output is anchored in a Bitcoin transaction output owned by this node." flush>
        <div className="p-table-wrap">
          <table className="p-table">
            <thead>
              <tr>
                <th>Anchor outpoint</th>
                <th className="p-num">Anchor block</th>
                <th className="p-num">Confirmations</th>
                <th>Status</th>
                <th className="p-num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {summary.outputs.map((o) => (
                <tr key={o.anchorOutpoint}>
                  <td><IdCopy value={o.anchorOutpoint} what="anchor outpoint" head={10} tail={6} /></td>
                  <td className="p-num">{o.anchorBlockHeight > 0 ? o.anchorBlockHeight.toLocaleString('en-US') : <span className="p-faint">Unconfirmed</span>}</td>
                  <td className="p-num">{o.anchorBlockHeight > 0 && height !== null ? (height - o.anchorBlockHeight + 1).toLocaleString('en-US') : '—'}</td>
                  <td>{o.isSpent ? <Badge tone="neutral">Spent</Badge> : <Badge tone="positive">Unspent</Badge>}</td>
                  <td className="p-num"><Units value={o.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function Receive({ summary }: { summary: AssetSummary }) {
  const { api, toast } = usePlatform();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState<{ address: string; amount: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trimmed = amount.replace(/[,_\s]/g, '');
  const invalid = trimmed === '' ? null : UNITS.test(trimmed) ? null : 'Enter a whole number of units, at least 1.';

  const create = async () => {
    if (!UNITS.test(trimmed)) {
      setError('Enter a whole number of units, at least 1.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.newAssetAddress(summary.assetIdHex, trimmed);
      setAddress({ address: r.address, amount: trimmed });
      toast({ title: 'Asset address created', body: `${BigInt(trimmed).toLocaleString('en-US')} units of ${summary.name}`, tone: 'positive' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-grid">
      <div className="p-span-5">
        <Panel title={`Receive ${summary.name}`}>
          <div className="p-stack">
            <div className="ac-prose">
              <p>A Taproot Assets address is for one asset and one exact amount. The sender must pay exactly this amount.</p>
            </div>
            <Field label="Amount" hint="In base units of this asset." error={invalid}>
              {(id) => (
                <div className="p-input-affix">
                  <input
                    id={id}
                    className="p-input"
                    inputMode="numeric"
                    placeholder="1000"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void create();
                    }}
                  />
                  <span>units</span>
                </div>
              )}
            </Field>
            {error ? <Notice tone="danger" title="Couldn't create the address">{error}</Notice> : null}
            <div>
              <button type="button" className="p-btn p-btn-primary" disabled={busy || trimmed === '' || invalid !== null} onClick={() => void create()}>
                {busy ? 'Creating address…' : 'Create address'}
              </button>
            </div>
          </div>
        </Panel>
        <div style={{ marginTop: 16 }}>
          <Panel title="Before you share it">
            <ul className="ac-points">
              <li>
                <strong>Proof courier:</strong> when another wallet pays this address, it uploads the transfer proof to the proof courier named in the address,
                and this node fetches it from there. Both sides must be able to reach that courier.
              </li>
              <li>
                This node creates addresses without checking the courier is reachable. Transfers inside this wallet don&apos;t need it; transfers from other
                wallets do.
              </li>
              <li>The asset arrives once the sender&apos;s anchor transaction confirms on-chain.</li>
            </ul>
          </Panel>
        </div>
      </div>
      <div className="p-span-7">
        <Panel title="Address" note={address ? `${BigInt(address.amount).toLocaleString('en-US')} units of ${summary.name}` : undefined}>
          {address === null ? (
            <Empty title="No address yet">Enter an amount and create an address to show its QR code here.</Empty>
          ) : (
            <div className="p-row" style={{ alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
              <QrCode value={address.address} size={232} label="Taproot Assets address QR code" />
              <div className="p-stack" style={{ flex: 1, minWidth: 240 }}>
                <div data-testid="asset-address">
                  <CopyField value={address.address} label="Taproot Assets address" />
                </div>
                <Facts>
                  <Fact label="Asset">{summary.name}</Fact>
                  <Fact label="Amount"><Units value={address.amount} /></Fact>
                </Facts>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

type SendStage = { kind: 'enter' } | { kind: 'review'; address: string; amount: string } | { kind: 'sent'; address: string; amount: string; txid: string };

function Send({ summary, onDone }: { summary: AssetSummary; onDone: () => void }) {
  const { api, toast, bumpRefresh } = usePlatform();
  const [input, setInput] = useState('');
  const [stage, setStage] = useState<SendStage>({ kind: 'enter' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const balance = /^[0-9]+$/.test(summary.balance) ? BigInt(summary.balance) : null;

  const review = async () => {
    const address = input.trim();
    if (address === '') {
      setError('Paste a Taproot Assets address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const d = await api.decodeAssetAddress(address);
      if (d.assetIdHex.toLowerCase() !== summary.assetIdHex) {
        setError(`This address asks for a different asset (ID ${shortId(d.assetIdHex, 8, 6)}). Open that asset to pay it.`);
        return;
      }
      if (balance !== null && BigInt(d.amount) > balance) {
        setError(`This address asks for ${BigInt(d.amount).toLocaleString('en-US')} units, more than the ${balance.toLocaleString('en-US')} units this node holds.`);
        return;
      }
      setStage({ kind: 'review', address, amount: d.amount });
    } catch (err) {
      setError(`That isn't a valid Taproot Assets address for this network: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (stage.kind !== 'review') return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.sendAsset(stage.address);
      setStage({ kind: 'sent', address: stage.address, amount: stage.amount, txid: displayTxid(r.txid) });
      toast({ title: 'Asset sent', body: `${BigInt(stage.amount).toLocaleString('en-US')} units of ${summary.name}`, tone: 'positive' });
      bumpRefresh();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const step = stage.kind === 'enter' ? 0 : stage.kind === 'review' ? 1 : 2;

  return (
    <div className="ac-flow">
      <Panel title={`Send ${summary.name}`}>
        <Steps steps={['Address', 'Review', 'Sent']} current={step} />
        <div className="p-stack" style={{ marginTop: 20 }}>
          {stage.kind === 'enter' ? (
            <>
              <Field label="Taproot Assets address" hint="Starts with taprt (regtest), taptb (testnet) or tapbc (mainnet). The amount comes from the address.">
                {(id) => <textarea id={id} className="p-textarea p-mono" rows={4} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />}
              </Field>
              {error ? <Notice tone="danger" title="Can't send to this address">{error}</Notice> : null}
              <div>
                <button type="button" className="p-btn p-btn-primary" disabled={busy || input.trim() === ''} onClick={() => void review()}>
                  {busy ? 'Checking address…' : 'Review send'}
                </button>
              </div>
            </>
          ) : null}
          {stage.kind === 'review' ? (
            <>
              <Facts>
                <Fact label="From">This node&apos;s tapd · balance <Units value={summary.balance} /></Fact>
                <Fact label="Asset">
                  {summary.name} <span className="p-mono p-faint">{shortId(summary.assetIdHex, 8, 6)}</span>
                </Fact>
                <Fact label="Amount" help="Fixed by the address; decoded by tapd.">
                  <strong><Units value={stage.amount} /></strong>
                </Fact>
                <Fact label="Destination">
                  <span className="p-mono" style={{ overflowWrap: 'anywhere', fontSize: 12 }}>{stage.address}</span>
                </Fact>
                <Fact label="On-chain fee" help="tapd funds the anchor transaction from this node's on-chain wallet and picks the fee rate itself. The bridge has no fee quote for asset sends yet.">
                  Paid in sats, chosen by tapd at send time
                </Fact>
                <Fact label="Timing">Complete when the anchor transaction confirms (one block).</Fact>
              </Facts>
              <Notice tone="warning" title="Asset sends can't be reversed">
                Once broadcast, the units belong to the address owner. The recipient&apos;s node must get the transfer proof, through the proof courier when it&apos;s
                another wallet.
              </Notice>
              {error ? <Notice tone="danger" title="The send failed">{error}</Notice> : null}
              <div className="p-row">
                <button type="button" className="p-btn p-btn-ghost" disabled={busy} onClick={() => setStage({ kind: 'enter' })}>
                  Back
                </button>
                <button type="button" className="p-btn p-btn-primary" disabled={busy} onClick={() => void send()}>
                  {busy ? 'Sending…' : `Send ${BigInt(stage.amount).toLocaleString('en-US')} units`}
                </button>
              </div>
            </>
          ) : null}
          {stage.kind === 'sent' ? (
            <>
              <Notice tone="positive" title="Asset sent">
                tapd broadcast the anchor transaction. The transfer completes when it confirms; on regtest that means the next mined block.
              </Notice>
              <Facts>
                <Fact label="Amount"><Units value={stage.amount} /></Fact>
                <Fact label="Anchor transaction"><IdCopy value={stage.txid} what="transaction ID" head={14} tail={10} /></Fact>
              </Facts>
              <div className="p-row">
                <Link to="/assets/activity" className="p-btn">View asset activity</Link>
                <button
                  type="button"
                  className="p-btn p-btn-ghost"
                  onClick={() => {
                    setInput('');
                    setStage({ kind: 'enter' });
                  }}
                >
                  Send again
                </button>
              </div>
            </>
          ) : null}
        </div>
      </Panel>
      <Panel title="How an asset send works">
        <ul className="ac-points">
          <li>tapd decodes the address and builds a Bitcoin transaction whose taproot outputs commit to the asset transfer.</li>
          <li>Any remaining units return to a new output owned by this node.</li>
          <li>Proofs for the new outputs are stored locally and, for another wallet, delivered via the proof courier.</li>
        </ul>
      </Panel>
    </div>
  );
}

function AssetTransfers({ assetIdHex, outputs }: { assetIdHex: string; outputs: readonly AssetView[] }) {
  const transfers = useTransfers();
  const rows = (transfers.data ?? []).filter((t) => t.outputs.some((o) => o.assetIdHex === assetIdHex)).sort((a, b) => b.at - a.at);
  return (
    <Panel
      title="Transfers"
      note="Outgoing transfers tapd recorded for this asset, including sends to this node's own addresses."
      actions={<Link to="/assets/activity" className="p-btn p-btn-ghost p-btn-sm">All asset activity</Link>}
      flush
    >
      {transfers.error !== null && transfers.data === undefined ? (
        <div style={{ padding: 24 }}>
          <Notice tone="danger" title="Couldn't load transfers" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void transfers.reload()}>Retry</button>}>
            {transfers.error}
          </Notice>
        </div>
      ) : transfers.data === undefined ? (
        <div style={{ padding: 24 }}><Skeleton height={60} /></div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 24 }}>
          <Empty title="No transfers yet">Sends of this asset appear here. Receives from other wallets aren&apos;t listed by the bridge yet.</Empty>
        </div>
      ) : (
        <div className="p-table-wrap">
          <table className="p-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Anchor transaction</th>
                <th>Status</th>
                <th className="p-num">Broadcast near block</th>
                <th className="p-num">Outputs (this asset)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.txid}>
                  <td>{relativeTime(t.at)}</td>
                  <td><IdCopy value={t.txid} what="transaction ID" head={12} tail={8} /></td>
                  <td><TransferStatus txid={t.txid} outputs={outputs} /></td>
                  <td className="p-num">{t.anchorTxHeight > 0 ? t.anchorTxHeight.toLocaleString('en-US') : '—'}</td>
                  <td className="p-num">
                    {t.outputs.filter((o) => o.assetIdHex === assetIdHex).map((o, i) => (
                      <div key={i}><Units value={o.amount} /></div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}


function Proofs({ summary, first }: { summary: AssetSummary; first: AssetView | undefined }) {
  return (
    <div className="p-grid">
      <div className="p-span-7">
        <Panel title="Proof anchors" note="What this asset's provenance proofs commit to.">
          <Facts>
            <Fact label="Genesis point" help="Issuance spent this outpoint; every proof chain starts here.">
              {first ? <IdCopy value={first.genesisPoint} what="genesis point" head={14} tail={8} /> : '—'}
            </Fact>
            <Fact label="Metadata hash" help="Hash of the issuance metadata. The metadata itself isn't exposed by the bridge.">
              {first ? <IdCopy value={first.metaHashHex} what="metadata hash" head={14} tail={8} /> : '—'}
            </Fact>
            {summary.outputs.map((o, i) => (
              <Fact key={o.anchorOutpoint} label={`Output ${i + 1} anchor`} help={o.anchorBlockHeight > 0 ? `Confirmed in block ${o.anchorBlockHeight.toLocaleString('en-US')}` : 'Not yet confirmed'}>
                <IdCopy value={o.anchorOutpoint} what="anchor outpoint" head={14} tail={8} />
              </Fact>
            ))}
          </Facts>
        </Panel>
      </div>
      <div className="p-span-5">
        <Panel title="Proofs and backups">
          <div className="ac-prose">
            <p>
              Every asset output is backed by a <strong>proof file</strong>: the chain of Bitcoin transactions from issuance to the output you hold. tapd keeps
              proofs in its own database and checks them on receipt.
            </p>
            <p>
              <strong>Your seed alone can&apos;t restore assets.</strong> It recovers the keys, but not the proofs. Back up tapd&apos;s data directory, or make
              sure a universe server you trust holds the proofs.
            </p>
            <p>Exporting or verifying a proof file isn&apos;t available in this build (no ExportProof or VerifyProof route).</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ——— mint ———

function MintView() {
  const { api, services, toast, bumpRefresh } = usePlatform();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [grouped, setGrouped] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ batchKeyHex: string; state: string; txid: string } | null>(null);
  const network = services.data?.network ?? '';

  const units = amount.replace(/[,_\s]/g, '');
  const nameError = name.trim() === '' ? null : name.trim().length > 64 ? 'Use at most 64 characters.' : null;
  const amountError = units === '' ? null : UNITS.test(units) ? null : 'Enter a whole number of units, from 1 to 19 digits.';
  const canReview = name.trim() !== '' && nameError === null && UNITS.test(units);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.mintAsset({ name: name.trim(), amount: units, description: description.trim() || undefined, grouped });
      setResult(r);
      setStep(2);
      toast({ title: 'Asset minted', body: `${name.trim()}: batch broadcast, waiting for confirmation`, tone: 'positive' });
      bumpRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link to="/assets" className="p-btn p-btn-ghost p-btn-sm">
          <Icon name="collapse" />
          All assets
        </Link>
      </div>
      <PageHeader title="Mint asset" sub="Advanced. Issue a new Taproot asset from this node. Most people only ever receive assets." />
      <div className="ac-flow">
        <Panel>
          <Steps steps={['Details', 'Review', 'Minted']} current={step} />
          <div className="p-stack" style={{ marginTop: 20 }}>
            {step === 0 ? (
              <>
                <Field label="Asset name" hint="Public and permanent. 1 to 64 characters." error={nameError}>
                  {(id) => <input id={id} className="p-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}
                </Field>
                <Field label="Supply" hint="Total units to issue, as a whole number." error={amountError}>
                  {(id) => (
                    <div className="p-input-affix">
                      <input id={id} className="p-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
                      <span>units</span>
                    </div>
                  )}
                </Field>
                <Field label="Description" hint="Optional. Stored in the issuance metadata, which is public and permanent.">
                  {(id) => <textarea id={id} className="p-textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
                </Field>
                <label className="p-check">
                  <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
                  <span>
                    Allow issuing more later
                    <span className="ac-cell-note">Creates a group key so future batches can add supply. Leave off for a fixed supply.</span>
                  </span>
                </label>
                <div>
                  <button type="button" className="p-btn p-btn-primary" disabled={!canReview} onClick={() => setStep(1)}>
                    Review mint
                  </button>
                </div>
              </>
            ) : null}
            {step === 1 ? (
              <>
                <Facts>
                  <Fact label="Name">{name.trim()}</Fact>
                  <Fact label="Supply"><Units value={units} /></Fact>
                  <Fact label="Type">Normal (fungible)</Fact>
                  <Fact label="Future issuance">{grouped ? 'Allowed (grouped asset)' : 'Not allowed (fixed supply)'}</Fact>
                  <Fact label="Description">{description.trim() || <span className="p-faint">None</span>}</Fact>
                  <Fact label="Network">{network || '—'}</Fact>
                  <Fact label="On-chain fee" help="tapd funds the batch transaction from the on-chain wallet and chooses the fee rate. The bridge has no fee quote for minting yet.">
                    Paid in sats, chosen by tapd
                  </Fact>
                </Facts>
                <Notice tone="danger" title="Issuance is permanent">
                  Minting broadcasts a Bitcoin transaction that pays a fee from your on-chain wallet. The name, supply and metadata are committed on-chain and
                  can&apos;t be changed or undone.
                  {network !== 'mainnet' ? ` This node is on ${network || 'a test network'}, so this is a test asset with no value.` : ''}
                </Notice>
                <label className="p-check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>I understand this creates an on-chain transaction, costs a fee, and can&apos;t be reversed.</span>
                </label>
                {error ? <Notice tone="danger" title="Minting failed">{error}</Notice> : null}
                <div className="p-row">
                  <button type="button" className="p-btn p-btn-ghost" disabled={busy} onClick={() => setStep(0)}>
                    Back
                  </button>
                  <button type="button" className="p-btn p-btn-primary" disabled={!ack || busy} onClick={() => void mint()}>
                    {busy ? 'Minting…' : 'Mint asset'}
                  </button>
                  {!ack ? <span className="ac-reason">Confirm the statement above to continue.</span> : null}
                </div>
              </>
            ) : null}
            {step === 2 && result ? (
              <>
                <Notice tone="positive" title="Asset minted">
                  The batch is {sentence(result.state).toLowerCase()}. Wait for the batch transaction to confirm before the asset can be sent; on regtest that
                  means the next mined block.
                </Notice>
                <Facts>
                  <Fact label="Batch state">{sentence(result.state)}</Fact>
                  <Fact label="Batch key"><IdCopy value={result.batchKeyHex} what="batch key" head={14} tail={8} /></Fact>
                  <Fact label="Batch transaction">{result.txid ? <IdCopy value={result.txid} what="transaction ID" head={14} tail={8} /> : <span className="p-faint">Not reported yet</span>}</Fact>
                </Facts>
                <div className="p-row">
                  <Link to="/assets" className="p-btn p-btn-primary">Back to assets</Link>
                </div>
              </>
            ) : null}
          </div>
        </Panel>
        <div className="p-stack">
          <Panel title="Before you mint">
            <ul className="ac-points">
              <li><strong>On-chain transaction:</strong> issuance anchors in a Bitcoin transaction and costs a miner fee.</li>
              <li><strong>Irreversible:</strong> name, supply and metadata are permanent.</li>
              <li><strong>Unverified by default:</strong> wallets can&apos;t tell who issued an asset, so a name proves nothing.</li>
              <li><strong>Back up proofs:</strong> tapd&apos;s data directory holds the issuance proofs; the seed alone won&apos;t restore them.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
