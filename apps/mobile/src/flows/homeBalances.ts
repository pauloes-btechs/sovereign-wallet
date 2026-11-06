/**
 * What Home shows about money, per mode — pure, from the backend's own
 * numbers. Each line is tagged spendable, pending, locked or unavailable so
 * the screen never presents money the user cannot use as if they could.
 *
 * No double counting: Mode A buckets are disjoint by construction (see
 * `bucketsFromWireBalance` / `bucketsFromSdkBalance` in the Wavelength
 * adapter) and the total is the shared `providerTotalSat`. Ark VTXOs ARE the
 * Lightning-spendable balance in Mode A — there is no separate Ark line to
 * add. Mode B's total is Lightning + on-chain; receiving capacity is shown
 * apart and never added (it is the peers' money, not the user's).
 */

import { providerTotalSat } from '@sovereign/ui/totals';
import type { BalanceBuckets } from '@sovereign/wallet-core';
import type { RemoteBalances } from './modeBRemoteController.js';

export type BalanceState = 'spendable' | 'pending' | 'locked' | 'unavailable';

export const BALANCE_STATE_LABEL: Readonly<Record<BalanceState, string>> = {
  spendable: 'Spendable',
  pending: 'Pending',
  locked: 'Locked',
  unavailable: 'Unavailable',
};

/** Which fund color (desktop liquidity-bar segments) a line uses. */
export type FundSwatch = 'outbound' | 'onchain' | 'locked' | 'pending';

export interface BalanceLine {
  readonly key: string;
  readonly label: string;
  readonly sats: bigint;
  readonly state: BalanceState;
  readonly swatch: FundSwatch;
  /** Plain-language explanation under the line. */
  readonly note?: string;
}

export interface HomeBalanceView {
  /** Everything the user owns in this wallet; the lines below sum to it. */
  readonly totalSat: bigint;
  readonly lines: readonly BalanceLine[];
  /** Mode B: what the user's active channels can receive. Never part of the total. */
  readonly receiveCapacitySat: bigint | null;
  /** What this backend does not report, said once under the lines. */
  readonly footnote: string | null;
}

/** Mode A (Wavelength). `operatorReachable === false` pauses cooperative spending. */
export function wavelengthBalanceView(
  buckets: BalanceBuckets,
  operatorReachable: boolean | null,
): HomeBalanceView {
  const paused = operatorReachable === false;
  const lines: BalanceLine[] = [
    {
      key: 'lightning',
      label: 'Lightning (spendable)',
      sats: buckets.lightningSpendableSat,
      state: paused ? 'unavailable' : 'spendable',
      swatch: 'outbound',
      note: paused
        ? 'Held off-chain as Ark VTXOs. Paused while the Ark operator is unreachable.'
        : 'Held off-chain as Ark VTXOs; Lightning payments go through the swap service.',
    },
    {
      key: 'onchain',
      label: 'On-chain (confirmed)',
      sats: buckets.onchainConfirmedSat,
      state: 'spendable',
      swatch: 'onchain',
    },
  ];
  if (buckets.onchainPendingSat > 0n) {
    lines.push({
      key: 'onchain-pending',
      label: 'On-chain (unconfirmed)',
      sats: buckets.onchainPendingSat,
      state: 'pending',
      swatch: 'pending',
      note: 'Deposits waiting for confirmation.',
    });
  }
  if (buckets.lightningPendingSat > 0n) {
    lines.push({
      key: 'lightning-pending',
      label: 'Lightning (settling)',
      sats: buckets.lightningPendingSat,
      state: 'pending',
      swatch: 'pending',
      note: 'Payments the wallet has not finished settling.',
    });
  }
  lines.push({
    key: 'locked',
    label: 'Locked / expiring',
    sats: buckets.lockedOrExpiringSat,
    state: 'locked',
    swatch: 'locked',
    note:
      buckets.lockedOrExpiringSat > 0n
        ? 'Expiring funds are rolled forward automatically; funds in an exit move to on-chain.'
        : undefined,
  });
  return {
    totalSat: providerTotalSat(buckets),
    lines,
    receiveCapacitySat: null,
    footnote: null,
  };
}

/** Mode B (remote LND over LNC). */
export function remoteBalanceView(balances: RemoteBalances): HomeBalanceView {
  const { channels } = balances;
  const localSum = channels.reduce((sum, c) => sum + c.localSat, 0n);
  const inactiveLocal = channels.filter((c) => !c.active).reduce((sum, c) => sum + c.localSat, 0n);
  // Split off inactive channels' balance only when the node's spendable figure
  // is provably the sum of the channel balances it reported.
  const splitInactive = channels.length > 0 && localSum === balances.lightningSpendableSat && inactiveLocal > 0n;
  const lines: BalanceLine[] = [
    {
      key: 'lightning',
      label: 'Lightning (spendable)',
      sats: splitInactive ? balances.lightningSpendableSat - inactiveLocal : balances.lightningSpendableSat,
      state: 'spendable',
      swatch: 'outbound',
      note: 'Your side of your channels.',
    },
  ];
  if (splitInactive) {
    lines.push({
      key: 'lightning-inactive',
      label: 'Lightning (inactive channels)',
      sats: inactiveLocal,
      state: 'unavailable',
      swatch: 'locked',
      note: 'Spendable again once these channels are back online.',
    });
  }
  lines.push({
    key: 'onchain',
    label: 'On-chain (node wallet)',
    sats: balances.onchainConfirmedSat,
    state: 'spendable',
    swatch: 'onchain',
    note: "Confirmed. Spend it from the desktop app; this connection can't send on-chain.",
  });
  const activeChannels = channels.filter((c) => c.active);
  return {
    totalSat: balances.lightningSpendableSat + balances.onchainConfirmedSat,
    lines,
    receiveCapacitySat: channels.length === 0 ? null : activeChannels.reduce((sum, c) => sum + c.remoteSat, 0n),
    footnote: "Unconfirmed on-chain funds and channels still opening aren't reported over this connection.",
  };
}
