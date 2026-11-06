import { describe, expect, it, vi } from 'vitest';
import type { AssetsPortExtension, RemoteAsset } from './assets.js';
import {
  RemoteAssetStore,
  assetAddressFormatError,
  assetTrust,
  decodedSendError,
  formatAssetUnits,
  parseAssetAmount,
} from './assets.js';
import { SimulatedLiquidityNode, simulatedAssetAddress } from '../testing/simulatedLiquidity.js';

const asset: RemoteAsset = {
  assetIdHex: 'aa'.repeat(32),
  name: 'beans',
  type: 'normal',
  balance: 1_000n,
  decimalDisplay: null,
  groupKeyHex: null,
  metaHashHex: null,
  genesisPoint: null,
};

describe('asset trust', () => {
  it('every asset is issuer unverified in this build', () => {
    expect(assetTrust(asset).trust).toBe('issuer-claimed');
    expect(assetTrust(asset).stablecoinImpersonationRisk).toBe(false);
  });
  it('a stablecoin name is flagged as a possible imitation, never trusted', () => {
    const t = assetTrust({ ...asset, name: 'USDC' });
    expect(t.trust).toBe('issuer-claimed');
    expect(t.stablecoinImpersonationRisk).toBe(true);
    expect(t.label).toBe('USDC (unverified issuer)');
  });
});

describe('asset amounts', () => {
  it('formats with the declared decimal display', () => {
    expect(formatAssetUnits(500_000n, 2)).toBe('5,000');
    expect(formatAssetUnits(500_050n, 2)).toBe('5,000.5');
    expect(formatAssetUnits(1_234_567n, null)).toBe('1,234,567');
  });

  it('parses display units exactly into base units', () => {
    expect(parseAssetAmount('1.5', 2)).toEqual({ ok: true, units: 150n });
    expect(parseAssetAmount('0.01', 2)).toEqual({ ok: true, units: 1n });
    expect(parseAssetAmount('1,000.25', 2)).toEqual({ ok: true, units: 100_025n });
    // No float rounding, even at 18 decimals.
    expect(parseAssetAmount('0.1', 18)).toEqual({ ok: true, units: 100_000_000_000_000_000n });
    expect(parseAssetAmount('123456789.123456789123456789', 18)).toEqual({ ok: true, units: 123_456_789_123_456_789_123_456_789n });
    expect(parseAssetAmount('0.1234567891234567891', 18)).toEqual({ ok: false, error: 'This asset has at most 18 decimals.' });
    expect(parseAssetAmount('25', null)).toEqual({ ok: true, units: 25n });
    expect(parseAssetAmount('2.5', null)).toMatchObject({ ok: false, error: expect.stringMatching(/whole number/) });
    expect(parseAssetAmount('0.001', 2)).toMatchObject({ ok: false, error: 'This asset has at most 2 decimals.' });
    expect(parseAssetAmount('1,5', 2)).toMatchObject({ ok: false, error: expect.stringMatching(/Use a dot for decimals/) });
    expect(parseAssetAmount('0', 2)).toMatchObject({ ok: false });
    expect(parseAssetAmount('abc', 2)).toMatchObject({ ok: false });
  });
});

