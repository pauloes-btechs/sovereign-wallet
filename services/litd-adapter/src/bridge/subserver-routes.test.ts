import { describe, expect, it, vi } from 'vitest';
import { AddressType, Loop, OutPoint, Transaction, Utxo, type GetTransactionsRequest, type LightningClient, type ListUnspentRequest } from '@sovereign/litd-proto';
import { NO_ROUTE, routeSubServers } from './subserver-routes.js';
import { mapSwapStatus, mapUtxo, spentFromAddresses, SubServerHub, utxoAddressType } from './subservers.js';
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
    utxos: vi.fn(async () => ({ utxos: [], spentFromAddresses: [], unresolvedSpends: 0, historyTransactions: 0 })),
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

  it('refuses a Loop Out to a SegWit v2 (BIP-360 P2MR) destination with the reason', async () => {
    const hub = fakeHub();
    const call = routeSubServers(
      hub,
      'POST',
      '/loop/out',
      body({
        amountSat: 500_000,
        destAddress: 'bc1zzmv50jjgxxhww6ve4g5zpewrkjqhr06fyujpm20tuezdlxmfphcqfc80ve',
        authorization: { amountSat: 500_000, maxTotalFeeSat: 2_000 },
      }),
    );
    await expect(call).rejects.toThrow('Coins sent to a version-2 address before BIP-360 activates can be taken by anyone.');
    expect(await status(call)).toBe(400);
    expect(hub.loopOut).not.toHaveBeenCalled();
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

  it('serves GET /lnd/utxos from the hub', async () => {
    const hub = fakeHub();
    expect(await routeSubServers(hub, 'GET', '/lnd/utxos', body({}))).toEqual({
      utxos: [],
      spentFromAddresses: [],
      unresolvedSpends: 0,
      historyTransactions: 0,
    });
    expect(hub.utxos).toHaveBeenCalledOnce();
    expect(await routeSubServers(hub, 'POST', '/lnd/utxos', body({}))).toBe(NO_ROUTE);
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

// Display-order txid (what explorers print) and its raw little-endian bytes.
const TXID_A = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const TXID_A_RAW = Uint8Array.from(Buffer.from(TXID_A, 'hex').reverse());
const TXID_B = 'b'.repeat(63) + '1';
const TXID_C = 'c'.repeat(63) + '2';

describe('mapUtxo', () => {
  it('uses txid_str as-is (display order) and keeps the output index', () => {
    const v = mapUtxo(
      Utxo.create({
        addressType: AddressType.TAPROOT_PUBKEY,
        address: 'bcrt1pexample',
        amountSat: 50_000n,
        pkScript: '5120' + 'ab'.repeat(32),
        outpoint: OutPoint.create({ txidStr: TXID_A, txidBytes: TXID_A_RAW, outputIndex: 3 }),
        confirmations: 6n,
      }),
    );
    expect(v).toEqual({
      outpoint: `${TXID_A}:3`,
      address: 'bcrt1pexample',
      addressType: 'p2tr',
      amountSat: 50_000,
      confirmations: 6,
      pkScript: '5120' + 'ab'.repeat(32),
    });
  });

  it('reverses raw txid bytes when only txid_bytes is set', () => {
    const v = mapUtxo(Utxo.create({ outpoint: OutPoint.create({ txidBytes: TXID_A_RAW, outputIndex: 0 }) }));
    expect(v.outpoint).toBe(`${TXID_A}:0`);
  });

  it('collapses UNUSED_* address types onto their script family', () => {
    expect(utxoAddressType(AddressType.WITNESS_PUBKEY_HASH)).toBe('p2wkh');
    expect(utxoAddressType(AddressType.UNUSED_WITNESS_PUBKEY_HASH)).toBe('p2wkh');
    expect(utxoAddressType(AddressType.NESTED_PUBKEY_HASH)).toBe('np2wkh');
    expect(utxoAddressType(AddressType.UNUSED_NESTED_PUBKEY_HASH)).toBe('np2wkh');
    expect(utxoAddressType(AddressType.TAPROOT_PUBKEY)).toBe('p2tr');
    expect(utxoAddressType(AddressType.UNUSED_TAPROOT_PUBKEY)).toBe('p2tr');
    expect(utxoAddressType(99 as AddressType)).toBe('unknown');
  });
});

/** A: two receives to bcrt1qreused (0, 1) + one to bcrt1qfresh (2). B spends A:0. C spends a coin A/B never created. */
function history(): Transaction[] {
  return [
    Transaction.create({
      txHash: TXID_A,
      outputDetails: [
        { outputType: 2, address: 'bcrt1qreused', pkScript: '', outputIndex: 0n, amount: 1n, isOurAddress: true },
        { outputType: 2, address: 'bcrt1qreused', pkScript: '', outputIndex: 1n, amount: 1n, isOurAddress: true },
        { outputType: 2, address: 'bcrt1qfresh', pkScript: '', outputIndex: 2n, amount: 1n, isOurAddress: true },
        { outputType: 2, address: 'bcrt1qsomeoneelse', pkScript: '', outputIndex: 3n, amount: 1n, isOurAddress: false },
      ],
    }),
    Transaction.create({
      txHash: TXID_B,
      previousOutpoints: [
        { outpoint: `${TXID_A}:0`, isOurOutput: true },
        { outpoint: `${TXID_A}:3`, isOurOutput: false },
      ],
    }),
    Transaction.create({ txHash: TXID_C, previousOutpoints: [{ outpoint: `${'d'.repeat(64)}:0`, isOurOutput: true }] }),
  ];
}

describe('spentFromAddresses', () => {
  it('maps our spent inputs back to the address they were paid to, and counts spends it cannot map', () => {
    expect(spentFromAddresses(history())).toEqual({ addresses: ['bcrt1qreused'], unresolvedSpends: 1 });
  });

  it('never treats a foreign input as ours', () => {
    const txs = history().slice(0, 2);
    expect(spentFromAddresses(txs).addresses).not.toContain('bcrt1qsomeoneelse');
  });

  it('is empty for a wallet that never spent', () => {
    expect(spentFromAddresses(history().slice(0, 1))).toEqual({ addresses: [], unresolvedSpends: 0 });
  });
});

describe('SubServerHub.utxos', () => {
  it('asks LND for every confirmation depth and joins the spend history', async () => {
    const listUnspent = vi.fn((req: ListUnspentRequest) => ({
      response: Promise.resolve({
        utxos: [
          Utxo.create({ address: 'bcrt1qreused', amountSat: 10n, addressType: AddressType.WITNESS_PUBKEY_HASH, outpoint: OutPoint.create({ txidStr: TXID_A, outputIndex: 1 }) }),
          Utxo.create({ address: 'bcrt1qfresh', amountSat: 20n, addressType: AddressType.WITNESS_PUBKEY_HASH, outpoint: OutPoint.create({ txidStr: TXID_A, outputIndex: 2 }), confirmations: req.minConfs === 0 ? 0n : 1n }),
        ],
      }),
    }));
    const getTransactions = vi.fn((_req: GetTransactionsRequest) => ({ response: Promise.resolve({ transactions: history() }) }));
    const lightning = { listUnspent, getTransactions } as unknown as LightningClient;
    const hub = new SubServerHub({
      network: 'regtest',
      litdEndpoint: { rpcHost: '127.0.0.1', rpcPort: 1, tlsCertPath: '/nonexistent' },
      superMacaroonPath: '/nonexistent',
      plan: { extraSubServerArgs: [], operators: { loop: { mode: 'offline' }, pool: { mode: 'offline' } } },
      lightning: async () => lightning,
    });
    const v = await hub.utxos();
    expect(listUnspent.mock.calls[0]?.[0]).toMatchObject({ minConfs: 0, maxConfs: 2_147_483_647, account: '' });
    expect(v.utxos.map((u) => u.outpoint)).toEqual([`${TXID_A}:2`, `${TXID_A}:1`]);
    expect(v.spentFromAddresses).toEqual(['bcrt1qreused']);
    expect(v.unresolvedSpends).toBe(1);
    expect(v.historyTransactions).toBe(3);
  });
});
