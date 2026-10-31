/**
 * Unit tests for LitdBridgeSession — the full state machine without a daemon:
 * phase probing (info + canary disambiguation), macaroon lifecycle, wallet
 * init/unlock gating, close-job lifecycle, payment stream consumption, and
 * the requireReady guard on every operation.
 */
import { describe, expect, it, vi } from 'vitest';

import type { CloseChannelRequest, PayReq, Payment } from '@sovereign/litd-proto';

import {
  BridgeRequestError,
  LitdBridgeSession,
  type LightningOps,
  type LitdBridgeDeps,
  type UnlockerOps,
} from './session.js';

const throwsBridge = async (fn: () => Promise<unknown>): Promise<BridgeRequestError> => {
  try {
    await fn();
  } catch (err) {
    // Only the bridge request error counts — anything else is a bug.
    if (err instanceof BridgeRequestError) return err;
    throw err;
  }
  throw new Error('expected BridgeRequestError, but nothing was thrown');
};

function asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

/** Minimal getInfo response the mapper accepts (fixture, cast like siblings). */
const infoResponse = {
  version: '0.21.5-beta',
  identityPubkey: '02pk',
  alias: 'test-node',
  syncedToChain: true,
  syncedToGraph: true,
  blockHeight: 101,
  numPeers: 0,
  numActiveChannels: 0,
  numPendingChannels: 0,
  numInactiveChannels: 0,
  uris: [],
  chains: [{ chain: 'bitcoin', network: 'regtest' }],
} as never;

interface Harness {
  readonly session: LitdBridgeSession;
  readonly unlocker: UnlockerOps & { calls: string[] };
  readonly lightning: LightningOps & { getInfoCount: () => number; setInfoError: (e?: Error) => void };
  readonly macaroon: { current: string | undefined };
}

function makeHarness(options: {
  readonly initialMacaroon?: string;
  readonly infoError?: Error;
} = {}): Harness {
  let infoError = options.infoError;
  let infoCount = 0;
  const macaroon = { current: options.initialMacaroon ?? 'aa'.repeat(32) };

  const unlocker = {
    calls: [] as string[],
    async genSeed() {
      unlocker.calls.push('genSeed');
      return { mnemonic: ['word'] };
    },
    async initWallet() {
      unlocker.calls.push('initWallet');
    },
    async unlockWallet(password: string) {
      unlocker.calls.push(`unlock:${password}`);
      throw new Error('2 UNKNOWN: wallet locked, unlock it via `lncli unlock` or the UnlockWallet gRPC');
    },
  };

  const lightning: LightningOps & { getInfoCount: () => number; setInfoError: (e?: Error) => void } = {
    async getInfo() {
      infoCount += 1;
      if (infoError !== undefined) throw infoError;
      return { response: infoResponse };
    },
    getInfoCount: () => infoCount,
    setInfoError: (e) => {
      infoError = e;
    },
    async walletBalance() {
      return { response: {} as never };
    },
    async channelBalance() {
      return { response: {} as never };
    },
    async newAddress() {
      return { address: 'bcrt1qtest' };
    },
    async sendCoins() {
      return { txid: 'tx-1' };
    },
    async estimateFee() {
      return { satPerVbyte: 2n, feeSat: 200n };
    },
    async listChannels() {
      return { response: { channels: [] } as never };
    },
    async pendingChannels() {
      return { response: {} as never };
    },
    async closedChannels() {
      return { response: { channels: [] } as never };
    },
    async connectPeer() {},
    async openChannelSync() {
      return { channelPoint: 'ab:0' };
    },
    closeChannel() {
      return asyncFrom([]);
    },
    async addInvoice() {
      return { paymentRequest: 'lnbcrt1abc', rHashHex: 'ff'.repeat(32) };
    },
    async decodePayReq() {
      return { response: { numSatoshis: 210n } as never as PayReq };
    },
    async listPayments() {
      return { response: { payments: [] } as never };
    },
    sendPaymentV2() {
      return asyncFrom([]);
    },
    async forwardingHistory() {
      return { response: { forwardingEvents: [] } as never };
    },
    async exportAllChannelBackups() {
      return { response: {} as never };
    },
    async restoreChannelBackups() {},
  };

  const deps: LitdBridgeDeps = {
    createUnlocker: async () => unlocker,
    createLightning: async () => lightning,
    readAdminMacaroon: async () => macaroon.current,
    canaryPassword: () => 'canary-not-a-real-password',
    macaroonWaitMs: 10,
  };

  return { session: new LitdBridgeSession(deps), unlocker, lightning, macaroon };
}

