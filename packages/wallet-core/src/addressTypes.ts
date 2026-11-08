/**
 * Bitcoin output (address) types this wallet knows about, and the rule for
 * which SegWit versions it will send to.
 *
 * Why this exists: a SegWit output whose version has no consensus rules yet
 * (v2–v16 today) is spendable by anyone. BIP-360 (P2MR, Pay-to-Merkle-Root)
 * proposes SegWit v2 as a post-quantum-friendly output type, but it is a
 * Draft and not activated: coins sent to a `bc1z…` address now could be
 * taken by anyone. So:
 *
 * - every on-chain send passes `witnessVersionPolicy` / `unactivatedWitnessRefusal`,
 *   which refuses unactivated versions with a plain reason;
 * - P2MR is listed as `proposed`, never offered for receiving, and switches
 *   on by changing its `status` to `active` once a soft fork activates it.
 *
 * Facts below are from the BIP text (bitcoin/bips bip-0360.mediawiki,
 * Version 0.12.1, Status Draft), checked 2026-11-08.
 */

import { segwitAddressDecode } from './bech32.js';

export type OutputTypeId = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'p2mr';

/**
 * What an observer (or a future quantum attacker) can see while coins sit
 * in an output of this type, before they are spent.
 *
 * - `hidden-until-spend`: the output commits to a hash; the public key (or
 *   script) is revealed only when the coins are spent. Reusing an address
 *   after a spend leaves the key exposed.
 * - `exposed-in-output`: the public key itself is in the output (Taproot's
 *   output key), visible on-chain for as long as the coins stay there.
 * - `no-key-path`: no key in the output and no key-path spend; only a
 *   Merkle root of scripts is committed.
 */
export type KeyExposure = 'hidden-until-spend' | 'exposed-in-output' | 'no-key-path';

export type OutputTypeStatus =
  | { readonly state: 'active' }
  | {
      readonly state: 'proposed';
      readonly bip: number;
      readonly bipTitle: string;
      readonly bipStatus: 'Draft';
      /** Why it can't be used yet, shown wherever the type is listed. */
      readonly reason: string;
    };

export interface OutputTypeInfo {
  readonly id: OutputTypeId;
  /** Sentence-case label for lists and badges. */
  readonly label: string;
  /** SegWit witness version; null for pre-SegWit (P2PKH). Nested P2SH-P2WPKH is 0. */
  readonly witnessVersion: number | null;
  /** True when the SegWit program is wrapped in P2SH (address starts `3`). */
  readonly nested: boolean;
  /** How a mainnet address of this type begins. */
  readonly mainnetPrefix: string;
  readonly keyExposure: KeyExposure;
  /** One plain sentence about key exposure while coins sit there. */
  readonly exposureNote: string;
  readonly status: OutputTypeStatus;
}

const EXPOSURE_HIDDEN =
  'The public key stays hidden behind a hash until the coins are spent. Reusing the address after a spend leaves the key exposed.';

export const P2MR_UNAVAILABLE_REASON = 'Not available — BIP-360 is a draft and not activated';

export const OUTPUT_TYPES: readonly OutputTypeInfo[] = [
  {
    id: 'p2pkh',
    label: 'Legacy (P2PKH)',
    witnessVersion: null,
    nested: false,
    mainnetPrefix: '1',
    keyExposure: 'hidden-until-spend',
    exposureNote: EXPOSURE_HIDDEN,
    status: { state: 'active' },
  },
  {
    id: 'p2sh-p2wpkh',
    label: 'Nested SegWit (P2SH-P2WPKH)',
    witnessVersion: 0,
    nested: true,
    mainnetPrefix: '3',
    keyExposure: 'hidden-until-spend',
    exposureNote: EXPOSURE_HIDDEN,
    status: { state: 'active' },
  },
  {
    id: 'p2wpkh',
    label: 'Native SegWit (P2WPKH)',
    witnessVersion: 0,
    nested: false,
    mainnetPrefix: 'bc1q',
    keyExposure: 'hidden-until-spend',
    exposureNote: EXPOSURE_HIDDEN,
    status: { state: 'active' },
  },
  {
    id: 'p2wsh',
    label: 'SegWit script (P2WSH)',
    witnessVersion: 0,
    nested: false,
    mainnetPrefix: 'bc1q',
    keyExposure: 'hidden-until-spend',
    exposureNote: 'The script and its keys stay hidden behind a hash until the coins are spent.',
    status: { state: 'active' },
  },
  {
    id: 'p2tr',
    label: 'Taproot (P2TR)',
    witnessVersion: 1,
    nested: false,
    mainnetPrefix: 'bc1p',
    keyExposure: 'exposed-in-output',
    exposureNote: 'The output contains a public key, so it is visible on-chain for as long as the coins sit there.',
    status: { state: 'active' },
  },
  {
    id: 'p2mr',
    label: 'Pay-to-Merkle-Root (P2MR)',
    witnessVersion: 2,
    nested: false,
    mainnetPrefix: 'bc1z',
    keyExposure: 'no-key-path',
    exposureNote:
      'No key in the output and no key-path spend: only a Merkle root of scripts is committed. Designed to resist long-exposure quantum attacks, not short-exposure ones.',
    status: {
      state: 'proposed',
      bip: 360,
      bipTitle: 'Pay-to-Merkle-Root (P2MR)',
      bipStatus: 'Draft',
      reason: P2MR_UNAVAILABLE_REASON,
    },
  },
];

