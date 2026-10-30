/**
 * Capability-declaring provider contract — the system boundary between the
 * engine-agnostic domain layer and each backend (Wavelength / litd).
 *
 * Boundary invariant: no code path may create a wallet, balance, or history
 * under one provider and read or restore it under another. Seed compatibility
 * lists are disjoint per provider.
 */

/** How a user escapes a dead operator/backend: never silently unsupported. */
export type UnilateralExit = 'unsupported' | 'async' | 'instant';

/** Seed/recovery model per provider. Lists are disjoint — never shared. */
export type RecoveryModel = 'aezeed+scb' | 'mnemonic-ark' | 'remote-macaroon';

/** Taproot asset support depth per provider. */
export type AssetSupport = 'none' | 'layer1' | 'layer1+channels';

/** Lightning mechanism actually used — copy must say which, verbatim. */
export type LightningMechanism = 'channels' | 'swaps';

/**
 * A third party the wallet cannot function without for the listed operations.
 * `disclosure` is shown verbatim in onboarding and help — no paraphrasing.
 */
export interface OperatorDependency {
  kind: 'ark-operator' | 'swap-server' | 'proof-courier' | 'rfq-oracle' | 'pool-market';
  requiredFor: Array<'send' | 'receive' | 'exit' | 'recovery'>;
  disclosure: string;
}

/** What a backend can actually guarantee. Static, versioned, test-golden. */
export interface WalletCapabilities {
  /** True via channels (litd) OR swaps (Wavelength) — the UI labels which. */
  lightningSend: boolean;
  lightningReceive: boolean;
  lightningMechanism: LightningMechanism;
  onchainSend: boolean;
  onchainReceive: boolean;
  assets: AssetSupport;
  unilateralExit: UnilateralExit;
  recoveryModel: RecoveryModel;
  operatorDependencies: OperatorDependency[];
}

export type ProviderId = 'wavelength' | 'litd-local' | 'lnc-remote';

export interface StartOptions {
  readonly network: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  readonly dataDir: string;
}

export type WalletEvent =
  | { type: 'balance-changed' }
  | { type: 'payment-in-flight'; intentId: string }
  | { type: 'payment-settled'; intentId: string }
  | { type: 'vtxo-expiry-approaching' }
  | { type: 'operator-unreachable' };

export interface WalletProvider {
  readonly id: ProviderId;
  /** Declared, not inferred. Consumers render this — nothing else. */
  readonly capabilities: Readonly<WalletCapabilities>;
  /** Seed types this provider accepts. Disjoint across providers by design. */
  readonly seedCompatibility: readonly string[];
  start(opts: StartOptions): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (e: WalletEvent) => void): () => void;
}

/** Human-readable label for the Lightning mechanism, for UI copy. */
export function describeLightningMechanism(mechanism: LightningMechanism): string {
  switch (mechanism) {
    case 'channels':
      return 'Lightning via payment channels';
    case 'swaps':
      return 'Lightning via swap service';
  }
}

/** True when the provider can lose funds if an operator dependency dies. */
export function dependsOnOperatorForRecovery(caps: Readonly<WalletCapabilities>): boolean {
  return caps.operatorDependencies.some((d) => d.requiredFor.includes('recovery'));
}
