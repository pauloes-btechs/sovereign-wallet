/**
 * Quantum exposure: which of a wallet's funds already have their public key
 * visible on the blockchain.
 *
 * A large enough quantum computer could derive a private key from its public
 * key. The first practical target would be keys that sit on-chain for a long
 * time ("long-exposure" attacks). Coins whose output only commits to a HASH
 * of the key keep the key off-chain until they are spent; spending reveals it
 * (a "short-exposure" attack in the minutes before confirmation would need a
 * far faster machine).
 *
 * Wording rules this module encodes, and the UI must keep:
 *  - a hashed output is "not exposed yet", never "quantum-safe";
 *  - nothing on Bitcoin today is quantum-safe: BIP-360 (Pay-to-Merkle-Root,
 *    SegWit v2, bc1z…) is a Draft, is not activated, and defines no
 *    post-quantum signature algorithm;
 *  - spending any output reveals its key.
 *
 * Pure and engine-agnostic: callers pass what their node reported (unspent
 * outputs, addresses already spent from, channels, assets); every amount in
 * the result comes from those inputs. Nothing is estimated.
 */

/** Output script families, read from the scriptPubKey. */
export type ScriptFamily = 'p2pk' | 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'unknown';

/** What a wallet backend says an address is (LND's AddressType, collapsed). */
export type WalletAddressType = 'p2wkh' | 'np2wkh' | 'p2tr' | 'unknown';

const HEX = /^[0-9a-f]*$/;

/**
 * Classifies a scriptPubKey (hex). Only exact standard templates match;
 * anything else is `unknown` rather than guessed.
 */
export function scriptFamily(pkScriptHex: string): ScriptFamily {
  const s = pkScriptHex.trim().toLowerCase();
  if (!HEX.test(s) || s.length % 2 !== 0) return 'unknown';
  const bytes = s.length / 2;
  // OP_1 PUSH32 <x-only output key>
  if (bytes === 34 && s.startsWith('5120')) return 'p2tr';
  // OP_0 PUSH20 <hash160(pubkey)>
  if (bytes === 22 && s.startsWith('0014')) return 'p2wpkh';
  // OP_0 PUSH32 <sha256(script)>
  if (bytes === 34 && s.startsWith('0020')) return 'p2wsh';
  // OP_HASH160 PUSH20 <hash160(script)> OP_EQUAL
  if (bytes === 23 && s.startsWith('a914') && s.endsWith('87')) return 'p2sh';
  // OP_DUP OP_HASH160 PUSH20 <hash160(pubkey)> OP_EQUALVERIFY OP_CHECKSIG
  if (bytes === 25 && s.startsWith('76a914') && s.endsWith('88ac')) return 'p2pkh';
  // PUSH33 <compressed pubkey> OP_CHECKSIG | PUSH65 <uncompressed pubkey> OP_CHECKSIG
  if (bytes === 35 && s.startsWith('21') && s.endsWith('ac')) return 'p2pk';
  if (bytes === 67 && s.startsWith('41') && s.endsWith('ac')) return 'p2pk';
  return 'unknown';
}

function familyFromAddressType(t: WalletAddressType | undefined): ScriptFamily {
  switch (t) {
    case 'p2wkh':
      return 'p2wpkh';
    case 'np2wkh':
      return 'p2sh';
    case 'p2tr':
      return 'p2tr';
    default:
      return 'unknown';
  }
}

export type ExposureStatus = 'exposed' | 'hidden' | 'unclassified';

export type ExposureReason =
  /** P2TR output: the (tweaked) output key is in the scriptPubKey. */
  | 'taproot-output'
  /** P2PK output: the full public key is in the scriptPubKey. */
  | 'bare-public-key'
  /** Hashed address that was already spent from: that spend revealed its key. */
  | 'reused-after-spend'
  /** Hashed output (P2WPKH, P2SH-P2WPKH, P2PKH, P2WSH) never spent from. */
  | 'hashed-unspent'
  /** Taproot channel: MuSig2 taproot funding output. */
  | 'taproot-channel'
  /** P2WSH 2-of-2 multisig funding output (legacy / static remote key / anchors / lease). */
  | 'multisig-channel'
  /** Taproot Assets anchor output (P2TR). */
  | 'asset-anchor'
  | 'unknown-script'
  | 'unknown-channel-type'
  /** Channel closing: its funds are moving back on-chain. */
  | 'channel-closing';

export type ExposureSource = 'onchain' | 'channel' | 'asset';

