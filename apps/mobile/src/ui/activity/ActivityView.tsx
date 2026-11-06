/**
 * The Activity tab body, shared by both modes: search, status and type
 * filters, day-grouped rows, a skeleton while the first read runs, and
 * explicit empty, error (with retry) and unavailable states. The mode
 * wrappers supply the items (from the real backend) and the navigation.
 */

import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import {
  RAIL_LABEL,
  STATUS_FILTERS,
  filterActivity,
  groupByDay,
  isFiltered,
  railsPresent,
  sortNewestFirst,
} from '../../flows/activity.js';
import type { ActivityItem, ActivityRailFilter } from '../../flows/activity.js';
import {
  MobileButton,
  MobileField,
  MobileHeader,
  MobilePanel,
  MobileScreen,
  MobileWarningBand,
  styles,
} from '../Primitives.js';
import { ActivityGroups, ActivitySkeleton, FilterChips } from './ActivityParts.js';
import { useActivityFilter } from './activityViewState.js';

export type ActivityLoadStatus = 'idle' | 'loading' | 'loaded' | 'failed' | 'unavailable';

export function ActivityView({
  owner,
  subtitle,
  items,
  status,
  error,
  unavailableReason,
  emptyText,
  footnote,
  onRetry,
  onOpen,
}: {
  /** The wallet controller — keys the filter state. */
  owner: object;
  subtitle: string;
  /** Items from the last successful read (null before the first one). */
  items: readonly ActivityItem[] | null;
  status: ActivityLoadStatus;
  error: string | null;
  /** Set when this wallet/connection cannot read history at all. */
  unavailableReason: string | null;
  emptyText: string;
  footnote: string | null;
  onRetry: () => void;
  onOpen: (id: string) => void;
}): ReactNode {
  const { filter, store } = useActivityFilter(owner);

  if (unavailableReason !== null) {
    return (
      <MobileScreen>
        <MobileHeader title="Activity" />
        <MobilePanel>
          <Text style={styles.dim}>{unavailableReason}</Text>
        </MobilePanel>
      </MobileScreen>
    );
  }

  const all = items === null ? null : sortNewestFirst(items);
  const rails = all === null ? [] : railsPresent(all);
  const railOptions: Array<{ id: ActivityRailFilter; label: string }> = [
    { id: 'all', label: 'All types' },
    ...rails.map((rail) => ({ id: rail, label: RAIL_LABEL[rail] })),
  ];
  const shown = all === null ? null : filterActivity(all, filter);
  const filtered = isFiltered(filter);

  return (
    <MobileScreen>
      <View style={styles.rowBetween}>
        <View style={{ flexShrink: 1 }}>
          <MobileHeader title="Activity" subtitle={subtitle} />
        </View>
        <MobileButton
          label="Refresh"
          kind="ghost"
          compact
          busy={status === 'loading'}
          onPress={onRetry}
        />
      </View>

      {status === 'failed' && (
        <MobileWarningBand tone="danger">
          <Text style={styles.bandText}>Activity could not be read: {error}</Text>
          <View style={{ alignSelf: 'flex-start' }}>
            <MobileButton label="Try again" kind="secondary" compact onPress={onRetry} />
          </View>
        </MobileWarningBand>
      )}

      {all !== null && all.length > 0 && (
        <View style={{ gap: 8 }}>
          <MobileField
            label="Search activity"
            value={filter.query}
            onChangeText={(query) => store.set({ query })}
            placeholder="Memo, id or amount"
          />
          <FilterChips
            label="Status"
            options={STATUS_FILTERS}
            value={filter.status}
            onChange={(id) => store.set({ status: id })}
          />
          {rails.length > 1 && (
            <FilterChips
              label="Type"
              options={railOptions}
              value={filter.rail}
              onChange={(id) => store.set({ rail: id })}
            />
          )}
        </View>
      )}

      {all === null && status !== 'failed' && <ActivitySkeleton />}

      {all !== null && all.length === 0 && (
        <MobilePanel>
          <Text style={styles.dim}>{emptyText}</Text>
        </MobilePanel>
      )}

      {shown !== null && all !== null && all.length > 0 && (
        <>
          {filtered && (
            <View style={styles.rowBetween}>
              <Text style={styles.faint} accessibilityLiveRegion="polite">
                {shown.length === 1 ? '1 match' : `${shown.length} matches`} of {all.length}
              </Text>
              <MobileButton label="Clear filters" kind="ghost" compact onPress={() => store.reset()} />
            </View>
          )}
          {shown.length === 0 ? (
            <MobilePanel>
              <Text style={styles.dim}>Nothing matches these filters.</Text>
            </MobilePanel>
          ) : (
            <ActivityGroups groups={groupByDay(shown, Date.now())} onOpen={onOpen} />
          )}
        </>
      )}

      {footnote !== null && <Text style={styles.faint}>{footnote}</Text>}
    </MobileScreen>
  );
}
