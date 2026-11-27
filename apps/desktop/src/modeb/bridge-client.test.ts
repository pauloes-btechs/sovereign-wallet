import { describe, expect, it } from 'vitest';
import { BridgeHttpError, sendMayHaveHappened } from './bridge-client.js';

describe('sendMayHaveHappened', () => {
  it('treats a lost response or a server-side failure as possibly sent', () => {
    expect(sendMayHaveHappened(new BridgeHttpError(0, 'fetch failed'))).toBe(true);
    expect(sendMayHaveHappened(new BridgeHttpError(502, 'deadline exceeded'))).toBe(true);
    expect(sendMayHaveHappened(new Error('anything else'))).toBe(true);
  });

  it('treats a 4xx rejection as nothing sent', () => {
    expect(sendMayHaveHappened(new BridgeHttpError(400, 'fee must be at least 1'))).toBe(false);
    expect(sendMayHaveHappened(new BridgeHttpError(409, 'wallet locked'))).toBe(false);
  });
});
