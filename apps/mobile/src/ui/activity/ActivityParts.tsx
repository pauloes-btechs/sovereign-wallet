/**
 * Building blocks for activity lists — rows, day groups, the loading
 * skeleton and filter chips — shared by Home (recent activity) and the
 * Activity tab in both modes.
 */

import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { sovlFontSize, sovlRadius, sovlSpace } from '@sovereign/ui/tokens';
import type { ActivityDayGroup, ActivityItem, ActivityStatus } from '../../flows/activity.js';
import { STATUS_LABEL, amountSign, fullTime, rowTitle, timeOfDay } from '../../flows/activity.js';
import { useAmountFormatter } from '../appContext.js';
import { MIN_TOUCH_TARGET } from '../navigationUi.js';
import { MobileAmount, MobileBadge, mobilePalette, styles as base } from '../Primitives.js';
import type { BandTone } from '../Primitives.js';

export const STATUS_TONE: Readonly<Record<ActivityStatus, BandTone | 'neutral'>> = {
  settled: 'positive',
  pending: 'warning',
  failed: 'danger',
  open: 'neutral',
  canceled: 'neutral',
};


export function ActivityStatusBadge({ status }: { status: ActivityStatus }): ReactNode {
  return <MobileBadge label={STATUS_LABEL[status]} tone={STATUS_TONE[status]} />;
}

/** Direction glyph in a circle; decorative (the title says Sent/Received). */
function DirectionMark({ item }: { item: ActivityItem }): ReactNode {
  const out = item.direction === 'out';
  return (
    <View
      style={[local.mark, { borderColor: out ? mobilePalette.borderStrong : mobilePalette.fundInbound }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[local.markText, { color: out ? mobilePalette.textSecondary : mobilePalette.fundInbound }]}>
        {out ? '↑' : '↓'}
      </Text>
    </View>
  );
}

/** One tappable activity row: what, when, memo, amount and status. */
export function ActivityRow({
  item,
  onPress,
  divider,
  showDate = false,
}: {
  item: ActivityItem;
  onPress: (id: string) => void;
  divider: boolean;
  /** Show the full date (Home's recent list has no day headers). */
  showDate?: boolean;
}): ReactNode {
  const amounts = useAmountFormatter();
  const sign = amountSign(item);
  const when =
    item.at === null ? 'Time not reported' : showDate ? fullTime(item.at) : timeOfDay(item.at);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${rowTitle(item)}, ${amounts.accessibilityLabel(item.amountSat, sign)}, ${
        item.status === 'settled' ? 'settled' : item.status
      }, ${when}`}
      accessibilityHint="Opens the receipt"
      onPress={() => onPress(item.id)}
      style={({ pressed }) => [local.row, divider ? local.rowDivider : null, pressed ? local.pressed : null]}
    >
      <DirectionMark item={item} />
      <View style={local.rowMain}>
        <Text style={[base.value, local.title]} numberOfLines={1}>
          {rowTitle(item)}
        </Text>
        <Text style={base.faint} numberOfLines={1}>
          {when}
        </Text>
        {item.memo !== null && (
          <Text style={base.faint} numberOfLines={1}>
            {item.memo}
          </Text>
        )}
      </View>
      <View style={local.rowEnd}>
        <MobileAmount
          sats={item.amountSat}
          sign={sign}
          style={item.direction === 'in' && sign === '+' ? { color: mobilePalette.positive } : null}
        />
        <ActivityStatusBadge status={item.status} />
      </View>
    </Pressable>
  );
}

/** Day-grouped rows inside panels. */
export function ActivityGroups({
  groups,
  onOpen,
}: {
  groups: readonly ActivityDayGroup[];
  onOpen: (id: string) => void;
}): ReactNode {
  return (
    <View style={local.groups}>
      {groups.map((group) => (
        <View key={group.key} style={local.group}>
          <Text style={local.dayHeader} accessibilityRole="header">
            {group.label}
          </Text>
          <View style={local.listPanel}>
            {group.items.map((item, index) => (
              <ActivityRow key={item.id} item={item} onPress={onOpen} divider={index > 0} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Placeholder rows while the first read is in progress. */
export function ActivitySkeleton({ rows = 4 }: { rows?: number }): ReactNode {
  return (
    <View style={local.listPanel} accessibilityLabel="Loading activity" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} style={[local.row, index > 0 ? local.rowDivider : null]}>
          <View style={[local.mark, local.skeletonBlock, { borderWidth: 0 }]} />
          <View style={local.rowMain}>
            <View style={[local.skeletonBlock, { width: '55%', height: 12 }]} />
            <View style={[local.skeletonBlock, { width: '30%', height: 10 }]} />
          </View>
          <View style={[local.skeletonBlock, { width: 72, height: 12 }]} />
        </View>
      ))}
    </View>
  );
}

/** A horizontal row of single-choice filter chips. */
export function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** Names the group for assistive tech ("Status", "Type"). */
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}): ReactNode {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={local.chips}
      accessibilityLabel={label}
      accessibilityRole="radiogroup"
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityLabel={`${label}: ${option.label}`}
            accessibilityState={{ checked: active }}
            aria-checked={active}
            onPress={() => onChange(option.id)}
            hitSlop={{ top: 4, bottom: 4 }}
            style={[local.chip, active ? local.chipActive : null]}
          >
            <Text style={[local.chipText, active ? local.chipTextActive : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export const activityStyles = StyleSheet.create({
  listPanel: {
    backgroundColor: mobilePalette.surface,
    borderColor: mobilePalette.border,
    borderWidth: 1,
    borderRadius: sovlRadius.md,
    paddingHorizontal: sovlSpace[3],
  },
});

const local = StyleSheet.create({
  groups: { gap: sovlSpace[4] },
  group: { gap: sovlSpace[2] },
  dayHeader: { ...base.overline, fontSize: sovlFontSize.xs, paddingHorizontal: sovlSpace[1] },
  listPanel: activityStyles.listPanel,
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sovlSpace[3],
    paddingVertical: sovlSpace[3],
    minHeight: MIN_TOUCH_TARGET + 12,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: mobilePalette.border },
  pressed: { opacity: 0.7 },
  rowMain: { flex: 1, gap: 2, minWidth: 0 },
  // Proportional figures for words: tabular spacing pulls "On-chain" apart.
  title: { fontVariant: [] },
  rowEnd: { alignItems: 'flex-end', gap: sovlSpace[1] },
  mark: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: { fontSize: sovlFontSize.md, fontWeight: '600' },
  skeletonBlock: { backgroundColor: mobilePalette.surfaceRaised, borderRadius: 4, height: 32 },
  chips: { gap: sovlSpace[2], paddingVertical: 2 },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: sovlSpace[3],
    borderRadius: 999,
    borderWidth: 1,
    borderColor: mobilePalette.border,
    backgroundColor: mobilePalette.surface,
  },
  chipActive: { backgroundColor: mobilePalette.text, borderColor: mobilePalette.text },
  chipText: { ...base.dim, fontSize: sovlFontSize.sm, fontWeight: '500' },
  chipTextActive: { color: mobilePalette.bg, fontWeight: '600' },
});
