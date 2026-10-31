import type { ProviderId, WalletProvider } from './provider.js';
import type { ProviderDeclaration } from './capabilities.js';

/**
 * Thrown when a seed (or backup) from one provider is presented to another.
 * The refusal is explicit and names both sides — partial restores across
 * providers are impossible by contract.
 */
export class CrossProviderRestoreError extends Error {
  constructor(
    readonly targetProviderId: string,
    readonly seedType: string,
    readonly accepted: readonly string[],
  ) {
    super(
      `Refusing seed restore: seed type '${seedType}' is not compatible with provider '${targetProviderId}'. ` +
        `Accepted seed types: ${accepted.join(', ') || 'none'}. ` +
        'Seeds and recovery state are never shared across providers.',
    );
    this.name = 'CrossProviderRestoreError';
  }
}

/**
 * The single guard every seed-import path must route through. Providers
 * declare disjoint seedCompatibility lists; anything not on the list is
 * refused with an explanation instead of a partial restore.
 */
export function assertSeedCompatible(
  provider: Pick<WalletProvider, 'id' | 'seedCompatibility'>,
  seedType: string,
): void {
  if (!provider.seedCompatibility.includes(seedType)) {
    throw new CrossProviderRestoreError(provider.id, seedType, provider.seedCompatibility);
  }
}

export class SeedCompatibilityOverlapError extends Error {
  constructor(
    readonly sharedType: string,
    readonly providerA: string,
    readonly providerB: string,
  ) {
    super(
      `Seed compatibility lists overlap: '${sharedType}' is accepted by both '${providerA}' and '${providerB}'. ` +
        'Seed lists must be disjoint per provider.',
    );
    this.name = 'SeedCompatibilityOverlapError';
  }
}

/**
 * Pairwise-disjointness check over provider declarations. Run at startup and
 * in tests: a shared seed type across two providers would make cross-provider
 * restore ambiguous, which the boundary invariant forbids.
 */
export function assertSeedCompatibilityDisjoint(
  declarations: ReadonlyArray<Pick<ProviderDeclaration, 'id' | 'seedCompatibility'>>,
): void {
  for (let i = 0; i < declarations.length; i++) {
    for (let j = i + 1; j < declarations.length; j++) {
      const a = declarations[i];
      const b = declarations[j];
      if (a === undefined || b === undefined) continue;
      for (const seedType of a.seedCompatibility) {
        if (b.seedCompatibility.includes(seedType)) {
          throw new SeedCompatibilityOverlapError(seedType, a.id, b.id);
        }
      }
    }
  }
}

/** A backend wallet identity as observed from a live node (e.g. an LND
 * identity pubkey — the node key is derived from the seed, so two nodes
 * initialized from one aezeed are indistinguishable on the network). */
export interface WalletIdentityRef {
  readonly providerId: ProviderId;
  /** The wallet instance being registered — stable across restarts. */
  readonly instanceId: string;
  /** Backend-derived identity (LND identity pubkey, Ark identity key). */
  readonly identityPubKey: string;
}

/**
 * Thrown when a second wallet instance presents an identity that is already
 * registered to a DIFFERENT instance — i.e. two live wallets derived from
 * the same seed. Both hold the same node key, channels, and SCB state;
 * running them concurrently risks double-issued commitments and conflicting
 * channel-backup restores. The wallet refuses the second registration
 * outright instead of letting the operator discover the collision on-chain.
 */
export class DuplicateWalletIdentityError extends Error {
  constructor(
    readonly identityPubKey: string,
    readonly existingInstanceId: string,
    readonly candidateInstanceId: string,
  ) {
    super(
      `Refusing wallet registration: identity '${identityPubKey.slice(0, 12)}…' is already ` +
        `registered to instance '${existingInstanceId}' and is claimed by '${candidateInstanceId}'. ` +
        'Two live wallets from the same seed cannot both operate safely — restore ONE wallet ' +
        'per seed and wipe or archive the other.',
    );
    this.name = 'DuplicateWalletIdentityError';
  }
}

/**
 * The single guard every wallet-registration path routes through. A
 * re-registration by the SAME instance (a restart) is legitimate; any other
 * claim on a registered identity is refused. An empty identity key cannot be
 * verified at all and fails closed.
 */
export function assertWalletIdentityUnique(
  registered: readonly WalletIdentityRef[],
  candidate: WalletIdentityRef,
): void {
  if (candidate.identityPubKey === '') {
    throw new Error('Wallet registration requires a backend-derived identity key — refusing an empty one.');
  }
  const existing = registered.find((r) => r.identityPubKey === candidate.identityPubKey);
  if (existing !== undefined && existing.instanceId !== candidate.instanceId) {
    throw new DuplicateWalletIdentityError(
      candidate.identityPubKey,
      existing.instanceId,
      candidate.instanceId,
    );
  }
}
