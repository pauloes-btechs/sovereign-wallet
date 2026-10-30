/**
 * React Native primitives for the Mode A screens — the mobile mirror of the
 * @sovereign/ui DOM components. Props match their DOM counterparts so wording
 * and information hierarchy stay identical across platforms; rendering uses
 * RN Views/Text/Pressables instead of DOM elements.
 */

import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatSats, satsLabel } from '@sovereign/ui/copy';
import { providerTotalSat } from '@sovereign/ui/totals';
import type { BalanceBuckets } from '@sovereign/wallet-core';
import type { ReactNode } from 'react';

const palette = {
  bg: '#0B0C0E',
  panel: '#141519',
  panelBorder: '#26282E',
  text: '#F2F3F5',
  textDim: '#9BA1AB',
  textFaint: '#6B7280',
  accent: '#F7931A',
  green: '#3DDB84',
  red: '#F0524D',
  yellow: '#F5B840',
  blue: '#5AA7FF',
  input: '#1B1D23',
} as const;

export const mobilePalette = palette;

// ——— Amounts ———

/** The hero balance: integer sats, bitcoin-orange, largest text on screen. */
export function MobileAmountBig({ sats }: { sats: bigint }): ReactNode {
  return <Text style={styles.amountBig}>{formatSats(sats)}</Text>;
}

/** Labeled sat amount row (value right-aligned). */
export function MobileSats({ label, sats }: { label: string; sats: bigint }): ReactNode {
  return (
    <View style={styles.rowBetween}>
      <Text style={styles.dim}>{label}</Text>
      <Text style={styles.value}>{satsLabel(sats)}</Text>
    </View>
  );
}

/** Labeled text row (value right-aligned, monospace for keys/addresses). */
export function MobileLabelRow({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <View style={styles.rowBetween}>
      <Text style={styles.dim}>{label}</Text>
      <Text style={[styles.value, styles.mono]}>{value}</Text>
    </View>
  );
}

/** The three Mode A balance buckets plus the provider total. */
export function MobileBalanceGrid({ buckets }: { buckets: BalanceBuckets }): ReactNode {
  return (
    <View style={styles.panel}>
      <MobileAmountBig sats={providerTotalSat(buckets)} />
      <View style={styles.divider} />
      <MobileSats label="Lightning (spendable)" sats={buckets.lightningSpendableSat} />
      <MobileSats label="On-chain (confirmed)" sats={buckets.onchainConfirmedSat} />
      <MobileSats label="Locked / expiring" sats={buckets.lockedOrExpiringSat} />
    </View>
  );
}

/** Network + runtime status line, mirroring the DOM BalanceStatus. */
export function MobileBalanceStatus({
  network,
  status,
  syncedAt,
}: {
  network: string;
  status: 'synced' | 'syncing' | 'unreachable';
  syncedAt: number;
}): ReactNode {
  const label =
    status === 'synced' ? 'Synced' : status === 'syncing' ? 'Syncing…' : 'Unreachable';
  return (
    <Text style={styles.faint}>
      {network} · {label} · as of {new Date(syncedAt).toISOString().slice(11, 19)} UTC
    </Text>
  );
}

// ——— Tabs ———

