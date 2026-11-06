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
  MobileHeader,
  MobileScreen,
  mobilePalette,
  styles,
} from './Primitives.js';
import type {
  ModeBRemoteController,
  ModeBRemoteState,
} from '../flows/modeBRemoteController.js';
import { isDesktopOnly } from '../flows/modeBRemoteController.js';
import type { PreferencesStore } from '../flows/preferences.js';
import { NO_PLATFORM_SERVICES } from '../flows/platform.js';
import type { PlatformServices } from '../flows/platform.js';
import { MobileAppProvider, usePreferencesStore } from './appContext.js';
import { PrimaryTabBar, useHardwareBack } from './navigationUi.js';
import { isWalletRoute } from './wallet/routes.js';
import { WalletRouter } from './wallet/WalletSettings.js';
import { WalletSecurityBoundary, useWalletSecurity } from './wallet/WalletSecurity.js';
import { ModeBMoneyScreen } from './transfers/moneyScreens.js';
import {
  ModeBActivityScreen,
  ModeBHomeScreen,
  ModeBTransactionScreen,
} from './home/ModeBHome.js';
import { ModeBSendScreen } from './send/sendScreens.js';
import { ModeBReceiveScreen } from './receive/receiveScreens.js';

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
  const security = useWalletSecurity(platform, preferences);
  return (
    <MobileAppProvider preferences={preferences} platform={platform}>
      <WalletSecurityBoundary security={security}>
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
      </WalletSecurityBoundary>
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
  if (isWalletRoute(state.screen)) {
    return <WalletRouter host={{ kind: 'remote-lnd', controller, state, network }} route={state.screen} />;
  }
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
    case 'transaction':
      return <ModeBTransactionScreen controller={controller} state={state} />;
    case 'send':
      return <ModeBSendScreen controller={controller} state={state} network={network} />;
    case 'receive':
      return <ModeBReceiveScreen controller={controller} state={state} />;
    case 'liquidity':
    case 'transfers':
    case 'swap-flow':
    case 'swap':
    case 'swaps':
    case 'assets':
    case 'asset':
    case 'asset-receive':
    case 'asset-send':
      return <ModeBMoneyScreen controller={controller} state={state} route={state.screen} />;
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

const shell = StyleSheet.create({
  shell: { flex: 1, backgroundColor: mobilePalette.bg },
});

// Re-export for the host shell: mobile renders channel ops as desktop-only.
export { isDesktopOnly };
