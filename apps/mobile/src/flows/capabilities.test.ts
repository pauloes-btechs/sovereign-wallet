import { describe, expect, it } from 'vitest';
import { LNC_REMOTE_DECLARATION, WAVELENGTH_DECLARATION } from '@sovereign/wallet-core';
import {
  FEATURE_IDS,
  isAvailable,
  remoteLndCapabilities,
  unavailableReason,
  wavelengthCapabilities,
} from './capabilities.js';
import type { MobileWalletCapabilities } from './capabilities.js';
import { NO_PLATFORM_SERVICES } from './platform.js';

const FULL_PORT = { listLightningActivity: true, listSessions: true, revokeSession: true };

function everyUnavailableHasAReason(caps: MobileWalletCapabilities): void {
  for (const id of FEATURE_IDS) {
    const status = caps.features[id];
    if (!status.available) expect(status.reason.trim().length, id).toBeGreaterThan(10);
  }
}

describe('Wavelength capabilities', () => {
  const base = {
    declared: WAVELENGTH_DECLARATION.capabilities,
    walletReady: true,
    operatorReachable: true,
    platform: NO_PLATFORM_SERVICES,
  };

  it('derives money movement from the declaration and covers every feature', () => {
    const caps = wavelengthCapabilities(base);
    expect(caps.backend).toBe('wavelength');
    expect(Object.keys(caps.features).sort()).toEqual([...FEATURE_IDS].sort());
    for (const id of ['lightningSend', 'lightningReceive', 'onchainSend', 'onchainReceive', 'activity'] as const) {
      expect(isAvailable(caps, id)).toBe(true);
    }
    everyUnavailableHasAReason(caps);
  });

  it('never claims node features: no channels, Loop, sessions or assets', () => {
    const caps = wavelengthCapabilities(base);
    for (const id of ['channelSummary', 'loopSwaps', 'taprootAssets', 'sessionList', 'sessionRevoke'] as const) {
      expect(isAvailable(caps, id)).toBe(false);
    }
  });

  it('only honours the fee preferences the SDK accepts', () => {
    const caps = wavelengthCapabilities(base);
    expect(isAvailable(caps, 'lightningFeeLimit')).toBe(true); // SendRequest.maxFeeSat
    expect(isAvailable(caps, 'onchainFeePreference')).toBe(false); // no fee rate in SendRequest
    expect(isAvailable(caps, 'invoiceExpiry')).toBe(false); // ReceiveRequest has no expiry
  });

  it('an unreachable operator pauses send and receive with a reason; exits stay available', () => {
    const caps = wavelengthCapabilities({ ...base, operatorReachable: false });
    expect(unavailableReason(caps, 'lightningSend')).toMatch(/operator is unreachable/);
    expect(unavailableReason(caps, 'onchainReceive')).toMatch(/operator is unreachable/);
    expect(isAvailable(caps, 'unilateralExit')).toBe(true);
  });

  it('before a wallet exists, wallet features say so', () => {
    const caps = wavelengthCapabilities({ ...base, walletReady: false, operatorReachable: null });
    expect(unavailableReason(caps, 'balances')).toMatch(/once your wallet is set up/);
    expect(isAvailable(caps, 'createWallet')).toBe(true);
  });
});

describe('remote LND capabilities', () => {
  const base = {
    declared: LNC_REMOTE_DECLARATION.capabilities,
    connected: true,
    foregrounded: true,
    port: FULL_PORT,
    platform: NO_PLATFORM_SERVICES,
  };

  it('Lightning works; on-chain is declared by the backend but not exposed by the port', () => {
    const caps = remoteLndCapabilities(base);
    expect(caps.backend).toBe('remote-lnd');
    expect(isAvailable(caps, 'lightningSend')).toBe(true);
    expect(isAvailable(caps, 'lightningReceive')).toBe(true);
    expect(LNC_REMOTE_DECLARATION.capabilities.onchainSend).toBe(true);
    expect(unavailableReason(caps, 'onchainSend')).toMatch(/isn't available over this connection/);
    expect(isAvailable(caps, 'sendFeeQuote')).toBe(false);
    everyUnavailableHasAReason(caps);
  });

  it('feature-detects optional port methods', () => {
    const none = remoteLndCapabilities({
      ...base,
      port: { listLightningActivity: false, listSessions: false, revokeSession: false },
    });
    expect(isAvailable(none, 'activity')).toBe(false);
    expect(isAvailable(none, 'sessionList')).toBe(false);
    expect(isAvailable(none, 'sessionRevoke')).toBe(false);
    const full = remoteLndCapabilities(base);
    expect(isAvailable(full, 'activity')).toBe(true);
    expect(isAvailable(full, 'sessionRevoke')).toBe(true);
  });

  it('backgrounded or disconnected states block payments with a reason', () => {
    expect(unavailableReason(remoteLndCapabilities({ ...base, foregrounded: false }), 'lightningSend')).toMatch(
      /while the app is open/,
    );
    const offline = remoteLndCapabilities({ ...base, connected: false });
    expect(unavailableReason(offline, 'balances')).toMatch(/Connect to your node/);
  });

  it('never claims wallet creation or Ark exits on a remote node', () => {
    const caps = remoteLndCapabilities(base);
    for (const id of ['createWallet', 'restoreWallet', 'exitInformation', 'unilateralExit'] as const) {
      expect(isAvailable(caps, id)).toBe(false);
    }
  });
});

describe('device features', () => {
  it('are unavailable without injected services and available with them', () => {
    const without = wavelengthCapabilities({
      declared: WAVELENGTH_DECLARATION.capabilities,
      walletReady: true,
      operatorReachable: true,
      platform: NO_PLATFORM_SERVICES,
    });
    for (const id of ['qrScan', 'copyToClipboard', 'nativeShare', 'appLock', 'biometricUnlock'] as const) {
      expect(isAvailable(without, id)).toBe(false);
    }
    const store = new Map<string, string>();
    const withServices = remoteLndCapabilities({
      declared: LNC_REMOTE_DECLARATION.capabilities,
      connected: true,
      foregrounded: true,
      port: FULL_PORT,
      platform: {
        copyText: () => Promise.resolve(),
        scanQrCode: () => Promise.resolve(null),
        authenticateBiometric: () => Promise.resolve(true),
        secureStorage: {
          getItem: (k) => Promise.resolve(store.get(k) ?? null),
          setItem: (k, v) => Promise.resolve(void store.set(k, v)),
          removeItem: (k) => Promise.resolve(void store.delete(k)),
        },
      },
    });
    for (const id of ['qrScan', 'copyToClipboard', 'appLock', 'biometricUnlock'] as const) {
      expect(isAvailable(withServices, id)).toBe(true);
    }
    expect(isAvailable(withServices, 'fiatReference')).toBe(false);
  });
});
