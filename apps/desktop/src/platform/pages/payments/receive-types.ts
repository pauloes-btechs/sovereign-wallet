/**
 * Which address types the Receive page can create, built from the shared
 * output-type registry (`@sovereign/wallet-core` OUTPUT_TYPES). Every known
 * type is listed with why it is or isn't offered, plus whether its public
 * key is visible on-chain while the coins sit there. P2MR (BIP-360) is
 * listed as not available, never hidden, and there is no way to create one.
 */
import { OUTPUT_TYPES, type KeyExposure, type OutputTypeId } from '@sovereign/wallet-core';

/** The bridge's `/onchain/address` types. */
export type BridgeAddressType = 'p2wkh' | 'np2wkh';

/** Registry type → bridge type, for the types this page offers. */
export const BRIDGE_TYPE: Readonly<Partial<Record<OutputTypeId, BridgeAddressType>>> = {
  p2wpkh: 'p2wkh',
  'p2sh-p2wpkh': 'np2wkh',
};

export const EXPOSURE_LABEL: Readonly<Record<KeyExposure, string>> = {
  'hidden-until-spend': 'Hidden until spent',
  'exposed-in-output': 'Visible while unspent',
  'no-key-path': 'No key in the output',
};

const NOT_OFFERED: Readonly<Partial<Record<OutputTypeId, string>>> = {
  p2pkh: 'Not offered: legacy addresses cost more to spend, and the node bridge creates SegWit addresses only.',
  p2wsh: 'Not offered: script addresses come from multisig setups or contracts, not this single-key wallet.',
  p2tr: 'Not offered here yet: the node bridge creates Native and Nested SegWit deposit addresses only.',
};

export interface ReceiveTypeRow {
  readonly id: OutputTypeId;
  readonly label: string;
  readonly prefix: string;
  readonly availability: 'offered' | 'not-offered' | 'not-available';
  /** Plain-language status, including the reason when not offered. */
  readonly availabilityText: string;
  readonly exposure: string;
  readonly exposureNote: string;
}

export function receiveTypeRows(): readonly ReceiveTypeRow[] {
  return OUTPUT_TYPES.map((t) => {
    const base = { id: t.id, label: t.label, prefix: t.mainnetPrefix, exposure: EXPOSURE_LABEL[t.keyExposure], exposureNote: t.exposureNote };
    if (t.status.state === 'proposed') {
      return { ...base, availability: 'not-available', availabilityText: `${t.status.reason}.` };
    }
    if (BRIDGE_TYPE[t.id] !== undefined) return { ...base, availability: 'offered', availabilityText: 'Offered above.' };
    return { ...base, availability: 'not-offered', availabilityText: NOT_OFFERED[t.id] ?? 'Not offered by this wallet.' };
  });
}
