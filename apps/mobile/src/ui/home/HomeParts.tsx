/**
 * Home building blocks shared by both modes: the balance card (total,
 * sats/BTC toggle, privacy toggle, lines tagged spendable / pending /
 * locked / unavailable), the contextual notices and the recent-activity
 * preview. Numbers come from `flows/homeBalances.ts`; notices from
 * `flows/notifications.ts`.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { sovlFontSize, sovlRadius, sovlSpace } from '@sovereign/ui/tokens';
import { sortNewestFirst } from '../../flows/activity.js';
import type { ActivityItem } from '../../flows/activity.js';
import { BALANCE_STATE_LABEL } from '../../flows/homeBalances.js';
import type { BalanceLine, BalanceState, FundSwatch, HomeBalanceView } from '../../flows/homeBalances.js';
import type { WalletNotice } from '../../flows/notifications.js';
import { usePreferences } from '../appContext.js';
import { MIN_TOUCH_TARGET } from '../navigationUi.js';
import {
  MobileAmount,
  MobileAmountBig,
  MobileButton,
  mobilePalette,
  styles as base,
} from '../Primitives.js';
import { ActivityRow, ActivitySkeleton, activityStyles } from '../activity/ActivityParts.js';

const SWATCH: Readonly<Record<FundSwatch, string>> = {
  outbound: mobilePalette.fundOutbound,
  onchain: mobilePalette.fundOnchain,
  locked: mobilePalette.fundLocked,
  pending: mobilePalette.info,
};

/** Status is spelled out in text; color only reinforces it. */
const STATE_COLOR: Readonly<Record<BalanceState, string>> = {
  spendable: mobilePalette.positive,
  pending: mobilePalette.info,
  locked: mobilePalette.textSecondary,
  unavailable: mobilePalette.warning,
};

