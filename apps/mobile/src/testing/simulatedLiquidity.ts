/**
 * SimulatedLiquidityNode — the channels, Loop swap server and Taproot Assets
 * daemon behind `SimulatedLncPort`. Preview/test only; every result is
 * labelled simulated in the UI (`port.simulated`).
 *
 * The simulation follows the stated terms below, never shortcuts:
 * - Quotes are computed from SIM_LOOP (swap fee = base + ppm, a fixed
 *   prepayment, miner fee = fee rate × the transaction's vbytes).
 * - A swap starts only if every fee is within the limits sent (as loopd
 *   refuses), then moves through loopd's states over time (SIM_TIMELINE_MS),
 *   evaluated against the injected clock on every read. Balances move at the
 *   step where they would on a real node.
 * - A Loop Out larger than any single active channel can send fails with
 *   loopd's off-chain failure, and a Loop In that no single channel can
 *   receive times out and refunds on-chain (minus the miner fee).
 * - Asset sends deduct units, pay an anchor fee from the on-chain balance,
 *   and confirm after SIM_ASSET_CONFIRM_MS.
 */

import type { RemoteBalances } from '../flows/modeBRemoteController.js';
import { sha256Hex } from '../flows/modeBRemoteController.js';
import type { RemoteChannelDetail } from '../flows/liquidity.js';
import type {
  LoopDirection,
  LoopFailureReason,
  LoopInRequest,
  LoopOutRequest,
  LoopSwapStarted,
  LoopTerms,
  RemoteLoopQuote,
  RemoteSwap,
  RemoteSwapState,
} from '../flows/transfers.js';
import type { DecodedAssetAddress, RemoteAsset, RemoteAssetTransfer } from '../flows/assets.js';

/** The simulated swap server's stated terms. */
export const SIM_LOOP = {
  terms: {
    loopOut: { minSat: 100_000n, maxSat: 2_000_000n },
    loopIn: { minSat: 100_000n, maxSat: 2_000_000n },
  } satisfies LoopTerms,
  swapFeeBaseSat: 50n,
  swapFeePpm: 1_500n,
  prepayAmtSat: 1_337n,
  /** Starting miner fee rate; tests raise it with `setFeeRate`. */
  feeRateSatPerVbyte: 12n,
  sweepVbytes: 138n,
  htlcPublishVbytes: 154n,
  /** Routing actually paid by the simulated node: 0.05% of the amount. */
  routingPpm: 500n,
  confTarget: 9,
  cltvDelta: 144,
} as const;

/** When each state is reached, in ms after the swap starts. */
export const SIM_TIMELINE_MS: Readonly<Record<LoopDirection, readonly { state: RemoteSwapState; atMs: number }[]>> = {
  'loop-out': [
    { state: 'htlc-published', atMs: 4_000 },
    { state: 'preimage-revealed', atMs: 9_000 },
    { state: 'succeeded', atMs: 15_000 },
  ],
  'loop-in': [
    { state: 'htlc-published', atMs: 4_000 },
    { state: 'invoice-settled', atMs: 10_000 },
    { state: 'succeeded', atMs: 15_000 },
  ],
};
/** A doomed swap fails at this point. */
export const SIM_FAIL_AT_MS = { 'loop-out': 3_000, 'loop-in': 10_000 } as const;
export const SIM_ASSET_CONFIRM_MS = 10_000;
/** Simulated anchor transaction size for an asset send. */
export const SIM_ASSET_ANCHOR_VBYTES = 180n;

interface SimChannel {
  chanId: string;
  remotePubkey: string;
  peerAlias: string;
  active: boolean;
  localSat: bigint;
  remoteSat: bigint;
  capacitySat: bigint;
  localReserveSat: bigint;
  remoteReserveSat: bigint;
}

