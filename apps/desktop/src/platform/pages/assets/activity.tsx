/**
 * Asset activity — every Taproot Assets transfer tapd recorded
 * (GET /assets/transfers), with asset names from GET /assets.
 * tapd's transfer log holds this node's sends (including sends to its own
 * addresses); receives from other wallets are not part of it.
 */
import { useMemo, useState } from 'react';
import { useService } from '../../context.js';
import { Link } from '../../router.js';
import { Badge, Empty, Field, Icon, Notice, PageHeader, Panel, Sheet, Skeleton, relativeTime, shortId } from '../../ui.js';
import { Fact, Facts, IdCopy, Units } from '../account/components.js';
import { anchoredOutput, assetNames, TransferStatus, useAssets, useTransfers, type Transfer } from './asset-shared.js';

export default function AssetActivityPage() {
  const svc = useService('taproot-assets');
  const assets = useAssets();
  const transfers = useTransfers();
  const [query, setQuery] = useState('');
  const [asset, setAsset] = useState('all');
  const [open, setOpen] = useState<Transfer | null>(null);

  const names = useMemo(() => assetNames(assets.data), [assets.data]);
  const outputs = assets.data?.assets ?? [];
  const all = transfers.data ?? [];
  const assetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of transfers.data ?? []) for (const o of t.outputs) ids.add(o.assetIdHex);
    return [...ids].sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
  }, [transfers.data, names]);

  const q = query.trim().toLowerCase();
  const rows = all.filter((t) => {
    if (asset !== 'all' && !t.outputs.some((o) => o.assetIdHex === asset)) return false;
    if (q === '') return true;
    return (
      t.txid.includes(q) ||
      t.outputs.some((o) => o.assetIdHex.includes(q) || (names.get(o.assetIdHex) ?? '').toLowerCase().includes(q) || o.amount === q.replace(/[,_\s]/g, ''))
    );
  });

  return (
    <>
      <PageHeader
        title="Asset activity"
        sub="Taproot Assets transfers recorded by this node's tapd. Each transfer is anchored in one Bitcoin transaction."
        actions={
          <button type="button" className="p-btn p-btn-ghost" onClick={() => void transfers.reload()}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <div className="p-stack">
        {svc.running === false ? (
          <Notice tone="danger" title="Taproot Assets is not running">
            litd reports tapd as stopped{svc.error ? `: ${svc.error}` : ''}. Restart the node to bring it back.
          </Notice>
        ) : null}
        {transfers.error !== null && transfers.data === undefined ? (
          <Notice tone="danger" title="Couldn't load asset transfers" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void transfers.reload()}>Retry</button>}>
            {transfers.error}
          </Notice>
        ) : null}

        <Panel flush>
          <div className="p-row" style={{ padding: '16px 24px', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 320px' }}>
              <Field label="Search">
                {(id) => (
                  <input
                    id={id}
                    className="p-input"
                    type="search"
                    placeholder="Transaction ID, asset name, asset ID or amount"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <div style={{ flex: '0 1 260px' }}>
              <Field label="Asset">
                {(id) => (
                  <select id={id} className="p-select" value={asset} onChange={(e) => setAsset(e.target.value)}>
                    <option value="all">All assets</option>
                    {assetIds.map((a) => (
                      <option key={a} value={a}>
                        {names.get(a) ?? shortId(a, 8, 6)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <div className="p-muted" style={{ fontSize: 13, paddingBottom: 8 }}>
              {transfers.data ? `${rows.length} of ${all.length} ${all.length === 1 ? 'transfer' : 'transfers'}` : ''}
            </div>
          </div>
          {transfers.data === undefined ? (
            <div style={{ padding: 24 }} className="p-stack">
              <Skeleton height={20} />
              <Skeleton height={20} />
            </div>
          ) : all.length === 0 ? (
            <div style={{ padding: 24 }}>
              <Empty title="No asset transfers yet" action={<Link to="/assets" className="p-btn">Go to Taproot Assets</Link>}>
                Sends of any asset, including to this node&apos;s own addresses, appear here.
              </Empty>
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24 }}>
              <Empty title="No transfers match">Try a different search or asset.</Empty>
            </div>
          ) : (
            <div className="p-table-wrap">
              <table className="p-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Assets</th>
                    <th>Anchor transaction</th>
                    <th>Status</th>
                    <th className="p-num">Output amounts</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => {
                    const ids = [...new Set(t.outputs.map((o) => o.assetIdHex))];
                    return (
                      <tr
                        key={t.txid}
                        data-clickable="true"
                        tabIndex={0}
                        onClick={() => setOpen(t)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setOpen(t);
                          }
                        }}
                        aria-label={`Transfer ${shortId(t.txid)}`}
                      >
                        <td>
                          {relativeTime(t.at)}
                          <span className="ac-cell-note">{new Date(t.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                        </td>
                        <td>{ids.map((id) => names.get(id) ?? shortId(id, 8, 6)).join(', ')}</td>
                        <td>
                          <span className="p-mono" title={t.txid}>{shortId(t.txid, 10, 8)}</span>
                        </td>
                        <td><TransferStatus txid={t.txid} outputs={outputs} /></td>
                        <td className="p-num">
                          {t.outputs.map((o, i) => (
                            <span key={i}>
                              {i > 0 ? <span className="p-faint"> · </span> : null}
                              <Units value={o.amount} unit={i === t.outputs.length - 1 ? 'units' : ''} />
                            </span>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <p className="p-hint" style={{ margin: 0 }}>
          Output amounts include change returning to this node; the bridge doesn&apos;t mark which output is which. Receives from other wallets aren&apos;t in tapd&apos;s
          transfer log and aren&apos;t exposed by the bridge yet.
        </p>
      </div>

      {open ? (
        <Sheet title="Asset transfer" onClose={() => setOpen(null)}>
          <div className="p-stack">
            <Facts>
              <Fact label="Anchor transaction" help="The Bitcoin transaction that commits to this transfer.">
                <IdCopy value={open.txid} what="transaction ID" head={12} tail={8} />
              </Fact>
              <Fact label="When">{new Date(open.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' })}</Fact>
              <Fact label="Status">
                <TransferStatus txid={open.txid} outputs={outputs} />
              </Fact>
              <Fact label="Broadcast near block" help="tapd's height hint when the transaction was published, not its confirmation height.">
                {open.anchorTxHeight > 0 ? open.anchorTxHeight.toLocaleString('en-US') : '—'}
              </Fact>
              <Fact label="Asset inputs">{open.inputs}</Fact>
            </Facts>
            <Panel title="Outputs" flush>
              <div className="p-table-wrap">
                <table className="p-table">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Held now</th>
                      <th className="p-num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.outputs.map((o, i) => {
                      const held = (assets.data?.assets ?? []).some((a) => a.assetIdHex === o.assetIdHex && a.amount === o.amount && a.anchorOutpoint.startsWith(`${open.txid}:`));
                      return (
                        <tr key={i}>
                          <td>
                            <Link to={`/assets/${o.assetIdHex}`} onClick={() => setOpen(null)} style={{ color: 'inherit' }}>
                              {names.get(o.assetIdHex) ?? 'Unknown asset'}
                            </Link>
                            <span className="ac-cell-note p-mono">{shortId(o.assetIdHex, 8, 6)}</span>
                          </td>
                          <td>{held ? <Badge tone="positive">By this node</Badge> : <span className="p-faint">Not among current outputs</span>}</td>
                          <td className="p-num"><Units value={o.amount} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
            {anchoredOutput(open.txid, outputs) === undefined ? (
              <Notice tone="info" title="Not confirmed, or already spent">
                None of this transfer&apos;s outputs are among tapd&apos;s current outputs. tapd lists outputs only once the anchor transaction confirms; if it has
                confirmed, the outputs have since been spent or belong to another wallet.
              </Notice>
            ) : null}
            <p className="p-hint" style={{ margin: 0 }}>
              The bridge doesn&apos;t say which output is the recipient and which is change, so outputs are listed as tapd
              recorded them.
            </p>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
