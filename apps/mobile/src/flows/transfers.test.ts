import { describe, expect, it, vi } from 'vitest';
import { loopRoutingFeeCapSat } from '@sovereign/liquidity';
import { LNC_REMOTE_DECLARATION, WAVELENGTH_DECLARATION } from '@sovereign/wallet-core';
import { remoteLndCapabilities, wavelengthCapabilities } from './capabilities.js';
import { NO_PLATFORM_SERVICES } from './platform.js';
import type { LoopPortExtension, RemoteLoopQuote, RouteEnv, TransferEndpointId } from './transfers.js';
import {
  RemoteSwapStore,
  bitcoinAddressError,
  buildQuoteView,
  explainSwapFailure,
  hasRail,
  loopInFeeLimits,
  loopOutFeeLimits,
  quotedSwapError,
  recheckAuthorization,
  resolveTransferRoutes,
  swapAmountError,
  swapProgress,
  transferDestinations,
  transferSources,
  worstCaseFeeSat,
} from './transfers.js';
import { SimulatedLiquidityNode } from '../testing/simulatedLiquidity.js';

const remoteCaps = (loop = true) =>
  remoteLndCapabilities({
    declared: LNC_REMOTE_DECLARATION.capabilities,
    connected: true,
    foregrounded: true,
    port: { listLightningActivity: true, listSessions: false, revokeSession: false, loop, loopMonitor: loop, assets: true },
    platform: NO_PLATFORM_SERVICES,
  });

const remoteEnv = (over: Partial<RouteEnv> = {}): RouteEnv => ({
  backend: 'remote-lnd',
  features: remoteCaps().features,
  lightningSpendableSat: 500_000n,
  onchainSat: 1_000_000n,
  receivableSat: 300_000n,
  activeChannels: 2,
  loopRunnable: true,
  loopTermsError: null,
  assetCount: 2,
  ...over,
});

const wavelengthEnv = (): RouteEnv => ({
  backend: 'wavelength',
  features: wavelengthCapabilities({
    declared: WAVELENGTH_DECLARATION.capabilities,
    walletReady: true,
    operatorReachable: true,
    platform: NO_PLATFORM_SERVICES,
  }).features,
  lightningSpendableSat: 80_000n,
  onchainSat: null,
  receivableSat: null,
  activeChannels: null,
  loopRunnable: false,
  loopTermsError: null,
  assetCount: null,
});

const rails = (from: TransferEndpointId, to: TransferEndpointId, env: RouteEnv) =>
  resolveTransferRoutes(from, to, env).candidates.map((c) => c.adapter.rail);

