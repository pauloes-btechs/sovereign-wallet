/**
 * Mode adapters for the unified Receive view.
 *
 * - Everyday wallet: Lightning invoices come from the swap service and need
 *   an amount; the SDK sets their expiry (the invoice expiry preference
 *   can't apply — the decoded expiry is shown instead). On-chain uses a
 *   fresh boarding address per tap. Status comes from the wallet's activity
 *   (the receive entry carrying the invoice's payment hash; deposit entries
 *   with their confirmation height).
 * - Your node: invoices come from `addInvoice` with the invoice expiry
 *   preference; the amount is optional. Status comes from the node's invoice
 *   list when this connection can read it. On-chain addresses aren't
 *   available over this connection (the reason is shown).
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { ModeAController, ModeAState } from '../../flows/modeAController.js';
import type { ModeBRemoteController, ModeBRemoteState } from '../../flows/modeBRemoteController.js';
import { buildBip21, decodeBolt11 } from '../../flows/destination.js';
import { invoiceStatus } from '../../flows/sendFlow.js';
import type { SendRail } from '../../flows/sendFlow.js';
import { usePreferences } from '../appContext.js';
import { ReceiveView } from './ReceiveView.js';
import type { ReceiveDeposit, ReceiveViewModel } from './ReceiveView.js';

const onchainUri = (address: string, amountSat: bigint | null, label: string): string =>
  buildBip21(address, { amountSat, label });

function decoded(invoice: string | null) {
  if (invoice === null) return null;
  const result = decodeBolt11(invoice);
  return result.ok ? result.invoice : null;
}

// ——— Everyday wallet ———

export function ModeAReceiveScreen({
  controller,
  state,
}: {
  controller: ModeAController;
  state: ModeAState;
}): ReactNode {
  const capabilities = controller.walletCapabilities();
  const { features } = capabilities;
  const onPoll = useCallback(() => void controller.loadActivity(), [controller]);
  const invoice = decoded(state.invoice);
  const details = state.activityDetails;

  const receiveRecord =
    invoice === null ? undefined : details?.find((d) => d.entryKind === 'receive' && d.paymentHash === invoice.paymentHash);
  const deposits: ReceiveDeposit[] = (details ?? [])
    .filter((d) => d.entryKind === 'deposit' && d.record.amountSat > 0n)
    .map((d) => ({
      id: d.entryId,
      amountSat: d.record.amountSat,
      status: d.record.status,
      detail:
        d.confirmationHeight !== null
          ? `Confirmed in block ${d.confirmationHeight.toLocaleString('en-US')}`
          : d.txid !== null
            ? `Transaction ${d.txid.slice(0, 10)}…`
            : null,
    }));

  const model: ReceiveViewModel = {
    title: 'Receive',
    subtitle: 'Into your everyday wallet',
    rails: [
      {
        rail: 'lightning',
        available: features.lightningReceive.available,
        detail: features.lightningReceive.available
          ? (features.lightningReceive.note ?? null)
          : features.lightningReceive.reason,
      },
      {
        rail: 'onchain',
        available: features.onchainReceive.available,
        detail: features.onchainReceive.available
          ? 'Deposit Bitcoin on-chain into your wallet. A fresh address is generated each time.'
          : features.onchainReceive.reason,
      },
    ],
    rail: state.receiveTab,
    onRail: (rail) => controller.setReceiveTab(rail),
    amountText: state.receiveAmountText,
    onAmountText: (text) => controller.setReceiveAmount(text),
    amountRequired: (rail) => rail === 'lightning',
    memoText: state.receiveMemoText,
    onMemoText: (text) => controller.setReceiveMemo(text),
    expiry: features.invoiceExpiry.available
      ? null
      : { kind: 'backend', reason: `${features.invoiceExpiry.reason} The expiry is shown once the invoice is created.` },
    busy: state.busy,
    error: state.receiveError,
    onCreate: (rail: SendRail, amountSat) => {
      if (rail === 'lightning') void controller.generateInvoice({ amountSat }).catch(() => undefined);
      else void controller.generateAddress({ amountSat }).catch(() => undefined);
    },
    lightning:
      state.invoice === null
        ? null
        : {
            invoice: state.invoice,
            decoded: invoice,
            status: (now) => invoiceStatus(receiveRecord?.record.status ?? null, invoice, now),
            statusNote:
              details === null
                ? 'Status is read from your wallet activity.'
                : receiveRecord === undefined
                  ? "Your wallet hasn't reported this invoice yet; status is checked every few seconds."
                  : 'Status is read from your wallet activity every few seconds.',
          },
    onchain:
      state.onchainAddress === null
        ? null
        : {
            address: state.onchainAddress,
            deposits,
            depositNote:
              details === null
                ? 'Deposit status appears in Activity once the wallet sees the transaction.'
                : 'Deposits are read from your wallet activity. The wallet reports confirmation by block height, not a count; it does not say which address a deposit used.',
          },
    onchainUri,
    onPoll,
  };
  return <ReceiveView model={model} />;
}

// ——— Your node ———

export function ModeBReceiveScreen({
  controller,
  state,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
}): ReactNode {
  const { preferences } = usePreferences();
  const capabilities = controller.walletCapabilities();
  const { features } = capabilities;
  const [rail, setRail] = useState<SendRail>('lightning');
  const canReadStatus = features.activity.available && state.activityStatus !== 'unavailable';
  const loadActivity = useCallback(() => void controller.loadActivity(), [controller]);
  const invoice = decoded(state.invoice);
  const record =
    state.invoice === null
      ? undefined
      : state.activity?.find(
          (r) => r.direction === 'in' && (r.paymentRequest === state.invoice || (invoice !== null && r.paymentHash === invoice.paymentHash)),
        );

  const model: ReceiveViewModel = {
    title: 'Receive',
    subtitle: 'Into your node',
    rails: [
      {
        rail: 'lightning',
        available: features.lightningReceive.available,
        detail: features.lightningReceive.available ? null : features.lightningReceive.reason,
      },
      {
        rail: 'onchain',
        available: features.onchainReceive.available,
        detail: features.onchainReceive.available ? null : features.onchainReceive.reason,
      },
    ],
    rail,
    onRail: setRail,
    amountText: state.invoiceAmountText,
    onAmountText: (text) => controller.editInvoiceAmount(text),
    amountRequired: () => false,
    memoText: state.invoiceMemoText,
    onMemoText: (text) => controller.editInvoiceMemo(text),
    expiry: features.invoiceExpiry.available
      ? { kind: 'preference', seconds: preferences.invoiceExpirySeconds }
      : { kind: 'backend', reason: features.invoiceExpiry.reason },
    busy: state.busy,
    error: state.invoiceError,
    onCreate: (_rail, amountSat) => {
      void controller
        .createInvoice({
          amountSat,
          ...(features.invoiceExpiry.available ? { expirySeconds: preferences.invoiceExpirySeconds } : {}),
        })
        .catch(() => undefined);
    },
    lightning:
      state.invoice === null
        ? null
        : {
            invoice: state.invoice,
            decoded: invoice,
            status: (now) => invoiceStatus(record?.status ?? null, invoice, now),
            statusNote: canReadStatus
              ? 'Status is read from your node every few seconds.'
              : `Payment status can't be read over this connection. ${features.activity.available ? '' : features.activity.reason}`.trim(),
          },
    onchain: null,
    onchainUri,
    onPoll: canReadStatus ? loadActivity : null,
  };
  return <ReceiveView model={model} />;
}
