/**
 * The asset-channels experimental gate.
 *
 * Asset channels (tapd + litd lockstep, RFQ oracle) are EXPERIMENTAL
 * upstream, and seed-only recovery is impossible for asset state — so the
 * wallet ships them behind a flag that is OFF BY DEFAULT and refuses to
 * enable unless a proof-backup plan is configured. The gate is pure: tests
 * assert the default is closed, and the provider reads the same gate it
 * declares capabilities from — nothing can quietly open the surface.
 */

/** Where the mandatory proof backup lives when asset channels are on. */
export type ProofBackupPlan =
  | Readonly<{ kind: 'json-file'; dirPath: string }>
  | Readonly<{ kind: 'none' }>;

export interface AssetChannelsConfig {
  /** Experimental flag — OFF by default. */
  readonly enabled: boolean;
  /** Mandatory when `enabled`. */
  readonly proofBackup: ProofBackupPlan;
}

/** The shipped default: asset channels exist as a capability answer only. */
export const DEFAULT_ASSET_CHANNELS_CONFIG: Readonly<AssetChannelsConfig> = Object.freeze({
  enabled: false,
  proofBackup: { kind: 'none' },
} as const);

export type AssetChannelGateReason = 'experimental-flag-off' | 'proof-backup-required';

export interface AssetChannelGateClosed {
  readonly allowed: false;
  readonly reason: AssetChannelGateReason;
  /** Copy shown to the user verbatim — honesty is part of the gate. */
  readonly explanation: string;
}

export interface AssetChannelGateOpen {
  readonly allowed: true;
}

export type AssetChannelGate = AssetChannelGateOpen | AssetChannelGateClosed;

const FLAG_OFF_EXPLANATION =
  'Asset transfers over Lightning channels are experimental. Taproot assets on Bitcoin layer 1 are available without this flag.';

const BACKUP_REQUIRED_EXPLANATION =
  'Asset-channel state cannot be recovered from the seed alone. Configure the proof backup before enabling experimental asset channels.';

/**
 * The single gate decision. Rules:
 * 1. Flag off (the default) → closed, reason `experimental-flag-off`.
 * 2. Flag on without a configured proof backup → closed, reason
 *    `proof-backup-required` — the flag alone is never enough.
 * 3. Flag on + proof backup → open.
 */
export function resolveAssetChannelGate(config: Readonly<AssetChannelsConfig>): AssetChannelGate {
  if (!config.enabled) {
    return { allowed: false, reason: 'experimental-flag-off', explanation: FLAG_OFF_EXPLANATION };
  }
  if (config.proofBackup.kind === 'none') {
    return { allowed: false, reason: 'proof-backup-required', explanation: BACKUP_REQUIRED_EXPLANATION };
  }
  return { allowed: true };
}

/** Typed error thrown when channel operations are attempted behind a closed gate. */
export class AssetChannelsDisabledError extends Error {
  readonly reason: AssetChannelGateReason;
  readonly explanation: string;

  constructor(gate: AssetChannelGateClosed) {
    super(`asset channels are disabled (${gate.reason}): ${gate.explanation}`);
    this.name = 'AssetChannelsDisabledError';
    this.reason = gate.reason;
    this.explanation = gate.explanation;
  }
}

/** Guards channel operations — call at every entry point, before work. */
export function assertAssetChannelsEnabled(config: Readonly<AssetChannelsConfig>): void {
  const gate = resolveAssetChannelGate(config);
  if (!gate.allowed) {
    throw new AssetChannelsDisabledError(gate);
  }
}

/** Capability depth the provider honestly declares for this config. */
export function assetSupportForConfig(config: Readonly<AssetChannelsConfig>): 'layer1' | 'layer1+channels' {
  return resolveAssetChannelGate(config).allowed ? 'layer1+channels' : 'layer1';
}