export interface ExposureAsset {
  readonly assetIdHex: string;
  readonly name: string;
  /** Asset units, as the node reported them (decimal string). */
  readonly amount: string;
}

export interface ExposureItem {
  /** Outpoint (txid:index) for on-chain outputs and asset anchors; channel point for channels. */
  readonly id: string;
  readonly source: ExposureSource;
  readonly status: ExposureStatus;
  readonly reason: ExposureReason;
  /**
   * Bitcoin this item counts toward the totals. On-chain: the output's value.
   * Channels: YOUR side (local balance), not the capacity. Null when the node
   * did not report a bitcoin amount for it (an asset anchor that is not in
   * the wallet's unspent list) or it must not be counted (a closing channel,
   * whose funds reappear as on-chain outputs).
   */
  readonly amountSat: number | null;
  /** Channels only: the funding output's full value (both sides). */
  readonly capacitySat?: number;
  readonly address?: string;
  /** Script family read from the output script (on-chain items). */
  readonly family?: ScriptFamily;
  /** Unspent outputs of this wallet at the same address, this one included. */
  readonly coinsAtAddress?: number;
  /** Taproot Assets carried by this output. */
  readonly assets?: readonly ExposureAsset[];
  /** Plain-language reason. */
  readonly why: string;
  /** What would reduce the exposure, honestly (may be "nothing available today"). */
  readonly reduce: string;
}

export interface ExposureUtxoInput {
  readonly outpoint: string;
  readonly address: string;
  /** scriptPubKey hex — the authoritative source for the script family. */
  readonly pkScript: string;
  /** Backend's address type; used only when the script is missing. */
  readonly addressType?: WalletAddressType;
  readonly amountSat: number;
}

export type ExposureChannelState = 'opening' | 'open' | 'open-inactive' | 'closing' | 'closing-force' | 'waiting-close';

export interface ExposureChannelInput {
  readonly channelPoint: string;
  /** LND commitment type name (see ChannelCommitmentType in the litd adapter). */
  readonly commitmentType: string | undefined;
  readonly state: ExposureChannelState;
  readonly localBalanceSat: number;
  readonly capacitySat: number;
}

export interface ExposureAssetInput {
  readonly assetIdHex: string;
  readonly name: string;
  readonly amount: string;
  /** txid:index of the P2TR output that anchors the asset. */
  readonly anchorOutpoint: string;
  readonly isSpent: boolean;
}

export interface ExposureInput {
  readonly utxos: readonly ExposureUtxoInput[];
  /** This wallet's addresses that coins were already spent from. */
  readonly spentFromAddresses: readonly string[];
  readonly channels?: readonly ExposureChannelInput[];
  readonly assets?: readonly ExposureAssetInput[];
}

export interface ReasonTotal {
  readonly reason: ExposureReason;
  readonly status: ExposureStatus;
  readonly count: number;
  /** Sum of the items' counted bitcoin (items with a null amount add 0). */
  readonly amountSat: number;
  /** Items in this group with no counted bitcoin amount. */
  readonly uncountedItems: number;
}

export interface ExposureReport {
  readonly items: readonly ExposureItem[];
  /** Counted bitcoin whose key is visible on-chain now. */
  readonly exposedSat: number;
  /** Counted bitcoin whose key is still behind a hash. */
  readonly hiddenSat: number;
  /** Counted bitcoin this check could not classify. */
  readonly unclassifiedSat: number;
  /** Non-empty groups, in REASON_ORDER. */
  readonly byReason: readonly ReasonTotal[];
}

/** Display order: exposed groups first, then hidden, then unclassified. */
export const REASON_ORDER: readonly ExposureReason[] = [
  'taproot-output',
  'reused-after-spend',
  'bare-public-key',
  'taproot-channel',
  'asset-anchor',
  'hashed-unspent',
  'multisig-channel',
  'unknown-script',
  'unknown-channel-type',
  'channel-closing',
];

export const REASON_STATUS: Readonly<Record<ExposureReason, ExposureStatus>> = {
  'taproot-output': 'exposed',
  'bare-public-key': 'exposed',
  'reused-after-spend': 'exposed',
  'taproot-channel': 'exposed',
  'asset-anchor': 'exposed',
  'hashed-unspent': 'hidden',
  'multisig-channel': 'hidden',
  'unknown-script': 'unclassified',
  'unknown-channel-type': 'unclassified',
  'channel-closing': 'unclassified',
};

