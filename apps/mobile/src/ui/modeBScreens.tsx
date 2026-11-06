/**
 * Mode B remote-node screens — the advanced-mode mobile experience over LNC.
 *
 * Presentation only: the ModeBRemoteController owns every rule (foreground
 * payments, desktop-only liveness ops, phrase handling). Screens subscribe
 * with `useSyncExternalStore` and render what the controller's state says.
 * The phone hosts NO node — the pairing screen says what the connection is,
 * and the home screen labels channel-safety operations desktop-only.
 */

import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  MobileAmount,
  MobileBadge,
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileField,
  MobileHeader,
  MobileLabelRow,
  MobilePanel,
  MobileSats,
  MobileScreen,
  MobileWarningBand,
  mobilePalette,
  styles,
} from './Primitives.js';
import type {
  ModeBRemoteController,
  ModeBRemoteState,
  RemoteActivityRecord,
} from '../flows/modeBRemoteController.js';
import {
  DESKTOP_ONLY_DISCLOSURE,
  isDesktopOnly,
} from '../flows/modeBRemoteController.js';
import type { FeatureId } from '../flows/capabilities.js';
import type { PreferencesStore } from '../flows/preferences.js';
import { NO_PLATFORM_SERVICES } from '../flows/platform.js';
import type { PlatformServices } from '../flows/platform.js';
import { MobileAppProvider, usePreferencesStore } from './appContext.js';
import { PrimaryTabBar, useHardwareBack } from './navigationUi.js';
import { QrCode } from './QrCode.js';
import { shortenMiddle } from './format.js';
import { CapabilitySummary } from './walletScreens.js';

/** Full Mode B mobile tree — the host supplies a connected-capable port. */
export function ModeBRemoteApp({
  controller,
  network,
  preferences: givenPreferences,
  platform = NO_PLATFORM_SERVICES,
}: {
  controller: ModeBRemoteController;
  network: string;
  /** Omitted → in-memory preferences (not persisted). */
  preferences?: PreferencesStore;
  platform?: PlatformServices;
}): ReactNode {
  const preferences = usePreferencesStore(givenPreferences);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useHardwareBack(() => controller.goBack(), state.nav !== null);
  return (
    <MobileAppProvider preferences={preferences} platform={platform}>
      <View style={shell.shell}>
        <ModeBScreenBody controller={controller} state={state} network={network} />
        {state.nav !== null && (
          <PrimaryTabBar
            activeTab={state.nav.tab}
            onSelect={(tab) => controller.selectTab(tab)}
            bottomInset={platform.bottomInset}
          />
        )}
      </View>
    </MobileAppProvider>
  );
}

function ModeBScreenBody({
  controller,
  state,
  network,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
  network: string;
}): ReactNode {
  switch (state.screen) {
    case 'pairing':
      return <PairingScreen controller={controller} state={state} />;
    case 'connecting':
      return (
        <MobileScreen>
          <MobileHeader title="Connecting" />
          <Text style={styles.dim}>
            Pairing with your node over Lightning Node Connect…
          </Text>
        </MobileScreen>
      );
    case 'home':
      return <ModeBHomeScreen controller={controller} state={state} network={network} />;
    case 'activity':
      return <ModeBActivityScreen controller={controller} state={state} />;
    case 'send':
      return <ModeBSendScreen controller={controller} state={state} />;
    case 'receive':
      return <ModeBReceiveScreen controller={controller} state={state} />;
    case 'wallet':
      return <ModeBWalletScreen controller={controller} state={state} network={network} />;
    case 'revoked':
      return (
        <MobileScreen>
          <MobileHeader title="Session revoked" />
          <Text style={styles.dim}>
            This Lightning Node Connect session is no longer valid. Create a new
            session on your node to connect again.
          </Text>
          <MobileButtonGroup>
            <MobileButton
              label="Pair again"
              onPress={() => controller.navigate('pairing')}
            />
          </MobileButtonGroup>
        </MobileScreen>
      );
  }
}

/**
 * The pairing screen states the trust model plainly: this wallet talks to
 * the user's OWN node (litd) with a 10-word pairing phrase; nothing runs on
 * the phone. The phrase is sent once and never stored.
 */