interface SimSwap {
  id: string;
  direction: LoopDirection;
  amountSat: bigint;
  swapFeeSat: bigint;
  minerFeeSat: bigint;
  routingSat: bigint;
  destIsNodeWallet: boolean;
  chanId: string | null;
  doomed: LoopFailureReason | null;
  startedMs: number;
  updatedMs: number;
  state: RemoteSwapState;
  failureReason: LoopFailureReason | null;
  costServerSat: bigint;
  costOnchainSat: bigint;
  costOffchainSat: bigint;
  htlcAddress: string;
  label: string;
}

const key = (n: number): string => `02${sha256Hex(`sim-peer-${n}`)}`.slice(0, 66);

export class SimulatedLiquidityNode {
  private onchainSat = 1_250_000n;
  private feeRate: bigint = SIM_LOOP.feeRateSatPerVbyte;
  private seq = 0;
  private readonly swaps = new Map<string, SimSwap>();
  private readonly channels: SimChannel[] = [
    {
      chanId: '812345x1x0',
      remotePubkey: key(1),
      peerAlias: 'sim-peer-alpha',
      active: true,
      localSat: 420_000n,
      remoteSat: 80_000n,
      capacitySat: 500_000n,
      localReserveSat: 5_000n,
      remoteReserveSat: 5_000n,
    },
    {
      chanId: '812400x3x1',
      remotePubkey: key(2),
      peerAlias: 'sim-peer-bravo',
      active: true,
      localSat: 1_170_000n,
      remoteSat: 30_000n,
      capacitySat: 1_200_000n,
      localReserveSat: 12_000n,
      remoteReserveSat: 12_000n,
    },
    {
      chanId: '812610x7x0',
      remotePubkey: key(3),
      peerAlias: 'sim-peer-charlie',
      active: false,
      localSat: 150_000n,
      remoteSat: 150_000n,
      capacitySat: 300_000n,
      localReserveSat: 3_000n,
      remoteReserveSat: 3_000n,
    },
  ];

  private readonly assets: { asset: RemoteAsset }[] = [
    {
      asset: {
        assetIdHex: sha256Hex('sim-asset-beans'),
        name: 'beans',
        type: 'normal',
        balance: 25_000n,
        decimalDisplay: null,
        groupKeyHex: null,
        metaHashHex: sha256Hex('sim-asset-beans-meta'),
        genesisPoint: `${sha256Hex('sim-genesis-beans')}:0`,
      },
    },
    {
      asset: {
        assetIdHex: sha256Hex('sim-asset-usdt-lookalike'),
        name: 'USDT',
        type: 'normal',
        balance: 500_000n,
        decimalDisplay: 2,
        groupKeyHex: null,
        metaHashHex: null,
        genesisPoint: `${sha256Hex('sim-genesis-usdt')}:1`,
      },
    },
  ];
  private readonly transfers: { transfer: RemoteAssetTransfer; confirmAtMs: number }[] = [];
  private readonly ownAddresses = new Set<string>();

  constructor(private readonly nowMs: () => number) {}

  /** Test hook: the miner fee rate quotes use from now on. */
  setFeeRate(satPerVbyte: bigint): void {
    this.feeRate = satPerVbyte;
  }

  // ——— balances / channels ———

  balances(): RemoteBalances {
    this.advance();
    const active = this.channels.filter((c) => c.active);
    return {
      lightningSpendableSat: active.reduce((s, c) => s + c.localSat, 0n),
      onchainConfirmedSat: this.onchainSat,
      channels: this.channels.map((c) => ({
        chanId: c.chanId,
        active: c.active,
        localSat: c.localSat,
        remoteSat: c.remoteSat,
        capacitySat: c.capacitySat,
      })),
    };
  }

  listChannels(): readonly RemoteChannelDetail[] {
    this.advance();
    return this.channels.map((c) => ({
      chanId: c.chanId,
      active: c.active,
      localSat: c.localSat,
      remoteSat: c.remoteSat,
      capacitySat: c.capacitySat,
      remotePubkey: c.remotePubkey,
      peerAlias: c.peerAlias,
      localReserveSat: c.localReserveSat,
      remoteReserveSat: c.remoteReserveSat,
      private: false,
    }));
  }

  // ——— Loop ———

