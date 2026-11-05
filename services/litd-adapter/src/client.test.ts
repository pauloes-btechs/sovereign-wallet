import { describe, expect, it } from 'vitest';
import { isServiceUpEvidence } from './client.js';

describe('isServiceUpEvidence', () => {
  it('treats refusals that prove the service is registered as "serving"', () => {
    expect(isServiceUpEvidence('rpc error: code = Unknown desc = wallet already exists')).toBe(true);
    expect(isServiceUpEvidence('wallet already unlocked, WalletUnlocker service is no longer available')).toBe(true);
    expect(isServiceUpEvidence('wallet locked, unlock it to enable full RPC access')).toBe(true);
  });

  it('keeps retrying on startup and transport errors', () => {
    expect(isServiceUpEvidence('waiting to start, RPC services not available')).toBe(false);
    expect(isServiceUpEvidence('14 UNAVAILABLE: Connection dropped')).toBe(false);
  });
});
