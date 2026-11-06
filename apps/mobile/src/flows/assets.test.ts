import { describe, expect, it, vi } from 'vitest';
import type { AssetsPortExtension, RemoteAsset } from './assets.js';
import {
  RemoteAssetStore,
  assetAddressFormatError,
  assetTrust,
  decodedSendError,
  formatAssetUnits,
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

  it('a port without assets says unavailable', async () => {
    const store = new RemoteAssetStore({ port: {}, network: 'regtest', isForegrounded: () => true });
    await store.load();
    expect(store.getState().assetsStatus).toBe('unavailable');
    expect(store.surface()).toEqual({ list: false, history: false, receive: false, send: false });
  });
});