  loopTerms(): LoopTerms {
    return SIM_LOOP.terms;
  }

  quote(direction: LoopDirection, amountSat: bigint): RemoteLoopQuote {
    const range = direction === 'loop-out' ? SIM_LOOP.terms.loopOut : SIM_LOOP.terms.loopIn;
    if (amountSat < range.minSat || amountSat > range.maxSat) {
      throw new Error(`amount out of the swap server's range (${range.minSat}–${range.maxSat} sats)`);
    }
    const swapFeeSat = SIM_LOOP.swapFeeBaseSat + (amountSat * SIM_LOOP.swapFeePpm) / 1_000_000n;
    const vbytes = direction === 'loop-out' ? SIM_LOOP.sweepVbytes : SIM_LOOP.htlcPublishVbytes;
    return {
      direction,
      amountSat,
      swapFeeSat,
      prepayAmtSat: direction === 'loop-out' ? SIM_LOOP.prepayAmtSat : 0n,
      minerFeeSat: this.feeRate * vbytes,
      confTarget: SIM_LOOP.confTarget,
      cltvDelta: SIM_LOOP.cltvDelta,
    };
  }

  loopOut(req: LoopOutRequest): LoopSwapStarted {
    this.advance();
    const q = this.quote('loop-out', req.amountSat);
    // loopd checks the server's fees against the client's limits before starting.
    if (q.swapFeeSat > req.maxSwapFeeSat) throw new Error('swap fee too high');
    if (q.prepayAmtSat > req.maxPrepayAmtSat) throw new Error('prepay amount too high');
    if (q.minerFeeSat > req.maxMinerFeeSat) throw new Error('miner fee too high');
    const routingSat = (req.amountSat * SIM_LOOP.routingPpm) / 1_000_000n;
    if (routingSat > req.maxSwapRoutingFeeSat) throw new Error('routing fee limit too low');
    const channel = this.channels
      .filter((c) => c.active && c.localSat - c.localReserveSat >= req.amountSat + routingSat)
      .sort((a, b) => (b.localSat > a.localSat ? 1 : -1))[0];
    const swap = this.newSwap('loop-out', req.amountSat, q, routingSat, req.label, {
      destIsNodeWallet: req.destAddress === null,
      chanId: channel?.chanId ?? null,
      doomed: channel === undefined ? 'offchain' : null,
    });
    if (channel !== undefined) channel.localSat -= req.amountSat + routingSat; // HTLCs in flight
    return { swapId: swap.id, htlcAddress: swap.htlcAddress };
  }

  loopIn(req: LoopInRequest): LoopSwapStarted {
    this.advance();
    const q = this.quote('loop-in', req.amountSat);
    if (q.swapFeeSat > req.maxSwapFeeSat) throw new Error('swap fee too high');
    if (q.minerFeeSat > req.maxMinerFeeSat) throw new Error('miner fee too high');
    if (this.onchainSat < req.amountSat + q.minerFeeSat) {
      throw new Error('insufficient confirmed on-chain balance for the HTLC and its miner fee');
    }
    const received = req.amountSat - q.swapFeeSat;
    const channel = this.channels
      .filter((c) => c.active && c.remoteSat - c.remoteReserveSat >= received)
      .sort((a, b) => (b.remoteSat > a.remoteSat ? 1 : -1))[0];
    const swap = this.newSwap('loop-in', req.amountSat, q, 0n, req.label, {
      destIsNodeWallet: true,
      chanId: channel?.chanId ?? null,
      doomed: channel === undefined ? 'timeout' : null,
    });
    // The HTLC transaction spends the amount plus its miner fee.
    this.onchainSat -= req.amountSat + q.minerFeeSat;
    return { swapId: swap.id, htlcAddress: swap.htlcAddress };
  }

  listSwaps(): readonly RemoteSwap[] {
    this.advance();
    return [...this.swaps.values()].map(view).reverse();
  }

  swapStatus(id: string): RemoteSwap {
    this.advance();
    const swap = this.swaps.get(id);
    if (swap === undefined) throw new Error(`swap ${id} not found`);
    return view(swap);
  }

