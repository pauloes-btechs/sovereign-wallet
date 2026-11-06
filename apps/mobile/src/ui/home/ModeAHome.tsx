/**
 * Everyday wallet (Mode A, Wavelength) — Home, Activity and the receipt
 * screen. Everything shown comes from the controller's live state: balance
 * buckets and VTXO lifecycle from the provider, activity from the daemon's
 * activity page (with receipt fields when the provider has them).
 */

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { wavelengthActivityItems } from '../../flows/activity.js';
import type { ActivityItem } from '../../flows/activity.js';
import { wavelengthBalanceView } from '../../flows/homeBalances.js';
import type { ModeAController, ModeAState } from '../../flows/modeAController.js';
import { currentEntry } from '../../flows/navigation.js';
import { wavelengthNotices } from '../../flows/notifications.js';
import type { WalletNotice } from '../../flows/notifications.js';
import {
  MobileButton,
  MobileButtonGroup,
  MobileHeader,
  MobileNavRow,
  MobileScreen,
  mobilePalette,
  styles,
  utcClock,
} from '../Primitives.js';
import { ActivityView } from '../activity/ActivityView.js';
import { TransactionDetailScreen } from '../activity/TransactionDetail.js';
import { activityViewStore } from '../activity/activityViewState.js';
import { BalanceCard, NoticeList, RecentActivity } from './HomeParts.js';

const SOURCE_LABEL = 'Everyday wallet (Wavelength)';

function itemsOf(state: ModeAState): ActivityItem[] | null {
  return state.activity === null ? null : wavelengthActivityItems(state.activity, state.activityDetails);
}

/** Home: total and balance lines, quick actions, notices, recent activity. */
export function ModeAHomeScreen({
  controller,
  state,
  network,
}: {
  controller: ModeAController;
  state: ModeAState;
  network: string;
}): ReactNode {
  const { balances, vtxo } = state;
  const activityFeature = controller.walletCapabilities().features.activity;

  // Recent activity and the notices derived from it need a fresh read.
  useEffect(() => {
    if (activityFeature.available) void controller.loadActivity();
    // Once per visit to Home (the screen remounts on each visit).
  }, [controller]);

  const items = itemsOf(state);
  const notices = wavelengthNotices({
    vtxo,
    balances,
    balancesError: state.balancesError,
    paymentInFlight: state.sendStatus === 'sending',
    activity: state.activityStatus === 'failed' ? null : items,
    unilateralExit: controller.capabilities.unilateralExit,
  });
  const operator =
    vtxo === null
      ? 'checking Ark operator'
      : vtxo.operatorReachable
        ? 'Ark operator reachable'
        : 'Ark operator unreachable';

  const onAction = (notice: WalletNotice): void => {
    const target = notice.action.target;
    switch (target.kind) {
      case 'tab':
        controller.navigate(target.tab);
        return;
      case 'exit-information':
        controller.navigate('capabilities');
        return;
      case 'liquidity':
        controller.navigate('liquidity');
        return;
      case 'activity':
        activityViewStore(controller).set({ status: target.status, rail: 'all', query: '' });
        controller.navigate('activity');
        return;
      case 'transaction':
        controller.navigate('transaction', { id: target.id });
        return;
      case 'refresh':
        void controller.refreshBalances();
        return;
      case 'pair-again':
        return; // remote-node only
    }
  };

  return (
    <MobileScreen>
      <MobileHeader title="Everyday wallet" subtitle={`${network} · ${operator}`} />
      {balances !== null ? (
        <BalanceCard view={wavelengthBalanceView(balances, vtxo === null ? null : vtxo.operatorReachable)} />
      ) : state.balancesError === null ? (
        <Text style={styles.dim}>Loading balances…</Text>
      ) : null}
      {balances !== null && (
        <BalanceFreshness
          updatedAt={state.balancesUpdatedAt}
          error={state.balancesError}
          refreshing={state.balancesRefreshing}
          onRefresh={() => void controller.refreshBalances()}
        />
      )}

      <MobileButtonGroup row>
        <MobileButton label="Send" onPress={() => controller.navigate('send')} />
        <MobileButton label="Receive" kind="secondary" onPress={() => controller.navigate('receive')} />
      </MobileButtonGroup>

      <NoticeList notices={notices} onAction={onAction} />

      <RecentActivity
        items={items}
        loading={state.activityStatus === 'loading' || state.activityStatus === 'idle'}
        error={state.activityStatus === 'failed' ? state.activityError : null}
        unavailableReason={activityFeature.available ? null : activityFeature.reason}
        onOpen={(id) => controller.navigate('transaction', { id })}
        onSeeAll={() => {
          activityViewStore(controller).reset();
          controller.navigate('activity');
        }}
      />

      <MobileNavRow
        label="How this wallet works"
        detail="Lightning mechanism, exits, recovery and the services this wallet depends on"
        onPress={() => controller.navigate('capabilities')}
      />
    </MobileScreen>
  );
}

/** When the balances were read (the controller's last success, never the render clock). */
function BalanceFreshness({
  updatedAt,
  error,
  refreshing,
  onRefresh,
}: {
  updatedAt: number | null;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}): ReactNode {
  return (
    <View style={styles.rowBetween}>
      <View style={{ flexShrink: 1 }}>
        <Text style={styles.faint}>
          {refreshing ? 'Refreshing…' : updatedAt !== null ? `Updated ${utcClock(updatedAt)}` : 'Not read yet'}
        </Text>
        {error !== null && (
          <Text style={[styles.faint, { color: mobilePalette.danger }]} accessibilityRole="alert">
            Last refresh failed: {error}
          </Text>
        )}
      </View>
      <MobileButton label="Refresh" kind="ghost" compact busy={refreshing} onPress={onRefresh} />
    </View>
  );
}

/** Activity tab: the daemon's activity page with search, filters and day groups. */
export function ModeAActivityScreen({
  controller,
  state,
}: {
  controller: ModeAController;
  state: ModeAState;
}): ReactNode {
  const feature = controller.walletCapabilities().features.activity;
  return (
    <ActivityView
      owner={controller}
      subtitle="Payments recorded by this wallet"
      items={itemsOf(state)}
      status={state.activityStatus}
      error={state.activityError}
      unavailableReason={feature.available ? null : feature.reason}
      emptyText="No activity yet. Payments you send or receive appear here once the wallet records them."
      footnote="Shows what the wallet returned in its latest read. Times are in UTC."
      onRetry={() => void controller.loadActivity()}
      onOpen={(id) => controller.navigate('transaction', { id })}
    />
  );
}

/** Receipt for the entry named by the route's `id` param. */
export function ModeATransactionScreen({
  controller,
  state,
}: {
  controller: ModeAController;
  state: ModeAState;
}): ReactNode {
  const id = state.nav === null ? undefined : currentEntry(state.nav).params?.id;
  const item = id === undefined ? null : (itemsOf(state)?.find((i) => i.id === id) ?? null);
  return (
    <TransactionDetailScreen item={item} sourceLabel={SOURCE_LABEL} onBack={() => controller.goBack()} />
  );
}