export function MobileFlowTabs({
  tabs,
  activeId,
  onChange,
}: {
  tabs: ReadonlyArray<{ id: string; label: string }>;
  activeId: string;
  onChange: (id: string) => void;
}): ReactNode {
  return (
    <View style={styles.tabRow}>
      {tabs.map((tab) => (
        <Pressable
          key={tab.id}
          accessibilityRole="button"
          accessibilityLabel={tab.label}
          onPress={() => onChange(tab.id)}
          style={[styles.tab, tab.id === activeId ? styles.tabActive : null]}
        >
          <Text style={tab.id === activeId ? styles.tabTextActive : styles.dim}>{tab.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ——— Buttons ———

function buttonStyle(kind: 'primary' | 'secondary'): { bg: string; fg: string; border: string } {
  return kind === 'primary'
    ? { bg: palette.accent, fg: '#181818', border: palette.accent }
    : { bg: 'transparent', fg: palette.text, border: palette.panelBorder };
}

export function MobileButton({
  label,
  onPress,
  kind = 'primary',
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary';
  disabled?: boolean;
}): ReactNode {
  const tone = buttonStyle(kind);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: disabled }}
      onPress={disabled ? undefined : onPress}
      style={[styles.button, { backgroundColor: tone.bg, borderColor: tone.border }, disabled ? styles.buttonDisabled : null]}
    >
      <Text style={[styles.buttonText, { color: tone.fg }, disabled ? styles.buttonTextDisabled : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function MobileButtonGroup({ children }: { children: ReactNode }): ReactNode {
  return <View style={styles.buttonGroup}>{children}</View>;
}

// ——— Fields ———

export function MobileField({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  secure = false,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  multiline?: boolean;
  secure?: boolean;
}): ReactNode {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.dim}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
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
    </View>
  );
}

// ——— Feedback ———

export function MobileErrorNote({ error }: { error: string | null }): ReactNode {
  if (error === null) return null;
  return <Text style={styles.errorNote}>{error}</Text>;
}

/** Full-width status band — the VTXO lifecycle and recovery rejections. */
export function MobileWarningBand({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'danger';
}): ReactNode {
  const color = tone === 'warning' ? palette.yellow : tone === 'danger' ? palette.red : palette.blue;
  return (
    <View style={[styles.band, { borderLeftColor: color }]} accessibilityRole="alert">
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
    <View style={styles.panel}>
      {words.map((word, index) => (
        <View key={`${index}-${word}`} style={styles.rowBetween}>
          <Text style={styles.dim}>{String(index + 1).padStart(2, '0')}</Text>
          <Text style={[styles.value, styles.mono]}>{word}</Text>
        </View>
      ))}
    </View>
  );
}

// ——— Screen chrome ———

export function MobileScreen({ children }: { children: ReactNode }): ReactNode {
  return (
    <View style={styles.screen}>
      <View style={styles.screenInner}>{children}</View>
    </View>
  );
}

export function MobileHeader({
  title,
  onBack,
}: {
  title: string;
  onBack?: () => void;
}): ReactNode {
  return (
    <View style={styles.headerRow}>
      {onBack !== undefined && (
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={styles.backLink}>‹ Back</Text>
        </Pressable>
      )}
      <Text style={styles.h2}>{title}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.bg },
  screenInner: { padding: 16, gap: 12 },
  panel: {
    backgroundColor: palette.panel,
    borderColor: palette.panelBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  divider: { height: 1, backgroundColor: palette.panelBorder, marginVertical: 6 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  amountBig: { color: palette.accent, fontSize: 36, fontWeight: '700' },
  value: { color: palette.text, fontSize: 15, fontWeight: '600' },
  dim: { color: palette.textDim, fontSize: 14 },
  faint: { color: palette.textFaint, fontSize: 12 },
  mono: { fontFamily: 'monospace' },
  h2: { color: palette.text, fontSize: 22, fontWeight: '700' },
  h3: { color: palette.text, fontSize: 17, fontWeight: '700' },
  tabRow: { flexDirection: 'row', gap: 8 },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: palette.panelBorder,
    alignItems: 'center',
  },
  tabActive: { borderColor: palette.accent },
  tabTextActive: { color: palette.accent, fontWeight: '700', fontSize: 14 },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 15, fontWeight: '700' },
  buttonTextDisabled: { color: palette.textFaint },
  buttonGroup: { gap: 8 },
  fieldWrap: { gap: 4 },
  input: {
    backgroundColor: palette.input,
    borderColor: palette.panelBorder,
    borderWidth: 1,
    borderRadius: 8,
    color: palette.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  errorNote: { color: palette.red, fontSize: 14 },
  band: {
    borderLeftWidth: 3,
    backgroundColor: palette.panel,
    padding: 12,
    borderRadius: 8,
    gap: 4,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: { backgroundColor: palette.panel, borderRadius: 12, padding: 16, gap: 10, width: '100%' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  backLink: { color: palette.blue, fontSize: 15 },
});