/** Short, sentence-case group labels. */
export const REASON_LABEL: Readonly<Record<ExposureReason, string>> = {
  'taproot-output': 'Taproot outputs',
  'bare-public-key': 'Pay-to-public-key outputs',
  'reused-after-spend': 'Addresses reused after a spend',
  'taproot-channel': 'Taproot channels',
  'asset-anchor': 'Taproot Assets anchors',
  'hashed-unspent': 'Hidden on-chain',
  'multisig-channel': 'Hidden in channels',
  'unknown-script': 'Unrecognized output scripts',
  'unknown-channel-type': 'Channels of unknown type',
  'channel-closing': 'Channels closing',
};

const TAPROOT_COMMITMENTS = new Set(['simple_taproot', 'simple_taproot_overlay', 'taproot', 'simple_taproot_final']);
const P2WSH_COMMITMENTS = new Set(['legacy', 'static_remote_key', 'anchors', 'script_enforced_lease']);

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function classifyUtxo(
  u: ExposureUtxoInput,
  spentFrom: ReadonlySet<string>,
  coinsAtAddress: number,
  assets: readonly ExposureAsset[] | undefined,
): ExposureItem {
  const fromScript = scriptFamily(u.pkScript);
  const family = fromScript !== 'unknown' ? fromScript : u.pkScript.trim() === '' ? familyFromAddressType(u.addressType) : 'unknown';
  const base = { id: u.outpoint, source: 'onchain' as const, amountSat: u.amountSat, address: u.address, family, coinsAtAddress };

  if (assets !== undefined && assets.length > 0) {
    return {
      ...base,
      status: 'exposed',
      reason: 'asset-anchor',
      assets,
      why:
        'This output anchors Taproot Assets. Asset anchors are taproot outputs, so the key is visible on the blockchain. ' +
        'The bitcoin in it is a small anchor amount; the assets it carries are what is exposed.',
      reduce: 'Nothing available today: Taproot Assets can only be anchored in taproot outputs.',
    };
  }

  switch (family) {
    case 'p2tr':
      return {
        ...base,
        status: 'exposed',
        reason: 'taproot-output',
        why: 'Taproot output: its public key is written into the output itself, so it has been visible on the blockchain since this coin arrived.',
        reduce:
          'Sending it to a fresh bc1q… address of this wallet hides the key behind a hash again until that coin is spent. That costs an on-chain fee.',
      };
    case 'p2pk':
      return {
        ...base,
        status: 'exposed',
        reason: 'bare-public-key',
        why: 'Pay-to-public-key output: the full public key is in the output, visible on the blockchain.',
        reduce: 'Sending it to a fresh bc1q… address of this wallet hides the key behind a hash until that coin is spent.',
      };
    case 'p2wpkh':
    case 'p2sh':
    case 'p2pkh':
    case 'p2wsh': {
      if (spentFrom.has(u.address)) {
        return {
          ...base,
          status: 'exposed',
          reason: 'reused-after-spend',
          why:
            'This address was spent from before, and that spend put its public key on the blockchain. ' +
            'This coin was paid to the same address, so its key is already public.',
          reduce: 'Send it to a fresh address of this wallet, and never receive to an address again after spending from it.',
        };
      }
      const shared = coinsAtAddress > 1;
      return {
        ...base,
        status: 'hidden',
        reason: 'hashed-unspent',
        why:
          'Only a hash of the public key is on the blockchain; the key itself appears when this coin is spent.' +
          (shared ? ` ${plural(coinsAtAddress, 'coin shares', 'coins share')} this address, so spending any one of them reveals the key for all.` : ''),
        reduce: shared
          ? 'When you spend from this address, spend all of its coins together so none is left behind at a revealed address.'
          : 'Nothing needed now. Keep receiving to fresh addresses, which this wallet does by default.',
      };
    }
    default:
      return {
        ...base,
        status: 'unclassified',
        reason: 'unknown-script',
        why: 'This output script is not a standard type this check recognizes, so it is not classified.',
        reduce: 'No suggestion: the script type is unknown.',
      };
  }
}