function PairingScreen({
  controller,
  state,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
}): ReactNode {
  return (
    <MobileScreen>
      <MobileHeader title="Connect your node" />
      <Text style={styles.dim}>
        Paste the 10-word pairing phrase from your node's terminal session
        screen. Your wallet connects directly to your own node — end-to-end
        encrypted — and the phrase is never saved on this device.
      </Text>
      <MobileField
        label="Pairing phrase"
        value={state.phraseText}
        onChangeText={(text) => controller.enterPairingPhrase(text)}
        placeholder="ten words"
      />
      {state.phraseValidation === 'wrong-word-count' && (
        <MobileErrorNote error="A pairing phrase is exactly 10 words." />
      )}
      {state.connectError !== null && <MobileErrorNote error={state.connectError} />}
      <MobileButtonGroup>
        <MobileButton
          label={state.busy ? 'Connecting…' : 'Connect'}
          kind={state.phraseValidation === 'ok' ? 'primary' : 'secondary'}
          busy={state.busy}
          onPress={() => {
            void controller.pair().catch(() => undefined);
          }}
        />
      </MobileButtonGroup>
    </MobileScreen>
  );
}

/**
 * Home for remote-node Mode B: balances and node identity from the user's
 * litd, plus the standing disclosure that channel-safety operations live on
 * desktop — the phone's connection gaps, channel safety needs liveness.
 */
function ModeBHomeScreen({
  controller,
  state,
  network,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
  network: string;
}): ReactNode {
  const { node, balances } = state;
  const caps = controller.capabilities();
  const activeChannels = balances?.channels.filter((c) => c.active).length ?? 0;
  return (
    <MobileScreen>
      <MobileHeader
        title="Node wallet"
        subtitle={node !== null ? `${network} · ${node.alias}` : network}
      />
      {balances !== null ? (
        <MobilePanel title="Balances on your node">
          <MobileSats
            label="Lightning (spendable)"
            sats={balances.lightningSpendableSat}
            swatch={mobilePalette.fundOutbound}
          />
          <MobileSats
            label="On-chain (node wallet)"
            sats={balances.onchainConfirmedSat}
            swatch={mobilePalette.fundOnchain}
          />
          <Text style={styles.faint}>
            {balances.channels.length === 0
              ? 'No channels'
              : `${balances.channels.length} channel${balances.channels.length === 1 ? '' : 's'}, ${activeChannels} active`}
          </Text>
        </MobilePanel>
      ) : (
        <Text style={styles.dim}>Loading balances…</Text>
      )}
      <MobileButtonGroup row>
        <MobileButton label="Send" onPress={() => controller.navigate('send')} />
        <MobileButton label="Receive" onPress={() => controller.navigate('receive')} />
      </MobileButtonGroup>
      <MobileWarningBand>{caps.note}</MobileWarningBand>
      <MobileWarningBand tone="warning">{DESKTOP_ONLY_DISCLOSURE}</MobileWarningBand>
    </MobileScreen>
  );
}

/**
 * Send: the foreground rule is visible before it bites — payments only run
 * while the app is open, because the LNC session should not be resumed for
 * background dispatches.
 */
function ModeBSendScreen({
  controller,
  state,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
}): ReactNode {
  const empty = state.sendBolt11Text.trim().length === 0;
  const sending = state.sendStatus === 'sending';
  const lightning = controller.walletCapabilities().features.lightningSend;
  return (
    <MobileScreen>
      <MobileHeader title="Send" subtitle="Lightning, paid by your node" />
      {!lightning.available && state.foregrounded && (
        <MobileWarningBand tone="warning">{lightning.reason}</MobileWarningBand>
      )}
      {!state.foregrounded && (
        <MobileWarningBand tone="warning">
          The app is in the background — reopen it to make payments.
        </MobileWarningBand>
      )}
      <MobileField
        label="Lightning invoice (BOLT11)"
        value={state.sendBolt11Text}
        onChangeText={(text) => controller.editSendDestination(text)}
        placeholder="lnbc…"
        multiline
      />
      <MobileErrorNote error={state.sendError} />
      {state.sendStatus === 'settled' && (
        <MobileWarningBand tone="positive">Payment sent.</MobileWarningBand>
      )}
      <MobileButton
        label={sending ? 'Paying…' : 'Pay invoice'}
        kind="primary"
        disabled={!lightning.available || empty}
        busy={sending}
        onPress={() => {
          void controller.send().catch(() => undefined);
        }}
      />
      {empty && <Text style={styles.faint}>Paste an invoice to pay it from your node.</Text>}
      <Text style={styles.faint}>
        Your node pays the invoice and picks the route; its routing fee is not quoted here
        beforehand.
      </Text>
    </MobileScreen>
  );
}

