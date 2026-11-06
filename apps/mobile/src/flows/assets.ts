/**
 * Taproot Assets on mobile (remote node only) — port extension types, pure
 * validation, trust classification and the remote-node asset store.
 *
 * Trust rule (from `@sovereign/wallet-core` assets): this build has NO issuer
 * verification source, so every asset is "issuer unverified". A name that
 * claims a stablecoin (USDT, USDC…) gets the impersonation warning; nothing
 * here ever presents an asset as trusted or redeemable.
 *
 * Wavelength wallets hold no Taproot Assets (declared `assets: 'none'`).
 */

import { classifyAsset, parseAssetId } from '@sovereign/wallet-core';
import type { AssetDisplayInfo } from '@sovereign/wallet-core';
import type { LoadStatus } from './transfers.js';

export interface RemoteAsset {
  /** 32-byte asset id, hex. */
  readonly assetIdHex: string;
  /** Genesis name — chosen by whoever minted it; proves nothing about the issuer. */
  readonly name: string;
  readonly type: 'normal' | 'collectible';
  /** Units held (tapd ListBalances). */
  readonly balance: bigint;
  /** Decimal places the issuer declared for display; null when none. */
  readonly decimalDisplay: number | null;
  readonly groupKeyHex: string | null;
  readonly metaHashHex: string | null;
  /** `txid:vout` of the genesis outpoint, when the node reports it. */
  readonly genesisPoint: string | null;
}

export interface RemoteAssetTransfer {
  /** Anchor transaction id (display byte order). */
  readonly txid: string;
  readonly direction: 'out' | 'in';
  readonly assetIdHex: string;
  /** Units moved to / from the other party (change excluded). */
  readonly amount: bigint;
  readonly status: 'unconfirmed' | 'confirmed';
  readonly blockHeight: number | null;
  /** On-chain fee your node paid for the anchor, when tapd reports it. */
  readonly chainFeeSat: bigint | null;
  /** ISO-8601 UTC. */
  readonly at: string;
}

export interface DecodedAssetAddress {
  readonly assetIdHex: string;
  readonly amount: bigint;
  readonly network: string;
}

/**
 * Optional Taproot Assets methods on the LNC port. litd exposes tapd over the
 * same session when its macaroon allows it; the lnc-rn adapter maps these to
 * `tapd.taprootAssets.*` (ListAssets/ListBalances, ListTransfers + AddrReceives,
 * NewAddr, DecodeAddr, SendAsset).
 */
export interface AssetsPortExtension {
  listAssets?(): Promise<readonly RemoteAsset[]>;
  assetTransfers?(): Promise<readonly RemoteAssetTransfer[]>;
  newAssetAddress?(request: { readonly assetIdHex: string; readonly amount: bigint }): Promise<{ readonly address: string }>;
  decodeAssetAddress?(address: string): Promise<DecodedAssetAddress>;
  sendAsset?(request: { readonly address: string }): Promise<{
    readonly txid: string;
    readonly chainFeeSat: bigint | null;
  }>;
}

export function assetsSurface(port: AssetsPortExtension): {
  readonly list: boolean;
  readonly history: boolean;
  readonly receive: boolean;
  readonly send: boolean;
} {
  const has = (f: unknown): boolean => typeof f === 'function';
  return {
    list: has(port.listAssets),
    history: has(port.assetTransfers),
    receive: has(port.newAssetAddress),
    send: has(port.decodeAssetAddress) && has(port.sendAsset),
  };
}

// ——— trust ———

/** Display trust for an asset. No verification source exists in this build. */
export function assetTrust(asset: Pick<RemoteAsset, 'assetIdHex' | 'name' | 'groupKeyHex' | 'metaHashHex'>): AssetDisplayInfo {
  return classifyAsset(
    {
      assetId: asset.assetIdHex,
      ...(asset.groupKeyHex === null ? {} : { groupKeyHex: asset.groupKeyHex }),
      ...(asset.metaHashHex === null ? {} : { metaHashHex: asset.metaHashHex }),
      // The genesis name, treated as an issuer claim (which is all it is).
      meta: { rawHex: '', metaType: 'opaque', json: { name: asset.name } },
      metaHashAnchored: false,
    },
    { trustedIssuers: new Set<string>() },
  ).display;
}

