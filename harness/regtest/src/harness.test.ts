import { describe, expect, it } from 'vitest';

import { isWalletAlreadyReady } from './harness.js';

/** RpcError look-alike: protobuf-ts RpcError extends Error with a message. */
const rpcError = (message: string): Error => Object.assign(new Error(message), { code: 2 });

describe('isWalletAlreadyReady', () => {
  it('matches the unlocker-gone error observed in CI', () => {
    expect(
      isWalletAlreadyReady(
        rpcError('wallet already unlocked, WalletUnlocker service is no longer available'),
      ),
    ).toBe(true);
  });

  it('matches the already-exists and already-initialized variants', () => {
    expect(isWalletAlreadyReady(rpcError('wallet already exists'))).toBe(true);
    expect(isWalletAlreadyReady(rpcError('wallet already initialized'))).toBe(true);
  });

  it('matches non-Error rejections carrying the same text', () => {
    expect(isWalletAlreadyReady('WalletUnlocker service is no longer available')).toBe(true);
  });

  it('never matches a wrong-password or transient failure', () => {
    expect(isWalletAlreadyReady(rpcError('invalid passphrase for main macaroon'))).toBe(false);
    expect(isWalletAlreadyReady(rpcError('unavailable: connection refused'))).toBe(false);
    expect(isWalletAlreadyReady(rpcError('deadline exceeded'))).toBe(false);
  });
});
