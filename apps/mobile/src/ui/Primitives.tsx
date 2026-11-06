/**
 * React Native primitives for the mobile screens — the mobile mirror of the
 * @sovereign/ui DOM components and the desktop platform kit. Colors, type
 * scale, spacing and radii come from `@sovereign/ui/tokens`, the TS twin of
 * the `--sovl-*` custom properties desktop renders with, so both apps share
 * one palette. Never hard-code a color here or in a screen.
 */

import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { providerTotalSat } from '@sovereign/ui/totals';
import {
  sovlColors,
  sovlFontFamily,
  sovlFontSize,
  sovlRadius,
  sovlSpace,
} from '@sovereign/ui/tokens';
import type { BalanceBuckets } from '@sovereign/wallet-core';
import { Children } from 'react';
import type { ReactNode } from 'react';
import { useAmountFormatter } from './appContext.js';
import { unitLabel } from './format.js';
import { MIN_TOUCH_TARGET } from './navigationUi.js';

const palette = sovlColors;

/** The shared palette, re-exported for screens that need a one-off tint. */
export const mobilePalette = palette;

/**
 * Web renders the desktop font stack; native uses the platform's system face
 * (an unbundled custom family is an error on iOS).
 */
const fontSans = Platform.select<string | undefined>({ web: sovlFontFamily.sans, default: undefined });
const fontMono = Platform.select<string>({
  web: sovlFontFamily.mono,
  ios: 'Menlo',
  default: 'monospace',
});

export type BandTone = 'info' | 'warning' | 'danger' | 'positive';

const toneColor: Record<BandTone, string> = {
  info: palette.info,
  warning: palette.warning,
  danger: palette.danger,
  positive: palette.positive,
};

// ——— Amounts ———

/**
 * The hero balance: the total in the user's denomination, largest text on
 * screen. Privacy mode masks the digits (spoken as "Amount hidden").
 */
export function MobileAmountBig({ sats }: { sats: bigint }): ReactNode {
  const amounts = useAmountFormatter();
  return (
    <View style={styles.amountBigRow} accessible accessibilityLabel={amounts.accessibilityLabel(sats)}>
      <Text style={styles.amountBig}>{amounts.format(sats).replace(/ (sats|BTC)$/, '')}</Text>
      <Text style={styles.amountUnit}>{unitLabel(amounts.preferences.denomination)}</Text>
    </View>
  );
}

/**
 * One amount as text in the user's denomination (masked in privacy mode).
 * Use this for every amount on every tab instead of formatting by hand.
 */
export function MobileAmount({
  sats,
  sign = null,
  style,
}: {
  sats: bigint;
  /** Direction sign for lists ('+' received, '−' sent). */
  sign?: '+' | '−' | null;
  style?: StyleProp<TextStyle>;
}): ReactNode {
  const amounts = useAmountFormatter();
  return (
    <Text style={[styles.value, style]} accessibilityLabel={amounts.accessibilityLabel(sats, sign)}>
      {amounts.format(sats, sign)}
    </Text>
  );
}

/** Labeled amount row (value right-aligned), with an optional fund-color key. */
export function MobileSats({
  label,
  sats,
  swatch,
}: {
  label: string;
  sats: bigint;
  swatch?: string;
}): ReactNode {
  return (
    <View style={styles.rowBetween}>
      <View style={styles.rowStart}>
        {swatch !== undefined && <View style={[styles.swatch, { backgroundColor: swatch }]} />}
        <Text style={styles.dim}>{label}</Text>
      </View>
      <MobileAmount sats={sats} />
    </View>
  );
}

