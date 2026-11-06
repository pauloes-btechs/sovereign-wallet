/**
 * The unified Send experience, shared by both wallet modes. Presentation
 * only: a mode adapter (`sendScreens.tsx`) turns its controller's state into
 * a `SendViewModel` and its actions into callbacks.
 *
 * Steps: one input for whatever the user pasted or scanned (parsed on the
 * phone by `flows/destination.ts`) → rail choice among the rails this
 * backend supports for that destination → amount when the destination has
 * none → review with every number from a real quote (or, where the backend
 * has no quote, the fee cap the payment is sent with) → confirm → progress
 * (a sheet that can't be dismissed while the payment is dispatching) →
 * receipt, or a failure explained in plain language with a safe next step.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { MobileWalletCapabilities } from '../../flows/capabilities.js';
import type { BitcoinNetwork, ParsedDestination } from '../../flows/destination.js';
import { ADDRESS_TYPE_LABEL, parseDestination } from '../../flows/destination.js';
import type { RailOption, RailRules, SendRail } from '../../flows/sendFlow.js';
import {
  RAIL_LABEL,
  clockTime,
  defaultRail,
  explainSendFailure,
  fixedAmountSat,
  railOptions,
  relativeDuration,
} from '../../flows/sendFlow.js';
import { useAmountFormatter, usePlatformServices } from '../appContext.js';
import { parseAmountInput, shortenMiddle, unitLabel } from '../format.js';
import {
  MobileAmount,
  MobileBadge,
  MobileButton,
  MobileButtonGroup,
  MobileField,
  MobileFlowTabs,
  MobileHeader,
  MobilePanel,
  MobileScreen,
  MobileWarningBand,
  mobilePalette,
  styles as base,
} from '../Primitives.js';
import { Sheet } from '../Sheet.js';

/** What the review shows. Every amount is from the backend's quote or the user's own limit. */
export interface SendReviewModel {
  readonly rail: SendRail;
  /** Where the money comes from, e.g. "Everyday wallet balance". */
  readonly source: string;
  /** Full address or invoice (selectable). */
  readonly recipient: string;
  /** Invoice description or BIP21 label/message; null when none. */
  readonly recipientNote: string | null;
  readonly amountSat: bigint;
  /** A quoted fee, or — where the backend can't quote — the cap the payment is sent with. */
  readonly fee:
    | { readonly kind: 'quoted'; readonly label: string; readonly feeSat: bigint; readonly known: boolean; readonly note: string | null }
    | { readonly kind: 'cap'; readonly capSat: bigint; readonly note: string };
  /** Quoted total, or amount + cap (`totalIsMaximum`). Null when the backend could not total it. */
  readonly totalSat: bigint | null;
  readonly totalIsMaximum: boolean;
  readonly timing: string;
  /** Things the user should know before confirming (verbatim backend warnings included). */
  readonly notices: readonly string[];
  /** Unix seconds the invoice or quote stops being valid; null when not known. */
  readonly validUntil: number | null;
  /** "Invoice expires" or "Quote valid until". */
  readonly validUntilLabel: string;
}

export interface SendReceiptModel {
  readonly rail: SendRail;
  readonly recipient: string;
  readonly amountSat: bigint;
  /** Fee actually recorded, or the quoted fee (`feeLabel` says which); null = not reported. */
  readonly feeSat: bigint | null;
  readonly feeLabel: string;
  readonly completedAt: number | null;
  /** Payment hash or other reference; null when none. */
  readonly reference: string | null;
  readonly referenceLabel: string;
}

export type SendViewStatus = 'compose' | 'review' | 'sending' | 'in-flight' | 'settled' | 'failed';

