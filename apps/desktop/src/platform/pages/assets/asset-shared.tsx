/**
 * Shared by the Taproot Assets and Asset activity pages: grouping tapd's
 * outputs per asset, loading transfers, and deciding a transfer's status
 * from data tapd actually reports.
 */
import type { AssetsView, AssetView } from '../../api.js';
import { usePlatform, usePoll } from '../../context.js';
import { Badge } from '../../ui.js';

export interface AssetSummary {
  readonly assetIdHex: string;
  readonly name: string;
  readonly type: string;
  readonly balance: string;
  readonly outputs: readonly AssetView[];
}

/** One row per asset id: tapd's balance plus every output it holds. */
export function summarize(view: AssetsView): AssetSummary[] {
  const ids = new Map<string, AssetSummary>();
  for (const b of view.balances) {
    ids.set(b.assetIdHex, { assetIdHex: b.assetIdHex, name: b.name, type: b.type, balance: b.balance, outputs: view.assets.filter((a) => a.assetIdHex === b.assetIdHex) });
  }
  for (const a of view.assets) {
    if (!ids.has(a.assetIdHex)) {
      ids.set(a.assetIdHex, { assetIdHex: a.assetIdHex, name: a.name, type: a.type, balance: '', outputs: view.assets.filter((x) => x.assetIdHex === a.assetIdHex) });
    }
  }
  return [...ids.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** Asset id → name, from everything tapd currently reports. */
export function assetNames(view: AssetsView | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of view?.balances ?? []) m.set(b.assetIdHex, b.name);
  for (const a of view?.assets ?? []) if (!m.has(a.assetIdHex)) m.set(a.assetIdHex, a.name);
  return m;
}

/** Anchor txids arrive in display byte order (the bridge reverses tapd's raw hash). */
export function displayTxid(raw: string): string {
  return raw;
}

export type RawTransfer = Awaited<ReturnType<ReturnType<typeof usePlatform>['api']['assetTransfers']>>[number];
export type Transfer = RawTransfer;

export function useAssets() {
  const { api, refreshKey } = usePlatform();
  return usePoll(() => api.assets(), 20_000, [api, refreshKey]);
}

/** Transfers, newest first, with the txid in standard display order. */
export function useTransfers() {
  const { api, refreshKey } = usePlatform();
  return usePoll(
    async () => (await api.assetTransfers()).map((t) => ({ ...t, txid: displayTxid(t.txid) })).sort((a, b) => b.at - a.at),
    20_000,
    [api, refreshKey],
  );
}

/** Transfers none of whose outputs are among tapd's current (confirmed, unspent) outputs, for assets tapd doesn't list. */
export function unlistedTransfers(view: AssetsView | undefined, transfers: readonly Transfer[] | undefined): Transfer[] {
  if (view === undefined || transfers === undefined) return [];
  const anchored = new Set(view.assets.map((a) => a.anchorOutpoint.split(':')[0]));
  const held = new Set(view.balances.map((b) => b.assetIdHex));
  return transfers.filter((t) => !anchored.has(t.txid) && t.outputs.some((o) => !held.has(o.assetIdHex)));
}

/** Confirmed when one of tapd's current outputs is anchored in this transaction (txid in display order). */
export function anchoredOutput(txid: string, outputs: readonly AssetView[]): AssetView | undefined {
  return outputs.find((o) => o.anchorOutpoint.startsWith(`${txid}:`) && o.anchorBlockHeight > 0);
}

export function TransferStatus({ txid, outputs }: { txid: string; outputs: readonly AssetView[] }) {
  const anchored = anchoredOutput(txid, outputs);
  if (anchored) return <Badge tone="positive">Confirmed · block {anchored.anchorBlockHeight.toLocaleString('en-US')}</Badge>;
  return (
    <span title="None of this transfer's outputs are among tapd's current outputs: it is awaiting confirmation, or its outputs have since been spent.">
      <Badge tone="neutral">Pending or spent</Badge>
    </span>
  );
}
