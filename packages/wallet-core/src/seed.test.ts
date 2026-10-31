import { describe, expect, it } from 'vitest';
import { LITD_LOCAL_DECLARATION, WAVELENGTH_DECLARATION } from './capabilities.js';
import {
  CrossProviderRestoreError,
  DuplicateWalletIdentityError,
  SeedCompatibilityOverlapError,
  assertSeedCompatible,
  assertSeedCompatibilityDisjoint,
  assertWalletIdentityUnique,
} from './seed.js';
import type { WalletIdentityRef } from './seed.js';

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

describe('assertWalletIdentityUnique — two-live-instances-same-seed guard', () => {
  const alice: WalletIdentityRef = {
    providerId: 'litd-local',
    instanceId: 'node-bob-1',
    identityPubKey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const sameSeedOtherInstance: WalletIdentityRef = { ...alice, instanceId: 'node-bob-2' };
  const sameInstanceRestart: WalletIdentityRef = { ...alice, instanceId: 'node-bob-1' };
  const differentSeed: WalletIdentityRef = {
    providerId: 'litd-local',
    instanceId: 'node-alice-1',
    identityPubKey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };

  it('registers a first identity and allows the same instance to re-register (restart)', () => {
    expect(() => assertWalletIdentityUnique([], alice)).not.toThrow();
    expect(() => assertWalletIdentityUnique([alice], sameInstanceRestart)).not.toThrow();
  });

  it('refuses a second instance claiming a registered identity', () => {
    expect(() => assertWalletIdentityUnique([alice], sameSeedOtherInstance)).toThrowError(
      DuplicateWalletIdentityError,
    );
  });

  it('refuses across providers too — a shared identity means a shared seed', () => {
    const wavelengthClaim: WalletIdentityRef = { ...sameSeedOtherInstance, providerId: 'wavelength' };
    expect(() => assertWalletIdentityUnique([alice], wavelengthClaim)).toThrowError(
      DuplicateWalletIdentityError,
    );
  });

  it('registers distinct identities independently', () => {
    expect(() => assertWalletIdentityUnique([alice], differentSeed)).not.toThrow();
  });

  it('fails closed on an empty identity key — an unverifiable identity registers nothing', () => {
    expect(() =>
      assertWalletIdentityUnique([], {
        providerId: 'litd-local',
        instanceId: 'node-x',
        identityPubKey: '',
      }),
    ).toThrow(/identity key/i);
  });
});
