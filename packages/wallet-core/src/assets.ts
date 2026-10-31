/**
 * Taproot asset domain — validated asset identifiers and the asset registry
 * that separates verified metadata from unverified issuer claims.
 *
 * Pure and engine-agnostic: the tapd adapter feeds this layer, the UI renders
 * only what this layer returns. The trust rule lives here so no screen can
 * accidentally render an unverified asset as a trusted one.
 */

// ---------------------------------------------------------------------------
// Validated asset identifiers
// ---------------------------------------------------------------------------

/** Canonical (lowercase) hex of a 32-byte Taproot Asset ID. */
export type AssetIdHex = string;

/** Canonical hex of a 33-byte compressed group key (02/03 prefix). */
export type GroupKeyHex = string;

/** Canonical hex of a 33-byte compressed script key. */
export type ScriptKeyHex = string;

/** `[txid]:[output-index]` on-chain outpoint with a validated txid. */
export interface AssetOutpoint {
  readonly txid: string;
  readonly outputIndex: number;
}

export type AssetIdentifierErrorCode =
  | 'empty-input'
  | 'not-hex'
  | 'wrong-length'
  | 'not-compressed-pubkey'
  | 'bad-outpoint';

/** Typed so callers can branch on the reason — never string-match errors. */
export class AssetIdentifierError extends Error {
  readonly code: AssetIdentifierErrorCode;

  constructor(code: AssetIdentifierErrorCode, message: string) {
    super(message);
    this.name = 'AssetIdentifierError';
    this.code = code;
  }
}

const HEX = /^[0-9a-f]+$/;

function toCanonicalHex(input: string, byteLen: number, what: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new AssetIdentifierError('empty-input', `${what} is empty`);
  }
  if (!HEX.test(trimmed)) {
    throw new AssetIdentifierError('not-hex', `${what} is not hex`);
  }
  if (trimmed.length !== byteLen * 2) {
    throw new AssetIdentifierError(
      'wrong-length',
      `${what} must be ${byteLen * 2} hex chars (${byteLen} bytes), got ${trimmed.length}`,
    );
  }
  return trimmed;
}

function toCompressedPubKeyHex(input: string, what: string): string {
  const hex = toCanonicalHex(input, 33, what);
  if (!hex.startsWith('02') && !hex.startsWith('03')) {
    throw new AssetIdentifierError('not-compressed-pubkey', `${what} is not a 33-byte compressed pubkey (02/03 prefix)`);
  }
  return hex;
}

/**
 * Parses and validates a 32-byte asset ID. Asset IDs are the primary key of
 * every asset view — anything malformed must be refused before it can be
 * rendered, stored, or sent to tapd.
 */
export function parseAssetId(input: string): AssetIdHex {
  return toCanonicalHex(input, 32, 'asset id');
}

/** Parses and validates a 33-byte compressed asset group key. */
export function parseGroupKey(input: string): GroupKeyHex {
  return toCompressedPubKeyHex(input, 'group key');
}

/** Parses and validates a 33-byte compressed script key. */
export function parseScriptKey(input: string): ScriptKeyHex {
  return toCompressedPubKeyHex(input, 'script key');
}

/** Parses and validates an on-chain outpoint (`txid:index`). */
export function parseAssetOutpoint(input: string): AssetOutpoint {
  const separator = input.lastIndexOf(':');
  if (separator <= 0 || separator === input.length - 1) {
    throw new AssetIdentifierError('bad-outpoint', `outpoint must be txid:index, got "${input}"`);
  }
  const txid = input.slice(0, separator).trim().toLowerCase();
  const index = Number(input.slice(separator + 1));
  if (!HEX.test(txid) || txid.length !== 64) {
    throw new AssetIdentifierError('bad-outpoint', `outpoint txid must be 64 hex chars, got "${txid}"`);
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new AssetIdentifierError('bad-outpoint', `outpoint index must be a non-negative integer, got "${input.slice(separator + 1)}"`);
  }
  return { txid, outputIndex: index };
}

/**
 * Canonical display short form of an asset ID — first 8 hex chars. The FULL
 * id is the identifier; short forms are for humans only and never used as
 * keys by the registry.
 */
export function shortAssetId(assetId: AssetIdHex): string {
  return `${assetId.slice(0, 8)}…`;
}

