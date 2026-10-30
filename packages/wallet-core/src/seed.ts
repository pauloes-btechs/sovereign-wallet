import type { WalletProvider } from './provider.js';
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