/** Labeled text row (value right-aligned, monospace for keys/addresses). */
export function MobileLabelRow({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactNode {
  return (
    <View style={styles.labelRow}>
      <Text style={styles.dim}>{label}</Text>
      <Text style={[styles.value, mono ? styles.mono : null, styles.labelRowValue]} selectable>
        {value}
      </Text>
    </View>
  );
}

/**
 * Where funds sit, as one proportional bar — the desktop liquidity bar's
 * segment colors. Decorative: the rows beside it carry every number in text.
 */
function FundBar({
  segments,
}: {
  segments: ReadonlyArray<{ key: string; sats: bigint; color: string }>;
}): ReactNode {
  const total = segments.reduce((sum, s) => sum + s.sats, 0n);
  if (total === 0n) return <View style={[styles.fundBar, styles.fundBarEmpty]} />;
  return (
    <View style={styles.fundBar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {segments
        .filter((s) => s.sats > 0n)
        .map((s) => (
          <View
            key={s.key}
            style={{ flexGrow: Number((s.sats * 10_000n) / total), flexBasis: 0, backgroundColor: s.color }}
          />
        ))}
    </View>
  );
}

/** The three Mode A balance buckets plus the provider total. */
export function MobileBalanceGrid({ buckets }: { buckets: BalanceBuckets }): ReactNode {
  return (
    <View style={styles.panel}>
      <Text style={styles.overline}>Total balance</Text>
      <MobileAmountBig sats={providerTotalSat(buckets)} />
      <FundBar
        segments={[
          { key: 'lightning', sats: buckets.lightningSpendableSat, color: palette.fundOutbound },
          { key: 'onchain', sats: buckets.onchainConfirmedSat, color: palette.fundOnchain },
          { key: 'locked', sats: buckets.lockedOrExpiringSat, color: palette.fundLocked },
        ]}
      />
      <MobileSats
        label="Lightning (spendable)"
        sats={buckets.lightningSpendableSat}
        swatch={palette.fundOutbound}
      />
      <MobileSats
        label="On-chain (confirmed)"
        sats={buckets.onchainConfirmedSat}
        swatch={palette.fundOnchain}
      />
      <MobileSats
        label="Locked / expiring"
        sats={buckets.lockedOrExpiringSat}
        swatch={palette.fundLocked}
      />
    </View>
  );
}

/** "HH:MM:SS UTC" for a status line — deterministic across devices. */
export function utcClock(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 19)} UTC`;
}

// ——— Tabs ———

/** Segmented control for a flow's sub-views (Lightning / On-chain, Send / Receive). */
export function MobileFlowTabs({
  tabs,
  activeId,
  onChange,
  variant = 'segmented',
}: {
  tabs: ReadonlyArray<{ id: string; label: string }>;
  activeId: string;
  onChange: (id: string) => void;
  /** `underline` is the quieter, secondary level (e.g. the rail under Send / Receive). */
  variant?: 'segmented' | 'underline';
}): ReactNode {
  const underline = variant === 'underline';
  return (
    <View style={underline ? styles.underlineTabs : styles.segmented} accessibilityRole="tablist">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: active }}
            aria-selected={active}
            onPress={() => onChange(tab.id)}
            style={
              underline
                ? [styles.underlineTab, active ? styles.underlineTabActive : null]
                : [styles.segment, active ? styles.segmentActive : null]
            }
          >
            <Text style={[styles.segmentText, active ? styles.segmentTextActive : null]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ——— Buttons ———

type ButtonKind = 'primary' | 'secondary' | 'ghost';

function buttonStyle(kind: ButtonKind): { bg: string; fg: string; border: string } {
  switch (kind) {
    case 'primary':
      return { bg: palette.accent, fg: palette.accentContrast, border: palette.accent };
    case 'secondary':
      return { bg: palette.surfaceRaised, fg: palette.text, border: palette.borderStrong };
    case 'ghost':
      return { bg: 'transparent', fg: palette.text, border: palette.border };
  }
}

export function MobileButton({
  label,
  onPress,
  kind = 'primary',
  disabled = false,
  busy = false,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  /** Work in progress — announced to assistive tech, and blocks presses. */
  busy?: boolean;
  compact?: boolean;
}): ReactNode {
  const tone = buttonStyle(kind);
  const inert = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inert, busy }}
      aria-disabled={inert}
      aria-busy={busy}
      onPress={inert ? undefined : onPress}
      hitSlop={compact ? 4 : undefined}
      style={[
        styles.button,
        compact ? styles.buttonCompact : null,
        { backgroundColor: tone.bg, borderColor: tone.border },
        inert ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={[styles.buttonText, compact ? styles.buttonTextCompact : null, { color: tone.fg }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function MobileButtonGroup({
  children,
  row = false,
}: {
  children: ReactNode;
  /** Side by side, equal widths (e.g. Send / Receive). */
  row?: boolean;
}): ReactNode {
  if (!row) return <View style={styles.buttonGroup}>{children}</View>;
  return (
    <View style={styles.buttonRow}>
      {Children.map(children, (child) => (
        <View style={styles.buttonRowCell}>{child}</View>
      ))}
    </View>
  );
}

/** A tappable list row that opens another screen. */
export function MobileNavRow({
  label,
  detail,
  onPress,
}: {
  label: string;
  detail?: string;
  onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
      onPress={onPress}
      style={styles.navRow}
    >
      <View style={styles.navRowText}>
        <Text style={styles.value}>{label}</Text>
        {detail !== undefined && <Text style={styles.faint}>{detail}</Text>}
      </View>
      <Text style={styles.chevron} accessibilityElementsHidden importantForAccessibility="no">
        ›
      </Text>
    </Pressable>
  );
}

// ——— Fields ———

export function MobileField({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  multiline = false,
  secure = false,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  /** Helper text under the input (also read as the accessibility hint). */
  hint?: string;
  multiline?: boolean;
  secure?: boolean;
}): ReactNode {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={[styles.input, multiline ? styles.inputMultiline : null]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        multiline={multiline}
      />
      {hint !== undefined && <Text style={styles.faint}>{hint}</Text>}
    </View>
  );
}

// ——— Feedback ———

export function MobileErrorNote({ error }: { error: string | null }): ReactNode {
  if (error === null) return null;
  return (
    <Text style={styles.errorNote} accessibilityRole="alert">
      {error}
    </Text>
  );
}

/** Small inline status label — tone is carried by the text, color only reinforces it. */
export function MobileBadge({ label, tone }: { label: string; tone: BandTone | 'neutral' }): ReactNode {
  const color = tone === 'neutral' ? palette.textSecondary : toneColor[tone];
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

/** Full-width status band — the VTXO lifecycle and recovery rejections. */
export function MobileWarningBand({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: BandTone;
}): ReactNode {
  // React Native throws on raw strings outside <Text> ("Text strings must be
  // rendered within a <Text> component"), so plain-text bands are wrapped
  // here; composed children (Text + buttons) pass through untouched.
  const isPlainText = (c: ReactNode): boolean => typeof c === 'string' || typeof c === 'number';
  const plain = isPlainText(children) || (Array.isArray(children) && children.every(isPlainText));
  return (
    <View style={[styles.band, { borderLeftColor: toneColor[tone] }]} accessibilityRole="alert">
      {plain ? <Text style={styles.bandText}>{children}</Text> : children}
    </View>
  );
}

/** A titled group on a screen (desktop `Panel`). */
export function MobilePanel({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <View style={styles.panel}>
      {title !== undefined && <Text style={styles.overline}>{title}</Text>}
      {children}
    </View>
  );
}

// ——— Modal + words ———

export function MobileModal({
  open,
  title,
  body,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  onClose: () => void;
}): ReactNode {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.h3}>{title}</Text>
          <Text style={styles.dim}>{body}</Text>
          <MobileButton label="OK" onPress={onClose} kind="secondary" />
        </View>
      </View>
    </Modal>
  );
}

/** The recovery phrase, numbered, on the "show" step. */
export function MobileWords({ words }: { words: readonly string[] }): ReactNode {
  return (
    <View style={[styles.panel, styles.wordsGrid]}>
      {words.map((word, index) => (
        <View key={`${index}-${word}`} style={styles.wordCell}>
          <Text style={styles.wordIndex}>{String(index + 1).padStart(2, '0')}</Text>
          <Text style={[styles.value, styles.mono]}>{word}</Text>
        </View>
      ))}
    </View>
  );
}

// ——— Screen chrome ———

/**
 * A scrolling screen body. `footer` (the tab bar) stays pinned below the
 * scroll area.
 */
export function MobileScreen({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  return (
    <View style={styles.screen}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.screenInner}>
        {children}
      </ScrollView>
      {footer}
    </View>
  );
}

export function MobileHeader({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
}): ReactNode {
  return (
    <View style={styles.header}>
      {onBack !== undefined && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          style={styles.backButton}
        >
          <Text style={styles.backLink}>‹ Back</Text>
        </Pressable>
      )}
      <Text style={styles.h2} accessibilityRole="header">
        {title}
      </Text>
      {subtitle !== undefined && <Text style={styles.faint}>{subtitle}</Text>}
    </View>
  );
}

const text = { fontFamily: fontSans } as const;

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.bg },
  scroll: { flex: 1 },
  screenInner: { padding: sovlSpace[4], gap: sovlSpace[3], paddingBottom: sovlSpace[6] },
  panel: {
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: sovlRadius.md,
    padding: sovlSpace[4],
    gap: sovlSpace[2],
  },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: sovlSpace[3] },
  rowStart: { flexDirection: 'row', alignItems: 'center', gap: sovlSpace[2], flexShrink: 1 },
  labelRow: { gap: 2 },
  labelRowValue: { flexShrink: 1 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  amountBigRow: { flexDirection: 'row', alignItems: 'baseline', gap: sovlSpace[2] },
  amountBig: {
    ...text,
    color: palette.text,
    fontSize: sovlFontSize['3xl'],
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  amountUnit: { ...text, color: palette.textSecondary, fontSize: sovlFontSize.lg },
  fundBar: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    gap: 2,
    marginVertical: sovlSpace[1],
  },
  fundBarEmpty: { backgroundColor: palette.surfaceRaised },
  overline: { ...text, color: palette.textSecondary, fontSize: sovlFontSize.sm, fontWeight: '500' },
  value: {
    ...text,
    color: palette.text,
    fontSize: sovlFontSize.md,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  dim: { ...text, color: palette.textSecondary, fontSize: sovlFontSize.md, lineHeight: 20 },
  faint: { ...text, color: palette.textFaint, fontSize: sovlFontSize.xs, lineHeight: 16 },
  mono: { fontFamily: fontMono, fontSize: sovlFontSize.sm },
  h2: { ...text, color: palette.text, fontSize: sovlFontSize.xl, fontWeight: '600' },
  h3: { ...text, color: palette.text, fontSize: sovlFontSize.lg, fontWeight: '600' },
  segmented: {
    flexDirection: 'row',
    backgroundColor: palette.sidebar,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: sovlRadius.sm,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    minHeight: 40,
    justifyContent: 'center',
    paddingVertical: sovlSpace[2],
    borderRadius: sovlRadius.xs,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: palette.surfaceRaised },
  segmentText: { ...text, color: palette.textSecondary, fontSize: sovlFontSize.md, fontWeight: '500' },
  segmentTextActive: { color: palette.text, fontWeight: '600' },
  underlineTabs: {
    flexDirection: 'row',
    gap: sovlSpace[5],
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  underlineTab: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingVertical: sovlSpace[2],
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginBottom: -1,
  },
  underlineTabActive: { borderBottomColor: palette.text },
  button: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingVertical: sovlSpace[3],
    paddingHorizontal: sovlSpace[4],
    borderRadius: sovlRadius.sm,
    borderWidth: 1,
    alignItems: 'center',
  },
  buttonCompact: { minHeight: 36, paddingVertical: 6, paddingHorizontal: sovlSpace[3] },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { ...text, fontSize: sovlFontSize.md, fontWeight: '600' },
  buttonTextCompact: { fontSize: sovlFontSize.sm },
  buttonGroup: { gap: sovlSpace[2] },
  buttonRow: { flexDirection: 'row', gap: sovlSpace[2] },
  buttonRowCell: { flex: 1 },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sovlSpace[3],
    paddingVertical: sovlSpace[3],
    paddingHorizontal: sovlSpace[4],
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: sovlRadius.md,
  },
  navRowText: { flex: 1, gap: 2 },
  chevron: { ...text, color: palette.textFaint, fontSize: sovlFontSize.xl },
  fieldWrap: { gap: 6 },
  fieldLabel: { ...text, color: palette.textSecondary, fontSize: sovlFontSize.sm, fontWeight: '500' },
  input: {
    ...text,
    backgroundColor: palette.surfaceRaised,
    borderColor: palette.borderStrong,
    borderWidth: 1,
    borderRadius: sovlRadius.sm,
    color: palette.text,
    paddingHorizontal: sovlSpace[3],
    paddingVertical: 10,
    fontSize: sovlFontSize.md,
  },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  errorNote: { ...text, color: palette.danger, fontSize: sovlFontSize.md, lineHeight: 20 },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: sovlSpace[2],
    paddingVertical: 1,
    alignSelf: 'flex-start',
  },
  badgeText: { ...text, fontSize: sovlFontSize.xs, fontWeight: '500' },
  band: {
    borderLeftWidth: 3,
    backgroundColor: palette.surface,
    borderColor: palette.border,
    padding: sovlSpace[3],
    borderRadius: sovlRadius.sm,
    gap: sovlSpace[1],
  },
  bandText: { ...text, color: palette.text, fontSize: sovlFontSize.md, lineHeight: 20 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: sovlSpace[5],
  },
  modalCard: {
    backgroundColor: palette.surfaceRaised,
    borderRadius: sovlRadius.md,
    padding: sovlSpace[4],
    gap: sovlSpace[3],
    width: '100%',
  },
  wordsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 0, paddingVertical: sovlSpace[2] },
  wordCell: {
    width: '50%',
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: sovlSpace[2],
    paddingVertical: 6,
  },
  wordIndex: { ...text, color: palette.textFaint, fontSize: sovlFontSize.xs, width: 20 },
  header: { gap: 2, paddingTop: sovlSpace[1] },
  backButton: {
    alignSelf: 'flex-start',
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingRight: sovlSpace[3],
    marginLeft: -sovlSpace[1],
    paddingLeft: sovlSpace[1],
  },
  backLink: { ...text, color: palette.textSecondary, fontSize: sovlFontSize.md },
});