// ---------------------------------------------------------------------------
// Asset registry — verified metadata vs unverified issuer claims
// ---------------------------------------------------------------------------

/**
 * Where an asset's displayed metadata comes from.
 *
 * - `issuer-verified`: the metadata is bound to the asset's on-chain genesis
 *   (meta hash anchored in the asset's own witness data) AND the issuer is
 *   on the user's trusted list. Both conditions — binding alone proves the
 *   data is issuer-written, not that the issuer is honest.
 * - `issuer-claimed`: everything else. Any name/ticker on such an asset is
 *   a CLAIM by an unknown party — including a scammer naming their asset
 *   "USDC".
 */
export type AssetMetadataTrust = 'issuer-verified' | 'issuer-claimed';

export interface AssetMetaClaim {
  /** Raw meta bytes as delivered (only inspected, never trusted). */
  readonly rawHex: string;
  readonly metaType: 'opaque' | 'json' | 'url';
  /** Decoded JSON claims when the meta parses as JSON, else undefined. */
  readonly json?: Readonly<{ name?: string; ticker?: string; [k: string]: unknown }>;
}

export interface AssetRegistryEntryInput {
  readonly assetId: AssetIdHex;
  /** Set when the asset belongs to a re-issuance group (grouped assets). */
  readonly groupKeyHex?: string;
  readonly metaHashHex?: string;
  /** Meta as claimed by the issuer / fetched from the daemon. */
  readonly meta?: AssetMetaClaim;
  /**
   * True when the meta hash of `meta` matches the meta hash anchored in the
   * asset's genesis (what tapd's FetchAssetMeta guarantees for issued
   * assets). Proves binding to the asset, NOT issuer honesty.
   */
  readonly metaHashAnchored?: boolean;
}

export interface AssetRegistryEntry {
  readonly assetId: AssetIdHex;
  readonly groupKeyHex?: string;
  readonly metaHashHex?: string;
  readonly meta?: AssetMetaClaim;
  readonly metaHashAnchored: boolean;
  readonly trust: AssetMetadataTrust;
}

/** Display data the UI is allowed to render — nothing else. */
export interface AssetDisplayInfo {
  readonly assetId: AssetIdHex;
  /**
   * What the UI prints. Unverified assets always carry the "(unverified
   * issuer)" suffix — the only path to a clean label is the trust allowlist.
   */
  readonly label: string;
  readonly trust: AssetMetadataTrust;
  /**
   * The UNVERIFIED asset claims a well-known stablecoin identity (name or
   * ticker match). The UI must render the scam warning; verified assets
   * never reach this path — a trusted issuer's USDC is just verified.
   */
  readonly stablecoinImpersonationRisk: boolean;
}

/** Well-known stablecoin identities used for the impersonation warning. */
export const DEFAULT_STABLECOIN_TICKERS: readonly string[] = Object.freeze([
  'usdt',
  'usdc',
  'dai',
  'busd',
  'fdusd',
  'tusd',
  'pyusd',
  'usde',
]);

const UNVERIFIED_SUFFIX = '(unverified issuer)';

function metaClaims(meta: AssetMetaClaim | undefined): { name?: string; ticker?: string } {
  return { name: meta?.json?.['name'], ticker: meta?.json?.['ticker'] };
}

function isStablecoinLike(entry: AssetRegistryEntryInput, tickers: ReadonlySet<string>): boolean {
  const { name, ticker } = metaClaims(entry.meta);
  const candidates = [name, ticker]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
  return candidates.some((v) => tickers.has(v));
}

/**
 * The single classifier for asset display trust. Rules, in order:
 *
 * 1. `issuer-verified` requires BOTH the meta hash being anchored in the
 *    asset's genesis AND the issuer being on the user's trust allowlist.
 * 2. Everything else is `issuer-claimed` — rendered with the unverified
 *    suffix, never as a trusted asset.
 * 3. Unverified assets claiming a well-known stablecoin identity are
 *    flagged `stablecoinImpersonationRisk` for the mandatory warning.
 */
