/**
 * Navigation chrome: the five-tab bottom bar (with drawn icons), the
 * Android hardware-back hook, and a back-aware stack header.
 *
 * Accessibility: each tab is one element with role "tab", its label as the
 * accessible name and its selected state; the icon is decorative and
 * hidden from screen readers. Touch targets are at least 44pt high.
 */

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { sovlColors, sovlFontFamily, sovlFontSize, sovlSpace } from '@sovereign/ui/tokens';
import { PRIMARY_TABS, PRIMARY_TAB_LABELS } from '../flows/navigation.js';
import type { PrimaryTab } from '../flows/navigation.js';

const palette = sovlColors;
const fontSans = Platform.select<string | undefined>({ web: sovlFontFamily.sans, default: undefined });

/** Minimum touch target (Apple HIG 44pt; Material 48dp is met by the 56pt bar). */
export const MIN_TOUCH_TARGET = 44;

// ——— icons ———

/** Simple line icons drawn with Views (no icon font or SVG dependency). */
export function TabIcon({ tab, color }: { tab: PrimaryTab; color: string }): ReactNode {
  return (
    <View
      style={icon.box}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
    >
      {tab === 'home' && (
        <>
          <View style={[icon.roof, { borderColor: color }]} />
          <View style={[icon.house, { borderColor: color }]} />
        </>
      )}
      {tab === 'activity' && (
        <>
          <View style={[icon.bar, { top: 5, width: 18, backgroundColor: color }]} />
          <View style={[icon.bar, { top: 11, width: 14, backgroundColor: color }]} />
          <View style={[icon.bar, { top: 17, width: 10, backgroundColor: color }]} />
        </>
      )}
      {tab === 'send' && (
        <>
          <View style={[icon.stem, { top: 5, backgroundColor: color }]} />
          <View style={[icon.chevron, icon.chevronUp, { borderColor: color }]} />
        </>
      )}
      {tab === 'receive' && (
        <>
          <View style={[icon.stem, { top: 3, backgroundColor: color }]} />
          <View style={[icon.chevron, icon.chevronDown, { borderColor: color }]} />
          <View style={[icon.base, { backgroundColor: color }]} />
        </>
      )}
      {tab === 'wallet' && (
        <>
          <View style={[icon.walletBody, { borderColor: color }]} />
          <View style={[icon.walletClasp, { backgroundColor: color }]} />
        </>
      )}
    </View>
  );
}

const icon = StyleSheet.create({
  box: { width: 24, height: 24, position: 'relative' },
  roof: {
    position: 'absolute',
    left: 5,
    top: 4,
    width: 14,
    height: 14,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    transform: [{ rotate: '45deg' }],
  },
  house: {
    position: 'absolute',
    left: 6,
    top: 11,
    width: 12,
    height: 10,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderBottomWidth: 2,
  },
  bar: { position: 'absolute', left: 3, height: 2, borderRadius: 1 },
  stem: { position: 'absolute', left: 11, width: 2, height: 15, borderRadius: 1 },
  chevron: {
    position: 'absolute',
    left: 7,
    width: 10,
    height: 10,
    transform: [{ rotate: '45deg' }],
  },
  chevronUp: { top: 5, borderTopWidth: 2, borderLeftWidth: 2 },
  chevronDown: { top: 8, borderBottomWidth: 2, borderRightWidth: 2 },
  base: { position: 'absolute', left: 4, top: 21, width: 16, height: 2, borderRadius: 1 },
  walletBody: {
    position: 'absolute',
    left: 2,
    top: 5,
    width: 20,
    height: 15,
    borderWidth: 2,
    borderRadius: 4,
  },
  walletClasp: { position: 'absolute', left: 14, top: 11, width: 5, height: 4, borderRadius: 1 },
});

// ——— tab bar ———

/**
 * The bottom tab bar. `bottomInset` is the device's bottom safe area
 * (home indicator / gesture bar); the bar pads by at least one spacing step.
 */
export function PrimaryTabBar({
  activeTab,
  onSelect,
  bottomInset = 0,
  tabs = PRIMARY_TABS,
}: {
  activeTab: PrimaryTab | null;
  onSelect: (tab: PrimaryTab) => void;
  bottomInset?: number;
  tabs?: readonly PrimaryTab[];
}): ReactNode {
  return (
    <View
      style={[bar.bar, { paddingBottom: Math.max(bottomInset, sovlSpace[2]) }]}
      accessibilityRole="tablist"
    >
      {tabs.map((tab) => {
        const active = tab === activeTab;
        const color = active ? palette.accent : palette.textFaint;
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityLabel={PRIMARY_TAB_LABELS[tab]}
            accessibilityState={{ selected: active }}
            aria-selected={active}
            onPress={() => onSelect(tab)}
            style={({ pressed }) => [bar.item, pressed ? bar.itemPressed : null]}
          >
            <View style={[bar.indicator, active ? bar.indicatorActive : null]} />
            <TabIcon tab={tab} color={color} />
            <Text
              style={[bar.label, active ? bar.labelActive : null]}
              numberOfLines={1}
              accessibilityElementsHidden
              importantForAccessibility="no"
              aria-hidden
            >
              {PRIMARY_TAB_LABELS[tab]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const bar = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: palette.sidebar,
    borderTopColor: palette.border,
    borderTopWidth: 1,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    minHeight: 56,
    minWidth: MIN_TOUCH_TARGET,
    gap: 3,
  },
  itemPressed: { backgroundColor: palette.surface },
  indicator: { height: 2, width: 28, borderRadius: 1, marginBottom: 5 },
  indicatorActive: { backgroundColor: palette.accent },
  label: {
    fontFamily: fontSans,
    color: palette.textFaint,
    fontSize: sovlFontSize.xs,
    fontWeight: '500',
  },
  labelActive: { color: palette.text, fontWeight: '600' },
});

// ——— hardware back ———

/**
 * Android hardware/gesture back. `onBack` returns true when it handled the
 * press (popped a screen, closed a sheet); false lets the OS act. A no-op
 * on iOS and web, where BackHandler does not exist (react-native-web logs
 * an error if it is used, so it is not touched there).
 */
export function useHardwareBack(onBack: () => boolean, enabled = true): void {
  const handler = useRef(onBack);
  handler.current = onBack;
  useEffect(() => {
    if (!enabled || Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => handler.current());
    return () => subscription.remove();
  }, [enabled]);
}
