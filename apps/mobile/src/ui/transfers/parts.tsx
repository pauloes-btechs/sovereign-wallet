/**
 * Small building blocks shared by the transfers, liquidity and assets
 * screens. Colors come from the shared palette (`mobilePalette`); every
 * status is spelled out in text, color only reinforces it.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { sovlRadius, sovlSpace } from '@sovereign/ui/tokens';
import { usePlatformServices } from '../appContext.js';
import { MobileAmount, MobileButton, MobileWarningBand, mobilePalette, styles } from '../Primitives.js';
import { shortenMiddle } from '../format.js';
import type { StepStatus } from '../../flows/transfers.js';

/** Shown on every screen whose data comes from the simulated node. */
export function SimulatedBanner({ show, what }: { show: boolean; what: string }): ReactNode {
  if (!show) return null;
  return (
    <MobileWarningBand tone="info">
      {`Simulated node: everything on this screen (${what}) comes from a test stand-in running in this page. Nothing reaches a real node, swap server or Taproot Assets daemon.`}
    </MobileWarningBand>
  );
}

/** Label on the left, value (text or amount) on the right. */
export function Fact({
  label,
  children,
  note,
  strong = false,
  fixedValue = false,
}: {
  label: string;
  children: ReactNode;
  note?: string;
  strong?: boolean;
  /** Keep the value on one line (amounts); the label wraps instead. */
  fixedValue?: boolean;
}): ReactNode {
  const plain = typeof children === 'string' || typeof children === 'number';
  return (
    <View style={local.fact}>
      <View style={local.factRow}>
        <Text style={[styles.dim, strong ? local.strong : null, local.factLabel]}>{label}</Text>
        <View style={[local.factValue, fixedValue ? local.noShrink : null]}>
          {plain ? <Text style={[styles.value, strong ? local.strong : null, local.right]}>{children}</Text> : children}
        </View>
      </View>
      {note !== undefined && <Text style={styles.faint}>{note}</Text>}
    </View>
  );
}

export function AmountFact({
  label,
  sats,
  note,
  strong = false,
}: {
  label: string;
  sats: bigint;
  note?: string;
  strong?: boolean;
}): ReactNode {
  return (
    <Fact label={label} note={note} strong={strong} fixedValue>
      <MobileAmount sats={sats} style={strong ? local.strong : undefined} />
    </Fact>
  );
}

export function Divider(): ReactNode {
  return <View style={local.divider} />;
}

const STEP_TEXT: Readonly<Record<StepStatus, string>> = {
  done: 'Done',
  current: 'In progress',
  pending: 'Waiting',
  failed: 'Failed',
};

const STEP_COLOR: Readonly<Record<StepStatus, string>> = {
  done: mobilePalette.positive,
  current: mobilePalette.info,
  pending: mobilePalette.textFaint,
  failed: mobilePalette.danger,
};

/** A vertical progress list; each step says its status in words. */
export function StepList({
  steps,
}: {
  steps: readonly { readonly title: string; readonly body: string; readonly status: StepStatus }[];
}): ReactNode {
  return (
    <View style={local.steps} accessibilityRole="list">
      {steps.map((step, index) => (
        <View key={`${index}-${step.title}`} style={local.step} accessibilityLabel={`${step.title}: ${STEP_TEXT[step.status]}`}>
          <View style={local.stepRail}>
            <View style={[local.stepDot, { borderColor: STEP_COLOR[step.status] }, step.status === 'done' || step.status === 'failed' ? { backgroundColor: STEP_COLOR[step.status] } : null]} />
            {index < steps.length - 1 && <View style={local.stepLine} />}
          </View>
          <View style={local.stepText}>
            <View style={styles.rowBetween}>
              <Text style={[styles.value, local.shrink, step.status === 'pending' ? local.muted : null]}>{step.title}</Text>
              <Text style={[styles.faint, local.noShrink, { color: STEP_COLOR[step.status] }]}>{STEP_TEXT[step.status]}</Text>
            </View>
            {step.status !== 'pending' && <Text style={styles.faint}>{step.body}</Text>}
          </View>
        </View>
      ))}
    </View>
  );
}

/** A long id shortened for display, fully selectable, with Copy when a clipboard exists. */
export function CopyableId({ label, value }: { label: string; value: string }): ReactNode {
  const { copyText } = usePlatformServices();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <View style={local.fact}>
      <Text style={styles.dim}>{label}</Text>
      <View style={local.idRow}>
        <Text style={[styles.value, styles.mono, local.shrink]} selectable accessibilityLabel={`${label}: ${value}`}>
          {shortenMiddle(value, 12, 8)}
        </Text>
        {copyText !== undefined && (
          <MobileButton
            label={copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
            kind="ghost"
            compact
            onPress={() => {
              copyText(value).then(
                () => setCopied('copied'),
                () => setCopied('failed'),
              );
            }}
          />
        )}
      </View>
    </View>
  );
}

