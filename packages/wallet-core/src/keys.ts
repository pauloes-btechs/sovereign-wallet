import type { ProviderId } from './provider.js';

/** How a user authorizes sensitive key operations. */
export interface Authorization {
  readonly method: 'passkey' | 'password' | 'platform-biometrics';
  readonly proof: string;
}

export interface SeedMaterialHandle {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly createdAt: string;
}

export interface SeedMaterial {
  readonly providerId: ProviderId;
  /** Must appear in this provider's seedCompatibility list — never shared across providers. */
  readonly seedType: string;
  readonly words: readonly string[];
}

/**
 * Per-provider key custody. Implementations keep key material in platform
 * secure storage (spec: SQLCipher-at-rest data, keys in OS secure storage).
 *
 * Contract: seed material is namespaced by provider — `importSeed` MUST
 * route through `assertSeedCompatible` so a cross-provider seed is refused
 * explicitly instead of partially restored.
 */
export interface KeyManager {
  readonly providerId: ProviderId;
  generateSeed(options?: { readonly strengthBits?: 128 | 256 }): Promise<SeedMaterialHandle>;
  exportSeed(handleId: string, auth: Authorization): Promise<SeedMaterial>;
  importSeed(seed: SeedMaterial, auth: Authorization): Promise<SeedMaterialHandle>;
  wipe(handleId: string, auth: Authorization): Promise<void>;
}