export function classifyAsset(
  entry: AssetRegistryEntryInput,
  options: Readonly<{ trustedIssuers: ReadonlySet<string>; stablecoinTickers?: readonly string[] }>,
): AssetRegistryEntry & { display: AssetDisplayInfo } {
  const stableTickers = new Set((options.stablecoinTickers ?? DEFAULT_STABLECOIN_TICKERS).map((t) => t.toLowerCase()));
  const trusted =
    entry.metaHashAnchored === true &&
    (options.trustedIssuers.has(entry.assetId) || trustedGroup(entry, options.trustedIssuers));
  const trust: AssetMetadataTrust = trusted ? 'issuer-verified' : 'issuer-claimed';
  const { name } = metaClaims(entry.meta);
  const baseLabel = typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'Unknown asset';
  const label = trusted ? baseLabel : `${baseLabel} ${UNVERIFIED_SUFFIX}`;
  return {
    ...entry,
    metaHashAnchored: entry.metaHashAnchored === true,
    trust,
    display: {
      assetId: entry.assetId,
      label,
      trust,
      stablecoinImpersonationRisk: !trusted && isStablecoinLike(entry, stableTickers),
    },
  };
}

function trustedGroup(entry: AssetRegistryEntryInput, trustedIssuers: ReadonlySet<string>): boolean {
  // A group key listed as trusted vouches for every asset in that group
  // (group membership is enforced by tapd's witness validation, not by us).
  const groupKey = entry.groupKeyHex;
  return typeof groupKey === 'string' && groupKey.length > 0 && trustedIssuers.has(groupKey);
}

/**
 * The asset registry. Holds one entry per asset ID — balances, identities,
 * and histories are never merged across assets (the same boundary rule the
 * provider contract applies to wallets). Trust is user-curated: an entry
 * becomes verified ONLY via `trustIssuer` (or `trustGroup`).
 */
export class AssetRegistry {
  private readonly entries = new Map<AssetIdHex, AssetRegistryEntry & { display: AssetDisplayInfo }>();
  private readonly trustedIssuers = new Set<string>();

  constructor(options: Readonly<{ stablecoinTickers?: readonly string[]; pretrustedIssuers?: readonly string[] }> = {}) {
    for (const issuer of options.pretrustedIssuers ?? []) {
      this.trustedIssuers.add(issuer);
    }
    this.stablecoinTickers = options.stablecoinTickers ?? DEFAULT_STABLECOIN_TICKERS;
  }

  private readonly stablecoinTickers: readonly string[];

  /** Marks an issuer (asset ID or group key) as trusted — the ONLY path to verified. */
  trustIssuer(idOrGroupKey: string): void {
    this.trustedIssuers.add(idOrGroupKey.toLowerCase());
    this.reclassify(idOrGroupKey);
  }

  /** Records (or re-records) an asset from live daemon data. */
  record(entry: AssetRegistryEntryInput): AssetRegistryEntry & { display: AssetDisplayInfo } {
    const classified = classifyAsset(entry, { trustedIssuers: this.trustedIssuers, stablecoinTickers: this.stablecoinTickers });
    this.entries.set(entry.assetId, classified);
    return classified;
  }

  get(assetId: AssetIdHex): (AssetRegistryEntry & { display: AssetDisplayInfo }) | undefined {
    return this.entries.get(assetId.toLowerCase());
  }

  list(): ReadonlyArray<AssetRegistryEntry & { display: AssetDisplayInfo }> {
    return [...this.entries.values()];
  }

  /** Display info by id — the only render input the UI gets. */
  displayInfo(assetId: AssetIdHex): AssetDisplayInfo | undefined {
    return this.entries.get(assetId.toLowerCase())?.display;
  }

  private reclassify(idOrGroupKey: string): void {
    for (const [id, entry] of this.entries) {
      if (id === idOrGroupKey || entry.groupKeyHex === idOrGroupKey) {
        this.record(entry);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Capability copy
// ---------------------------------------------------------------------------

/** UI copy for the asset-support depth, mirroring describeLightningMechanism. */
export function describeAssetSupport(support: 'none' | 'layer1' | 'layer1+channels'): string {
  switch (support) {
    case 'none':
      return 'Taproot assets not supported';
    case 'layer1':
      return 'Taproot assets on Bitcoin layer 1';
    case 'layer1+channels':
      return 'Taproot assets on layer 1 and over Lightning channels';
  }
}
