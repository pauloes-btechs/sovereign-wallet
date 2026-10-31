import { describe, expect, it } from 'vitest';

import {
  AssetChannelsDisabledError,
  DEFAULT_ASSET_CHANNELS_CONFIG,
  assertAssetChannelsEnabled,
  assetSupportForConfig,
  resolveAssetChannelGate,
} from './experimental.js';

describe('asset channels experimental gate — defaults OFF', () => {
  it('the shipped default config has the flag off and no proof backup', () => {
    expect(DEFAULT_ASSET_CHANNELS_CONFIG).toEqual({
      enabled: false,
      proofBackup: { kind: 'none' },
    });
  });

  it('the default gate is closed with the experimental-flag reason and honest copy', () => {
    const gate = resolveAssetChannelGate(DEFAULT_ASSET_CHANNELS_CONFIG);
    expect(gate.allowed).toBe(false);
    if (gate.allowed) {
      expect.unreachable('default gate must be closed');
    }
    expect(gate.reason).toBe('experimental-flag-off');
    expect(gate.explanation).toContain('experimental');
  });

  it('the default capability depth is layer1 — channels never leak into the default declaration', () => {
    expect(assetSupportForConfig(DEFAULT_ASSET_CHANNELS_CONFIG)).toBe('layer1');
  });

  it('assertAssetChannelsEnabled throws the typed error on the default', () => {
    expect(() => assertAssetChannelsEnabled(DEFAULT_ASSET_CHANNELS_CONFIG)).toThrow(AssetChannelsDisabledError);
    try {
      assertAssetChannelsEnabled(DEFAULT_ASSET_CHANNELS_CONFIG);
      expect.unreachable('must throw');
    } catch (err) {
      const typed = err as AssetChannelsDisabledError;
      expect(typed.reason).toBe('experimental-flag-off');
      expect(typed.explanation.length).toBeGreaterThan(0);
    }
  });

  it('enabling the flag WITHOUT a proof backup stays closed — the flag alone is never enough', () => {
    const gate = resolveAssetChannelGate({ enabled: true, proofBackup: { kind: 'none' } });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) {
      expect.unreachable('backup-less gate must be closed');
    }
    expect(gate.reason).toBe('proof-backup-required');
    // Seed-only recovery is impossible for asset state — the copy says so.
    expect(gate.explanation).toContain('seed alone');
    expect(assetSupportForConfig({ enabled: true, proofBackup: { kind: 'none' } })).toBe('layer1');
  });

  it('flag on + configured proof backup is the only open gate', () => {
    const enabled = { enabled: true, proofBackup: { kind: 'json-file', dirPath: '/data/proofs' } as const };
    expect(resolveAssetChannelGate(enabled)).toEqual({ allowed: true });
    expect(assetSupportForConfig(enabled)).toBe('layer1+channels');
    expect(() => assertAssetChannelsEnabled(enabled)).not.toThrow();
  });
});
