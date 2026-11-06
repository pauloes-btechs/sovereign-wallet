/**
 * Settings controls for the Wallet tab: grouped sections, rows, switches,
 * single-choice lists, "applied by this wallet" status and a PIN field.
 *
 * Rules every control here follows:
 * - a disabled control always shows why (`disabledReason`) in text;
 * - state is spoken (switch/radio roles with checked state), never color only;
 * - touch targets are at least 44pt.
 */

import { Children, isValidElement } from 'react';
import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { sovlColors, sovlFontFamily, sovlFontSize, sovlRadius, sovlSpace } from '@sovereign/ui/tokens';
import type { FeatureStatus } from '../../flows/capabilities.js';
import { MIN_TOUCH_TARGET } from '../navigationUi.js';
import { MobileBadge, styles as base } from '../Primitives.js';

const palette = sovlColors;
const fontSans = Platform.select<string | undefined>({ web: sovlFontFamily.sans, default: undefined });

/** A titled group of rows with dividers between them. */
export function SettingsSection({
  title,
  footnote,
  children,
}: {
  title?: string;
  footnote?: string;
  children: ReactNode;
}): ReactNode {
  const rows = Children.toArray(children).filter((child) => isValidElement(child));
  return (
    <View style={kit.sectionWrap}>
      {title !== undefined && (
        <Text style={kit.sectionTitle} accessibilityRole="header">
          {title}
        </Text>
      )}
      <View style={kit.section}>
        {rows.map((row, index) => (
          <View key={index} style={index > 0 ? kit.divider : null}>
            {row}
          </View>
        ))}
      </View>
      {footnote !== undefined && <Text style={[base.faint, kit.footnote]}>{footnote}</Text>}
    </View>
  );
}

/** Read-only row: label, optional value on the right, optional explanation below. */
export function SettingRow({
  label,
  value,
  description,
  badge,
  children,
}: {
  label: string;
  value?: string;
  description?: string;
  badge?: { label: string; tone: 'positive' | 'warning' | 'danger' | 'info' | 'neutral' };
  children?: ReactNode;
}): ReactNode {
  return (
    <View style={kit.row}>
      <View style={kit.rowHead}>
        <Text style={[base.value, kit.rowLabel]}>{label}</Text>
        {value !== undefined && (
          <Text style={[base.dim, kit.rowValue]} selectable>
            {value}
          </Text>
        )}
        {badge !== undefined && <MobileBadge label={badge.label} tone={badge.tone} />}
      </View>
      {description !== undefined && <Text style={base.faint}>{description}</Text>}
      {children}
    </View>
  );
}

/** A row that opens another screen or sheet. */
export function SettingLinkRow({
  label,
  value,
  description,
  onPress,
}: {
  label: string;
  value?: string;
  description?: string;
  onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      onPress={onPress}
      style={({ pressed }) => [kit.row, kit.linkRow, pressed ? kit.pressed : null]}
    >
      <View style={kit.linkText}>
        <Text style={base.value}>{label}</Text>
        {description !== undefined && <Text style={base.faint}>{description}</Text>}
      </View>
      {value !== undefined && <Text style={[base.dim, kit.linkValue]}>{value}</Text>}
      <Text style={base.chevron} accessibilityElementsHidden importantForAccessibility="no" aria-hidden>
        ›
      </Text>
    </Pressable>
  );
}

/** On/off control. With `disabledReason` it is inert and says why. */
export function ToggleRow({
  label,
  description,
  value,
  onChange,
  disabledReason = null,
  busy = false,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabledReason?: string | null;
  busy?: boolean;
}): ReactNode {
  const inert = disabledReason !== null || busy;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={disabledReason ?? description}
      accessibilityState={{ checked: value, disabled: inert, busy }}
      aria-checked={value}
      aria-disabled={inert}
      disabled={inert}
      onPress={inert ? undefined : () => onChange(!value)}
      style={[kit.row, kit.toggleRow]}
    >
      <View style={kit.linkText}>
        <Text style={[base.value, inert ? kit.inertText : null]}>{label}</Text>
        {description !== undefined && <Text style={base.faint}>{description}</Text>}
        {disabledReason !== null && <Text style={[base.faint, kit.reason]}>{disabledReason}</Text>}
      </View>
      <View
        style={[kit.track, value ? kit.trackOn : null, inert ? kit.inert : null]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={[kit.thumb, value ? kit.thumbOn : null]} />
      </View>
      <Text style={[base.faint, kit.toggleState]} accessibilityElementsHidden importantForAccessibility="no">
        {value ? 'On' : 'Off'}
      </Text>
    </Pressable>
  );
}

