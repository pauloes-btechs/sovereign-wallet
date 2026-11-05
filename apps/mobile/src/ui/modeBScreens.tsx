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
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileField,
  MobileFlowTabs,
  MobileHeader,
  MobileLabelRow,
  MobilePanel,
  MobileSats,
  MobileScreen,
  MobileTabBar,
  MobileWarningBand,
  mobilePalette,
  styles,
} from './Primitives.js';
import type {
  ModeBRemoteController,
  ModeBRemoteScreen,
  ModeBRemoteState,
} from '../flows/modeBRemoteController.js';
import {
  DESKTOP_ONLY_DISCLOSURE,
  isDesktopOnly,
} from '../flows/modeBRemoteController.js';

type ModeBTab = 'home' | 'pay' | 'more';

/** Remote-node destinations. No Activity tab: the LNC port reads no payment history yet. */
const MODE_B_TABS: ReadonlyArray<{ id: ModeBTab; label: string; glyph: string }> = [
  { id: 'home', label: 'Home', glyph: '⌂' },
  { id: 'pay', label: 'Pay', glyph: '⇅' },
  { id: 'more', label: 'More', glyph: '⋯' },
];

function tabFor(screen: ModeBRemoteScreen): ModeBTab | null {
  switch (screen) {
    case 'home':
      return 'home';
    case 'send':
    case 'receive':
      return 'pay';
    case 'more':
      return 'more';
    case 'pairing':
    case 'connecting':
    case 'revoked':
      return null;
  }
}

/** Full Mode B mobile tree — the host supplies a connected-capable port. */
export function ModeBRemoteApp({
  controller,
  network,
}: {
  controller: ModeBRemoteController;
  network: string;
}): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const tab = tabFor(state.screen);
  const selectTab = (next: ModeBTab): void => {
    if (next === 'pay') {
      if (tab !== 'pay') controller.navigate('send');
      return;
    }
    controller.navigate(next);
  };
  return (
    <View style={shell.shell}>
      <ModeBScreenBody controller={controller} state={state} network={network} />
      {tab !== null && <MobileTabBar tabs={MODE_B_TABS} activeId={tab} onChange={selectTab} />}
    </View>
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
    case 'send':
      return <ModeBSendScreen controller={controller} state={state} />;
    case 'receive':
      return <ModeBReceiveScreen controller={controller} state={state} />;
    case 'more':
      return <ModeBMoreScreen state={state} network={network} />;
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

function PaySwitch({
  controller,
  active,
}: {
  controller: ModeBRemoteController;
  active: 'send' | 'receive';
}): ReactNode {
  return (
    <MobileFlowTabs
      tabs={[
        { id: 'send', label: 'Send' },
        { id: 'receive', label: 'Receive' },
      ]}
      activeId={active}
      onChange={(id) => controller.navigate(id === 'receive' ? 'receive' : 'send')}
    />
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
  return (
    <MobileScreen>
      <MobileHeader title="Pay" />
      <PaySwitch controller={controller} active="send" />
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
        disabled={!state.foregrounded || empty}
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
  return (
    <MobileScreen>
      <MobileHeader title="Pay" />
      <PaySwitch controller={controller} active="receive" />
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
          <MobileLabelRow label="Invoice" value={state.invoice} />
        </MobilePanel>
      )}
    </MobileScreen>
  );
}

/** Node identity as the node reports it, and what this app leaves to desktop. */
function ModeBMoreScreen({
  state,
  network,
}: {
  state: ModeBRemoteState;
  network: string;
}): ReactNode {
  const { node } = state;
  return (
    <MobileScreen>
      <MobileHeader title="More" />
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
      <MobilePanel title="Not in this app yet">
        <Text style={styles.dim}>
          Payment history, channel management and liquidity tools (Loop, Pool) are not read
          over this connection. Use the desktop app connected to the same node.
        </Text>
      </MobilePanel>
    </MobileScreen>
  );
}

const shell = StyleSheet.create({
  shell: { flex: 1, backgroundColor: mobilePalette.bg },
});

// Re-export for the host shell: mobile renders channel ops as desktop-only.
export { isDesktopOnly };
