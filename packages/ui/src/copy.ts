import type {
  AssetSupport,
  LightningMechanism,
  OperatorDependency,
  UnilateralExit,
  RecoveryModel,
} from '@sovereign/wallet-core';
import { describeLightningMechanism } from '@sovereign/wallet-core';

/**
 * UI copy strings — the single place user-facing wording lives.
 *
 * Copy rule (spec, locked): wherever the Lightning mechanism is shown, it says
 * "Lightning via swap service" for Mode A — never "channel". Mode A copy never
 * uses the word "channel" at all; `describeLightningMechanism` from
 * wallet-core is the only source of mechanism labels.
 */

/** Mode A (Wavelength) VTXO lifecycle states — user-visible, spec table 1:1. */
export type VtxoState = 'fresh' | 'expiring' | 'at-risk' | 'exiting';

/** Spec-verbatim backup consequence, shown at backup confirmation. */
export const BACKUP_EXPIRY_CONSEQUENCE =
  'If you ever need to restore, do it promptly — waiting too long can force a slower on-chain exit.';

export function vtxoStateLabel(state: VtxoState): string {
  switch (state) {
    case 'fresh':
      return 'Spendable';
    case 'expiring':
      return 'Expiring soon';
    case 'at-risk':
      return 'At risk';
    case 'exiting':
      return 'Exiting to on-chain';
  }
}

export function formatSats(sats: bigint): string {
  return new Intl.NumberFormat('en-US').format(sats);
}

export function satsLabel(sats: bigint): string {
  return `${formatSats(sats)} sats`;
}

export function describeSeedType(seedType: RecoveryModel): string {
  switch (seedType) {
    case 'mnemonic-ark':
      return 'Ark recovery phrase';
    case 'aezeed+scb':
      return 'LND aezeed seed + channel backup file';
    case 'remote-macaroon':
      return 'Remote node session';
  }
}

export function describeDependencyKind(kind: OperatorDependency['kind']): string {
  switch (kind) {
    case 'ark-operator':
      return 'Ark operator';
    case 'swap-server':
      return 'Swap service';
    case 'proof-courier':
      return 'Proof courier';
    case 'rfq-oracle':
      return 'RFQ oracle';
    case 'pool-market':
      return 'Pool market';
  }
}

export function describeRequiredFor(op: OperatorDependency['requiredFor'][number]): string {
  switch (op) {
    case 'send':
      return 'Sending';
    case 'receive':
      return 'Receiving';
    case 'exit':
      return 'Emergency exit';
    case 'recovery':
      return 'Recovery';
  }
}

export function describeUnilateralExit(exit: UnilateralExit): string {
  switch (exit) {
    case 'unsupported':
      return 'Not available in this mode';
    case 'async':
      return 'Available — hours to days, on-chain fees apply';
    case 'instant':
      return 'Available — force-closes settle on-chain';
  }
}

export function describeAssetSupport(assets: AssetSupport): string {
  switch (assets) {
    case 'none':
      return 'Not supported in this mode';
    case 'layer1':
      return 'Layer-1 only';
    case 'layer1+channels':
      return 'Layer-1, asset transfers experimental';
  }
}

export function mechanismLabel(mechanism: LightningMechanism): string {
  // Delegates to the domain layer so UI copy can never drift from the
  // declared mechanism. Mode A renders "Lightning via swap service".
  return describeLightningMechanism(mechanism);
}