function ModeBReceiveScreen({
  controller,
  state,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
}): ReactNode {
  const amountReady = /^\d+$/.test(state.invoiceAmountText.trim());
  const features = controller.walletCapabilities().features;
  return (
    <MobileScreen>
      <MobileHeader title="Receive" subtitle="Lightning invoice from your node" />
      {!features.lightningReceive.available && (
        <MobileWarningBand tone="warning">{features.lightningReceive.reason}</MobileWarningBand>
      )}
      <MobileField
        label="Amount (sats)"
        value={state.invoiceAmountText}
        onChangeText={(text) => controller.editInvoiceAmount(text)}
        placeholder="1000"
      />
      <MobileButton
        label="Create invoice"
        kind="primary"
        disabled={!amountReady}
        onPress={() => {
          void controller.createInvoice().catch(() => undefined);
        }}
      />
      {!amountReady && (
        <Text style={styles.faint}>Enter a whole number of sats to create an invoice.</Text>
      )}
      <MobileErrorNote error={state.invoiceError} />
      {state.invoice !== null && (
        <MobilePanel>
          <QrCode
            value={`lightning:${state.invoice}`}
            copyValue={state.invoice}
            label="QR code for your Lightning invoice"
            textLabel="Invoice"
          />
        </MobilePanel>
      )}
      {!features.onchainReceive.available && (
        <Text style={styles.faint}>{features.onchainReceive.reason}</Text>
      )}
    </MobileScreen>
  );
}

// ——— Activity ———

const REMOTE_STATUS_BADGE: Record<
  RemoteActivityRecord['status'],
  { label: string; tone: 'positive' | 'warning' | 'danger' | 'neutral' }