/** Single choice from a short list (radio semantics). */
export function ChoiceList<T extends string | number>({
  label,
  options,
  selected,
  onSelect,
  disabledReason = null,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; detail?: string }>;
  selected: T;
  onSelect: (value: T) => void;
  disabledReason?: string | null;
}): ReactNode {
  const inert = disabledReason !== null;
  return (
    <View style={kit.choiceWrap} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((option) => {
        const checked = option.value === selected;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityHint={option.detail}
            accessibilityState={{ checked, disabled: inert }}
            aria-checked={checked}
            aria-disabled={inert}
            disabled={inert}
            onPress={inert || checked ? undefined : () => onSelect(option.value)}
            style={[kit.choice, checked ? kit.choiceOn : null, inert ? kit.inert : null]}
          >
            <View style={[kit.radio, checked ? kit.radioOn : null]}>
              {checked && <View style={kit.radioDot} />}
            </View>
            <View style={kit.linkText}>
              <Text style={base.value}>{option.label}</Text>
              {option.detail !== undefined && <Text style={base.faint}>{option.detail}</Text>}
            </View>
          </Pressable>
        );
      })}
      {disabledReason !== null && <Text style={[base.faint, kit.reason]}>{disabledReason}</Text>}
    </View>
  );
}

/**
 * Whether the ACTIVE wallet applies a setting — straight from its
 * capability status. Never claims an effect the backend does not have.
 */
export function AppliesNote({ status }: { status: FeatureStatus }): ReactNode {
  return (
    <View style={kit.applies}>
      <MobileBadge
        label={status.available ? 'Applied by this wallet' : 'Not applied by this wallet'}
        tone={status.available ? 'positive' : 'neutral'}
      />
      <Text style={base.faint}>{status.available ? (status.note ?? '') : status.reason}</Text>
    </View>
  );
}

/** Secure numeric PIN input. */
export function PinField({
  label,
  value,
  onChangeText,
  onSubmit,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
}): ReactNode {
  return (
    <View style={base.fieldWrap}>
      <Text style={base.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={[base.input, kit.pinInput]}
        value={value}
        onChangeText={(text) => onChangeText(text.replace(/[^0-9]/g, '').slice(0, 12))}
        keyboardType="number-pad"
        secureTextEntry
        autoComplete="off"
        autoCorrect={false}
        autoCapitalize="none"
        textContentType="oneTimeCode"
        maxLength={12}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmit}
        returnKeyType="done"
      />
    </View>
  );
}

/** Generic labelled text input for settings sheets (numbers, names). */
export function SettingInput({
  label,
  value,
  onChangeText,
  hint,
  numeric = false,
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  hint?: string;
  numeric?: boolean;
  maxLength?: number;
}): ReactNode {
  return (
    <View style={base.fieldWrap}>
      <Text style={base.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={base.input}
        value={value}
        onChangeText={onChangeText}
        keyboardType={numeric ? 'number-pad' : 'default'}
        autoCorrect={false}
        autoCapitalize={numeric ? 'none' : 'sentences'}
        maxLength={maxLength}
        placeholderTextColor={palette.textFaint}
      />
      {hint !== undefined && <Text style={base.faint}>{hint}</Text>}
    </View>
  );
}

export const kit = StyleSheet.create({
  sectionWrap: { gap: sovlSpace[2] },
  sectionTitle: {
    fontFamily: fontSans,
    color: palette.textSecondary,
    fontSize: sovlFontSize.sm,
    fontWeight: '600',
    paddingHorizontal: sovlSpace[1],
  },
  section: {
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: sovlRadius.md,
    overflow: 'hidden',
  },
  footnote: { paddingHorizontal: sovlSpace[1] },
  divider: { borderTopWidth: 1, borderTopColor: palette.border },
  row: { paddingVertical: sovlSpace[3], paddingHorizontal: sovlSpace[4], gap: 4, minHeight: MIN_TOUCH_TARGET },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: sovlSpace[2], flexWrap: 'wrap' },
  rowLabel: { flexGrow: 1, flexShrink: 1 },
  rowValue: { flexShrink: 1, textAlign: 'right' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: sovlSpace[3] },
  linkText: { flex: 1, gap: 2 },
  linkValue: { flexShrink: 0, maxWidth: '45%', textAlign: 'right' },
  pressed: { backgroundColor: palette.surfaceRaised },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: sovlSpace[3] },
  toggleState: { width: 22, textAlign: 'right' },
  track: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: palette.borderStrong,
    padding: 3,
    justifyContent: 'center',
  },
  trackOn: { backgroundColor: palette.accent },
  thumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: palette.textSecondary },
  thumbOn: { backgroundColor: palette.accentContrast, alignSelf: 'flex-end' },
  inert: { opacity: 0.45 },
  inertText: { color: palette.textSecondary },
  reason: { color: palette.textSecondary },
  choiceWrap: { gap: sovlSpace[1] },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sovlSpace[3],
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: sovlSpace[2],
    paddingHorizontal: sovlSpace[3],
    borderRadius: sovlRadius.sm,
    borderWidth: 1,
    borderColor: palette.border,
  },
  choiceOn: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: palette.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: palette.accent },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: palette.accent },
  applies: { gap: 4, paddingTop: 2 },
  pinInput: { fontSize: sovlFontSize.lg, letterSpacing: 6 },
});