export const UNVERIFIED_EXPLANATION =
  "Anyone can mint a Taproot Asset with any name, including the name of a real currency. This app has no issuer verification source, so every asset shows as issuer unverified. Confirm the asset ID with its issuer through a channel you trust; the name alone proves nothing, and nothing here makes an asset redeemable.";

export const STABLECOIN_WARNING =
  'This asset uses the name of a well-known stablecoin, but its issuer is unverified. It may be an imitation with no value. Do not treat it as dollars or as redeemable.';

// ——— amounts ———

/** Units with the issuer's declared decimal display (display only; amounts stay integer units). */
export function formatAssetUnits(units: bigint, decimalDisplay: number | null): string {
  const group = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decimalDisplay === null || decimalDisplay <= 0) return group(units.toString());
  const scale = 10n ** BigInt(decimalDisplay);
  const whole = units / scale;
  const frac = (units % scale).toString().padStart(decimalDisplay, '0').replace(/0+$/, '');
  return frac === '' ? group(whole.toString()) : `${group(whole.toString())}.${frac}`;
}

/** Whole units from input; null when invalid or zero. */
export function parseAssetUnits(text: string): bigint | null {
  const parsed = parseAssetAmount(text, null);
  return parsed.ok ? parsed.units : null;
}

/**
 * An amount typed in the asset's display units (its declared
 * `decimalDisplay`), converted exactly — string arithmetic, no floats — to
 * the integer base units the node works in. "1.5" of a 2-decimal asset is
 * 150 units. A dot is the decimal mark; commas only group thousands in the
 * whole part ("1,000.25"). More decimals than the asset has is refused.
 */
export function parseAssetAmount(
  text: string,
  decimalDisplay: number | null,
): { readonly ok: true; readonly units: bigint } | { readonly ok: false; readonly error: string } {
  const decimals = decimalDisplay === null || decimalDisplay <= 0 ? 0 : decimalDisplay;
  const compact = text.replace(/[\s_]/g, '');
  if (compact === '') return { ok: false, error: 'Enter an amount.' };
  const dot = compact.indexOf('.');
  const wholeRaw = dot === -1 ? compact : compact.slice(0, dot);
  const fracRaw = dot === -1 ? '' : compact.slice(dot + 1);
  if (fracRaw.includes(',') || (wholeRaw.includes(',') && !/^[1-9]\d{0,2}(?:,\d{3})+$/.test(wholeRaw))) {
    return { ok: false, error: 'Use a dot for decimals, like 1.5. Commas can only separate thousands, like 1,000.' };
  }
  const whole = wholeRaw.replace(/,/g, '');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fracRaw) || (whole === '' && fracRaw === '')) {
    return { ok: false, error: decimals === 0 ? 'Enter a whole number.' : `Enter a number with up to ${decimals} decimals.` };
  }
  if (fracRaw.length > decimals) {
    return {
      ok: false,
      error: decimals === 0 ? 'This asset has no decimals; enter a whole number.' : `This asset has at most ${decimals} decimals.`,
    };
  }
  const units = BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(decimals) + BigInt(fracRaw.padEnd(decimals, '0') || '0');
  if (units <= 0n) return { ok: false, error: 'Enter an amount above zero.' };
  return { ok: true, units };
}

// ——— addresses ———

/** tapd address HRPs per network (tapbc / taptb / taprt). */
export const ASSET_ADDRESS_PREFIX: Readonly<Record<string, string>> = {
  mainnet: 'tapbc1',
  testnet: 'taptb1',
  signet: 'taptb1',
  regtest: 'taprt1',
};

/** Format check before asking the node to decode. Null when it may be an address for this network. */
export function assetAddressFormatError(text: string, network: string): string | null {
  const a = text.trim().toLowerCase();
  if (a === '') return 'Paste a Taproot Assets address.';
  const prefix = ASSET_ADDRESS_PREFIX[network];
  if (prefix === undefined) return `Taproot Assets addresses for ${network} are not supported.`;
  if (!a.startsWith('tap')) return "That isn't a Taproot Assets address (they start with tap…).";
  if (!a.startsWith(prefix)) return `That address is for another network. On ${network} they start with ${prefix}.`;
  return null;
}

/**
 * After the node decoded the address: it must ask for THIS asset, a positive
 * amount, and no more than the balance. Null when the send can be reviewed.
 */
