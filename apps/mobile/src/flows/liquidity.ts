/**
 * Liquidity awareness on mobile — pure functions from live backend data to
 * plain-language status, warnings and recommended actions.
 *
 * Two backends, never presented as equivalent:
 * - Remote LND (Mode B): channels. Spendable = your side of active channels,
 *   receiving capacity = the peers' side. Low receiving capacity → Loop Out
 *   (moves your channel balance on-chain and leaves that room inbound); low
 *   sending capacity → Loop In (moves on-chain funds into your channels).
 * - Wavelength (Mode A): no channels. What can be spent is the wallet's
 *   settled balance; boarding deposits and expiring batches are reported as
 *   they are, never as channel balances.
 *
 * Home and other screens may call these helpers (e.g. `receiveCapacityWarning`
 * before showing an invoice, `liquidityAttention` for a contextual link).
 */

import type { BalanceBuckets } from '@sovereign/wallet-core';
import type { RemoteBalances, RemoteChannelSummary } from './modeBRemoteController.js';
import type { LoopDirection, LoopTerms, RemoteSwap } from './transfers.js';
import { groupSats, isTerminal } from './transfers.js';

// ——— remote LND: channels ———

/** A channel with the detail LND's ListChannels gives (peer, reserves). */
export interface RemoteChannelDetail extends RemoteChannelSummary {
  readonly remotePubkey: string;
  /** Peer alias from the node graph; null when the node doesn't know it. */
  readonly peerAlias: string | null;
  /** Reserve you must keep on your side (`local_constraints.chan_reserve_sat`). */
  readonly localReserveSat: bigint;
  /** Reserve the peer must keep on its side. */
  readonly remoteReserveSat: bigint;
  readonly private: boolean;
}

/**
 * Optional channel listing on the LNC port (lnc-rn: `lightning.listChannels`
 * + `getNodeInfo` for aliases). Without it, liquidity is computed from the
 * channel balances in `getBalances()` with no peer names or reserves.
 */
export interface ChannelPortExtension {
  listChannels?(): Promise<readonly RemoteChannelDetail[]>;
}

export interface ChannelLiquidityRow {
  readonly chanId: string;
  readonly label: string;
  readonly active: boolean;
  readonly capacitySat: bigint;
  /** What you can send through this channel now (after the reserve, when known). */
  readonly sendableSat: bigint;
  /** What this channel can receive now (after the peer's reserve, when known). */
  readonly receivableSat: bigint;
  readonly localSat: bigint;
  readonly remoteSat: bigint;
}

export interface ChannelLiquidity {
  readonly spendableSat: bigint;
  readonly receivableSat: bigint;
  /** The most one payment can send / receive through a single channel (no multi-path). */
  readonly largestSendSat: bigint;
  readonly largestReceiveSat: bigint;
  readonly activeChannels: number;
  readonly inactiveChannels: number;
  readonly capacitySat: bigint;
  /** True when reserves were known and subtracted. */
  readonly reservesApplied: boolean;
  readonly channels: readonly ChannelLiquidityRow[];
}

const max0 = (v: bigint): bigint => (v > 0n ? v : 0n);

function isDetail(c: RemoteChannelSummary | RemoteChannelDetail): c is RemoteChannelDetail {
  return 'localReserveSat' in c;
}

/** Spendable / receivable from channel balances; only active channels count. */
export function summarizeChannels(
  channels: readonly (RemoteChannelSummary | RemoteChannelDetail)[],
): ChannelLiquidity {
  const rows: ChannelLiquidityRow[] = channels.map((c) => {
    const detail = isDetail(c) ? c : null;
    const sendable = max0(c.localSat - (detail?.localReserveSat ?? 0n));
    const receivable = max0(c.remoteSat - (detail?.remoteReserveSat ?? 0n));
    return {
      chanId: c.chanId,
      label: detail?.peerAlias ?? (detail !== null ? shortKey(detail.remotePubkey) : `Channel ${c.chanId}`),
      active: c.active,
      capacitySat: c.capacitySat,
      sendableSat: c.active ? sendable : 0n,
      receivableSat: c.active ? receivable : 0n,
      localSat: c.localSat,
      remoteSat: c.remoteSat,
    };
  });
  const active = rows.filter((r) => r.active);
  const sum = (f: (r: ChannelLiquidityRow) => bigint): bigint => active.reduce((s, r) => s + f(r), 0n);
  const largest = (f: (r: ChannelLiquidityRow) => bigint): bigint => active.reduce((m, r) => (f(r) > m ? f(r) : m), 0n);
  return {
    spendableSat: sum((r) => r.sendableSat),
    receivableSat: sum((r) => r.receivableSat),
    largestSendSat: largest((r) => r.sendableSat),
    largestReceiveSat: largest((r) => r.receivableSat),
    activeChannels: active.length,
    inactiveChannels: rows.length - active.length,
    capacitySat: sum((r) => r.capacitySat),
    reservesApplied: channels.length > 0 && channels.every(isDetail),
    channels: rows,
  };
}

function shortKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key;
}

/** Share of a channel that is yours, 0–1 (for the per-channel bar). */
export function localShare(row: Pick<ChannelLiquidityRow, 'localSat' | 'remoteSat'>): number {
  const total = row.localSat + row.remoteSat;
  if (total === 0n) return 0;
  return Number((row.localSat * 10_000n) / total) / 10_000;
}

/** A supported action that resolves a liquidity problem. */
export interface LiquidityAction {
  readonly direction: LoopDirection;
  readonly label: string;
  /** Suggested size; the user can change it. Within the server's terms when they are known. */
  readonly amountSat: bigint;
  readonly explanation: string;
}

export interface LiquidityAdvice {
  readonly kind: 'no-channels' | 'all-inactive' | 'receive-low' | 'send-low' | 'healthy';
  readonly tone: 'info' | 'warning' | 'positive';
  readonly message: string;
  /** Present only when Loop can run over this connection and the action fits the funds. */
  readonly action: LiquidityAction | null;
  /** Why no action is offered, when a problem exists but can't be fixed from here. */
  readonly actionUnavailable: string | null;
}

/** Below this share of active capacity, a side is "low". */
export const LOW_SIDE_SHARE = 0.2;

/**
 * Plain-language assessment with the CORRECT direction:
 * - receiving capacity low → Loop Out (more inbound);
 * - sending capacity low → Loop In (more outbound).
 * The suggested size moves the balance toward half-and-half, clamped to the
 * source balance and to the server's terms.
 */
export function liquidityAdvice(
  liquidity: ChannelLiquidity,
  context: {
    readonly onchainSat: bigint;
    readonly loopAvailable: boolean;
    readonly loopUnavailableReason?: string;
    readonly terms: LoopTerms | null;
  },
): LiquidityAdvice {
  const none = (reason: string | undefined): string =>
    reason ?? "Loop isn't available over this connection, so this can't be fixed from the phone.";
  if (liquidity.activeChannels === 0 && liquidity.inactiveChannels === 0) {
    return {
      kind: 'no-channels',
      tone: 'warning',
      message:
        'Your node has no Lightning channels, so it can neither send nor receive over Lightning. Opening a channel is done from the desktop app.',
      action: null,
      actionUnavailable: 'Channels are opened from the desktop app.',
    };
  }
  if (liquidity.activeChannels === 0) {
    return {
      kind: 'all-inactive',
      tone: 'warning',
      message:
        "None of your channels is active right now (the peers are offline or the node is reconnecting), so Lightning payments can't go through. This usually resolves on its own.",
      action: null,
      actionUnavailable: 'Wait for the peers to come back online.',
    };
  }
  const total = liquidity.spendableSat + liquidity.receivableSat;
  const half = total / 2n;
  const low = (side: bigint): boolean => total > 0n && Number((side * 1000n) / total) / 1000 < LOW_SIDE_SHARE;

  if (low(liquidity.receivableSat)) {
    const want = clampToTerms(max0(half - liquidity.receivableSat), liquidity.spendableSat, context.terms?.loopOut ?? null);
    const action =
      context.loopAvailable && want !== null
        ? {
            direction: 'loop-out' as const,
            label: 'Loop Out to receive more',
            amountSat: want,
            explanation: `Moves ${groupSats(want)} sats of your Lightning balance on-chain, which frees about that much room to receive.`,
          }
        : null;
    return {
      kind: 'receive-low',
      tone: 'warning',
      message: `You can receive only ${groupSats(liquidity.receivableSat)} sats over Lightning right now; most of your channel balance is on your side.`,
      action,
      actionUnavailable: action === null ? (context.loopAvailable ? 'Your balance is below the swap server’s minimum for a Loop Out.' : none(context.loopUnavailableReason)) : null,
    };
  }
  if (low(liquidity.spendableSat)) {
    const want = clampToTerms(max0(half - liquidity.spendableSat), context.onchainSat, context.terms?.loopIn ?? null);
    const fitsInbound = want !== null && want <= liquidity.receivableSat;
    const action =
      context.loopAvailable && want !== null && fitsInbound
        ? {
            direction: 'loop-in' as const,
            label: 'Loop In to send more',
            amountSat: want,
            explanation: `Moves ${groupSats(want)} sats of your on-chain funds into your channels, so you can send about that much more.`,
          }
        : null;
    return {
      kind: 'send-low',
      tone: 'warning',
      message: `You can send only ${groupSats(liquidity.spendableSat)} sats over Lightning right now; most of your channel balance is on your peers' side.`,
      action,
      actionUnavailable:
        action === null
          ? context.loopAvailable
            ? 'Your confirmed on-chain balance is below the swap server’s minimum for a Loop In.'
            : none(context.loopUnavailableReason)
          : null,
    };
  }
  return {
    kind: 'healthy',
    tone: 'positive',
    message: `You can send up to ${groupSats(liquidity.spendableSat)} sats and receive up to ${groupSats(liquidity.receivableSat)} sats over Lightning.`,
    action: null,
    actionUnavailable: null,
  };
}