/** Two-sided bar: your side (left) and the peer's side (right). Numbers are in the text beside it. */
export function SplitBar({ share, dim = false }: { share: number; dim?: boolean }): ReactNode {
  const left = Math.max(0, Math.min(1, share));
  return (
    <View style={[local.bar, dim ? local.barDim : null]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {left > 0 && <View style={{ flexGrow: left, flexBasis: 0, backgroundColor: mobilePalette.fundOutbound }} />}
      {left < 1 && <View style={{ flexGrow: 1 - left, flexBasis: 0, backgroundColor: mobilePalette.fundInbound }} />}
    </View>
  );
}

/** A choice row (radio semantics) for pickers like FROM / TO. */
export function ChoiceRow({
  label,
  detail,
  selected,
  onPress,
  disabledNote,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
  /** Shown faint at the right when the choice has no route (still selectable, to read why). */
  disabledNote?: string;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={disabledNote ?? detail}
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      onPress={onPress}
      style={[local.choice, selected ? local.choiceSelected : null]}
    >
      <View style={[local.radio, selected ? local.radioOn : null]}>{selected && <View style={local.radioDot} />}</View>
      <View style={local.shrink}>
        <Text style={[styles.value, disabledNote !== undefined && !selected ? local.muted : null]}>{label}</Text>
        {detail !== undefined && <Text style={styles.faint}>{detail}</Text>}
      </View>
      {disabledNote !== undefined && <Text style={[styles.faint, local.choiceNote]}>{disabledNote}</Text>}
    </Pressable>
  );
}

export function Bullets({ items }: { items: readonly string[] }): ReactNode {
  return (
    <View style={local.bullets}>
      {items.map((item) => (
        <View key={item} style={local.bulletRow}>
          <Text style={styles.faint}>•</Text>
          <Text style={[styles.faint, local.shrink]}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

/** "2026-11-05 14:02 UTC", or the raw value when unparseable. */
export function utcTime(at: string): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return at;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export const local = StyleSheet.create({
  fact: { gap: 2 },
  factRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: sovlSpace[3] },
  factLabel: { flexShrink: 1 },
  factValue: { alignItems: 'flex-end', flexShrink: 1 },
  right: { textAlign: 'right' },
  strong: { color: mobilePalette.text, fontWeight: '600' },
  muted: { color: mobilePalette.textFaint },
  shrink: { flexShrink: 1, flexGrow: 1 },
  noShrink: { flexShrink: 0 },
  divider: { height: 1, backgroundColor: mobilePalette.border, marginVertical: sovlSpace[1] },
  steps: { gap: 0 },
  step: { flexDirection: 'row', gap: sovlSpace[3] },
  stepRail: { alignItems: 'center', width: 14 },
  stepDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, marginTop: 4 },
  stepLine: { flex: 1, width: 2, backgroundColor: mobilePalette.border, marginVertical: 2 },
  stepText: { flex: 1, gap: 2, paddingBottom: sovlSpace[3] },
  idRow: { flexDirection: 'row', alignItems: 'center', gap: sovlSpace[2] },
  bar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2 },
  barDim: { opacity: 0.4 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sovlSpace[3],
    paddingVertical: sovlSpace[3],
    paddingHorizontal: sovlSpace[3],
    borderRadius: sovlRadius.sm,
    borderWidth: 1,
    borderColor: mobilePalette.border,
    backgroundColor: mobilePalette.surface,
    minHeight: 48,
  },
  choiceSelected: { borderColor: mobilePalette.accent, backgroundColor: mobilePalette.surfaceRaised },
  choiceNote: { maxWidth: 96, textAlign: 'right' },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: mobilePalette.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: mobilePalette.accent },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: mobilePalette.accent },
  bullets: { gap: 4 },
  bulletRow: { flexDirection: 'row', gap: sovlSpace[2] },
  list: { gap: sovlSpace[2] },
  rowCard: {
    paddingVertical: sovlSpace[3],
    paddingHorizontal: sovlSpace[4],
    backgroundColor: mobilePalette.surface,
    borderColor: mobilePalette.border,
    borderWidth: 1,
    borderRadius: sovlRadius.md,
    gap: 4,
  },
});
