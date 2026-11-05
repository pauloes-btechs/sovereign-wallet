import { describe, expect, it, vi } from 'vitest';
import { Loop } from '@sovereign/litd-proto';
import { NO_ROUTE, routeSubServers } from './subserver-routes.js';
import { mapSwapStatus, type SubServerHub } from './subservers.js';
import { BridgeRequestError } from './session.js';

function fakeHub(): SubServerHub & Record<string, ReturnType<typeof vi.fn>> {
  const ok = () => vi.fn(async () => ({ ok: true }));
  return {
    services: ok(),
    loopTerms: ok(),
    loopQuote: ok(),
    swaps: vi.fn(async () => []),
    swap: ok(),
    loopOut: ok(),
    loopIn: ok(),
    staticAddress: ok(),
    newStaticAddress: ok(),
    staticLoopIn: ok(),
    autoloop: ok(),
    enableAutoloop: ok(),
    disableAutoloop: ok(),
    suggestSwaps: ok(),
    pool: ok(),
    assetsOverview: ok(),
    assetTransfers: vi.fn(async () => []),
    newAssetAddress: ok(),
    decodeAssetAddress: ok(),
    sendAsset: ok(),
  } as unknown as SubServerHub & Record<string, ReturnType<typeof vi.fn>>;
}

const body = (b: Record<string, unknown>) => async () => b;
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof BridgeRequestError ? e.httpStatus : -1;
  }
};

describe('sub-server routes', () => {
  it('leaves unknown paths to the core bridge', async () => {
    expect(await routeSubServers(fakeHub(), 'GET', '/channels', body({}))).toBe(NO_ROUTE);
  });

  it('refuses a Loop Out without a transaction-specific authorization', async () => {
    const hub = fakeHub();
    expect(await status(routeSubServers(hub, 'POST', '/loop/out', body({ amountSat: 500_000 })))).toBe(400);
    expect(hub.loopOut).not.toHaveBeenCalled();
  });

  it('passes a well-formed Loop Out through with its authorization', async () => {
    const hub = fakeHub();
    await routeSubServers(
      hub,
      'POST',
      '/loop/out',
      body({ amountSat: 500_000, destAddress: 'bcrt1qexample', outgoingChanIds: ['123'], authorization: { amountSat: 500_000, maxTotalFeeSat: 2_000 } }),
    );
    expect(hub.loopOut).toHaveBeenCalledWith(
      expect.objectContaining({ amountSat: 500_000, destAddress: 'bcrt1qexample', outgoingChanIds: ['123'], authorization: { amountSat: 500_000, maxTotalFeeSat: 2_000 } }),
    );
  });

  it('validates amounts, directions, pubkeys and outpoints', async () => {
    const hub = fakeHub();
    expect(await status(routeSubServers(hub, 'POST', '/loop/quote', body({ direction: 'sideways', amountSat: 1 })))).toBe(400);
    expect(await status(routeSubServers(hub, 'POST', '/loop/quote', body({ direction: 'loop-in', amountSat: -5 })))).toBe(400);
    expect(await status(routeSubServers(hub, 'POST', '/loop/quote', body({ direction: 'loop-in', amountSat: 1.5 })))).toBe(400);
    expect(
      await status(routeSubServers(hub, 'POST', '/loop/in', body({ amountSat: 1, lastHopPubkeyHex: 'nothex', authorization: { amountSat: 1, maxTotalFeeSat: 0 } }))),
    ).toBe(400);
    expect(
      await status(routeSubServers(hub, 'POST', '/loop/static/loop-in', body({ outpoints: ['nope'], authorization: { maxTotalFeeSat: 10 } }))),
    ).toBe(400);
  });

  it('requires the asset send authorization to name the reviewed address', async () => {
    const hub = fakeHub();
    expect(
      await status(routeSubServers(hub, 'POST', '/assets/send', body({ address: 'taprt1aaa', authorization: { address: 'taprt1bbb' } }))),
    ).toBe(400);
    await routeSubServers(hub, 'POST', '/assets/send', body({ address: 'taprt1aaa', authorization: { address: 'taprt1aaa' } }));
    expect(hub.sendAsset).toHaveBeenCalledWith('taprt1aaa');
  });

  it('only enables AutoLoop with an explicit enabled:true', async () => {
    const hub = fakeHub();
    expect(await status(routeSubServers(hub, 'POST', '/loop/autoloop', body({ enabled: 'yes' })))).toBe(400);
    await routeSubServers(hub, 'POST', '/loop/autoloop', body({ enabled: false }));
    expect(hub.disableAutoloop).toHaveBeenCalled();
    expect(hub.enableAutoloop).not.toHaveBeenCalled();
  });
});

describe('mapSwapStatus', () => {
  it('maps loopd swap status into a UI view with ms timestamps and hex id', () => {
    const view = mapSwapStatus(
      Loop.SwapStatus.create({
        amt: 250_000n,
        idBytes: new Uint8Array(32).fill(0xab),
        type: Loop.SwapType.LOOP_OUT,
        state: Loop.SwapState.SUCCESS,
        initiationTime: 1_700_000_000_000_000_000n,
        lastUpdateTime: 1_700_000_060_000_000_000n,
        costServer: 500n,
        costOnchain: 300n,
        costOffchain: 20n,
        htlcAddress: 'bcrt1phtlc',
        label: 'cold storage',
        outgoingChanSet: [42n],
      }),
    );
    expect(view).toMatchObject({
      id: 'ab'.repeat(32),
      kind: 'loop-out',
      state: 'success',
      done: true,
      failureReason: null,
      amountSat: 250_000,
      costServerSat: 500,
      initiatedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_060_000,
      outgoingChanIds: ['42'],
    });
  });

  it('names the failure reason of a failed swap', () => {
    const view = mapSwapStatus(
      Loop.SwapStatus.create({ type: Loop.SwapType.LOOP_IN, state: Loop.SwapState.FAILED, failureReason: Loop.FailureReason.TIMEOUT }),
    );
    expect(view).toMatchObject({ kind: 'loop-in', state: 'failed', done: true, failureReason: 'timeout' });
  });
});