/** Clamp a wanted swap size to the source balance and server terms; null when below the minimum. */
export function clampToTerms(
  wantSat: bigint,
  sourceSat: bigint,
  range: { readonly minSat: bigint; readonly maxSat: bigint } | null,
): bigint | null {
  let amount = wantSat < sourceSat ? wantSat : sourceSat;
  if (range !== null) {
    if (amount > range.maxSat) amount = range.maxSat;
    if (amount < range.minSat) return sourceSat >= range.minSat ? range.minSat : null;
  }
  return amount > 0n ? amount : null;
}

/**
 * The receive-side warning for one payment (an invoice amount). Null when
 * the channels can take it. Uses the single largest channel too: without
 * multi-path, one channel must carry the whole payment.
 */
export function receiveCapacityWarning(liquidity: ChannelLiquidity, amountSat: bigint): string | null {
  if (amountSat <= 0n) return null;
  if (liquidity.activeChannels === 0) {
    return 'Your node has no active channel, so it cannot receive Lightning payments right now.';
  }
  if (amountSat > liquidity.receivableSat) {
    return `Your wallet currently has insufficient receiving capacity for this payment: it can receive up to ${groupSats(liquidity.receivableSat)} sats.`;
  }
  if (amountSat > liquidity.largestReceiveSat) {
    return `No single channel can receive ${groupSats(amountSat)} sats (the largest can take ${groupSats(liquidity.largestReceiveSat)}). It may still arrive if the sender splits the payment.`;
  }
  return null;
}

/** The send-side warning for one payment. Null when the channels can carry it. */
export function sendCapacityWarning(liquidity: ChannelLiquidity, amountSat: bigint): string | null {
  if (amountSat <= 0n) return null;
  if (liquidity.activeChannels === 0) {
    return 'Your node has no active channel, so it cannot send Lightning payments right now.';
  }
  if (amountSat > liquidity.spendableSat) {
    return `Your wallet currently has insufficient sending capacity for this payment: it can send up to ${groupSats(liquidity.spendableSat)} sats.`;
  }
  return null;
}

/**
 * One contextual entry for Home: a pending swap first (→ its progress), then
 * a liquidity problem (→ the liquidity screen). Null when nothing needs attention.
 * Built only from live data; never invents a notification.
 */
export type LiquidityAttention =
  | { readonly kind: 'pending-swap'; readonly message: string; readonly route: 'swap'; readonly params: { readonly id: string } }
  | { readonly kind: 'liquidity'; readonly message: string; readonly route: 'liquidity' };

export function liquidityAttention(
  balances: RemoteBalances | null,
  swaps: readonly RemoteSwap[] | null,
): LiquidityAttention | null {
  const pending = (swaps ?? []).filter((s) => !isTerminal(s.state));
  const newest = pending[0];
  if (newest !== undefined) {
    const what = newest.direction === 'loop-out' ? 'Loop Out' : 'Loop In';
    return {
      kind: 'pending-swap',
      message:
        pending.length === 1
          ? `${what} of ${groupSats(newest.amountSat)} sats in progress`
          : `${pending.length} swaps in progress`,
      route: 'swap',
      params: { id: newest.id },
    };
  }
  if (balances === null) return null;
  const liquidity = summarizeChannels(balances.channels);
  const advice = liquidityAdvice(liquidity, { onchainSat: balances.onchainConfirmedSat, loopAvailable: false, terms: null });
  if (advice.kind === 'healthy') return null;
  const short: Record<Exclude<LiquidityAdvice['kind'], 'healthy'>, string> = {
    'no-channels': 'No Lightning channels yet',
    'all-inactive': 'No channel is active right now',
    'receive-low': `Low receiving capacity: ${groupSats(liquidity.receivableSat)} sats`,
    'send-low': `Low sending capacity: ${groupSats(liquidity.spendableSat)} sats`,
  };
  return { kind: 'liquidity', message: short[advice.kind], route: 'liquidity' };
}