> = {
  settled: { label: 'Settled', tone: 'positive' },
  pending: { label: 'Pending', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  open: { label: 'Awaiting payment', tone: 'neutral' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

/** "2026-10-30 14:02 UTC", or the raw value when unparseable. */
function remoteTime(at: string): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return at;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Lightning payments and invoices read from the node over LNC. */
function ModeBActivityScreen({
  controller,
  state,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
}): ReactNode {
  const feature = controller.walletCapabilities().features.activity;
  const { activity, activityStatus, activityError } = state;
  if (!feature.available || activityStatus === 'unavailable') {
    return (
      <MobileScreen>
        <MobileHeader title="Activity" />
        <MobilePanel>
          <Text style={styles.dim}>
            {feature.available
              ? "Payment history isn't available over this connection yet."
              : feature.reason}
          </Text>
        </MobilePanel>
      </MobileScreen>
    );
  }
  return (
    <MobileScreen>
      <View style={styles.rowBetween}>
        <View style={local.flexShrink}>
          <MobileHeader title="Activity" subtitle="Lightning payments and invoices on your node" />
        </View>
        <MobileButton
          label="Refresh"
          kind="ghost"
          compact
          busy={activityStatus === 'loading'}
          onPress={() => void controller.loadActivity()}
        />
      </View>
      {activityStatus === 'failed' && (
        <MobileWarningBand tone="danger">
          <Text style={styles.bandText}>Activity could not be read: {activityError}</Text>
        </MobileWarningBand>
      )}
      {activity === null && activityStatus !== 'failed' && (
        <Text style={styles.dim}>Loading activity…</Text>
      )}
      {activity !== null && activity.length === 0 && (
        <MobilePanel>
          <Text style={styles.dim}>
            No Lightning payments or invoices on your node yet.
          </Text>
        </MobilePanel>
      )}
      {activity !== null && activity.length > 0 && (
        <MobilePanel>
          {activity.map((record, index) => {
            const badge = REMOTE_STATUS_BADGE[record.status];
            const sign = record.status !== 'settled' || record.amountSat === 0n ? null : record.direction === 'out' ? '−' : '+';
            return (
              <View
                key={`${record.paymentHash}-${record.direction}`}
                style={[local.row, index > 0 ? local.rowDivider : null]}
              >
                <View style={local.flexShrink}>
                  <Text style={styles.value}>
                    {record.direction === 'out' ? 'Sent' : 'Invoice'} · Lightning
                  </Text>
                  <Text style={styles.faint}>{remoteTime(record.createdAt)}</Text>
                  {record.memo !== null && record.memo !== '' && (
                    <Text style={styles.faint}>{record.memo}</Text>
                  )}
                  <Text style={[styles.faint, styles.mono]}>{shortenMiddle(record.paymentHash)}</Text>
                </View>
                <View style={local.amount}>
                  <MobileAmount sats={record.amountSat} sign={sign} />
                  {record.feeSat !== null && record.direction === 'out' && record.status === 'settled' && (
                    <Text style={styles.faint}>
                      Fee <MobileAmount sats={record.feeSat} style={styles.faint} />
                    </Text>
                  )}
                  <MobileBadge label={badge.label} tone={badge.tone} />
                </View>
              </View>
            );
          })}
        </MobilePanel>
      )}
      <Text style={styles.faint}>
        On-chain transactions are not read over this connection.
      </Text>
    </MobileScreen>
  );
}

// ——— Wallet ———

const REMOTE_SUMMARY: ReadonlyArray<{ id: FeatureId; label: string }> = [
  { id: 'lightningSend', label: 'Lightning payments' },
  { id: 'onchainSend', label: 'On-chain payments' },
  { id: 'activity', label: 'Payment history' },
  { id: 'channelSummary', label: 'Channels' },
  { id: 'sendFeeQuote', label: 'Fee shown before paying' },
  { id: 'lightningFeeLimit', label: 'Lightning fee limit' },
  { id: 'invoiceExpiry', label: 'Invoice expiry' },
  { id: 'loopSwaps', label: 'Loop swaps' },
  { id: 'taprootAssets', label: 'Taproot Assets' },
  { id: 'qrScan', label: 'QR scanning' },
  { id: 'appLock', label: 'App PIN' },
];

/** Node identity as the node reports it, and what this connection can do. */
function ModeBWalletScreen({
  controller,
  state,
  network,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
  network: string;
}): ReactNode {
  const { node } = state;
  return (
    <MobileScreen>
      <MobileHeader title="Wallet" />
      <MobilePanel title="Your node">
        <MobileLabelRow label="Connection" value="Lightning Node Connect" mono={false} />
        <MobileLabelRow label="Network" value={network} mono={false} />
        {node !== null ? (
          <>
            <MobileLabelRow label="Alias" value={node.alias} mono={false} />
            <MobileLabelRow label="Version" value={node.version} />
            <MobileLabelRow label="Block height" value={String(node.blockHeight)} />
            <MobileLabelRow label="Identity key" value={node.identityPubkey} />
          </>
        ) : (
          <Text style={styles.dim}>Node details load after pairing.</Text>
        )}
      </MobilePanel>
      <MobileWarningBand tone="warning">{DESKTOP_ONLY_DISCLOSURE}</MobileWarningBand>
      <CapabilitySummary capabilities={controller.walletCapabilities()} features={REMOTE_SUMMARY} />
    </MobileScreen>
  );
}

const local = StyleSheet.create({
  flexShrink: { flexShrink: 1 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 10,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: mobilePalette.border },
  amount: { alignItems: 'flex-end', gap: 4 },
});

const shell = StyleSheet.create({
  shell: { flex: 1, backgroundColor: mobilePalette.bg },
});

// Re-export for the host shell: mobile renders channel ops as desktop-only.
export { isDesktopOnly };
