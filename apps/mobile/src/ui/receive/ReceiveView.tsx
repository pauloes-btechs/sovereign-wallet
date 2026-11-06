/**
 * The unified Receive experience, shared by both wallet modes. Presentation
 * only: a mode adapter (`receiveScreens.tsx`) supplies a `ReceiveViewModel`.
 *
 * Lightning or on-chain (only rails the backend supports, the others with
 * their reason) → optional amount in the user's denomination, memo/label,
 * expiry (the preference where the backend accepts one, otherwise why not)
 * → QR + copy + native share when the device has it → live status read
 * from the backend's own records (polled), and on-chain deposits with their
 * confirmation state where the wallet reports one.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Bolt11Invoice } from '../../flows/destination.js';
import { invoiceAmountSat } from '../../flows/destination.js';
import type { ReceiveStatus, SendRail } from '../../flows/sendFlow.js';
import { RAIL_LABEL, RECEIVE_STATUS_LABEL, clockTime, relativeDuration } from '../../flows/sendFlow.js';
import { useAmountFormatter, usePlatformServices } from '../appContext.js';
import { amountInputProblem, parseAmountInput, unitLabel } from '../format.js';
import {
  MobileAmount,
  MobileBadge,
  MobileButton,
  MobileField,
  MobileFlowTabs,
  MobileHeader,
  MobilePanel,
  MobileScreen,
  MobileWarningBand,
  styles as base,
  mobilePalette,
} from '../Primitives.js';
import { QrCode } from '../QrCode.js';

export interface ReceiveRailOption {
  readonly rail: SendRail;
  readonly available: boolean;
  /** Why it's unavailable, or a note about how it works when available. */
  readonly detail: string | null;
}

export type ExpiryInfo =
  | { readonly kind: 'preference'; readonly seconds: number }
  | { readonly kind: 'backend'; readonly reason: string };

export interface ReceiveDeposit {
  readonly id: string;
  readonly amountSat: bigint;
  readonly status: 'pending' | 'settled' | 'failed';
  /** e.g. "Confirmed in block 805,012"; null when the wallet reports nothing more. */
  readonly detail: string | null;
}

export interface ReceiveViewModel {
  readonly title: string;
  readonly subtitle?: string;
  readonly rails: readonly ReceiveRailOption[];
  readonly rail: SendRail;
  readonly onRail: (rail: SendRail) => void;
  readonly amountText: string;
  readonly onAmountText: (text: string) => void;
  /** Lightning on the everyday wallet needs an amount (swap service). */
  readonly amountRequired: (rail: SendRail) => boolean;
  readonly memoText: string;
  readonly onMemoText: (text: string) => void;
  readonly expiry: ExpiryInfo | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCreate: (rail: SendRail, amountSat: bigint | null) => void;
  readonly lightning: {
    readonly invoice: string;
    readonly decoded: Bolt11Invoice | null;
    /** Status at `nowSec`, from the backend's record and the invoice's expiry. */
    readonly status: (nowSec: number) => ReceiveStatus;
    /** How the status is known (or why it can't be). */
    readonly statusNote: string;
  } | null;
  readonly onchain: {
    readonly address: string;
    readonly deposits: readonly ReceiveDeposit[];
    readonly depositNote: string;
  } | null;
  /** Builds the QR/share text for the address with the current amount and label. */
  readonly onchainUri: (address: string, amountSat: bigint | null, label: string) => string;
  /** Re-reads the backend's records; null when the status can't be read. */
  readonly onPoll: (() => void) | null;
}

const POLL_MS = 5_000;

const STATUS_TONE: Readonly<Record<ReceiveStatus, 'positive' | 'warning' | 'danger' | 'neutral'>> = {
  waiting: 'warning',
  paid: 'positive',
  expired: 'neutral',
  canceled: 'neutral',
  failed: 'danger',
  unknown: 'neutral',
};

