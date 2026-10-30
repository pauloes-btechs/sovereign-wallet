import { describe, expect, it } from 'vitest';
import { LITD_LOCAL_DECLARATION, WAVELENGTH_DECLARATION } from './capabilities.js';
import {
  CrossProviderRestoreError,
  SeedCompatibilityOverlapError,
  assertSeedCompatible,
  assertSeedCompatibilityDisjoint,
} from './seed.js';

// The declarations satisfy the structural shape the guard needs.
const PROVIDER_LIST = [WAVELENGTH_DECLARATION, LITD_LOCAL_DECLARATION].map((d) => ({
  id: d.id,
  seedCompatibility: d.seedCompatibility,
}));

describe('cross-provider seed restore guard', () => {
  it('accepts a provider-native seed type', () => {
    expect(() => assertSeedCompatible(WAVELENGTH_DECLARATION, 'mnemonic-ark')).not.toThrow();
    expect(() => assertSeedCompatible(LITD_LOCAL_DECLARATION, 'aezeed+scb')).not.toThrow();
  });

  it('refuses a litd seed under Wavelength — explicitly, naming both sides', () => {
    try {
      assertSeedCompatible(WAVELENGTH_DECLARATION, 'aezeed+scb');
      expect.unreachable('expected CrossProviderRestoreError');
    } catch (err) {
      expect(err).toBeInstanceOf(CrossProviderRestoreError);
      const message = (err as Error).message;
      expect(message).toContain('wavelength');
      expect(message).toContain('aezeed+scb');
      expect(message).toContain('never shared across providers');
    }
  });

  it('refuses an unrecognized seed type', () => {
    expect(() => assertSeedCompatible(LITD_LOCAL_DECLARATION, 'bip39')).toThrowError(
      CrossProviderRestoreError,
    );
  });

  it('builtin seed compatibility lists are pairwise disjoint', () => {
    expect(() => assertSeedCompatibilityDisjoint(PROVIDER_LIST)).not.toThrow();
  });

  it('flags overlapping seed lists between any two providers', () => {
    expect(() =>
      assertSeedCompatibilityDisjoint([
        { id: 'wavelength', seedCompatibility: ['shared-seed'] },
        { id: 'litd-local', seedCompatibility: ['shared-seed'] },
      ]),
    ).toThrowError(SeedCompatibilityOverlapError);
  });
});