  private newSwap(
    direction: LoopDirection,
    amountSat: bigint,
    q: RemoteLoopQuote,
    routingSat: bigint,
    label: string,
    extra: Pick<SimSwap, 'destIsNodeWallet' | 'chanId' | 'doomed'>,
  ): SimSwap {
    this.seq += 1;
    const now = this.nowMs();
    const swap: SimSwap = {
      id: sha256Hex(`sim-swap-${this.seq}-${now}`),
      direction,
      amountSat,
      swapFeeSat: q.swapFeeSat,
      minerFeeSat: q.minerFeeSat,
      routingSat,
      ...extra,
      startedMs: now,
      updatedMs: now,
      state: 'initiated',
      failureReason: null,
      costServerSat: 0n,
      costOnchainSat: 0n,
      costOffchainSat: 0n,
      htlcAddress: `bcrt1psimhtlc${sha256Hex(`htlc-${this.seq}`).slice(0, 44)}`,
      label,
    };
    this.swaps.set(swap.id, swap);
    return swap;
  }

  /** Applies every state transition whose time has come, with its balance effect. */
  private advance(): void {
    const now = this.nowMs();
    for (const swap of this.swaps.values()) {
      if (swap.state === 'succeeded' || swap.state === 'failed') continue;
      if (swap.doomed !== null && now - swap.startedMs >= SIM_FAIL_AT_MS[swap.direction]) {
        this.fail(swap, swap.doomed, swap.startedMs + SIM_FAIL_AT_MS[swap.direction]);
        continue;
      }
      for (const step of SIM_TIMELINE_MS[swap.direction]) {
        if (now - swap.startedMs < step.atMs || reached(swap.state, step.state, swap.direction)) continue;
        if (swap.doomed !== null && step.atMs >= SIM_FAIL_AT_MS[swap.direction]) break;
        this.enter(swap, step.state, swap.startedMs + step.atMs);
      }
    }
    for (const t of this.transfers) {
      if (t.transfer.status === 'unconfirmed' && now >= t.confirmAtMs) {
        t.transfer = { ...t.transfer, status: 'confirmed', blockHeight: 805_001 };
      }
    }
  }

  private enter(swap: SimSwap, state: RemoteSwapState, at: number): void {
    const channel = this.channels.find((c) => c.chanId === swap.chanId);
    if (swap.direction === 'loop-out') {
      if (state === 'preimage-revealed' && channel !== undefined) {
        channel.remoteSat += swap.amountSat; // swap + prepay invoices settle
        swap.costOffchainSat = swap.routingSat;
        swap.costServerSat = swap.swapFeeSat;
      }
      if (state === 'succeeded') {
        swap.costOnchainSat = swap.minerFeeSat;
        if (swap.destIsNodeWallet) this.onchainSat += swap.amountSat - swap.swapFeeSat - swap.minerFeeSat;
      }
    } else {
      if (state === 'htlc-published') swap.costOnchainSat = swap.minerFeeSat;
      if (state === 'invoice-settled' && channel !== undefined) {
        const received = swap.amountSat - swap.swapFeeSat;
        channel.localSat += received;
        channel.remoteSat -= received;
        swap.costServerSat = swap.swapFeeSat;
      }
    }
    swap.state = state;
    swap.updatedMs = at;
  }

  private fail(swap: SimSwap, reason: LoopFailureReason, at: number): void {
    if (swap.direction === 'loop-in') {
      // Timed out: the node sweeps the HTLC back; only the publish fee is lost.
      this.onchainSat += swap.amountSat;
      swap.costOnchainSat = swap.minerFeeSat;
    }
    swap.state = 'failed';
    swap.failureReason = reason;
    swap.updatedMs = at;
  }

  // ——— Taproot Assets ———

  listAssets(): readonly RemoteAsset[] {
    this.advance();
    return this.assets.map((a) => a.asset);
  }

  assetTransfers(): readonly RemoteAssetTransfer[] {
    this.advance();
    return this.transfers.map((t) => t.transfer).reverse();
  }