describe('wallet-phase probing', () => {
  it('reports ready with node info when getInfo succeeds', async () => {
    const h = makeHarness();
    const state = await h.session.state();
    expect(state.phase).toBe('ready');
    expect(state.info?.version).toBe('0.21.5-beta');
  });

  it('reports locked directly from the info error without the canary', async () => {
    const h = makeHarness({ infoError: new Error('2 UNKNOWN: wallet locked, unlock it via `lncli unlock` or the UnlockWallet gRPC') });
    const state = await h.session.state();
    expect(state.phase).toBe('locked');
    // The canary path is a fallback — the info error alone is evidence enough.
    expect(h.unlocker.calls).toHaveLength(0);
  });

  it('disambiguates an undetermined info error with the unlock canary → missing', async () => {
    const h = makeHarness({ infoError: new Error('12 UNIMPLEMENTED: unknown service lnrpc.Lightning') });
    // The canary attempt records the unlock call and surfaces the daemon's own
    // "not initialized" refusal; the fake unlocker always throws a locked
    // error, so reclassify: patch the unlocker to the missing-state refusal.
    h.unlocker.unlockWallet = async () => {
      h.unlocker.calls.push('unlock:canary');
      throw new Error('1 UNKNOWN: wallet not initialized');
    };
    const state = await h.session.state();
    expect(state.phase).toBe('missing');
    expect(state.error).toMatch(/unknown service lnrpc.Lightning/);
  });

  it('caches the probe — repeated calls inside the window hit the daemon once', async () => {
    const h = makeHarness();
    await h.session.state();
    await h.session.state();
    expect(h.lightning.getInfoCount()).toBe(1);
  });

  it('ignores the probe cache after a mutation clears it (unlock flow)', async () => {
    const h = makeHarness({ infoError: new Error('wallet locked') });
    await h.session.state(); // locked, cached
    h.lightning.setInfoError(undefined);
    h.unlocker.unlockWallet = async () => {
      h.unlocker.calls.push('unlock:real');
    };
    await h.session.unlockWallet('correct-horse');
    const state = await h.session.state();
    expect(state.phase).toBe('ready');
  });
});

describe('macaroon lifecycle', () => {
  it('recreates the lightning client when the macaroon changes', async () => {
    let created = 0;
    const macaroon = { current: 'aa'.repeat(32) };
    const base = makeHarness();
    const deps: LitdBridgeDeps = {
      createUnlocker: async () => {
        throw new Error('not used');
      },
      createLightning: async () => {
        created += 1;
        return base.lightning;
      },
      readAdminMacaroon: async () => macaroon.current,
    };
    const session = new LitdBridgeSession(deps);
    await session.state();
    // Second immediate state() hits the probe cache — no new client.
    await session.state();
    expect(created).toBe(1);
    macaroon.current = 'bb'.repeat(32); // e.g. re-created wallet on the same daemon
    // requireReady re-checks the macaroon outside the probe cache and rebuilds.
    await session.walletBalance();
    expect(created).toBe(2);
  });

  it('waits for the admin macaroon after init before serving ready operations', async () => {
    const macaroon = { current: undefined as string | undefined };
    const harness = makeHarness();
    const deps: LitdBridgeDeps = {
      createUnlocker: async () => harness.unlocker,
      createLightning: async () => harness.lightning,
      readAdminMacaroon: async () => macaroon.current,
      macaroonWaitMs: 60,
    };
    const session = new LitdBridgeSession(deps);
    // Seed the macaroon shortly after initWallet, like the daemon does.
    setTimeout(() => {
      macaroon.current = 'cc'.repeat(32);
    }, 20);
    harness.unlocker.unlockWallet = async () => {
      harness.unlocker.calls.push('unlock:canary-missing');
      throw new Error('1 UNKNOWN: wallet not initialized');
    };
    await session.initWallet({ mnemonic: ['word'], password: 'pw' });
    const state = await session.state();
    expect(state.phase).toBe('ready');
  });

  it('fails init honestly when the macaroon never appears', async () => {
    const harness = makeHarness();
    const deps: LitdBridgeDeps = {
      createUnlocker: async () => harness.unlocker,
      createLightning: async () => harness.lightning,
      readAdminMacaroon: async () => undefined,
      macaroonWaitMs: 5,
    };
    const session = new LitdBridgeSession(deps);
    harness.unlocker.unlockWallet = async () => {
      throw new Error('1 UNKNOWN: wallet not initialized');
    };
    const err = await throwsBridge(() => session.initWallet({ mnemonic: ['word'], password: 'pw' }));
    expect(err.httpStatus).toBe(502);
    expect(err.message).toMatch(/macaroon did not appear/);
  });
});

describe('wallet lifecycle gating', () => {
  it('refuses seed generation once the wallet exists', async () => {
    const h = makeHarness();
    const err = await throwsBridge(() => h.session.generateSeed());
    expect(err.httpStatus).toBe(409);
    expect(err.message).toMatch(/refusing to generate a seed/);
    expect(h.unlocker.calls).toHaveLength(0);
  });

  it('refuses unlock when the wallet is not locked', async () => {
    const h = makeHarness();
    const err = await throwsBridge(() => h.session.unlockWallet('pw'));
    expect(err.httpStatus).toBe(409);
  });

  it('refuses ready-only operations with 409 while locked', async () => {
    const h = makeHarness({ infoError: new Error('wallet locked') });
    const err = await throwsBridge(() => h.session.walletBalance());
    expect(err.httpStatus).toBe(409);
  });
});

