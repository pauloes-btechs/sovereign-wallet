import { describe, expect, it } from 'vitest';
import {
  LITD_LOCAL_DECLARATION,
  LNC_REMOTE_DECLARATION,
  PROVIDER_DECLARATIONS,
  PROOF_COURIER_DISCLOSURE,
  WAVELENGTH_DECLARATION,
  validateDeclaration,
} from './capabilities.js';
import { dependsOnOperatorForRecovery, describeLightningMechanism } from './provider.js';

describe('builtin capability declarations (golden)', () => {
  it('Wavelength: swap-based Lightning, async unilateral exit, mnemonic-ark recovery', () => {
    expect(WAVELENGTH_DECLARATION).toEqual({
      id: 'wavelength',
      capabilities: {
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
            disclosure:
              'Lightning payments are sent and received through an external swap service. Its fee is shown before you confirm a payment.',
          },
          {
            kind: 'ark-operator',
            requiredFor: ['send', 'receive', 'exit', 'recovery'],
            disclosure:
              'Spendable funds are held as Ark VTXOs with an Ark operator. Sending, receiving, and rolling funds forward need the operator to be reachable; if it is not, a unilateral exit moves funds on-chain more slowly and at your cost. Restoring from seed must complete before VTXO batch expiry.',
          },
        ],
      },
      seedCompatibility: ['mnemonic-ark'],
    });
  });

  it('litd-local: channel-based Lightning, layer-1 assets, instant unilateral exit, courier disclosed', () => {
    expect(LITD_LOCAL_DECLARATION).toEqual({
      id: 'litd-local',
      capabilities: {
        lightningSend: true,
        lightningReceive: true,
        lightningMechanism: 'channels',
        onchainSend: true,
        onchainReceive: true,
        assets: 'layer1',
        unilateralExit: 'instant',
        recoveryModel: 'aezeed+scb',
        operatorDependencies: [
          {
            kind: 'proof-courier',
            requiredFor: ['send', 'receive'],
            disclosure: PROOF_COURIER_DISCLOSURE,
          },
        ],
      },
      seedCompatibility: ['aezeed+scb'],
    });
  });

  it('lnc-remote: channel-based Lightning through the user’s own node, remote-macaroon recovery', () => {
    expect(LNC_REMOTE_DECLARATION).toEqual({
      id: 'lnc-remote',
      capabilities: {
        lightningSend: true,
        lightningReceive: true,
        lightningMechanism: 'channels',
        onchainSend: true,
        onchainReceive: true,
        assets: 'none',
        unilateralExit: 'instant',
        recoveryModel: 'remote-macaroon',
        operatorDependencies: [],
      },
      seedCompatibility: ['remote-macaroon'],
    });
  });

  it('declarations are deep-frozen — capabilities are declared once, never mutated into parity', () => {
    for (const decl of PROVIDER_DECLARATIONS) {
      expect(() => {
        (decl.capabilities as { lightningSend: boolean }).lightningSend = false;
      }).toThrowError(TypeError);
      const deps = decl.capabilities.operatorDependencies;
      if (deps.length > 0) {
        expect(() => {
          (deps[0] as { kind: string }).kind = 'pool-market';
        }).toThrowError(TypeError);
      } else {
        // Empty dependency list: the array itself must still be frozen.
        expect(Object.isFrozen(deps)).toBe(true);
      }
      expect(() => {
        (decl.seedCompatibility as string[]).push('anything');
      }).toThrowError(TypeError);
    }
  });

  it('every builtin declaration satisfies the declaration invariants', () => {
    for (const decl of PROVIDER_DECLARATIONS) {
      expect(validateDeclaration(decl)).toEqual([]);
    }
  });

  it('mechanism copy names the mechanism — swaps are never rendered as channels', () => {
    expect(describeLightningMechanism('swaps')).toBe('Lightning via swap service');
    expect(describeLightningMechanism('channels')).toBe('Lightning via payment channels');
  });

  it('recovery-time operator dependence is flagged for the UI where it exists', () => {
    expect(dependsOnOperatorForRecovery(WAVELENGTH_DECLARATION.capabilities)).toBe(true);
    expect(dependsOnOperatorForRecovery(LITD_LOCAL_DECLARATION.capabilities)).toBe(false);
    expect(dependsOnOperatorForRecovery(LNC_REMOTE_DECLARATION.capabilities)).toBe(false);
  });
});