describe('send validation', () => {
  it('format check by network before asking the node', () => {
    expect(assetAddressFormatError('', 'regtest')).toBe('Paste a Taproot Assets address.');
    expect(assetAddressFormatError('bcrt1qxyz', 'regtest')).toMatch(/isn't a Taproot Assets address/);
    expect(assetAddressFormatError('tapbc1abc', 'regtest')).toMatch(/another network.*taprt1/);
    expect(assetAddressFormatError('taprt1abc', 'regtest')).toBeNull();
  });
  it('decoded address must be this asset, positive, within balance', () => {
    expect(decodedSendError({ assetIdHex: asset.assetIdHex, amount: 10n, network: 'regtest' }, asset)).toBeNull();
    expect(decodedSendError({ assetIdHex: 'bb'.repeat(32), amount: 10n, network: 'regtest' }, asset)).toMatch(/different asset/);
    expect(decodedSendError({ assetIdHex: asset.assetIdHex, amount: 0n, network: 'regtest' }, asset)).toMatch(/does not ask for an amount/);
    expect(decodedSendError({ assetIdHex: asset.assetIdHex, amount: 1_001n, network: 'regtest' }, asset)).toMatch(/more than the 1,000 you hold/);
    expect(decodedSendError({ assetIdHex: 'zz', amount: 1n, network: 'regtest' }, asset)).toMatch(/cannot read/);
  });
});

describe('RemoteAssetStore over the simulated node', () => {
  const setup = (authorize?: (r: { reason: string }) => Promise<boolean>) => {
    const sim = new SimulatedLiquidityNode(() => Date.parse('2026-11-05T12:00:00Z'));
    const port: AssetsPortExtension = {
      listAssets: async () => sim.listAssets(),
      assetTransfers: async () => sim.assetTransfers(),
      newAssetAddress: async (r) => ({ address: sim.newAssetAddress(r.assetIdHex, r.amount) }),
      decodeAssetAddress: async (a) => sim.decodeAssetAddress(a),
      sendAsset: async (r) => sim.sendAsset(r.address),
    };
    const store = new RemoteAssetStore({ port, network: 'regtest', isForegrounded: () => true, authorize });
    return { sim, store, port };
  };

  it('decode → review → send, then the balance and history update', async () => {
    const { store } = setup();
    await store.load();
    const beans = store.getState().assets?.find((a) => a.name === 'beans');
    if (beans === undefined) throw new Error('no beans');
    store.beginSend(beans.assetIdHex);
    store.editSendAddress(simulatedAssetAddress(beans.assetIdHex, 40n));
    await store.reviewSend();
    expect(store.getState().send?.stage).toBe('review');
    expect(store.getState().send?.decoded?.amount).toBe(40n);
    expect(await store.confirmSend()).toBe(true);
    expect(store.getState().send?.result?.chainFeeSat).toBeGreaterThan(0n);
    await store.load();
    expect(store.asset(beans.assetIdHex)?.balance).toBe(beans.balance - 40n);
    expect(store.transfersFor(beans.assetIdHex)[0]).toMatchObject({ direction: 'out', amount: 40n });
  });

  it('refuses an address for another asset before sending', async () => {
    const { store, port } = setup();
    const send = vi.spyOn(port, 'sendAsset');
    await store.load();
    const [first, second] = store.getState().assets ?? [];
    if (first === undefined || second === undefined) throw new Error('need two assets');
    store.beginSend(first.assetIdHex);
    store.editSendAddress(simulatedAssetAddress(second.assetIdHex, 1n));
    await store.reviewSend();
    expect(store.getState().send?.stage).toBe('edit');
    expect(store.getState().send?.error).toMatch(/different asset/);
    expect(send).not.toHaveBeenCalled();
  });

  it('device authorization denial sends nothing', async () => {
    const { store, port } = setup(async () => false);
    const send = vi.spyOn(port, 'sendAsset');
    await store.load();
    const beans = store.getState().assets?.find((a) => a.name === 'beans');
    if (beans === undefined) throw new Error('no beans');
    store.beginSend(beans.assetIdHex);
    store.editSendAddress(simulatedAssetAddress(beans.assetIdHex, 1n));
    await store.reviewSend();
    expect(await store.confirmSend()).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('receive needs a fixed amount and returns the node’s address', async () => {
    const { store } = setup();
    await store.load();
    const beans = store.getState().assets?.[0];
    if (beans === undefined) throw new Error('no asset');
    store.beginReceive(beans.assetIdHex);
    await store.createReceiveAddress();
    expect(store.getState().receive?.error).toMatch(/fixed amount/);
    store.editReceiveAmount('25');
    await store.createReceiveAddress();
    expect(store.getState().receive?.address).toMatch(/^taprt1sim/);
  });

  it('receive takes the amount in display units and asks the node for base units', async () => {
    const { store, port } = setup();
    const create = vi.spyOn(port, 'newAssetAddress');
    await store.load();
    const usdt = store.getState().assets?.find((a) => a.decimalDisplay === 2);
    if (usdt === undefined) throw new Error('no 2-decimal asset');
    store.beginReceive(usdt.assetIdHex);
    store.editReceiveAmount('1.5');
    await store.createReceiveAddress();
    expect(create).toHaveBeenCalledWith({ assetIdHex: usdt.assetIdHex, amount: 150n });
    expect(store.getState().receive?.addressUnits).toBe(150n);
    expect(formatAssetUnits(store.getState().receive?.addressUnits ?? 0n, usdt.decimalDisplay)).toBe('1.5');
    store.editReceiveAmount('1.505');
    await store.createReceiveAddress();
    expect(store.getState().receive?.error).toMatch(/at most 2 decimals/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a port without assets says unavailable', async () => {
    const store = new RemoteAssetStore({ port: {}, network: 'regtest', isForegrounded: () => true });
    await store.load();
    expect(store.getState().assetsStatus).toBe('unavailable');
    expect(store.surface()).toEqual({ list: false, history: false, receive: false, send: false });
  });
});