// ——— Wavelength: availability, not channels ———

export interface WavelengthAvailability {
  /** Settled wallet balance: spendable for Lightning and on-chain sends. */
  readonly spendableSat: bigint;
  /** In flight (incoming/outgoing payments, reserved credit). */
  readonly pendingSat: bigint;
  /** Boarding / on-chain funds not yet in a batch. */
  readonly onchainSat: bigint;
  /** Part of the spendable balance whose batch is expiring or at risk. */
  readonly expiringSat: bigint;
  readonly notes: readonly string[];
}

/**
 * Wavelength's real availability semantics from its balance buckets and the
 * VTXO summary. There are no channels and no receiving capacity to manage:
 * Lightning goes through the swap service, which sets its own limits.
 */
export function wavelengthAvailability(
  buckets: BalanceBuckets,
  vtxo: { readonly state: 'fresh' | 'expiring' | 'at-risk' | 'exiting'; readonly operatorReachable: boolean; readonly hoursToExpiry: number | null } | null,
): WavelengthAvailability {
  const notes: string[] = [];
  if (vtxo !== null && !vtxo.operatorReachable) {
    notes.push('The Ark operator is unreachable, so sending and receiving are paused. Your funds stay yours.');
  }
  if (vtxo?.state === 'expiring') {
    notes.push(
      vtxo.hoursToExpiry === null
        ? 'Part of your balance is in a batch that is expiring. The wallet renews it automatically while it can reach the operator.'
        : `Part of your balance is in a batch that expires in about ${vtxo.hoursToExpiry} h. The wallet renews it automatically while it can reach the operator.`,
    );
  }
  if (vtxo?.state === 'at-risk') {
    notes.push('Part of your balance is at risk of expiring. Open the app while online so the wallet can renew it, or see the exit information.');
  }
  if (vtxo?.state === 'exiting') {
    notes.push('Part of your balance is exiting on-chain and cannot be spent until the exit completes.');
  }
  if (buckets.onchainConfirmedSat + buckets.onchainPendingSat > 0n) {
    notes.push('On-chain deposits become spendable once they confirm and join the next batch.');
  }
  return {
    spendableSat: buckets.lightningSpendableSat,
    pendingSat: buckets.lightningPendingSat,
    onchainSat: buckets.onchainConfirmedSat + buckets.onchainPendingSat,
    expiringSat: buckets.lockedOrExpiringSat,
    notes,
  };
}

// ——— remote-node channel store ———

export interface RemoteChannelsState {
  /** Detailed channels from `listChannels`; null until read or when the port lacks it. */
  readonly channels: readonly RemoteChannelDetail[] | null;
  /** 'unavailable' = this connection can't list channels; balances' channel rows are used instead. */
  readonly status: 'idle' | 'loading' | 'loaded' | 'failed' | 'unavailable';
  readonly error: string | null;
}

export class RemoteChannelStore {
  private state: RemoteChannelsState = { channels: null, status: 'idle', error: null };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly port: ChannelPortExtension) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): RemoteChannelsState => this.state;

  async load(): Promise<void> {
    const list = this.port.listChannels;
    if (list === undefined) {
      this.set({ status: 'unavailable', error: null });
      return;
    }
    if (this.state.channels === null) this.set({ status: 'loading', error: null });
    try {
      this.set({ channels: await list.call(this.port), status: 'loaded', error: null });
    } catch (error) {
      this.set({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Detailed channels when read, else the balances' channel rows (no peers or reserves). */
  liquidity(balances: RemoteBalances | null): ChannelLiquidity | null {
    if (this.state.channels !== null) return summarizeChannels(this.state.channels);
    return balances === null ? null : summarizeChannels(balances.channels);
  }

  private set(partial: Partial<RemoteChannelsState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}
