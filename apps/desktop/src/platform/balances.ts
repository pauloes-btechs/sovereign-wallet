/**
 * Balance accounting for the advanced wallet — the ONE place that decides
 * what each sat counts as, so no page double-counts funds.
 *
 * Sources and how they overlap:
 * - LND WalletBalance (on-chain): total = confirmed + unconfirmed. `locked`
 *   (leased UTXOs) and `reservedAnchor` are INSIDE confirmed — subtract, never add.
 * - LND ChannelBalance: `local` is what you can send; `remote` is the peer's
 *   side (receivable capacity, NOT yours); `pendingOpenLocal` is your side of
 *   channels still confirming (no longer in WalletBalance once broadcast);
 *   `localUnsettled` is in-flight HTLCs (already excluded from `local`).
 * - Loop swaps in flight: a Loop Out's funds stay in `local` until its
 *   payment settles, and a Loop In's on-chain HTLC leaves WalletBalance when
 *   published — so swaps are informational here, never added to the total.
 * - Pool accounts: a separate on-chain output owned by the Pool trader key,
 *   NOT part of LND's WalletBalance — counted once, as locked.
 *
 * Total owned = on-chain total + local + localUnsettled + pendingOpenLocal + pool accounts.
 * Receivable capacity (remote) is shown but never part of the total.
 */
import type { ChannelsView, WalletBalanceView } from '../modeb/bridge-client.js';

export interface PoolAccountLike {
  readonly valueSat: number;
  readonly state: string;
}

export interface Accounts {
  /** Everything you own, counted once. */
  readonly totalSat: number;
  /** On-chain, confirmed and free to spend now. */
  readonly onchainSpendableSat: number;
  /** On-chain, awaiting confirmation (incoming or change). */
  readonly onchainUnconfirmedSat: number;
  /** On-chain but not spendable: leased UTXOs + anchor reserve. */
  readonly onchainLockedSat: number;
  /** Lightning: what you can send now. */
  readonly lightningSpendableSat: number;
  /** Lightning: what peers could send you (not yours). */
  readonly lightningReceivableSat: number;
  /** Lightning: your side of channels still opening. */
  readonly channelsOpeningSat: number;
  /** Lightning: outgoing HTLCs in flight. */
  readonly lightningInFlightSat: number;
  /** In open Pool accounts (separate on-chain outputs). */
  readonly poolAccountsSat: number;
}

const n = (s: string | number | undefined): number => {
  const v = typeof s === 'number' ? s : Number(s ?? 0);
  return Number.isFinite(v) ? v : 0;
};

/** Pool account states whose value is still held by the account. */
const LIVE_POOL_STATES = new Set(['pending_open', 'pending_update', 'open', 'expired', 'pending_batch', 'pending_closed', 'expired_pending_update']);

export function computeAccounts(
  wallet: WalletBalanceView | undefined,
  channels: ChannelsView | undefined,
  poolAccounts: readonly PoolAccountLike[] = [],
): Accounts {
  const confirmed = n(wallet?.confirmedSat);
  const unconfirmed = n(wallet?.unconfirmedSat);
  const locked = n(wallet?.lockedSat) + n(wallet?.reservedAnchorSat);
  const onchainSpendable = Math.max(0, confirmed - locked);
  const onchainLocked = Math.min(confirmed, locked);

  const local = n(channels?.balance.localSat);
  const remote = n(channels?.balance.remoteSat);
  const opening = n(channels?.balance.pendingOpenLocalSat);
  const inFlight = n(channels?.balance.localUnsettledSat);

  const pool = poolAccounts.filter((a) => LIVE_POOL_STATES.has(a.state)).reduce((s, a) => s + Math.max(0, a.valueSat), 0);

  return {
    totalSat: onchainSpendable + onchainLocked + unconfirmed + local + inFlight + opening + pool,
    onchainSpendableSat: onchainSpendable,
    onchainUnconfirmedSat: unconfirmed,
    onchainLockedSat: onchainLocked,
    lightningSpendableSat: local,
    lightningReceivableSat: remote,
    channelsOpeningSat: opening,
    lightningInFlightSat: inFlight,
    poolAccountsSat: pool,
  };
}

/** Segments for the liquidity bar, in a fixed order. Receivable is shown after owned funds. */
export function fundSegments(a: Accounts) {
  return [
    { kind: 'onchain' as const, sats: a.onchainSpendableSat },
    { kind: 'outbound' as const, sats: a.lightningSpendableSat },
    { kind: 'locked' as const, sats: a.onchainUnconfirmedSat + a.onchainLockedSat + a.channelsOpeningSat + a.lightningInFlightSat + a.poolAccountsSat },
    { kind: 'inbound' as const, sats: a.lightningReceivableSat },
  ];
}