export function decodedSendError(
  decoded: DecodedAssetAddress,
  asset: Pick<RemoteAsset, 'assetIdHex' | 'name' | 'balance' | 'decimalDisplay'>,
): string | null {
  let id: string;
  try {
    id = parseAssetId(decoded.assetIdHex);
  } catch {
    return 'Your node decoded an asset ID this app cannot read. Nothing was sent.';
  }
  if (id !== asset.assetIdHex.toLowerCase()) {
    return `This address asks for a different asset (ID ${id.slice(0, 8)}…). Open that asset to pay it.`;
  }
  if (decoded.amount <= 0n) return 'This address does not ask for an amount.';
  if (decoded.amount > asset.balance) {
    return `This address asks for ${formatAssetUnits(decoded.amount, asset.decimalDisplay)} units, more than the ${formatAssetUnits(asset.balance, asset.decimalDisplay)} you hold.`;
  }
  return null;
}

// ——— remote-node asset store ———

export interface AssetSendDraft {
  readonly assetIdHex: string;
  readonly addressText: string;
  readonly stage: 'edit' | 'decoding' | 'review' | 'sending' | 'sent';
  readonly decoded: DecodedAssetAddress | null;
  readonly error: string | null;
  readonly result: { readonly txid: string; readonly chainFeeSat: bigint | null } | null;
}

export interface AssetReceiveDraft {
  readonly assetIdHex: string;
  /** Typed in display units (the asset's `decimalDisplay`). */
  readonly amountText: string;
  readonly address: string | null;
  /** Base units the address asks for (set with `address`). */
  readonly addressUnits?: bigint | null;
  readonly busy: boolean;
  readonly error: string | null;
}

export interface RemoteAssetsState {
  readonly assets: readonly RemoteAsset[] | null;
  readonly assetsStatus: LoadStatus;
  readonly assetsError: string | null;
  readonly transfers: readonly RemoteAssetTransfer[] | null;
  readonly transfersStatus: LoadStatus;
  readonly transfersError: string | null;
  readonly send: AssetSendDraft | null;
  readonly receive: AssetReceiveDraft | null;
}

const INITIAL: RemoteAssetsState = {
  assets: null,
  assetsStatus: 'idle',
  assetsError: null,
  transfers: null,
  transfersStatus: 'idle',
  transfersError: null,
  send: null,
  receive: null,
};

export interface RemoteAssetStoreOptions {
  readonly port: AssetsPortExtension;
  readonly network: string;
  readonly isForegrounded: () => boolean;
  /** Device authorization hook (app lock / biometrics) — see transfers.ts. */
  readonly authorize?: (request: { readonly reason: string }) => Promise<boolean>;
}

