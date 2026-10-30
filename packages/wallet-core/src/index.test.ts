import { describe, expect, it } from 'vitest';
import {
  dependsOnOperatorForRecovery,
  describeLightningMechanism,
  type WalletCapabilities,
} from './index.js';

/** Golden declarations — UI copy and onboarding disclosures render from these. */
const wavelengthCaps: WalletCapabilities = {
  lightningSend: true,
  lightningReceive: true,
  lightningMechanism: 'swaps',
  onchainSend: true,
  onchainReceive: true,
  assets: 'none',
  unilateralExit: 'async',
  recoveryModel: 'mnemonic-ark',
  operatorDependencies: [
    {
      kind: 'swap-server',
      requiredFor: ['send', 'receive'],
      disclosure: 'Lightning payments route through an external swap service.',
    },
  ],
};

const litdCaps: WalletCapabilities = {
  lightningSend: true,
  lightningReceive: true,
  lightningMechanism: 'channels',
  onchainSend: true,
  onchainReceive: true,
  assets: 'layer1',
  unilateralExit: 'instant',
  recoveryModel: 'aezeed+scb',
  operatorDependencies: [],
};

describe('capability declarations (golden)', () => {
  it('labels Wavelength Lightning as swap-based, never channel-based', () => {
    expect(wavelengthCaps.lightningMechanism).toBe('swaps');
    expect(describeLightningMechanism('swaps')).toBe('Lightning via swap service');
  });

  it('labels litd Lightning as channel-based', () => {
    expect(litdCaps.lightningMechanism).toBe('channels');
    expect(describeLightningMechanism('channels')).toBe('Lightning via payment channels');
  });

  it('keeps operator dependencies disjoint between engines', () => {
    // Mode B is self-hosted: no operator dependency may appear.
    expect(litdCaps.operatorDependencies).toHaveLength(0);
    // Mode A must disclose every operator it depends on.
    expect(wavelengthCaps.operatorDependencies.length).toBeGreaterThan(0);
    expect(dependsOnOperatorForRecovery(wavelengthCaps)).toBe(false);
  });

  it('flags recovery-time operator dependence for the UI', () => {
    const withRecoveryOp: WalletCapabilities = {
      ...wavelengthCaps,
      operatorDependencies: [
        ...wavelengthCaps.operatorDependencies,
        {
          kind: 'ark-operator',
          requiredFor: ['recovery'],
          disclosure: 'Recovery requires a reachable Ark operator before batch expiry.',
        },
      ],
    };
    expect(dependsOnOperatorForRecovery(withRecoveryOp)).toBe(true);
  });
});