function classifyChannel(c: ExposureChannelInput): ExposureItem {
  const base = { id: c.channelPoint, source: 'channel' as const, capacitySat: c.capacitySat };
  if (c.state === 'closing' || c.state === 'closing-force' || c.state === 'waiting-close') {
    return {
      ...base,
      status: 'unclassified',
      reason: 'channel-closing',
      amountSat: null,
      why: 'This channel is closing. Its funds return to on-chain outputs, which are listed above once the node sees them, so they are not counted here.',
      reduce: 'Nothing to do; check again after the closing transaction confirms.',
    };
  }
  const type = (c.commitmentType ?? '').toLowerCase();
  const capacity = `The funding output holds the channel's full capacity of ${c.capacitySat.toLocaleString('en-US')} sats; the amount shown is your side.`;
  if (TAPROOT_COMMITMENTS.has(type)) {
    return {
      ...base,
      status: 'exposed',
      reason: 'taproot-channel',
      amountSat: c.localBalanceSat,
      why: `Taproot channel: the funding output is a MuSig2 taproot key, visible on the blockchain since the channel opened. ${capacity}`,
      reduce:
        'A channel keeps its type for life. Closing it and reopening as an anchors channel would hide the funding keys until the next close, at the cost of two on-chain fees.',
    };
  }
  if (P2WSH_COMMITMENTS.has(type)) {
    return {
      ...base,
      status: 'hidden',
      reason: 'multisig-channel',
      amountSat: c.localBalanceSat,
      why: `The funding output is a 2-of-2 multisig behind a script hash (P2WSH), so the channel keys are not on the blockchain yet. Closing the channel publishes them. ${capacity}`,
      reduce: 'Nothing needed while it stays open.',
    };
  }
  return {
    ...base,
    status: 'unclassified',
    reason: 'unknown-channel-type',
    amountSat: c.localBalanceSat,
    why: 'The node did not report this channel\'s commitment type, so its funding output is not classified.',
    reduce: 'No suggestion: the funding type is unknown.',
  };
}

/**
 * Classifies every unspent output, open or opening channel, and unspent
 * asset anchor. An asset anchor that is also one of the wallet's unspent
 * outputs is reported once (as that output, with its assets attached), so no
 * bitcoin is counted twice; channel funds are never wallet outputs.
 */
export function classifyExposure(input: ExposureInput): ExposureReport {
  const spentFrom = new Set(input.spentFromAddresses);

  const perAddress = new Map<string, number>();
  for (const u of input.utxos) if (u.address !== '') perAddress.set(u.address, (perAddress.get(u.address) ?? 0) + 1);

  const anchors = new Map<string, ExposureAsset[]>();
  for (const a of input.assets ?? []) {
    if (a.isSpent || a.anchorOutpoint === '') continue;
    const key = a.anchorOutpoint.toLowerCase();
    const list = anchors.get(key) ?? [];
    list.push({ assetIdHex: a.assetIdHex, name: a.name, amount: a.amount });
    anchors.set(key, list);
  }

  const items: ExposureItem[] = [];
  const seen = new Set<string>();
  for (const u of input.utxos) {
    const key = u.outpoint.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(classifyUtxo(u, spentFrom, perAddress.get(u.address) ?? 1, anchors.get(key)));
  }
  for (const [outpoint, assets] of anchors) {
    if (seen.has(outpoint)) continue;
    items.push({
      id: outpoint,
      source: 'asset',
      status: 'exposed',
      reason: 'asset-anchor',
      amountSat: null,
      family: 'p2tr',
      assets,
      why:
        'This output anchors Taproot Assets. Asset anchors are taproot outputs, so the key is visible on the blockchain. ' +
        'The node does not list its bitcoin amount (a small anchor amount); the assets it carries are what is exposed.',
      reduce: 'Nothing available today: Taproot Assets can only be anchored in taproot outputs.',
    });
  }
  for (const c of input.channels ?? []) items.push(classifyChannel(c));

  let exposedSat = 0;
  let hiddenSat = 0;
  let unclassifiedSat = 0;
  const groups = new Map<ExposureReason, { count: number; amountSat: number; uncountedItems: number }>();
  for (const it of items) {
    const sats = it.amountSat ?? 0;
    if (it.status === 'exposed') exposedSat += sats;
    else if (it.status === 'hidden') hiddenSat += sats;
    else unclassifiedSat += sats;
    const g = groups.get(it.reason) ?? { count: 0, amountSat: 0, uncountedItems: 0 };
    g.count += 1;
    g.amountSat += sats;
    if (it.amountSat === null) g.uncountedItems += 1;
    groups.set(it.reason, g);
  }

  const byReason: ReasonTotal[] = [];
  for (const reason of REASON_ORDER) {
    const g = groups.get(reason);
    if (g !== undefined) byReason.push({ reason, status: REASON_STATUS[reason], ...g });
  }

  const rank: Record<ExposureStatus, number> = { exposed: 0, hidden: 1, unclassified: 2 };
  items.sort((a, b) => rank[a.status] - rank[b.status] || (b.amountSat ?? 0) - (a.amountSat ?? 0) || a.id.localeCompare(b.id));

  return { items, exposedSat, hiddenSat, unclassifiedSat, byReason };
}