export class RemoteAssetStore {
  private state: RemoteAssetsState = INITIAL;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: RemoteAssetStoreOptions) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): RemoteAssetsState => this.state;

  surface(): ReturnType<typeof assetsSurface> {
    return assetsSurface(this.options.port);
  }

  hasDeviceAuthorization(): boolean {
    return this.options.authorize !== undefined;
  }

  asset(assetIdHex: string): RemoteAsset | null {
    return this.state.assets?.find((a) => a.assetIdHex === assetIdHex) ?? null;
  }

  async load(): Promise<void> {
    const { port } = this.options;
    const list = port.listAssets;
    if (list === undefined) {
      this.set({ assetsStatus: 'unavailable' });
    } else {
      if (this.state.assets === null) this.set({ assetsStatus: 'loading', assetsError: null });
      try {
        const assets = [...(await list.call(port))].sort((a, b) => a.name.localeCompare(b.name));
        this.set({ assets, assetsStatus: 'loaded', assetsError: null });
      } catch (error) {
        this.set({ assetsStatus: 'failed', assetsError: describe(error) });
      }
    }
    const transfers = port.assetTransfers;
    if (transfers === undefined) {
      this.set({ transfersStatus: 'unavailable' });
      return;
    }
    try {
      const list2 = [...(await transfers.call(port))].sort((a, b) => b.at.localeCompare(a.at));
      this.set({ transfers: list2, transfersStatus: 'loaded', transfersError: null });
    } catch (error) {
      this.set({ transfersStatus: 'failed', transfersError: describe(error) });
    }
  }

  transfersFor(assetIdHex: string): readonly RemoteAssetTransfer[] {
    return (this.state.transfers ?? []).filter((t) => t.assetIdHex === assetIdHex);
  }

  // ——— receive ———

  beginReceive(assetIdHex: string): void {
    this.set({ receive: { assetIdHex, amountText: '', address: null, busy: false, error: null } });
  }

  editReceiveAmount(text: string): void {
    const r = this.state.receive;
    if (r === null) return;
    this.set({ receive: { ...r, amountText: text, address: null, addressUnits: null, error: null } });
  }

  async createReceiveAddress(): Promise<void> {
    const r = this.state.receive;
    const create = this.options.port.newAssetAddress;
    if (r === null) return;
    if (create === undefined) {
      this.set({ receive: { ...r, error: "Creating asset addresses isn't available over this connection." } });
      return;
    }
    const asset = this.asset(r.assetIdHex);
    if (asset === null) {
      this.set({ receive: { ...r, error: "This asset isn't in your node's list, so its units can't be read." } });
      return;
    }
    const parsed = parseAssetAmount(r.amountText, asset.decimalDisplay);
    if (!parsed.ok) {
      this.set({ receive: { ...r, error: `${parsed.error} A Taproot Assets address always asks for a fixed amount.` } });
      return;
    }
    const amount = parsed.units;
    this.set({ receive: { ...r, busy: true, error: null } });
    try {
      const { address } = await create.call(this.options.port, { assetIdHex: r.assetIdHex, amount });
      this.set({ receive: { ...r, busy: false, address, addressUnits: amount } });
    } catch (error) {
      this.set({ receive: { ...r, busy: false, error: describe(error) } });
    }
  }

  // ——— send ———

  beginSend(assetIdHex: string): void {
    this.set({
      send: { assetIdHex, addressText: '', stage: 'edit', decoded: null, error: null, result: null },
    });
  }

  editSendAddress(text: string): void {
    const s = this.state.send;
    if (s === null) return;
    this.set({ send: { ...s, addressText: text, stage: 'edit', decoded: null, error: null } });
  }

  backToEditSend(): void {
    const s = this.state.send;
    if (s === null) return;
    this.set({ send: { ...s, stage: 'edit', error: null } });
  }

  /** Format check → the node decodes → asset/amount/balance check → review. */
  async reviewSend(): Promise<void> {
    const s = this.state.send;
    const decode = this.options.port.decodeAssetAddress;
    if (s === null) return;
    const asset = this.asset(s.assetIdHex);
    if (asset === null) {
      this.patchSend({ error: 'This asset is no longer listed by your node.' });
      return;
    }
    if (decode === undefined) {
      this.patchSend({ error: "Decoding asset addresses isn't available over this connection." });
      return;
    }
    const formatError = assetAddressFormatError(s.addressText, this.options.network);
    if (formatError !== null) {
      this.patchSend({ error: formatError });
      return;
    }
    this.patchSend({ stage: 'decoding', error: null });
    try {
      const decoded = await decode.call(this.options.port, s.addressText.trim());
      const error = decodedSendError(decoded, asset);
      if (error !== null) {
        this.patchSend({ stage: 'edit', error });
        return;
      }
      this.patchSend({ stage: 'review', decoded });
    } catch (error) {
      this.patchSend({
        stage: 'edit',
        error: `Your node could not decode that address: ${describe(error)}`,
      });
    }
  }

  async confirmSend(): Promise<boolean> {
    const s = this.state.send;
    const send = this.options.port.sendAsset;
    if (s === null || s.stage !== 'review' || s.decoded === null) return false;
    if (send === undefined) {
      this.patchSend({ error: "Sending assets isn't available over this connection." });
      return false;
    }
    if (!this.options.isForegrounded()) {
      this.patchSend({ error: 'Sends start only while the app is open. Reopen the app and try again.' });
      return false;
    }
    this.patchSend({ stage: 'sending', error: null });
    try {
      if (this.options.authorize !== undefined) {
        const approved = await this.options.authorize({ reason: 'Approve this asset send' });
        if (!approved) {
          this.patchSend({ stage: 'review', error: 'Device authorization was not given, so nothing was sent.' });
          return false;
        }
      }
      const result = await send.call(this.options.port, { address: s.addressText.trim() });
      this.patchSend({ stage: 'sent', result });
      void this.load();
      return true;
    } catch (error) {
      this.patchSend({ stage: 'review', error: `The send failed: ${describe(error)}` });
      return false;
    }
  }

  private patchSend(partial: Partial<AssetSendDraft>): void {
    if (this.state.send === null) return;
    this.set({ send: { ...this.state.send, ...partial } });
  }

  private set(partial: Partial<RemoteAssetsState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