describe('route resolution per backend', () => {
  it('remote node: Loop Out for Lightning → on-chain, Loop In for on-chain → Lightning', () => {
    const env = remoteEnv();
    expect(rails('lightning', 'onchain', env)).toEqual(['loop-out']);
    expect(rails('lightning', 'external-address', env)).toEqual(['loop-out']);
    expect(rails('onchain', 'lightning', env)).toEqual(['loop-in']);
    const out = resolveTransferRoutes('lightning', 'onchain', env).candidates[0];
    expect(out?.adapter.action).toEqual({ kind: 'swap', direction: 'loop-out' });
    expect(out?.blocker).toBeNull();
  });

  it('remote node: invoice and deposits hand off to Send / Receive', () => {
    const env = remoteEnv();
    const pay = resolveTransferRoutes('lightning', 'invoice', env).candidates[0];
    expect(pay?.adapter.action).toMatchObject({ kind: 'handoff', to: 'send-lightning' });
    const fund = resolveTransferRoutes('external-btc', 'lightning', env).candidates[0];
    expect(fund?.adapter.action).toMatchObject({ kind: 'handoff', to: 'receive-lightning' });
    // The port has no on-chain methods: the rail exists but says why it can't run.
    const deposit = resolveTransferRoutes('external-btc', 'onchain', env).candidates[0];
    expect(deposit?.adapter.rail).toBe('deposit-address');
    expect(deposit?.blocker?.reason).toMatch(/On-chain receive addresses aren't available over this connection/);
    const send = resolveTransferRoutes('onchain', 'external-address', env).candidates[0];
    expect(send?.blocker?.reason).toMatch(/On-chain sending isn't available/);
  });

  it('remote node: Loop routes are blocked with the reason when the port lacks Loop', () => {
    const env = remoteEnv({ features: remoteCaps(false).features, loopRunnable: false });
    const out = resolveTransferRoutes('lightning', 'onchain', env).candidates[0];
    expect(out?.blocker?.reason).toMatch(/Loop runs on your node, but this connection does not read it yet/);
  });

  it('remote node: blockers for missing funds, channels and swap-server errors', () => {
    expect(resolveTransferRoutes('lightning', 'onchain', remoteEnv({ activeChannels: 0 })).candidates[0]?.blocker?.reason).toMatch(/no active Lightning channel/);
    expect(resolveTransferRoutes('onchain', 'lightning', remoteEnv({ receivableSat: 0n })).candidates[0]?.blocker?.fix).toMatch(/Loop Out first/);
    expect(resolveTransferRoutes('onchain', 'lightning', remoteEnv({ loopTermsError: 'connection refused' })).candidates[0]?.blocker?.reason).toMatch(/connection refused/);
  });

  it('no fabricated bridges: other chains have no route on either backend', () => {
    for (const env of [remoteEnv(), wavelengthEnv()]) {
      const from = transferSources(env.backend)[0]?.id ?? 'wallet';
      const r = resolveTransferRoutes(from, 'other-chain', env);
      expect(r.candidates).toHaveLength(0);
      expect(r.noRoute?.reason).toMatch(/no cross-chain route/);
    }
  });

  it('Wavelength: only its real deposit / withdraw / pay routes, never Loop', () => {
    const env = wavelengthEnv();
    expect(transferSources('wavelength').map((s) => s.id)).toEqual(['wallet', 'external-btc', 'external-lightning']);
    expect(transferDestinations('wavelength').map((s) => s.id)).not.toContain('lightning');
    expect(rails('wallet', 'invoice', env)).toEqual(['wavelength-lightning-send']);
    expect(rails('wallet', 'external-address', env)).toEqual(['wavelength-onchain-send']);
    expect(rails('external-btc', 'wallet', env)).toEqual(['wavelength-boarding']);
    expect(rails('external-lightning', 'wallet', env)).toEqual(['wavelength-lightning-receive']);
    for (const from of transferSources('wavelength')) {
      for (const to of transferDestinations('wavelength')) {
        const r = resolveTransferRoutes(from.id, to.id, env);
        for (const c of r.candidates) {
          expect(c.adapter.backend).toBe('wavelength');
          expect(c.adapter.action.kind).toBe('handoff');
        }
      }
    }
    expect(hasRail('wavelength', 'lightning', 'onchain')).toBe(false);
  });
});

const outQuote: RemoteLoopQuote = {
  direction: 'loop-out',
  amountSat: 500_000n,
  swapFeeSat: 800n,
  prepayAmtSat: 1_337n,
  minerFeeSat: 1_656n,
  confTarget: 9,
  cltvDelta: 144,
};

describe('Loop quote and fee limits', () => {
  it('routing caps match @sovereign/liquidity (10 sats + 2% of swap and prepay)', () => {
    const view = buildQuoteView(outQuote);
    const expected = BigInt(loopRoutingFeeCapSat(500_000) + loopRoutingFeeCapSat(1_337));
    expect(view.routingFeeCapSat).toBe(expected);
    expect(view.routingFeeCapSat).toBe(10_010n + 36n);
    // The prepayment is part of the swap fee, never added to it.
    expect(view.totalFeeSat).toBe(800n + 1_656n + expected);
    expect(view.receivedSat).toBe(500_000n - 800n - 1_656n);
    expect(view.swapFeePpm).toBe(1_600);
  });

  it('Loop Out limits: swap fee, 2× miner, prepay, routing caps — as LiquidityManager sends', () => {
    expect(loopOutFeeLimits(outQuote)).toEqual({
      maxSwapFeeSat: 800n,
      maxMinerFeeSat: 3_312n,
      maxPrepayAmtSat: 1_337n,
      maxSwapRoutingFeeSat: BigInt(loopRoutingFeeCapSat(500_000)),
      maxPrepayRoutingFeeSat: BigInt(loopRoutingFeeCapSat(1_337)),
    });
    expect(worstCaseFeeSat(outQuote)).toBe(800n + 3_312n + 10_010n + 36n);
  });

  it('Loop In: no routing fee, receives amount minus swap fee', () => {
    const inQuote: RemoteLoopQuote = { ...outQuote, direction: 'loop-in', prepayAmtSat: 0n, minerFeeSat: 1_848n };
    const view = buildQuoteView(inQuote);
    expect(view.routingFeeCapSat).toBe(0n);
    expect(view.totalFeeSat).toBe(800n + 1_848n);
    expect(view.receivedSat).toBe(499_200n);
    expect(loopInFeeLimits(inQuote)).toEqual({ maxSwapFeeSat: 800n, maxMinerFeeSat: 3_696n });
  });

  it('maxTotalFeeSat re-check refuses a quote whose fees rose', () => {
    const reviewed = buildQuoteView(outQuote);
    const auth = { amountSat: reviewed.amountSat, maxTotalFeeSat: reviewed.totalFeeSat };
    expect(recheckAuthorization(reviewed, auth)).toBeNull();
    const higher = buildQuoteView({ ...outQuote, minerFeeSat: outQuote.minerFeeSat + 1n });
    expect(recheckAuthorization(higher, auth)).toMatch(/Fees changed since you reviewed this swap/);
    const other = buildQuoteView({ ...outQuote, amountSat: 400_000n });
    expect(recheckAuthorization(other, auth)).toMatch(/different amount/);
  });

  it('amount validation against terms and balances', () => {
    const terms = { loopOut: { minSat: 100_000n, maxSat: 1_000_000n }, loopIn: { minSat: 100_000n, maxSat: 1_000_000n } };
    const funds = { lightningSpendableSat: 300_000n, onchainSat: 200_000n, receivableSat: 150_000n };
    expect(swapAmountError('loop-out', '', terms, funds)).toBe('Enter an amount in sats.');
    expect(swapAmountError('loop-out', '1.5', terms, funds)).toBe('Enter a whole number of sats.');
    expect(swapAmountError('loop-out', '50000', terms, funds)).toMatch(/minimum is 100,000/);
    expect(swapAmountError('loop-out', '2,000,000', terms, funds)).toMatch(/maximum is 1,000,000/);
    expect(swapAmountError('loop-out', '400000', terms, funds)).toMatch(/Lightning spendable balance \(300,000/);
    expect(swapAmountError('loop-in', '250000', terms, funds)).toMatch(/confirmed on-chain balance \(200,000/);
    expect(swapAmountError('loop-out', '250,000', terms, funds)).toBeNull();
    const inView = buildQuoteView({ ...outQuote, direction: 'loop-in', amountSat: 180_000n, swapFeeSat: 320n, prepayAmtSat: 0n, minerFeeSat: 1_848n });
    expect(quotedSwapError(inView, funds)).toMatch(/Your channels can receive at most 150,000/);
    expect(quotedSwapError({ ...inView, amountSat: 199_000n, receivedSat: 100_000n }, funds)).toMatch(/plus the 1,848-sat miner fee/);
  });

  it('address check by network', () => {
    expect(bitcoinAddressError('', 'regtest')).toBeNull();
    expect(bitcoinAddressError('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 'regtest')).toBeNull();
    expect(bitcoinAddressError('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'regtest')).toMatch(/regtest/);
  });

  it('address checks use the full parser: checksum, network and unknown networks', () => {
    // A bech32 typo (last character changed) passed the old prefix/charset check.
    expect(bitcoinAddressError('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt081', 'regtest')).toMatch(/doesn't check out/);
    expect(bitcoinAddressError('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mainnet')).toBeNull();
    expect(bitcoinAddressError('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'bitcoin')).toBeNull();
    // A testnet base58 address on mainnet was accepted by the old regex.
    expect(bitcoinAddressError('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'mainnet')).toMatch(/testnet.*mainnet/);
    expect(bitcoinAddressError('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'testnet4')).toBeNull();
    expect(bitcoinAddressError('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3', 'mainnet')).toMatch(/doesn't check out/);
    expect(bitcoinAddressError('hello', 'regtest')).toMatch(/isn't a Bitcoin address/);
    expect(bitcoinAddressError('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'liquidv1')).toMatch(/doesn't recognize/);
  });

  it('failure explanations say what happened and what to do', () => {
    expect(explainSwapFailure('loop-out', 'offchain').what).toMatch(/could not pay the swap server/);
    expect(explainSwapFailure('loop-in', 'timeout').next).toMatch(/takes the funds back/);
    expect(explainSwapFailure('loop-in', null).what).toMatch(/without a reason/);
    const steps = swapProgress({ direction: 'loop-out', state: 'failed', failureReason: 'offchain' });
    expect(steps.map((s) => s.status)).toEqual(['done', 'failed']);
    expect(swapProgress({ direction: 'loop-in', state: 'htlc-published', failureReason: null }).map((s) => s.status)).toEqual([
      'done',
      'current',
      'pending',
      'pending',
    ]);
  });
});

describe('RemoteSwapStore over the simulated node', () => {
  const setup = (opts: { authorize?: (r: { reason: string }) => Promise<boolean>; foreground?: boolean } = {}) => {
    let now = Date.parse('2026-11-05T12:00:00Z');
    const node = new SimulatedLiquidityNode(() => now);
    const port: LoopPortExtension = {
      loopTerms: async () => node.loopTerms(),
      loopQuote: async (r) => node.quote(r.direction, r.amountSat),
      loopOut: async (r) => node.loopOut(r),
      loopIn: async (r) => node.loopIn(r),
      listSwaps: async () => node.listSwaps(),
      swapStatus: async (id) => node.swapStatus(id),
    };
    const store = new RemoteSwapStore({
      port,
      network: 'regtest',
      isForegrounded: () => opts.foreground ?? true,
      authorize: opts.authorize,
      pollIntervalMs: 60_000,
    });
    return { node, store, port, advance: (ms: number) => (now += ms) };
  };
  const funds = { lightningSpendableSat: 1_500_000n, onchainSat: 1_250_000n, receivableSat: 600_000n };

  it('quotes, reviews and starts a Loop Out with explicit limits', async () => {
    const { node, store } = setup();
    const spy = vi.spyOn(node, 'loopOut');
    await store.loadTerms();
    store.beginDraft('loop-out', 300_000n);
    await store.review(funds);
    expect(store.getState().draft?.stage).toBe('review');
    const id = await store.confirm();
    expect(id).not.toBeNull();
    const sent = spy.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ amountSat: 300_000n, destAddress: null, maxPrepayAmtSat: 1_337n });
    expect(sent?.maxSwapRoutingFeeSat).toBe(BigInt(loopRoutingFeeCapSat(300_000)));
    expect(sent?.maxPrepayRoutingFeeSat).toBe(BigInt(loopRoutingFeeCapSat(1_337)));
    expect(store.getState().draft).toBeNull();
    store.stop();
  });

  it('refuses to start when fees rose after review, and shows the new quote', async () => {
    const { node, store } = setup();
    const spy = vi.spyOn(node, 'loopOut');
    await store.loadTerms();
    store.beginDraft('loop-out', 300_000n);
    await store.review(funds);
    const reviewed = store.getState().draft?.quote?.totalFeeSat ?? 0n;
    node.setFeeRate(40n);
    expect(await store.confirm()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    const draft = store.getState().draft;
    expect(draft?.error).toMatch(/Fees changed since you reviewed this swap/);
    expect(draft?.stage).toBe('review');
    expect((draft?.quote?.totalFeeSat ?? 0n) > reviewed).toBe(true);
  });

  it('device authorization runs before anything starts; denial starts nothing', async () => {
    const authorize = vi.fn(async () => false);
    const { node, store } = setup({ authorize });
    const spy = vi.spyOn(node, 'loopIn');
    await store.loadTerms();
    store.beginDraft('loop-in', 200_000n);
    await store.review(funds);
    expect(await store.confirm()).toBeNull();
    expect(authorize).toHaveBeenCalledWith({ reason: 'Approve Loop In of 200,000 sats' });
    expect(spy).not.toHaveBeenCalled();
    expect(store.getState().draft?.error).toMatch(/Device authorization was not given/);
  });

  it('refuses while the app is in the background', async () => {
    const { store } = setup({ foreground: false });
    await store.loadTerms();
    store.beginDraft('loop-out', 300_000n);
    await store.review(funds);
    expect(await store.confirm()).toBeNull();
    expect(store.getState().draft?.error).toMatch(/only while the app is open/);
  });

  it('a start whose reply is lost says "may have started", blocks a re-confirm, and finds the swap by its label', async () => {
    const { node, store, port } = setup();
    const spy = vi.spyOn(node, 'loopOut');
    port.loopOut = async (r) => {
      await node.loopOut(r); // loopd started it…
      throw new Error('rpc error: code = Unavailable desc = transport is closing'); // …and the reply was lost
    };
    let lists = 0;
    const list = port.listSwaps;
    port.listSwaps = async () => {
      lists += 1;
      if (lists === 1) throw new Error('connection reset');
      return list === undefined ? [] : list();
    };
    await store.loadTerms();
    store.beginDraft('loop-out', 300_000n);
    await store.review(funds);
    expect(await store.confirm()).toBeNull();
    const draft = store.getState().draft;
    expect(draft?.stage).toBe('uncertain');
    expect(draft?.error).toMatch(/may have started/);
    expect(draft?.error).not.toMatch(/did not start/);
    expect(draft?.pendingStart?.amountSat).toBe(300_000n);

    // Blocked until the list is checked: no second start, no new draft.
    expect(await store.confirm()).toBeNull();
    store.backToEdit();
    store.beginDraft('loop-in', 200_000n);
    store.discardDraft();
    expect(store.getState().draft?.stage).toBe('uncertain');
    expect(spy).toHaveBeenCalledTimes(1);

    // The list read succeeds: the swap is found by the label this attempt set.
    const id = await store.checkUncertainStart();
    expect(id).not.toBeNull();
    const swap = (await node.listSwaps()).find((s) => s.id === id);
    expect(swap?.label).toBe(spy.mock.calls[0]?.[0].label);
    expect(swap?.label).toMatch(/^mobile loop-out /);
    expect(store.getState().draft).toBeNull();
    expect(store.getState().watchedId).toBe(id);
    expect(spy).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it('a lost reply for a swap that is not in the list goes back to review only after the list was read', async () => {
    const { node, store, port } = setup();
    port.loopIn = async () => {
      throw new Error('stream closed');
    };
    await store.loadTerms();
    store.beginDraft('loop-in', 200_000n);
    await store.review(funds);
    expect(await store.confirm()).toBeNull();
    // The check ran right away and the list had no such swap.
    const draft = store.getState().draft;
    expect(draft?.stage).toBe('review');
    expect(draft?.error).toMatch(/no swap from that attempt/);
    expect(draft?.error).not.toMatch(/did not start/);
    expect(await node.listSwaps()).toHaveLength(0);
  });

  it('each start attempt carries its own label', async () => {
    const { node, store } = setup();
    const spy = vi.spyOn(node, 'loopOut');
    await store.loadTerms();
    for (let i = 0; i < 2; i++) {
      store.beginDraft('loop-out', 300_000n);
      await store.review(funds);
      await store.confirm();
    }
    const [a, b] = spy.mock.calls.map((c) => c[0].label);
    expect(a).not.toBe(b);
    store.stop();
  });

  it('a port without Loop is reported unavailable, not as an error', async () => {
    const store = new RemoteSwapStore({ port: {}, network: 'regtest', isForegrounded: () => true });
    await store.loadTerms();
    await store.loadSwaps();
    expect(store.getState().termsStatus).toBe('unavailable');
    expect(store.getState().swapsStatus).toBe('unavailable');
    expect(store.surface()).toEqual({ run: false, monitor: false });
  });
});