/** Sats/BTC switch — writes the denomination preference every amount reads. */
function DenominationToggle(): ReactNode {
  const { preferences, store } = usePreferences();
  const options = [
    { id: 'sats', label: 'sats' },
    { id: 'btc', label: 'BTC' },
  ] as const;
  return (
    <View style={local.toggle} accessibilityRole="radiogroup" accessibilityLabel="Amount unit">
      {options.map((option) => {
        const active = preferences.denomination === option.id;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityLabel={`Show amounts in ${option.label}`}
            accessibilityState={{ checked: active }}
            aria-checked={active}
            onPress={() => void store.set({ denomination: option.id }).catch(() => undefined)}
            hitSlop={{ top: 6, bottom: 6 }}
            style={[local.toggleItem, active ? local.toggleItemActive : null]}
          >
            <Text style={[local.toggleText, active ? local.toggleTextActive : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Privacy mode — masks every amount in the app. */
function PrivacyToggle(): ReactNode {
  const { preferences, store } = usePreferences();
  const hidden = preferences.hideBalances;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel="Hide amounts"
      accessibilityState={{ checked: hidden }}
      aria-checked={hidden}
      onPress={() => void store.set({ hideBalances: !hidden }).catch(() => undefined)}
      style={local.privacy}
    >
      <Text style={local.privacyText}>{hidden ? 'Show amounts' : 'Hide amounts'}</Text>
    </Pressable>
  );
}

function FundBar({ lines }: { lines: readonly BalanceLine[] }): ReactNode {
  const total = lines.reduce((sum, line) => sum + line.sats, 0n);
  if (total === 0n) return <View style={[local.fundBar, local.fundBarEmpty]} />;
  return (
    <View style={local.fundBar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {lines
        .filter((line) => line.sats > 0n)
        .map((line) => (
          <View
            key={line.key}
            style={{ flexGrow: Number((line.sats * 10_000n) / total), flexBasis: 0, backgroundColor: SWATCH[line.swatch] }}
          />
        ))}
    </View>
  );
}

function BalanceLineRow({ line }: { line: BalanceLine }): ReactNode {
  return (
    <View style={local.line}>
      <View style={[base.swatch, local.lineSwatch, { backgroundColor: SWATCH[line.swatch] }]} />
      <View style={local.lineBody}>
        <View style={base.rowBetween}>
          <Text style={base.dim}>{line.label}</Text>
          <MobileAmount sats={line.sats} />
        </View>
        <Text style={base.faint}>
          <Text style={[local.lineState, { color: STATE_COLOR[line.state] }]}>
            {BALANCE_STATE_LABEL[line.state]}
          </Text>
          {line.note !== undefined ? ` · ${line.note}` : ''}
        </Text>
      </View>
    </View>
  );
}

/** The hero card: total, unit and privacy switches, and every balance line. */
export function BalanceCard({
  view,
  receiveCapacityLabel = 'Can receive over Lightning',
}: {
  view: HomeBalanceView;
  receiveCapacityLabel?: string;
}): ReactNode {
  return (
    <View style={base.panel}>
      <View style={base.rowBetween}>
        <Text style={base.overline}>Total balance</Text>
        <PrivacyToggle />
      </View>
      <View style={local.totalRow}>
        <MobileAmountBig sats={view.totalSat} />
        <DenominationToggle />
      </View>
      <FundBar lines={view.lines} />
      {view.lines.map((line) => (
        <BalanceLineRow key={line.key} line={line} />
      ))}
      {view.receiveCapacitySat !== null && (
        <View style={local.capacity}>
          <View style={base.rowBetween}>
            <View style={base.rowStart}>
              <View style={[base.swatch, { backgroundColor: mobilePalette.fundInbound }]} />
              <Text style={base.dim}>{receiveCapacityLabel}</Text>
            </View>
            <MobileAmount sats={view.receiveCapacitySat} />
          </View>
          <Text style={base.faint}>
            Your peers' side of your active channels — not part of your balance. A single payment
            may be limited by routing.
          </Text>
        </View>
      )}
      {view.footnote !== null && <Text style={base.faint}>{view.footnote}</Text>}
    </View>
  );
}

const NOTICE_COLOR: Readonly<Record<WalletNotice['tone'], string>> = {
  danger: mobilePalette.danger,
  warning: mobilePalette.warning,
  info: mobilePalette.info,
  positive: mobilePalette.positive,
};

/** Contextual notices, each with one action. */
export function NoticeList({
  notices,
  onAction,
}: {
  notices: readonly WalletNotice[];
  onAction: (notice: WalletNotice) => void;
}): ReactNode {
  if (notices.length === 0) return null;
  return (
    <View style={local.notices}>
      {notices.map((notice) => (
        <View
          key={notice.id}
          style={[base.band, { borderLeftColor: NOTICE_COLOR[notice.tone] }]}
          accessibilityRole={notice.tone === 'danger' ? 'alert' : undefined}
        >
          <Text style={base.h3}>{notice.title}</Text>
          <Text style={base.dim}>{notice.body}</Text>
          <View style={local.noticeAction}>
            <MobileButton label={notice.action.label} kind="secondary" compact onPress={() => onAction(notice)} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** The newest few items, linking into the receipt and the full Activity tab. */
export function RecentActivity({
  items,
  loading,
  error,
  unavailableReason,
  limit = 5,
  onOpen,
  onSeeAll,
}: {
  items: readonly ActivityItem[] | null;
  loading: boolean;
  error: string | null;
  unavailableReason: string | null;
  limit?: number;
  onOpen: (id: string) => void;
  onSeeAll: () => void;
}): ReactNode {
  const recent = items === null ? null : sortNewestFirst(items).slice(0, limit);
  return (
    <View style={local.recent}>
      <View style={base.rowBetween}>
        <Text style={base.h3} accessibilityRole="header">
          Recent activity
        </Text>
        {unavailableReason === null && (
          <MobileButton label="See all activity" kind="ghost" compact onPress={onSeeAll} />
        )}
      </View>
      {unavailableReason !== null ? (
        <Text style={base.faint}>{unavailableReason}</Text>
      ) : recent === null ? (
        error !== null ? (
          <Text style={base.faint}>Activity could not be read: {error}</Text>
        ) : loading ? (
          <ActivitySkeleton rows={2} />
        ) : null
      ) : recent.length === 0 ? (
        <Text style={base.faint}>No activity yet. Payments you send or receive appear here.</Text>
      ) : (
        <View style={activityStyles.listPanel}>
          {recent.map((item, index) => (
            <ActivityRow key={item.id} item={item} onPress={onOpen} divider={index > 0} showDate />
          ))}
        </View>
      )}
    </View>
  );
}

const local = StyleSheet.create({
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: sovlSpace[2],
  },
  toggle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: mobilePalette.border,
    borderRadius: 999,
    padding: 2,
    backgroundColor: mobilePalette.sidebar,
  },
  toggleItem: {
    minHeight: 32,
    minWidth: 48,
    paddingHorizontal: sovlSpace[3],
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleItemActive: { backgroundColor: mobilePalette.surfaceRaised },
  toggleText: { ...base.dim, fontSize: sovlFontSize.sm },
  toggleTextActive: { color: mobilePalette.text, fontWeight: '600' },
  privacy: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: sovlSpace[2],
    marginRight: -sovlSpace[2],
    borderRadius: sovlRadius.sm,
  },
  privacyText: { ...base.dim, fontSize: sovlFontSize.sm, color: mobilePalette.textSecondary },
  fundBar: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    gap: 2,
    marginVertical: sovlSpace[1],
  },
  fundBarEmpty: { backgroundColor: mobilePalette.surfaceRaised },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: sovlSpace[2], paddingVertical: 6 },
  lineSwatch: { marginTop: 6 },
  lineBody: { flex: 1, gap: 2 },
  lineState: { fontWeight: '600' },
  capacity: {
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: mobilePalette.border,
    paddingTop: sovlSpace[2],
    marginTop: sovlSpace[1],
  },
  notices: { gap: sovlSpace[2] },
  noticeAction: { alignSelf: 'flex-start', marginTop: sovlSpace[1] },
  recent: { gap: sovlSpace[2] },
});