export interface SendViewModel {
  readonly title: string;
  readonly subtitle?: string;
  readonly network: BitcoinNetwork;
  readonly capabilities: MobileWalletCapabilities;
  readonly rules: RailRules;
  readonly status: SendViewStatus;
  /** True while a quote is being fetched. */
  readonly quoting: boolean;
  readonly draftText: string;
  readonly onDraftText: (text: string) => void;
  /** Amount typed for a destination without one, in the user's denomination (kept across tabs). */
  readonly amountText: string;
  readonly onAmountText: (text: string) => void;
  /** Error from the backend or controller for the current step (verbatim). */
  readonly error: string | null;
  readonly review: SendReviewModel | null;
  readonly receipt: SendReceiptModel | null;
  /** Spendable for a rail, to warn before quoting; null when unknown. */
  readonly spendableSat: (rail: SendRail) => bigint | null;
  /** The fee policy line shown while composing, per rail; null when none applies. */
  readonly feePolicy: (rail: SendRail, amountSat: bigint | null) => string | null;
  readonly onReview: (request: { rail: SendRail; destination: ParsedDestination; amountSat: bigint }) => void;
  readonly onConfirm: () => Promise<void>;
  readonly onEdit: () => void;
  /** Looks the payment up on the backend — never re-sends. */
  readonly onCheckStatus: (() => void) | null;
  readonly checkingStatus: boolean;
  readonly onSendAnother: () => void;
  readonly onDone: () => void;
  readonly onOpenActivity: () => void;
  /** Haptic preference is on (the device service decides whether one exists). */
  readonly hapticsEnabled: boolean;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function SendView({ model }: { model: SendViewModel }): ReactNode {
  const platform = usePlatformServices();
  const [confirming, setConfirming] = useState(false);
  const wasSettled = useRef(false);

  useEffect(() => {
    if (model.status === 'settled' && !wasSettled.current && model.hapticsEnabled) platform.hapticConfirm?.();
    wasSettled.current = model.status === 'settled';
  }, [model.status, model.hapticsEnabled, platform]);

  const confirm = (): void => {
    setConfirming(true);
    model.onConfirm().finally(() => setConfirming(false));
  };

  // While the confirm call runs, the review stays behind the progress sheet.
  const shown: SendViewStatus = confirming && model.review !== null ? 'review' : model.status;
  return (
    <MobileScreen>
      <MobileHeader title={model.title} subtitle={model.subtitle} />
      {shown === 'compose' && <ComposeStep model={model} />}
      {shown === 'review' && model.review !== null && (
        <ReviewStep review={model.review} onConfirm={confirm} onEdit={model.onEdit} busy={confirming} />
      )}
      {shown === 'in-flight' && <InFlightStep model={model} />}
      {shown === 'settled' && <ReceiptStep model={model} />}
      {shown === 'failed' && <FailureStep model={model} />}
      <Sheet
        open={confirming || model.status === 'sending'}
        title="Sending payment"
        onClose={() => undefined}
        dismissable={false}
        animated={false}
      >
        <View style={local.progress} accessibilityLiveRegion="polite">
          <ActivityIndicator color={mobilePalette.text} />
          <Text style={base.dim}>
            {model.review !== null && model.review.rail === 'onchain'
              ? 'Handing your payment to the wallet for broadcast. Keep the app open.'
              : 'Your payment is on its way. Keep the app open until it finishes.'}
          </Text>
        </View>
      </Sheet>
    </MobileScreen>
  );
}

// ——— compose ———

function ComposeStep({ model }: { model: SendViewModel }): ReactNode {
  const platform = usePlatformServices();
  const amounts = useAmountFormatter();
  const denomination = amounts.preferences.denomination;
  const amountText = model.amountText;
  const setAmountText = model.onAmountText;
  const [chosenRail, setChosenRail] = useState<SendRail | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const parsed = useMemo(
    () => (model.draftText.trim() === '' ? null : parseDestination(model.draftText, model.network)),
    [model.draftText, model.network],
  );
  const destination = parsed !== null && parsed.ok ? parsed.destination : null;
  const options: readonly RailOption[] =
    destination === null ? [] : railOptions(destination, model.capabilities, model.rules, nowSec());
  const rail: SendRail | null =
    chosenRail !== null && options.some((o) => o.rail === chosenRail) ? chosenRail : defaultRail(options);
  const option = options.find((o) => o.rail === rail) ?? null;
  const fixed = destination !== null && rail !== null ? fixedAmountSat(destination, rail) : null;
  const typedAmount = parseAmountInput(amountText, denomination);
  const amountSat = fixed ?? typedAmount;
  const needsAmount = destination !== null && rail !== null && fixed === null;
  const spendable = rail === null ? null : model.spendableSat(rail);
  const overSpendable = amountSat !== null && spendable !== null && amountSat > spendable;

  const blocker =
    model.draftText.trim() === ''
      ? 'Paste an invoice or a Bitcoin address to start.'
      : parsed !== null && !parsed.ok
        ? 'Fix the payment details above to continue.'
        : option === null
          ? null
          : !option.available
            ? option.reason
            : amountSat === null
              ? `Enter an amount in ${unitLabel(denomination)}.`
              : null;

  const scan = platform.scanQrCode;
  const scanReason = model.capabilities.features.qrScan;

  return (
    <>
      <MobileField
        label="Pay to"
        value={model.draftText}
        onChangeText={(text) => {
          setScanError(null);
          model.onDraftText(text);
        }}
        placeholder="Paste an invoice, address or bitcoin: link"
        multiline
      />
      {scan !== undefined ? (
        <MobileButton
          label="Scan QR code"
          kind="secondary"
          compact
          onPress={() => {
            scan().then(
              (text) => {
                if (text !== null) model.onDraftText(text);
              },
              (error: unknown) => setScanError(error instanceof Error ? error.message : String(error)),
            );
          }}
        />
      ) : (
        !scanReason.available && <Text style={base.faint}>{scanReason.reason}</Text>
      )}
      {scanError !== null && <Text style={base.errorNote}>The scanner failed: {scanError}</Text>}

      {parsed !== null && !parsed.ok && (
        <MobileWarningBand tone="danger">
          <Text style={base.bandText}>{parsed.error.message}</Text>
        </MobileWarningBand>
      )}
      {destination !== null && <DestinationSummary destination={destination} />}

      {options.length > 1 && rail !== null && (
        <View style={local.group}>
          <Text style={base.overline}>Pay with</Text>
          <MobileFlowTabs
            tabs={options.map((o) => ({ id: o.rail, label: o.available ? RAIL_LABEL[o.rail] : `${RAIL_LABEL[o.rail]} (unavailable)` }))}
            activeId={rail}
            onChange={(id) => setChosenRail(id === 'onchain' ? 'onchain' : 'lightning')}
          />
        </View>
      )}
      {option !== null && !option.available && option.reason !== null && (
        <MobileWarningBand tone="warning">
          <Text style={base.bandText}>{option.reason}</Text>
        </MobileWarningBand>
      )}

      {needsAmount && option?.available === true && (
        <MobileField
          label={`Amount (${unitLabel(denomination)})`}
          value={amountText}
          onChangeText={setAmountText}
          placeholder={denomination === 'btc' ? '0.0005' : '50000'}
          hint={
            amountText.trim() !== '' && typedAmount === null
              ? denomination === 'btc'
                ? 'Enter BTC with up to 8 decimals.'
                : 'Enter a whole number of sats.'
              : undefined
          }
        />
      )}
      {option?.available === true && spendable !== null && (
        <Text style={overSpendable ? base.errorNote : base.faint}>
          {overSpendable ? 'More than your spendable balance: ' : 'Spendable: '}
          <MobileAmount sats={spendable} style={overSpendable ? base.errorNote : base.faint} />
        </Text>
      )}
      {option?.available === true && rail !== null && model.feePolicy(rail, amountSat) !== null && (
        <Text style={base.faint}>{model.feePolicy(rail, amountSat)}</Text>
      )}

      {model.error !== null && (
        <MobileWarningBand tone="danger">
          <FailureText raw={model.error} />
        </MobileWarningBand>
      )}

      <MobileButton
        label="Review payment"
        disabled={blocker !== null || destination === null || rail === null || amountSat === null}
        busy={model.quoting}
        onPress={() => {
          if (destination !== null && rail !== null && amountSat !== null) {
            model.onReview({ rail, destination, amountSat });
          }
        }}
      />
      {blocker !== null && <Text style={base.faint}>{blocker}</Text>}
    </>
  );
}

function DestinationSummary({ destination }: { destination: ParsedDestination }): ReactNode {
  const now = nowSec();
  const invoice = destination.lightning;
  const address = destination.onchain;
  const kind =
    destination.source === 'bip21'
      ? invoice !== null && address !== null
        ? 'Payment link with Lightning and on-chain options'
        : 'Payment link (BIP21)'
      : invoice !== null
        ? 'Lightning invoice'
        : 'Bitcoin address';
  return (
    <MobilePanel title="Recognized">
      <View style={base.rowBetween}>
        <Text style={local.textValue}>{kind}</Text>
        <MobileBadge label="Valid" tone="positive" />
      </View>
      {address !== null && (
        <Text style={base.faint}>
          {ADDRESS_TYPE_LABEL[address.type]} · {shortenMiddle(address.address, 10, 8)}
        </Text>
      )}
      {invoice !== null && (
        <>
          {invoice.description !== null && invoice.description !== '' && (
            <Text style={base.dim}>“{invoice.description}”</Text>
          )}
          {invoice.amountMsat === null ? (
            <Text style={base.faint}>No amount in the invoice.</Text>
          ) : (
            <Text style={base.faint}>
              Invoice amount: <MobileAmount sats={(invoice.amountMsat + 999n) / 1000n} style={base.faint} />
            </Text>
          )}
          <Text style={base.faint}>
            {now >= invoice.expiresAt
              ? `Expired at ${clockTime(invoice.expiresAt, now)}`
              : `Expires at ${clockTime(invoice.expiresAt, now)} (in ${relativeDuration(invoice.expiresAt - now)})`}
          </Text>
        </>
      )}
      {destination.onchainAmountSat !== null && (
        <Text style={base.faint}>
          Requested amount: <MobileAmount sats={destination.onchainAmountSat} style={base.faint} />
        </Text>
      )}
      {destination.label !== null && <Text style={base.faint}>Label: {destination.label}</Text>}
      {destination.message !== null && <Text style={base.faint}>Message: {destination.message}</Text>}
    </MobilePanel>
  );
}

// ——— review ———

/** Label left, value right; `stacked` puts long values (addresses, notes) under the label. */
function ReviewRow({ label, children, stacked = false }: { label: string; children: ReactNode; stacked?: boolean }): ReactNode {
  if (stacked) {
    return (
      <View style={local.reviewRow}>
        <Text style={base.dim}>{label}</Text>
        <View style={local.reviewValue}>{children}</View>
      </View>
    );
  }
  return (
    <View style={[local.reviewRow, local.reviewInline]}>
      <Text style={[base.dim, local.reviewLabel]}>{label}</Text>
      <View style={[local.reviewValue, local.reviewValueRight]}>{children}</View>
    </View>
  );
}

function ReviewStep({
  review,
  onConfirm,
  onEdit,
  busy,
}: {
  review: SendReviewModel;
  onConfirm: () => void;
  onEdit: () => void;
  busy: boolean;
}): ReactNode {
  const now = nowSec();
  return (
    <>
      <Text style={base.overline}>{review.rail === 'lightning' ? 'Lightning payment' : 'On-chain payment'}</Text>
      <MobilePanel title="Review">
        <ReviewRow label="From">
          <Text style={local.textValue}>{review.source}</Text>
        </ReviewRow>
        <ReviewRow label="To" stacked>
          <Text style={[base.value, base.mono]} selectable numberOfLines={3}>
            {review.recipient}
          </Text>
          {review.recipientNote !== null && <Text style={base.faint}>{review.recipientNote}</Text>}
        </ReviewRow>
        <ReviewRow label="Pay with">
          <Text style={local.textValue}>{RAIL_LABEL[review.rail]}</Text>
        </ReviewRow>
        <ReviewRow label="Amount">
          <MobileAmount sats={review.amountSat} />
        </ReviewRow>
        {review.fee.kind === 'quoted' ? (
          <>
            <ReviewRow label={review.fee.label}>
              <MobileAmount sats={review.fee.feeSat} />
            </ReviewRow>
            {!review.fee.known && <Text style={base.faint}>Estimated — the final fee may differ.</Text>}
            {review.fee.note !== null && <Text style={base.faint}>{review.fee.note}</Text>}
          </>
        ) : (
          <>
            <ReviewRow label="Routing fee">
              <Text style={base.value}>
                Up to <MobileAmount sats={review.fee.capSat} />
              </Text>
            </ReviewRow>
            <Text style={base.faint}>{review.fee.note}</Text>
          </>
        )}
        <View style={local.totalRow}>
          <ReviewRow label={review.totalIsMaximum ? 'Total, at most' : 'Total'}>
            {review.totalSat !== null ? (
              <MobileAmount sats={review.totalSat} style={local.total} />
            ) : (
              <Text style={base.value}>Not reported by the wallet</Text>
            )}
          </ReviewRow>
        </View>
        <ReviewRow label="Timing" stacked>
          <Text style={base.faint}>{review.timing}</Text>
        </ReviewRow>
        {review.validUntil !== null && (
          <ReviewRow label={review.validUntilLabel}>
            <Text style={base.faint}>
              {clockTime(review.validUntil, now)}
              {review.validUntil > now ? ` (in ${relativeDuration(review.validUntil - now)})` : ' — expired'}
            </Text>
          </ReviewRow>
        )}
      </MobilePanel>
      {review.notices.map((notice) => (
        <MobileWarningBand key={notice} tone="warning">
          <Text style={base.bandText}>{notice}</Text>
        </MobileWarningBand>
      ))}
      <MobileButtonGroup>
        <MobileButton label="Confirm and send" onPress={onConfirm} busy={busy} />
        <MobileButton label="Back to edit" kind="secondary" onPress={onEdit} disabled={busy} />
      </MobileButtonGroup>
    </>
  );
}

// ——— after dispatch ———

function InFlightStep({ model }: { model: SendViewModel }): ReactNode {
  return (
    <>
      <MobileWarningBand tone="warning">
        <Text style={base.h3}>Payment in flight — result not final yet</Text>
        <Text style={base.dim}>
          The wallet sent the payment but hasn&apos;t confirmed the outcome. Check its status before
          trying again — paying again now could pay twice.
        </Text>
      </MobileWarningBand>
      {model.review !== null && (
        <MobilePanel>
          <ReviewRow label="Amount">
            <MobileAmount sats={model.review.amountSat} />
          </ReviewRow>
          <ReviewRow label="To">
            <Text style={[base.value, base.mono]} numberOfLines={2}>
              {shortenMiddle(model.review.recipient, 14, 10)}
            </Text>
          </ReviewRow>
        </MobilePanel>
      )}
      <MobileButtonGroup>
        {model.onCheckStatus !== null && (
          <MobileButton label="Check payment status" onPress={model.onCheckStatus} busy={model.checkingStatus} />
        )}
        <MobileButton label="Open activity" kind="secondary" onPress={model.onOpenActivity} />
      </MobileButtonGroup>
    </>
  );
}

function ReceiptStep({ model }: { model: SendViewModel }): ReactNode {
  const receipt = model.receipt;
  return (
    <>
      <MobileWarningBand tone="positive">
        <Text style={base.bandText}>Payment sent.</Text>
      </MobileWarningBand>
      {receipt !== null && (
        <MobilePanel title="Receipt">
          <ReviewRow label="To" stacked>
            <Text style={[base.value, base.mono]} selectable numberOfLines={3}>
              {receipt.recipient}
            </Text>
          </ReviewRow>
          <ReviewRow label="Paid with">
            <Text style={local.textValue}>{RAIL_LABEL[receipt.rail]}</Text>
          </ReviewRow>
          <ReviewRow label="Amount">
            <MobileAmount sats={receipt.amountSat} />
          </ReviewRow>
          <ReviewRow label={receipt.feeLabel}>
            {receipt.feeSat !== null ? (
              <MobileAmount sats={receipt.feeSat} />
            ) : (
              <Text style={base.value}>Not reported</Text>
            )}
          </ReviewRow>
          {receipt.feeSat !== null && (
            <ReviewRow label="Total">
              <MobileAmount sats={receipt.amountSat + receipt.feeSat} style={local.total} />
            </ReviewRow>
          )}
          {receipt.completedAt !== null && (
            <ReviewRow label="Completed">
              <Text style={base.value}>{clockTime(Math.floor(receipt.completedAt / 1000))}</Text>
            </ReviewRow>
          )}
          {receipt.reference !== null && (
            <ReviewRow label={receipt.referenceLabel} stacked>
              <Text style={[base.faint, base.mono]} selectable>
                {receipt.reference}
              </Text>
            </ReviewRow>
          )}
        </MobilePanel>
      )}
      <MobileButtonGroup>
        <MobileButton label="Send another payment" onPress={model.onSendAnother} />
        <MobileButton label="Done" kind="secondary" onPress={model.onDone} />
      </MobileButtonGroup>
    </>
  );
}

function FailureText({ raw }: { raw: string }): ReactNode {
  const explained = explainSendFailure(raw);
  return (
    <>
      <Text style={base.h3}>{explained.title}</Text>
      <Text style={base.dim}>{explained.detail}</Text>
      <Text style={base.dim}>{explained.nextStep}</Text>
      {explained.detail !== raw && explained.unknownOutcome !== true && (
        <Text style={base.faint}>Wallet message: {raw}</Text>
      )}
    </>
  );
}

function FailureStep({ model }: { model: SendViewModel }): ReactNode {
  const raw = model.error ?? 'The payment failed.';
  const explained = explainSendFailure(raw);
  return (
    <>
      <MobileWarningBand tone={explained.unknownOutcome === true ? 'warning' : 'danger'}>
        <FailureText raw={raw} />
      </MobileWarningBand>
      <MobileButtonGroup>
        {explained.safeToRetry ? (
          <MobileButton label="Edit and try again" onPress={model.onEdit} />
        ) : (
          <MobileButton label="Open activity" onPress={model.onOpenActivity} />
        )}
        <MobileButton label="Start over" kind="secondary" onPress={model.onSendAnother} />
        <MobileButton label="Done" kind="ghost" onPress={model.onDone} />
      </MobileButtonGroup>
    </>
  );
}

const local = StyleSheet.create({
  group: { gap: 6 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  reviewRow: { gap: 2, paddingVertical: 6 },
  reviewInline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  reviewLabel: { flexShrink: 0 },
  reviewValue: { gap: 2 },
  reviewValueRight: { flexShrink: 1, alignItems: 'flex-end' },
  totalRow: { borderTopWidth: 1, borderTopColor: mobilePalette.border, marginTop: 4 },
  total: { fontWeight: '700' },
  textValue: { ...base.value, fontVariant: [] },
});
