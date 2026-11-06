/**
 * Transaction receipt, pushed onto the active tab's stack from Activity or
 * Home. Shows only what the source reported: amount, direction, a status
 * timeline of reported steps, the fee if known, identifiers (copyable when
 * the device has a clipboard) and timestamps. Anything the source does not
 * report says so instead of being left out silently.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { sovlFontSize, sovlSpace } from '@sovereign/ui/tokens';
import { RAIL_LABEL, amountSign, fullTime } from '../../flows/activity.js';
import type {
  ActivityField,
  ActivityFieldValue,
  ActivityIdentifier,
  ActivityItem,
  ActivityTimelineStep,
} from '../../flows/activity.js';
import { useAmountFormatter, usePlatformServices } from '../appContext.js';
import { shortenMiddle } from '../format.js';
import { MIN_TOUCH_TARGET } from '../navigationUi.js';
import {
  MobileAmount,
  MobileButton,
  MobileHeader,
  MobilePanel,
  MobileScreen,
  MobileWarningBand,
  mobilePalette,
  styles as base,
} from '../Primitives.js';
import { ActivityStatusBadge } from './ActivityParts.js';

export function TransactionDetailScreen({
  item,
  sourceLabel,
  onBack,
}: {
  /** null when the id is no longer in the loaded history. */
  item: ActivityItem | null;
  /** "Everyday wallet (Wavelength)" / "Your node" — who reported this. */
  sourceLabel: string;
  onBack: () => void;
}): ReactNode {
  if (item === null) {
    return (
      <MobileScreen>
        <MobileHeader title="Transaction" onBack={onBack} />
        <MobilePanel>
          <Text style={base.dim}>
            This transaction is no longer in the loaded history. Go back and refresh Activity to
            read it again.
          </Text>
        </MobilePanel>
      </MobileScreen>
    );
  }
  return (
    <MobileScreen>
      <MobileHeader title={`${item.title} · ${RAIL_LABEL[item.rail]}`} onBack={onBack} />
      <ReceiptHero item={item} />

      {item.status === 'failed' && (
        <MobileWarningBand tone="danger">
          <Text style={base.bandText}>
            {item.failureReason ?? 'The wallet reported this payment as failed.'}
          </Text>
          <Text style={base.dim}>
            {item.direction === 'out'
              ? 'A failed payment moves no funds. You can try again from Send with a fresh invoice or address.'
              : 'Nothing was received for this request.'}
          </Text>
        </MobileWarningBand>
      )}

      <MobilePanel title="Status">
        <Timeline steps={item.timeline} />
      </MobilePanel>

      <MobilePanel title="Details">
        <FieldRow label="Direction" value={{ kind: 'text', text: item.direction === 'out' ? 'Outgoing' : 'Incoming' }} />
        <FieldRow label="Type" value={{ kind: 'text', text: RAIL_LABEL[item.rail] }} />
        <FieldRow
          label={item.status === 'open' ? 'Requested amount' : 'Amount'}
          value={{ kind: 'amount', sats: item.amountSat }}
        />
        <FieldRow label="Fee" value={item.fee} />
        <FieldRow
          label="Memo"
          value={item.memo === null ? { kind: 'missing', reason: 'None recorded' } : { kind: 'text', text: item.memo }}
        />
        <FieldRow
          label="Time"
          value={item.at === null ? { kind: 'missing', reason: 'Not reported by this wallet' } : { kind: 'time', at: item.at }}
        />
        {item.fields.map((field: ActivityField) => (
          <FieldRow key={field.label} label={field.label} value={field.value} />
        ))}
        <FieldRow label="Reported by" value={{ kind: 'text', text: sourceLabel }} />
      </MobilePanel>

      <MobilePanel title="Identifiers">
        {item.identifiers.map((identifier, index) => (
          <IdentifierRow key={identifier.label} identifier={identifier} divider={index > 0} />
        ))}
      </MobilePanel>
    </MobileScreen>
  );
}

function ReceiptHero({ item }: { item: ActivityItem }): ReactNode {
  const amounts = useAmountFormatter();
  const sign = amountSign(item);
  return (
    <View style={local.hero}>
      <View
        accessible
        accessibilityLabel={`${item.direction === 'out' ? 'Sent' : 'Received'} ${amounts.accessibilityLabel(item.amountSat, sign)}`}
      >
        <Text style={local.heroAmount}>{amounts.format(item.amountSat, sign)}</Text>
      </View>
      <View style={base.rowStart}>
        <ActivityStatusBadge status={item.status} />
        {item.at !== null && <Text style={base.faint}>{fullTime(item.at)}</Text>}
      </View>
    </View>
  );
}

const STEP_COLOR: Readonly<Record<ActivityTimelineStep['state'], string>> = {
  done: mobilePalette.positive,
  current: mobilePalette.warning,
  failed: mobilePalette.danger,
};

const STEP_WORD: Readonly<Record<ActivityTimelineStep['state'], string>> = {
  done: 'done',
  current: 'in progress',
  failed: 'stopped',
};

