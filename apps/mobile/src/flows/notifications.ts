/**
 * Home's contextual notices — derived only from live state the controllers
 * hold (balances, VTXO lifecycle, operator/connection status, the payment in
 * flight, the activity the backend returned). Nothing here is scheduled,
 * stored or invented: when the state that raised a notice goes away, so
 * does the notice. Every notice carries one action that goes somewhere real.
 */

import { describeUnilateralExit, vtxoStateLabel } from '@sovereign/ui/copy';
import type { BalanceBuckets, WalletCapabilities } from '@sovereign/wallet-core';
import type { ActivityItem, ActivityStatusFilter } from './activity.js';
import { isUnfinished, sortNewestFirst } from './activity.js';
import type { VtxoSummary } from './modeAController.js';
import type { RemoteBalances } from './modeBRemoteController.js';
import type { PrimaryTab } from './navigation.js';

export type NoticeTarget =
  /** Switch to a primary tab (its stack is kept). */
  | { readonly kind: 'tab'; readonly tab: PrimaryTab }
  /** Mode A: the "How this wallet works" screen (exit path, dependencies). */
  | { readonly kind: 'exit-information' }
  /** The liquidity screen (channels, what can be sent and received). */
  | { readonly kind: 'liquidity' }
  /** Mode B: back to pairing with a fresh phrase. */
  | { readonly kind: 'pair-again' }
  /** Activity, filtered. */
  | { readonly kind: 'activity'; readonly status: ActivityStatusFilter }
  /** One item's receipt. */
  | { readonly kind: 'transaction'; readonly id: string }
  /** Re-read the backend (balances, operator status). */
  | { readonly kind: 'refresh' };

export type NoticeTone = 'danger' | 'warning' | 'info' | 'positive';

export interface WalletNotice {
  /** Stable per kind of notice (React key, tests). */
  readonly id: string;
  readonly tone: NoticeTone;
  readonly title: string;
  readonly body: string;
  readonly action: { readonly label: string; readonly target: NoticeTarget };
}

const TONE_ORDER: Readonly<Record<NoticeTone, number>> = { danger: 0, warning: 1, info: 2, positive: 3 };

function byTone(notices: WalletNotice[]): WalletNotice[] {
  return notices
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => TONE_ORDER[a.notice.tone] - TONE_ORDER[b.notice.tone] || a.index - b.index)
    .map(({ notice }) => notice);
}

/** Notices about the activity the backend returned (shared by both modes). */
function activityNotices(items: readonly ActivityItem[], sending: boolean): WalletNotice[] {
  const notices: WalletNotice[] = [];
  const newest = sortNewestFirst(items)[0];
  if (newest !== undefined && newest.status === 'failed') {
    notices.push({
      id: 'last-payment-failed',
      tone: 'warning',
      title: newest.direction === 'out' ? 'Your last payment failed' : 'Your last receive failed',
      body: newest.failureReason ?? 'The wallet reported it as failed. No funds moved for it.',
      action: { label: 'View details', target: { kind: 'transaction', id: newest.id } },
    });
  }
  const pending = items.filter((item) => item.status === 'pending').length;
  // The in-flight send has its own notice; count the rest only when they add information.
  if (pending > 0 && !(sending && pending === 1)) {
    notices.push({
      id: 'pending-payments',
      tone: 'info',
      title: pending === 1 ? '1 payment pending' : `${pending} payments pending`,
      body: sending
        ? "Including the payment in flight. These haven't reached a final state yet."
        : "These haven't reached a final state yet.",
      action: { label: 'View pending', target: { kind: 'activity', status: 'pending' } },
    });
  }
  return notices;
}

const IN_FLIGHT: WalletNotice = {
  id: 'payment-in-flight',
  tone: 'warning',
  title: 'Payment in flight',
  body: "Your last payment hasn't reached a final state. Check its status before paying again.",
  action: { label: 'View progress', target: { kind: 'tab', tab: 'send' } },
};

// ——— Mode A ———

export interface WavelengthNoticeInput {
  readonly vtxo: VtxoSummary | null;
  readonly balances: BalanceBuckets | null;
  readonly balancesError: string | null;
  /** A payment was dispatched and has not reached a final state. */
  readonly paymentInFlight: boolean;
  /** Only when the activity read succeeded; null = not known. */
  readonly activity: readonly ActivityItem[] | null;
  readonly unilateralExit: WalletCapabilities['unilateralExit'];
}

