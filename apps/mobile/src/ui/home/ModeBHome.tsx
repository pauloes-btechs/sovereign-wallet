/**
 * Remote node (Mode B, LND over Lightning Node Connect) — Home, Activity and
 * the receipt screen. Balances and channels come from the node's
 * `getBalances`; activity from the port's `listLightningActivity` (reported
 * as unavailable when the port lacks it, never as "no activity").
 */

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { remoteActivityItems } from '../../flows/activity.js';
import { remoteBalanceView } from '../../flows/homeBalances.js';
import { DESKTOP_ONLY_DISCLOSURE } from '../../flows/modeBRemoteController.js';
import type { ModeBRemoteController, ModeBRemoteState } from '../../flows/modeBRemoteController.js';
import { currentEntry } from '../../flows/navigation.js';
import { remoteNotices } from '../../flows/notifications.js';
import type { WalletNotice } from '../../flows/notifications.js';
import {
  MobileButton,
  MobileButtonGroup,
  MobileHeader,
  MobileNavRow,
  MobileScreen,
  MobileWarningBand,
  styles,
} from '../Primitives.js';
import { ActivityView } from '../activity/ActivityView.js';
import { TransactionDetailScreen } from '../activity/TransactionDetail.js';
import { activityViewStore } from '../activity/activityViewState.js';
import { BalanceCard, NoticeList, RecentActivity } from './HomeParts.js';

const SOURCE_LABEL = 'Your node (over Lightning Node Connect)';

/** Home: node balances, receiving capacity, quick actions, notices, recent activity. */
export function ModeBHomeScreen({
  controller,
  state,
  network,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
  network: string;
}): ReactNode {
  const { node, balances } = state;
  const caps = controller.walletCapabilities();
  const activityFeature = caps.features.activity;
  const connected = caps.features.balances.available;

  useEffect(() => {
    // Once per visit to Home: recent activity and its notices need a fresh read.
    void controller.loadActivity();
  }, [controller]);

  const items = state.activity === null ? null : remoteActivityItems(state.activity);
  const notices = remoteNotices({
    connected,
    balances,
    paymentInFlight: state.sendStatus === 'sending',
    activity: state.activityStatus === 'loaded' ? items : null,
  });

  const onAction = (notice: WalletNotice): void => {
    const target = notice.action.target;
    switch (target.kind) {
      case 'tab':
        controller.navigate(target.tab);
        return;
      case 'pair-again':
        controller.navigate('pairing');
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
        void controller.refresh().catch(() => undefined);
        return;
      case 'exit-information':
        return; // everyday wallet only
    }
  };

  const unavailable =
    !activityFeature.available
      ? activityFeature.reason
      : state.activityStatus === 'unavailable'
        ? "Payment history isn't available over this connection yet."
        : null;

  return (
    <MobileScreen>
      <MobileHeader title="Node wallet" subtitle={node !== null ? `${network} · ${node.alias}` : network} />
      {balances !== null ? (
        <BalanceCard view={remoteBalanceView(balances)} />
      ) : (
        <Text style={styles.dim}>Loading balances…</Text>
      )}
      {balances !== null && (
        <MobileNavRow
          label="Channels and liquidity"
          detail={
            balances.channels.length === 0
              ? 'No channels — what this node can send and receive'
              : `${balances.channels.length} channel${balances.channels.length === 1 ? '' : 's'}, ${
                  balances.channels.filter((c) => c.active).length
                } active — what this node can send and receive`
          }
          onPress={() => controller.navigate('liquidity')}
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
        unavailableReason={unavailable}
        onOpen={(id) => controller.navigate('transaction', { id })}
        onSeeAll={() => {
          activityViewStore(controller).reset();
          controller.navigate('activity');
        }}
      />

      <MobileWarningBand>{controller.capabilities().note}</MobileWarningBand>
      <MobileWarningBand tone="warning">{DESKTOP_ONLY_DISCLOSURE}</MobileWarningBand>
    </MobileScreen>
  );
}

/** Activity tab: the node's Lightning payments and invoices. */
export function ModeBActivityScreen({
  controller,
  state,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
}): ReactNode {
  const feature = controller.walletCapabilities().features.activity;
  const unavailable = !feature.available
    ? feature.reason
    : state.activityStatus === 'unavailable'
      ? "Payment history isn't available over this connection yet."
      : null;
  return (
    <ActivityView
      owner={controller}
      subtitle="Lightning payments and invoices on your node"
      items={state.activity === null ? null : remoteActivityItems(state.activity)}
      status={state.activityStatus}
      error={state.activityError}
      unavailableReason={unavailable}
      emptyText="No Lightning payments or invoices on your node yet."
      footnote="Up to the 100 most recent payments and invoices. On-chain transactions are not read over this connection. Times are in UTC."
      onRetry={() => void controller.loadActivity()}
      onOpen={(id) => controller.navigate('transaction', { id })}
    />
  );
}

/** Receipt for the record named by the route's `id` param. */
export function ModeBTransactionScreen({
  controller,
  state,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
}): ReactNode {
  const id = state.nav === null ? undefined : currentEntry(state.nav).params?.id;
  const items = state.activity === null ? null : remoteActivityItems(state.activity);
  const item = id === undefined ? null : (items?.find((i) => i.id === id) ?? null);
  return (
    <TransactionDetailScreen item={item} sourceLabel={SOURCE_LABEL} onBack={() => controller.goBack()} />
  );
}
