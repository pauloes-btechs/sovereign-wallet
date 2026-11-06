/**
 * Mode adapters for the unified Send view: each turns its controller's
 * state into a `SendViewModel`, and applies the payment preferences the
 * backend accepts.
 *
 * - Everyday wallet (Wavelength): the review is the daemon's live quote
 *   (`prepareSend`). The maximum Lightning fee preference becomes the
 *   quote's `maxFeeSat` — a quote above it is refused before anything is
 *   persisted. On-chain sends have no fee-rate control in the SDK; the
 *   quoted fee is shown and must be confirmed.
 * - Your node (LND over LNC): the invoice is decoded on the phone; LND can't
 *   quote a route over this connection, so the review shows the fee LIMIT
 *   (from the maximum Lightning fee preference) and the payment timeout,
 *   both sent with the payment and enforced by the node.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ModeAController, ModeAState } from '../../flows/modeAController.js';
import type { ModeBRemoteController, ModeBRemoteState } from '../../flows/modeBRemoteController.js';
import { decodeBolt11, knownBitcoinNetwork } from '../../flows/destination.js';
import { lightningFeeCapSat } from '../../flows/preferences.js';
import type { Preferences } from '../../flows/preferences.js';
import {
  REMOTE_LND_RAIL_RULES,
  WAVELENGTH_RAIL_RULES,
  timeExpectation,
} from '../../flows/sendFlow.js';
import type { SendRail } from '../../flows/sendFlow.js';
import { useAmountFormatter, usePreferences } from '../appContext.js';
import { formatAmount } from '../format.js';
import { SendView } from './SendView.js';
import type { SendReceiptModel, SendReviewModel, SendViewModel, SendViewStatus } from './SendView.js';


/** "Maximum Lightning fee: 125 sats (0.5% of the amount, at least 10 sats) — from your payment preferences." */
export function lightningFeePolicyText(
  preferences: Preferences,
  amountSat: bigint | null,
  format: (sats: bigint) => string,
  enforcement: string,
): string {
  const percent = preferences.maxLightningFeePpm / 10_000;
  const rule = `${percent}% of the amount, at least ${formatAmount(BigInt(preferences.maxLightningFeeSat), { denomination: 'sats' })}`;
  const cap = amountSat === null ? null : lightningFeeCapSat(preferences, amountSat);
  return `${cap === null ? 'Maximum Lightning fee' : `Maximum Lightning fee: ${format(cap)}`} (${rule}) — from your payment preferences. ${enforcement}`;
}

// ——— Everyday wallet ———

export function ModeASendScreen({
  controller,
  state,
  network,
}: {
  controller: ModeAController;
  state: ModeAState;
  network: string;
}): ReactNode {
  const { preferences } = usePreferences();
  const amounts = useAmountFormatter();
  const [checking, setChecking] = useState(false);
  const capabilities = controller.walletCapabilities();
  const quote = state.sendQuote;

  // Look up the settled payment's recorded fee once (the Activity read).
  const settled = state.sendStatus === 'settled';
  useEffect(() => {
    if (settled) void controller.loadActivity();
  }, [settled, controller]);

  const decodedInvoice = quote !== null && quote.rail === 'lightning' ? decodeBolt11(quote.destination) : null;
  const invoice = decodedInvoice !== null && decodedInvoice.ok ? decodedInvoice.invoice : null;

  const review: SendReviewModel | null =
    quote === null
      ? null
      : {
          rail: quote.rail,
          source: 'Everyday wallet balance',
          recipient: quote.destination,
          recipientNote: invoice?.description ?? null,
          amountSat: quote.amountSat,
          fee: {
            kind: 'quoted',
            label: quote.rail === 'lightning' ? 'Service fee' : 'Fee',
            feeSat: quote.feeSat,
            known: quote.feeKnown,
            note:
              quote.rail === 'lightning'
                ? `Quoted by the swap service that pays the invoice.${quote.maxFeeSat !== null ? ` Your limit for this payment: ${amounts.format(BigInt(quote.maxFeeSat))}.` : ''}`
                : 'Quoted by the wallet for this on-chain send. The wallet picks the fee rate; this app cannot change it.',
          },
          totalSat: quote.totalSat,
          totalIsMaximum: false,
          timing: timeExpectation(quote.rail, 'wavelength'),
          notices: [
            ...(quote.warning !== null ? [quote.warning] : []),
            ...(quote.rail === 'onchain'
              ? ["On-chain payments can't be reversed. Check the address with the recipient before you confirm."]
              : []),
          ],
          validUntil: invoice?.expiresAt ?? quote.expiresAtUnix,
          validUntilLabel: invoice !== null ? 'Invoice expires' : 'Quote valid until',
        };

  const recorded =
    quote !== null && quote.paymentHash !== null
      ? (state.activityDetails ?? []).find((d) => d.paymentHash === quote.paymentHash && d.record.direction === 'out')
      : undefined;
  const receipt: SendReceiptModel | null =
    quote === null
      ? null
      : {
          rail: quote.rail,
          recipient: quote.destination,
          amountSat: quote.amountSat,
          feeSat: recorded !== undefined ? recorded.feeSat : quote.feeSat,
          feeLabel: recorded !== undefined ? 'Fee' : 'Fee (as quoted)',
          completedAt: state.sendCompletedAt,
          reference: quote.paymentHash ?? recorded?.txid ?? null,
          referenceLabel: quote.paymentHash !== null ? 'Payment hash' : 'Transaction',
        };

  const status: SendViewStatus =
    state.sendStatus === 'idle'
      ? 'compose'
      : state.sendStatus === 'review'
        ? 'review'
        : state.sendStatus === 'sending'
          ? 'in-flight'
          : state.sendStatus;

  const model: SendViewModel = {
    title: 'Send',
    subtitle: 'From your everyday wallet',
    // An unrecognized network is never treated as mainnet: Send says why it is off.
    network: knownBitcoinNetwork(network),
    networkName: network,
    capabilities,
    rules: WAVELENGTH_RAIL_RULES,
    status,
    quoting: state.busy && state.sendStatus === 'idle',
    draftText: state.sendDestination,
    onDraftText: (text) => controller.setSendDestination(text),
    amountText: state.sendAmountText,
    onAmountText: (text) => controller.setSendAmount(text),
    // A quote failure is shown on the compose step (the draft is kept).
    error: state.sendError,
    review,
    receipt,
    spendableSat: () => state.balances?.lightningSpendableSat ?? null,
    feePolicy: (rail: SendRail, amountSat) =>
      rail === 'lightning'
        ? lightningFeePolicyText(preferences, amountSat, (s) => amounts.format(s), 'A quote above it is refused before anything is sent.')
        : 'On-chain fee: the wallet picks the fee rate and quotes the fee before you confirm. No maximum applies to on-chain sends.',
    onReview: ({ rail, destination, amountSat }) => {
      const target = rail === 'lightning' ? destination.lightning?.invoice : destination.onchain?.address;
      if (target === undefined) return;
      void controller.reviewPayment({
        rail,
        destination: target,
        amountSat,
        maxFeeSat: rail === 'lightning' ? Number(lightningFeeCapSat(preferences, amountSat)) : undefined,
        note: rail === 'onchain' ? (destination.label ?? destination.message ?? undefined) : undefined,
      });
    },
    onConfirm: () => controller.confirmSend(),
    onEdit: () => controller.editSend(),
    onCheckStatus: () => {
      setChecking(true);
      controller.reconcilePending().finally(() => setChecking(false));
    },
    checkingStatus: checking,
    onSendAnother: () => controller.sendAnother(),
    onDone: () => controller.backToHome(),
    onOpenActivity: () => controller.selectTab('activity'),
    hapticsEnabled: preferences.haptics,
  };
  // A failed quote returns to compose with the error; a failed payment shows the failure step.
  const composeError = state.sendStatus === 'failed' && state.sendQuote === null;
  return <SendView model={composeError ? { ...model, status: 'compose' } : model} />;
}

