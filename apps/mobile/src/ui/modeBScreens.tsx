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
import { Text, View } from 'react-native';
import {
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileField,
  MobileHeader,
  MobileLabelRow,
  MobileScreen,
  MobileWarningBand,
  mobilePalette,
  styles,
} from './Primitives.js';
import type { ModeBRemoteController, ModeBRemoteState } from '../flows/modeBRemoteController.js';
import {
  DESKTOP_ONLY_DISCLOSURE,
  isDesktopOnly,
} from '../flows/modeBRemoteController.js';

/** Full Mode B mobile tree — the host supplies a connected-capable port. */
export function ModeBRemoteApp({
  controller,
  network,
}: {
  controller: ModeBRemoteController;
  network: string;
}): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
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
          disabled={state.busy}
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
  return (
    <MobileScreen>
      <MobileHeader title="Node wallet" />
      {node !== null && (
        <View>
          <MobileLabelRow label="Node" value={node.alias} />
          <MobileLabelRow label="Lightning" value="Channels (your node)" />
        </View>
      )}
      {balances !== null ? (
        <View>
          <MobileLabelRow
            label="Lightning-spendable"
            value={`${balances.lightningSpendableSat} sat`}
          />
          <MobileLabelRow
            label="On-chain (node wallet)"
            value={`${balances.onchainConfirmedSat} sat`}
          />
        </View>
      ) : (
        <Text style={styles.dim}>Loading balances…</Text>
      )}
      <MobileWarningBand>{caps.note}</MobileWarningBand>
      <MobileWarningBand tone="warning">{DESKTOP_ONLY_DISCLOSURE}</MobileWarningBand>
      <MobileButtonGroup>
        <MobileButton label="Send" onPress={() => controller.navigate('send')} />
        <MobileButton label="Receive" onPress={() => controller.navigate('receive')} />
      </MobileButtonGroup>
      <Text style={[styles.dim, { color: mobilePalette.textDim }]}>network: {network}</Text>
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
  return (
    <MobileScreen>
      <MobileHeader title="Send" />
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
      />
      <MobileErrorNote error={state.sendError} />
      <MobileButtonGroup>
        <MobileButton
          label={state.sendStatus === 'sending' ? 'Paying…' : 'Pay'}
          kind="primary"
          disabled={!state.foregrounded || state.sendStatus === 'sending'}
          onPress={() => {
            void controller.send().catch(() => undefined);
          }}
        />
        <MobileButton label="Back" kind="secondary" onPress={() => controller.navigate('home')} />
      </MobileButtonGroup>
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
  return (
    <MobileScreen>
      <MobileHeader title="Receive" />
      <MobileField
        label="Amount (sats)"
        value={state.invoiceAmountText}
        onChangeText={(text) => controller.editInvoiceAmount(text)}
        placeholder="1000"
      />
      <MobileButtonGroup>
        <MobileButton
          label="Create invoice"
          kind="primary"
          onPress={() => {
            void controller.createInvoice().catch(() => undefined);
          }}
        />
        <MobileButton label="Back" kind="secondary" onPress={() => controller.navigate('home')} />
      </MobileButtonGroup>
      {state.invoice !== null && (
        <View>
          <MobileLabelRow label="Invoice" value={state.invoice} />
        </View>
      )}
    </MobileScreen>
  );
}

// Re-export for the host shell: mobile renders channel ops as desktop-only.
export { isDesktopOnly };