export function wavelengthNotices(input: WavelengthNoticeInput): WalletNotice[] {
  const notices: WalletNotice[] = [];
  const { vtxo, balances } = input;

  if (balances === null && input.balancesError !== null) {
    notices.push({
      id: 'balances-unreadable',
      tone: 'danger',
      title: 'Balances could not be read',
      body: input.balancesError,
      action: { label: 'Try again', target: { kind: 'refresh' } },
    });
  }

  if (vtxo !== null) {
    const exitText = describeUnilateralExit(input.unilateralExit);
    if (vtxo.state === 'at-risk') {
      notices.push({
        id: 'vtxo-at-risk',
        tone: 'danger',
        title: vtxoStateLabel('at-risk'),
        body:
          (vtxo.operatorReachable
            ? 'Some funds could not be refreshed in time. They will exit to the on-chain balance.'
            : 'The swap operator is unreachable, so cooperative payments are paused. Your funds will exit to the on-chain balance without the operator.') +
          (input.unilateralExit !== 'unsupported' && exitText !== '' ? ` ${exitText}` : ''),
        action: { label: 'View exit information', target: { kind: 'exit-information' } },
      });
    } else if (!vtxo.operatorReachable) {
      notices.push({
        id: 'operator-unreachable',
        tone: 'warning',
        title: 'Ark operator unreachable',
        body: 'Sending and receiving are paused until the operator is back. Your funds stay yours.',
        action: { label: 'Check again', target: { kind: 'refresh' } },
      });
    }
    if (vtxo.state === 'expiring') {
      const hours = vtxo.hoursToExpiry;
      notices.push({
        id: 'vtxo-expiring',
        tone: 'warning',
        title: vtxoStateLabel('expiring'),
        body: `Your funds are being rolled forward automatically${
          hours !== null ? ` — next deadline in about ${hours} hour${hours === 1 ? '' : 's'}` : ''
        }.`,
        action: { label: 'View exit information', target: { kind: 'exit-information' } },
      });
    } else if (vtxo.state === 'exiting') {
      notices.push({
        id: 'vtxo-exiting',
        tone: 'info',
        title: vtxoStateLabel('exiting'),
        body: 'These funds are moving to the on-chain balance and will be spendable there. This cannot be cancelled.',
        action: { label: 'View exit information', target: { kind: 'exit-information' } },
      });
    }
  }

  const sending = input.paymentInFlight;
  if (sending) notices.push(IN_FLIGHT);
  if (input.activity !== null) notices.push(...activityNotices(input.activity, sending));

  if (balances !== null && input.activity !== null) {
    const spendable = balances.lightningSpendableSat + balances.onchainConfirmedSat;
    const unfinished = input.activity.some(isUnfinished);
    if (spendable === 0n && !unfinished) {
      const total =
        balances.onchainPendingSat + balances.lightningPendingSat + balances.lockedOrExpiringSat;
      notices.push(
        total === 0n
          ? {
              id: 'no-funds',
              tone: 'info',
              title: 'No funds yet',
              body: 'Receive a payment over Lightning or deposit on-chain to start using this wallet.',
              action: { label: 'Receive', target: { kind: 'tab', tab: 'receive' } },
            }
          : {
              id: 'nothing-spendable',
              tone: 'info',
              title: 'Nothing spendable right now',
              body: 'Your balance is pending or locked, so a payment cannot be sent until it settles.',
              action: { label: 'View exit information', target: { kind: 'exit-information' } },
            },
      );
    }
  }
  return byTone(notices);
}

// ——— Mode B ———

export interface RemoteNoticeInput {
  /** The LNC session is up (capabilities report balances available). */
  readonly connected: boolean;
  readonly balances: RemoteBalances | null;
  /** A payment was dispatched and has not reached a final state. */
  readonly paymentInFlight: boolean;
  readonly activity: readonly ActivityItem[] | null;
}

export function remoteNotices(input: RemoteNoticeInput): WalletNotice[] {
  const notices: WalletNotice[] = [];
  if (!input.connected) {
    notices.push({
      id: 'node-disconnected',
      tone: 'danger',
      title: 'Not connected to your node',
      body: 'Balances and payments need the connection. Pair again with a new phrase from your node.',
      action: { label: 'Pair again', target: { kind: 'pair-again' } },
    });
  }
  const sending = input.paymentInFlight;
  if (sending) notices.push(IN_FLIGHT);

  const balances = input.balances;
  if (input.connected && balances !== null) {
    const { channels } = balances;
    const active = channels.filter((c) => c.active);
    if (channels.length === 0) {
      notices.push({
        id: 'no-channels',
        tone: 'warning',
        title: 'No channels',
        body: 'Lightning payments need a channel. Channels are opened from the desktop app.',
        action: { label: 'View liquidity', target: { kind: 'liquidity' } },
      });
    } else if (active.length === 0) {
      notices.push({
        id: 'channels-offline',
        tone: 'warning',
        title: 'Channels offline',
        body: "None of your channels is active, so Lightning payments can't go through right now.",
        action: { label: 'View liquidity', target: { kind: 'liquidity' } },
      });
    } else {
      const outbound = active.reduce((sum, c) => sum + c.localSat, 0n);
      const inbound = active.reduce((sum, c) => sum + c.remoteSat, 0n);
      if (outbound === 0n) {
        notices.push({
          id: 'no-outbound',
          tone: 'info',
          title: 'No Lightning balance to spend',
          body: 'Your active channels hold nothing on your side. Receive over Lightning to add some.',
          action: { label: 'Receive', target: { kind: 'tab', tab: 'receive' } },
        });
      }
      if (inbound === 0n) {
        notices.push({
          id: 'no-inbound',
          tone: 'info',
          title: 'No receiving capacity',
          body: 'Your wallet currently has insufficient receiving capacity for Lightning payments.',
          action: { label: 'View liquidity', target: { kind: 'liquidity' } },
        });
      }
    }
  }
  if (input.activity !== null) notices.push(...activityNotices(input.activity, sending));
  return byTone(notices);
}