function useNowSec(active: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), POLL_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function ReceiveView({ model }: { model: ReceiveViewModel }): ReactNode {
  const amounts = useAmountFormatter();
  const platform = usePlatformServices();
  const denomination = amounts.preferences.denomination;
  const option = model.rails.find((r) => r.rail === model.rail) ?? null;
  const typed = parseAmountInput(model.amountText, denomination);
  const amountInvalid = model.amountText.trim() !== '' && typed === null;
  const required = model.amountRequired(model.rail);
  const canCreate = option?.available === true && !amountInvalid && (!required || typed !== null);

  const lightning = model.rail === 'lightning' ? model.lightning : null;
  const onchain = model.rail === 'onchain' ? model.onchain : null;
  const showing = lightning !== null || onchain !== null;
  const now = useNowSec(showing);
  const status = lightning?.status(now) ?? null;

  // Poll the backend while something can still change.
  const { onPoll } = model;
  const polling = onPoll !== null && (onchain !== null || status === 'waiting');
  useEffect(() => {
    if (!polling || onPoll === null) return;
    onPoll();
    const timer = setInterval(onPoll, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, onPoll]);

  const share = platform.shareText;
  const shareValue =
    lightning !== null
      ? `lightning:${lightning.invoice}`
      : onchain !== null
        ? model.onchainUri(onchain.address, typed, model.memoText)
        : null;

  return (
    <MobileScreen>
      <MobileHeader title={model.title} subtitle={model.subtitle} />
      {model.rails.length > 1 && (
        <MobileFlowTabs
          tabs={model.rails.map((r) => ({ id: r.rail, label: RAIL_LABEL[r.rail] }))}
          activeId={model.rail}
          onChange={(id) => model.onRail(id === 'onchain' ? 'onchain' : 'lightning')}
          variant="underline"
        />
      )}
      {option !== null && !option.available && option.detail !== null && (
        <MobileWarningBand tone="warning">
          <Text style={base.bandText}>{option.detail}</Text>
        </MobileWarningBand>
      )}

      {option?.available === true && (
        <>
          {option.detail !== null && <Text style={base.dim}>{option.detail}</Text>}
          <MobileField
            label={`Amount (${unitLabel(denomination)})`}
            value={model.amountText}
            onChangeText={model.onAmountText}
            placeholder={required ? 'Required' : 'Optional — the payer can choose'}
            hint={amountInvalid ? (amountInputProblem(model.amountText, denomination) ?? undefined) : undefined}
          />
          <MobileField
            label={model.rail === 'lightning' ? 'Description (optional)' : 'Label (optional)'}
            value={model.memoText}
            onChangeText={model.onMemoText}
            placeholder={model.rail === 'lightning' ? 'Shown to the payer' : 'Saved in the payment link'}
          />
          {model.rail === 'lightning' && model.expiry !== null && (
            <Text style={base.faint}>
              {model.expiry.kind === 'preference'
                ? `Expires after ${relativeDuration(model.expiry.seconds)} — from your invoice expiry preference.`
                : model.expiry.reason}
            </Text>
          )}
          <MobileButton
            label={
              model.rail === 'lightning'
                ? lightning === null
                  ? 'Create invoice'
                  : 'New invoice'
                : onchain === null
                  ? 'Generate address'
                  : 'New address'
            }
            kind={showing ? 'secondary' : 'primary'}
            disabled={!canCreate}
            busy={model.busy}
            onPress={() => model.onCreate(model.rail, typed)}
          />
          {!canCreate && required && typed === null && !amountInvalid && (
            <Text style={base.faint}>Enter an amount in {unitLabel(denomination)} to create an invoice.</Text>
          )}
          {model.error !== null && (
            <Text style={base.errorNote} accessibilityRole="alert">
              {model.error}
            </Text>
          )}
        </>
      )}

      {lightning !== null && status !== null && (
        <MobilePanel>
          <View style={base.rowBetween}>
            <Text style={base.overline}>Lightning invoice</Text>
            <MobileBadge label={RECEIVE_STATUS_LABEL[status]} tone={STATUS_TONE[status]} />
          </View>
          {lightning.decoded !== null && (
            <View style={local.facts}>
              {invoiceAmountSat(lightning.decoded) !== null ? (
                <Text style={base.dim}>
                  Amount: <MobileAmount sats={invoiceAmountSat(lightning.decoded) ?? 0n} style={base.dim} />
                </Text>
              ) : (
                <Text style={base.dim}>Amount: chosen by the payer</Text>
              )}
              {lightning.decoded.description !== null && lightning.decoded.description !== '' && (
                <Text style={base.dim}>Description: {lightning.decoded.description}</Text>
              )}
              {status !== 'paid' && (
              <Text style={base.faint}>
                {now >= lightning.decoded.expiresAt
                  ? `Expired at ${clockTime(lightning.decoded.expiresAt, now)}`
                  : `Expires at ${clockTime(lightning.decoded.expiresAt, now)} (in ${relativeDuration(lightning.decoded.expiresAt - now)})`}
              </Text>
              )}
            </View>
          )}
          {status === 'paid' ? (
            <MobileWarningBand tone="positive">
              <Text style={base.bandText}>Payment received.</Text>
            </MobileWarningBand>
          ) : status === 'expired' ? (
            <MobileWarningBand tone="warning">
              <Text style={base.bandText}>This invoice expired. Create a new one to get paid.</Text>
            </MobileWarningBand>
          ) : (
            <QrCode
              value={`lightning:${lightning.invoice}`}
              copyValue={lightning.invoice}
              label="QR code for your Lightning invoice"
              textLabel="Invoice"
            />
          )}
          <Text style={base.faint}>{lightning.statusNote}</Text>
        </MobilePanel>
      )}

      {onchain !== null && (
        <MobilePanel>
          <Text style={base.overline}>Bitcoin address</Text>
          <QrCode
            value={model.onchainUri(onchain.address, typed, model.memoText)}
            copyValue={onchain.address}
            label="QR code for your Bitcoin deposit address"
            textLabel="Your address"
          />
          {(typed !== null || model.memoText.trim() !== '') && (
            <Text style={base.faint}>The QR code includes the amount and label you entered.</Text>
          )}
          <MobileWarningBand tone="info">
            <Text style={base.bandText}>
              Use this address once. Reusing an address links your payments together publicly — tap New
              address for each payment.
            </Text>
          </MobileWarningBand>
          <Text style={base.overline}>Deposits to this wallet</Text>
          {onchain.deposits.length === 0 ? (
            <Text style={base.faint}>No on-chain deposits reported yet.</Text>
          ) : (
            onchain.deposits.map((d, i) => (
              <View key={d.id} style={[local.deposit, i > 0 ? local.divider : null]}>
                <View style={local.depositText}>
                  <MobileAmount sats={d.amountSat} />
                  {d.detail !== null && <Text style={base.faint}>{d.detail}</Text>}
                </View>
                <MobileBadge
                  label={d.status === 'settled' ? 'Confirmed' : d.status === 'failed' ? 'Failed' : 'Waiting for confirmation'}
                  tone={d.status === 'settled' ? 'positive' : d.status === 'failed' ? 'danger' : 'warning'}
                />
              </View>
            ))
          )}
          <Text style={base.faint}>{onchain.depositNote}</Text>
        </MobilePanel>
      )}

      {shareValue !== null && status !== 'paid' && status !== 'expired' && (
        share !== undefined ? (
          <MobileButton
            label="Share"
            kind="secondary"
            onPress={() => {
              void share(shareValue).catch(() => undefined);
            }}
          />
        ) : (
          <Text style={base.faint}>Sharing needs the system share sheet, which this build doesn&apos;t connect to yet.</Text>
        )
      )}
    </MobileScreen>
  );
}

const local = StyleSheet.create({
  facts: { gap: 2 },
  deposit: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 8 },
  depositText: { flexShrink: 1, gap: 2 },
  divider: { borderTopWidth: 1, borderTopColor: mobilePalette.border },
});