describe('channel close jobs', () => {
  it('records pending txid then the closed summary from the stream', async () => {
    const h = makeHarness();
    let capturedRequest: CloseChannelRequest | undefined;
    h.lightning.closeChannel = (request) => {
      capturedRequest = request;
      return asyncFrom([
        { update: { oneofKind: 'closePending', closePending: { txid: new Uint8Array([0xab, 0xcd]), outputIndex: 0, feePerVbyte: 0n, localCloseTx: false } } },
        { update: { oneofKind: 'chanClose', chanClose: { closingTxid: new Uint8Array([0xab, 0xcd]), success: true, additionalOutputs: [] } } },
      ]);
    };
    const job = await h.session.closeChannel({ channelPoint: `${'ab'.repeat(32)}:0`, force: false });
    expect(job.state).toBe('closing');
    expect(capturedRequest).toBeDefined();
    // The job runs in the background; wait for the stream to finish.
    await vi.waitFor(() => {
      const done = h.session.closeJob(job.id);
      expect(done?.state).toBe('closed');
      expect(done?.closingTxid).toBe('abcd');
    });
  });

  it('surfaces stream failures on the job instead of throwing past the caller', async () => {
    const h = makeHarness();
    h.lightning.closeChannel = () =>
      ({
        async *[Symbol.asyncIterator]() {
          yield { update: { oneofKind: undefined } };
          throw new Error('channel not found');
        },
      } as AsyncIterable<{ update: { oneofKind: undefined } }>);
    const job = await h.session.closeChannel({ channelPoint: `${'ab'.repeat(32)}:0`, force: true });
    await vi.waitFor(() => {
      const done = h.session.closeJob(job.id);
      expect(done?.error).toMatch(/channel not found/);
    });
  });

  it('404s unknown close-job ids', () => {
    const h = makeHarness();
    expect(h.session.closeJob('0102030405060708')).toBeUndefined();
  });
});

describe('payment stream consumption', () => {
  it('resolves succeeded from terminal Payment.status 2', async () => {
    const h = makeHarness();
    h.lightning.sendPaymentV2 = () =>
      asyncFrom<Payment>([
        { status: 1 } as never,
        { status: 2, paymentHash: 'hh' } as never,
      ]);
    const outcome = await h.session.payInvoice({ paymentRequest: 'lnbcrt1abc' });
    expect(outcome.status).toBe('succeeded');
  });

  it('resolves failed from terminal Payment.status 3 with the failure reason', async () => {
    const h = makeHarness();
    h.lightning.sendPaymentV2 = () =>
      asyncFrom<Payment>([{ status: 3, failureReason: 2 } as never]);
    const outcome = await h.session.payInvoice({ paymentRequest: 'lnbcrt1abc' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toBe('no route found');
  });

  it('reports no-result when the stream ends without a terminal status', async () => {
    const h = makeHarness();
    h.lightning.sendPaymentV2 = () => asyncFrom<Payment>([{ status: 1 } as never]);
    const outcome = await h.session.payInvoice({ paymentRequest: 'lnbcrt1abc' });
    expect(outcome.status).toBe('no-result');
  });
});

describe('diagnostics and backups', () => {
  it('renders faraday unavailability as an honest state, never a crash', async () => {
    const h = makeHarness();
    const deps: LitdBridgeDeps = {
      createUnlocker: async () => h.unlocker,
      createLightning: async () => h.lightning,
      readAdminMacaroon: async () => 'aa'.repeat(32),
      createFaraday: async () => {
        throw new Error('faraday subserver not registered');
      },
    };
    const session = new LitdBridgeSession(deps);
    const diagnostics = await session.diagnostics();
    expect(diagnostics.faraday.available).toBe(false);
    expect(diagnostics.faraday.error).toMatch(/faraday subserver/);
  });

  it('exports and restores channel backups through the session', async () => {
    const h = makeHarness();
    h.lightning.exportAllChannelBackups = async () =>
      ({ response: { multiChanBackup: { multiChanBackup: new Uint8Array([1, 2, 3]) } } } as never);
    const exported = await h.session.exportChannelBackups();
    expect(exported.multiChanBackupHex).toBe('010203');

    let restored: string | undefined;
    h.lightning.restoreChannelBackups = async (hex) => {
      restored = hex;
    };
    await h.session.restoreChannelBackups('deadbeef'.repeat(8));
    expect(restored).toBe('deadbeef'.repeat(8));
  });
});