  newAssetAddress(assetIdHex: string, amount: bigint): string {
    if (!this.assets.some((a) => a.asset.assetIdHex === assetIdHex)) throw new Error('unknown asset id');
    if (amount <= 0n) throw new Error('amount must be positive');
    this.seq += 1;
    const address = simulatedAssetAddress(assetIdHex, amount, `own${this.seq}`);
    this.ownAddresses.add(address);
    return address;
  }

  decodeAssetAddress(address: string): DecodedAssetAddress {
    const decoded = decodeSimulatedAssetAddress(address);
    if (decoded === null) throw new Error('invalid address: not a Taproot Assets address this node can decode');
    return decoded;
  }

  sendAsset(address: string): { txid: string; chainFeeSat: bigint } {
    this.advance();
    const decoded = this.decodeAssetAddress(address);
    const held = this.assets.find((a) => a.asset.assetIdHex === decoded.assetIdHex);
    if (held === undefined) throw new Error('this node holds none of that asset');
    if (held.asset.balance < decoded.amount) throw new Error('insufficient asset balance');
    const chainFeeSat = this.feeRate * SIM_ASSET_ANCHOR_VBYTES;
    if (this.onchainSat < chainFeeSat) throw new Error('not enough on-chain funds to pay the anchor fee');
    this.onchainSat -= chainFeeSat;
    const self = this.ownAddresses.has(address.trim());
    if (!self) held.asset = { ...held.asset, balance: held.asset.balance - decoded.amount };
    this.seq += 1;
    const now = this.nowMs();
    const txid = sha256Hex(`sim-anchor-${this.seq}`);
    const base = { txid, assetIdHex: decoded.assetIdHex, amount: decoded.amount, status: 'unconfirmed' as const, blockHeight: null, at: new Date(now).toISOString() };
    this.transfers.push({ transfer: { ...base, direction: 'out', chainFeeSat }, confirmAtMs: now + SIM_ASSET_CONFIRM_MS });
    if (self) this.transfers.push({ transfer: { ...base, direction: 'in', chainFeeSat: null }, confirmAtMs: now + SIM_ASSET_CONFIRM_MS });
    return { txid, chainFeeSat };
  }
}

/** A simulated tap address: `taprt1sim` + asset id + amount + a tag (not bech32m; decodes only here). */
export function simulatedAssetAddress(assetIdHex: string, amount: bigint, tag = 'ext'): string {
  return `taprt1sim${assetIdHex}q${amount.toString()}q${tag}`;
}

export function decodeSimulatedAssetAddress(address: string): DecodedAssetAddress | null {
  const m = /^taprt1sim([0-9a-f]{64})q(\d+)q([a-z0-9]+)$/.exec(address.trim().toLowerCase());
  if (m === null) return null;
  return { assetIdHex: m[1] ?? '', amount: BigInt(m[2] ?? '0'), network: 'regtest' };
}

const ORDER: Readonly<Record<LoopDirection, readonly RemoteSwapState[]>> = {
  'loop-out': ['initiated', 'htlc-published', 'preimage-revealed', 'succeeded'],
  'loop-in': ['initiated', 'htlc-published', 'invoice-settled', 'succeeded'],
};

function reached(current: RemoteSwapState, target: RemoteSwapState, direction: LoopDirection): boolean {
  return ORDER[direction].indexOf(current) >= ORDER[direction].indexOf(target);
}

function view(s: SimSwap): RemoteSwap {
  return {
    id: s.id,
    direction: s.direction,
    state: s.state,
    failureReason: s.failureReason,
    amountSat: s.amountSat,
    costServerSat: s.costServerSat,
    costOnchainSat: s.costOnchainSat,
    costOffchainSat: s.costOffchainSat,
    htlcAddress: s.state === 'initiated' && s.direction === 'loop-out' ? null : s.htlcAddress,
    initiatedAt: new Date(s.startedMs).toISOString(),
    updatedAt: new Date(s.updatedMs).toISOString(),
    label: s.label,
  };
}