// ——— Your node (remote LND) ———

export function ModeBSendScreen({
  controller,
  state,
  network,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
  network: string;
}): ReactNode {
  const { preferences } = usePreferences();
  const amounts = useAmountFormatter();
  const [amountText, setAmountText] = useState('');
  const capabilities = controller.walletCapabilities();
  const r = state.sendReview;

  const review: SendReviewModel | null =
    r === null
      ? null
      : {
          rail: 'lightning',
          source: "Your node's Lightning balance",
          recipient: r.invoice.invoice,
          recipientNote: r.invoice.description,
          amountSat: r.amountSat,
          fee: {
            kind: 'cap',
            capSat: r.feeLimitSat,
            note: "Your node picks the route when it pays, so the routing fee isn't quoted beforehand. This is your maximum Lightning fee; the node won't pay more — the payment fails instead.",
          },
          totalSat: r.amountSat + r.feeLimitSat,
          totalIsMaximum: true,
          timing: `${timeExpectation('lightning', 'remote-lnd')} Payment timeout: ${r.timeoutSeconds} s (from your payment preferences).`,
          notices: state.foregrounded ? [] : ['The app is in the background — reopen it to make payments.'],
          validUntil: r.invoice.expiresAt,
          validUntilLabel: 'Invoice expires',
        };

  const receipt: SendReceiptModel | null =
    state.sendReceipt === null || r === null
      ? null
      : {
          rail: 'lightning',
          recipient: r.invoice.invoice,
          amountSat: state.sendReceipt.amountSat,
          feeSat: state.sendReceipt.feeSat,
          feeLabel: 'Routing fee',
          completedAt: state.sendReceipt.completedAt,
          reference: state.sendReceipt.paymentHash,
          referenceLabel: 'Payment hash',
        };

  const status: SendViewStatus = state.sendStatus === 'idle' ? 'compose' : state.sendStatus;
  const model: SendViewModel = {
    title: 'Send',
    subtitle: 'Paid by your node',
    // An unrecognized network is never treated as mainnet: Send says why it is off.
    network: knownBitcoinNetwork(network),
    networkName: network,
    capabilities,
    rules: REMOTE_LND_RAIL_RULES,
    status,
    quoting: false,
    draftText: state.sendBolt11Text,
    onDraftText: (text) => controller.editSendDestination(text),
    amountText,
    onAmountText: setAmountText,
    error: state.sendError,
    review,
    receipt,
    spendableSat: (rail) => (rail === 'lightning' ? (state.balances?.lightningSpendableSat ?? null) : null),
    feePolicy: (rail, amountSat) =>
      rail === 'lightning'
        ? lightningFeePolicyText(
            preferences,
            amountSat,
            (s) => amounts.format(s),
            'Sent to your node as the fee limit for this payment.',
          )
        : null,
    onReview: () => controller.reviewSend(preferences),
    onConfirm: () => controller.confirmSend(),
    onEdit: () => controller.editSend(),
    onCheckStatus: () => void controller.checkPaymentStatus(),
    checkingStatus: state.busy && state.sendStatus === 'in-flight',
    onSendAnother: () => controller.resetSend(),
    onDone: () => {
      controller.resetSend();
      controller.selectTab('home');
    },
    onOpenActivity: () => controller.selectTab('activity'),
    hapticsEnabled: preferences.haptics,
  };
  return <SendView model={model} />;
}