export function outputType(id: OutputTypeId): OutputTypeInfo {
  const found = OUTPUT_TYPES.find((t) => t.id === id);
  if (found === undefined) throw new Error(`unknown output type ${id}`);
  return found;
}

export function isOutputTypeActive(id: OutputTypeId): boolean {
  return outputType(id).status.state === 'active';
}

// ——— send policy ———

/** The reason shown when a send to a SegWit v2 (P2MR) address is refused. */
export const UNACTIVATED_V2_REASON = 'Coins sent to a version-2 address before BIP-360 activates can be taken by anyone.';

export interface WitnessPolicyOptions {
  /**
   * Output types whose soft fork has activated beyond the built-in registry.
   * Defaults to the registry: types with witness version ≥ 2 whose status
   * is `active` (none today).
   */
  readonly activated?: readonly OutputTypeId[];
  /**
   * Witness program length in bytes, when known. Consensus rules exist only
   * for v0 (20/32 bytes) and v1 with 32 bytes; v1 with any other length is
   * also spendable by anyone.
   */
  readonly programLength?: number;
}

export type WitnessPolicy =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly outputType: OutputTypeId | null };

function activatedTypes(options: WitnessPolicyOptions): readonly OutputTypeId[] {
  if (options.activated !== undefined) return options.activated;
  return OUTPUT_TYPES.filter((t) => t.witnessVersion !== null && t.witnessVersion >= 2 && t.status.state === 'active').map((t) => t.id);
}

/**
 * May this wallet send to a SegWit output of `version`? v0 and v1 (Taproot,
 * 32-byte program) are allowed; v2 only once P2MR is activated; v3–v16
 * never, because no soft fork gives them rules.
 */
export function witnessVersionPolicy(version: number, options: WitnessPolicyOptions = {}): WitnessPolicy {
  if (!Number.isInteger(version) || version < 0 || version > 16) {
    return { allowed: false, reason: `SegWit version ${String(version)} does not exist.`, outputType: null };
  }
  const len = options.programLength;
  if (version === 0) return { allowed: true };
  if (version === 1) {
    if (len !== undefined && len !== 32) {
      return {
        allowed: false,
        reason: `Coins sent to a version-1 address with a ${len}-byte program can be taken by anyone: only 32-byte Taproot programs have spending rules.`,
        outputType: null,
      };
    }
    return { allowed: true };
  }
  for (const id of activatedTypes(options)) {
    const t = outputType(id);
    if (t.witnessVersion === version) {
      if (version === 2 && len !== undefined && len !== 32) {
        return {
          allowed: false,
          reason: `Coins sent to a version-2 address with a ${len}-byte program can be taken by anyone: P2MR outputs are 32 bytes.`,
          outputType: null,
        };
      }
      return { allowed: true };
    }
  }
  if (version === 2) return { allowed: false, reason: UNACTIVATED_V2_REASON, outputType: 'p2mr' };
  return {
    allowed: false,
    reason: `Coins sent to a version-${version} address can be taken by anyone: no soft fork has given SegWit version ${version} spending rules.`,
    outputType: null,
  };
}

export interface UnactivatedWitnessRefusal {
  readonly witnessVersion: number;
  readonly reason: string;
  readonly outputType: OutputTypeId | null;
}

/** SegWit HRPs on every network this app supports (signet shares `tb`). */
const SEGWIT_HRPS = ['bc', 'tb', 'bcrt'] as const;

/**
 * Decodes `address` as a SegWit address (any supported network) and returns
 * a refusal when its witness version may not be sent to. Returns null for
 * allowed versions AND for anything that isn't a valid SegWit address
 * (legacy base58, typos): format and network checks belong to the caller.
 */
export function unactivatedWitnessRefusal(address: string, options: Omit<WitnessPolicyOptions, 'programLength'> = {}): UnactivatedWitnessRefusal | null {
  const decoded = segwitAddressDecode(address.trim(), SEGWIT_HRPS);
  if (decoded === null) return null;
  const policy = witnessVersionPolicy(decoded.witnessVersion, { ...options, programLength: decoded.program.length });
  if (policy.allowed) return null;
  return { witnessVersion: decoded.witnessVersion, reason: policy.reason, outputType: policy.outputType };
}