/** Reported steps only, oldest first; a step without a time says so. */
function Timeline({ steps }: { steps: readonly ActivityTimelineStep[] }): ReactNode {
  return (
    <View>
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <View
            key={`${step.label}-${index}`}
            style={local.step}
            accessible
            accessibilityLabel={`${step.label}, ${STEP_WORD[step.state]}${
              step.at !== null ? `, ${fullTime(step.at)}` : ''
            }${step.detail !== undefined ? `, ${step.detail}` : ''}`}
          >
            <View style={local.stepRail}>
              <View style={[local.stepDot, { borderColor: STEP_COLOR[step.state] }, step.state !== 'current' ? { backgroundColor: STEP_COLOR[step.state] } : null]} />
              {!last && <View style={local.stepLine} />}
            </View>
            <View style={local.stepBody}>
              <Text style={base.value}>{step.label}</Text>
              <Text style={base.faint}>{step.at !== null ? fullTime(step.at) : 'Time not reported'}</Text>
              {step.detail !== undefined && <Text style={base.faint}>{step.detail}</Text>}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function FieldRow({ label, value }: { label: string; value: ActivityFieldValue }): ReactNode {
  return (
    <View style={local.field}>
      <Text style={[base.dim, local.fieldLabel]}>{label}</Text>
      {value.kind === 'amount' ? (
        <MobileAmount sats={value.sats} />
      ) : value.kind === 'time' ? (
        <Text style={[base.value, local.proportional]}>{fullTime(value.at)}</Text>
      ) : value.kind === 'missing' ? (
        <Text style={[base.dim, local.fieldValue, local.missing]}>{value.reason}</Text>
      ) : (
        <Text
          style={[base.value, local.fieldValue, value.mono === true ? base.mono : local.proportional]}
          selectable
        >
          {value.text}
        </Text>
      )}
    </View>
  );
}

/** An identifier, shortened for reading, selectable in full, with Copy when a clipboard exists. */
function IdentifierRow({ identifier, divider }: { identifier: ActivityIdentifier; divider: boolean }): ReactNode {
  const { copyText } = usePlatformServices();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [revealed, setRevealed] = useState(identifier.sensitive !== true);
  return (
    <View style={[local.identifier, divider ? local.divider : null]}>
      <View style={base.rowBetween}>
        <Text style={base.dim}>{identifier.label}</Text>
        {revealed && copyText !== undefined && (
          <MobileButton
            label={state === 'copied' ? 'Copied' : `Copy ${identifier.label.toLowerCase()}`}
            kind="ghost"
            compact
            onPress={() => {
              copyText(identifier.value).then(
                () => setState('copied'),
                () => setState('failed'),
              );
            }}
          />
        )}
      </View>
      {revealed ? (
        <Text style={[base.value, base.mono]} selectable accessibilityLabel={`${identifier.label}: ${identifier.value}`}>
          {identifier.value.length > 90 ? shortenMiddle(identifier.value, 40, 30) : identifier.value}
        </Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show ${identifier.label.toLowerCase()}`}
          onPress={() => setRevealed(true)}
          style={local.reveal}
        >
          <Text style={base.value}>Show {identifier.label.toLowerCase()}</Text>
        </Pressable>
      )}
      {identifier.hint !== undefined && <Text style={base.faint}>{identifier.hint}</Text>}
      {state === 'failed' && (
        <Text style={[base.faint, { color: mobilePalette.danger }]} accessibilityRole="alert">
          Could not copy. Select the text to copy it.
        </Text>
      )}
      {revealed && copyText === undefined && (
        <Text style={base.faint}>Select the text to copy it.</Text>
      )}
    </View>
  );
}

const local = StyleSheet.create({
  hero: { gap: sovlSpace[2], paddingVertical: sovlSpace[2] },
  heroAmount: {
    ...base.amountBig,
    fontSize: sovlFontSize['2xl'],
  },
  step: { flexDirection: 'row', gap: sovlSpace[3] },
  stepRail: { alignItems: 'center', width: 14 },
  stepDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, marginTop: 4 },
  stepLine: { flex: 1, width: 2, backgroundColor: mobilePalette.border, marginVertical: 2 },
  stepBody: { flex: 1, gap: 2, paddingBottom: sovlSpace[3] },
  field: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: sovlSpace[3],
    paddingVertical: 6,
  },
  fieldLabel: { flexShrink: 0 },
  fieldValue: { flexShrink: 1, textAlign: 'right' },
  missing: { fontStyle: 'italic', color: mobilePalette.textFaint },
  // Words and dates read better with proportional figures than tabular ones.
  proportional: { fontVariant: [] },
  identifier: { gap: sovlSpace[1], paddingVertical: sovlSpace[2] },
  divider: { borderTopWidth: 1, borderTopColor: mobilePalette.border },
  reveal: { minHeight: MIN_TOUCH_TARGET, justifyContent: 'center' },
});
