/**
 * Mode A app root — builds the real provider/engine stack from a connected
 * Wavelength client and renders the active screen.
 *
 * The host (native shell or preview) resolves the client BEFORE mounting:
 * `ModeAApp` takes a connected `WavelengthClient`. On React Native that
 * client comes from the SDK's native bindings (New Architecture); in the
 * web preview it is the harness SimulatedWavelengthClient.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PaymentEngine, InMemoryPaymentIntentStore } from '@sovereign/payments';
import {
  SDK_PIN,
  WavelengthPaymentDispatcher,
  WavelengthProvider,
} from '@sovereign/wavelength-adapter';
import type { WavelengthClient } from '@sovereign/wavelength-adapter';
import { ModeAController } from './flows/modeAController.js';
import { ModeBRemoteController } from './flows/modeBRemoteController.js';
import type { LncRpcPort } from './flows/modeBRemoteController.js';
import type { PreferencesStore } from './flows/preferences.js';
import { NO_PLATFORM_SERVICES } from './flows/platform.js';
import type { PlatformServices } from './flows/platform.js';
import { MobileAppProvider, usePreferencesStore } from './ui/appContext.js';
import { ModeBRemoteApp } from './ui/modeBScreens.js';
import { ModeAMoneyScreen } from './ui/transfers/moneyScreens.js';
import { PrimaryTabBar, useHardwareBack } from './ui/navigationUi.js';
import {
  BackupConfirmationScreen,
  OnboardingScreen,
  RestoreScreen,
} from './ui/onboardingScreens.js';
import { mobilePalette } from './ui/Primitives.js';
import {
  ModeAActivityScreen,
  ModeAHomeScreen,
  ModeATransactionScreen,
} from './ui/home/ModeAHome.js';
import { CapabilitiesScreen } from './ui/walletScreens.js';
import { ModeASendScreen } from './ui/send/sendScreens.js';
import { ModeAReceiveScreen } from './ui/receive/receiveScreens.js';
import { isWalletRoute } from './ui/wallet/routes.js';
import { WalletRouter } from './ui/wallet/WalletSettings.js';
import {
  WalletSecurityBoundary,
  useBackupRecorder,
  useWalletSecurity,
} from './ui/wallet/WalletSecurity.js';

export interface ModeAAppPorts {
  /** A CONNECTED Wavelength client (native bindings or the harness simulator). */
  readonly client: WavelengthClient;
  readonly network: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  readonly dataDir: string;
  /** Daemon poll cadence for VTXO/exit state; the UI also refreshes on events. */
  readonly pollIntervalMs?: number;
  /**
   * Preferences (denomination, privacy, payment limits…). Omitted → an
   * in-memory store: settings work but do not survive a restart.
   */
  readonly preferences?: PreferencesStore;
  /** Device services (clipboard, share, scanner, keystore, safe area). */
  readonly platform?: PlatformServices;
}

/**
 * Wires the REAL Mode A stack: WavelengthProvider (adapter) + shared
 * PaymentEngine (persist-before-dispatch) + the Mode A controller.
 */
export function createModeAController(ports: ModeAAppPorts): ModeAController {
  const provider = new WavelengthProvider({
    client: ports.client,
    pollIntervalMs: ports.pollIntervalMs ?? 30_000,
  });
  // The payment-timeout preference is read when the wallet starts (the
  // dispatcher is built once); capabilities say so next to the setting.
  const timeoutSeconds = ports.preferences?.get().paymentTimeoutSeconds;
  // TODO(native-shell): swap for the SQLCipher-at-rest store and inject the
  // platform UUID source — Hermes has no crypto.randomUUID.
  const store = new InMemoryPaymentIntentStore();
  const paymentEngine = new PaymentEngine({
    store,
    dispatcher: new WavelengthPaymentDispatcher({
      client: ports.client,
      sdkPin: SDK_PIN,
      dispatchTimeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
    }),
    newId: () => globalThis.crypto.randomUUID(),
  });
  return new ModeAController({
    provider,
    engine: {
      submit: (kind, payload, maxFeeSat) => paymentEngine.submit(kind, payload, maxFeeSat),
      execute: (intentId) => paymentEngine.execute(intentId),
      recoverInterrupted: () => paymentEngine.recoverInterrupted(),
      // Read-only: lets a reconcile report what the intent actually became.
      intentState: async (intentId) => (await store.get(intentId))?.state,
    },
    network: ports.network,
    dataDir: ports.dataDir,
    platform: ports.platform,
  });
}

export function ModeAApp(ports: ModeAAppPorts): ReactNode {
  const preferences = usePreferencesStore(ports.preferences);
  const [controller] = useState(() => createModeAController({ ...ports, preferences }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const platform = ports.platform ?? NO_PLATFORM_SERVICES;
  useHardwareBack(() => controller.goBack(), state.nav !== null);
  const security = useWalletSecurity(platform, preferences);
  useBackupRecorder(security.backup, state);

  useEffect(() => {
    void controller.start();
    return () => {
      void controller.stop();
    };
  }, [controller]);

  const screen = ((): ReactNode => {
    if (isWalletRoute(state.screen)) {
      return (
        <WalletRouter
          host={{ kind: 'wavelength', controller, state, network: ports.network }}
          route={state.screen}
        />
      );
    }
    switch (state.screen) {
      case 'onboarding':
        return <OnboardingScreen controller={controller} />;
      case 'backup':
        return <BackupConfirmationScreen controller={controller} state={state} />;
      case 'restore':
        return <RestoreScreen controller={controller} state={state} />;
      case 'send':
        return <ModeASendScreen controller={controller} state={state} network={ports.network} />;
      case 'receive':
        return <ModeAReceiveScreen controller={controller} state={state} />;
      case 'activity':
        return <ModeAActivityScreen controller={controller} state={state} />;
      case 'transaction':
        return <ModeATransactionScreen controller={controller} state={state} />;
      case 'capabilities':
        return <CapabilitiesScreen controller={controller} />;
      case 'home':
        return <ModeAHomeScreen controller={controller} state={state} network={ports.network} />;
      case 'transfers':
      case 'liquidity':
      case 'assets':
        return <ModeAMoneyScreen controller={controller} state={state} route={state.screen} />;
    }
  })();

  return (
    <MobileAppProvider preferences={preferences} platform={platform}>
      <WalletSecurityBoundary security={security}>
        <View style={shellStyles.shell}>
          {screen}
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

const shellStyles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: mobilePalette.bg },
});

/**
 * Native entry (registered in index.js). The native shell injects a resolver
 * that hands back the SDK's RN-native-binding client (New Architecture); the
 * resolver prop keeps `ModeAApp` client-agnostic and this entry diagnosable —
 * a missing resolver renders an explicit not-configured state, never a blank screen.
 */
export interface NativeAppProps {
  /** Resolves the connected client before the app mounts (native shell provided). */
  readonly resolveClient?: () => Promise<WavelengthClient>;
  /**
   * Mode B (remote node): resolves the LNC port built on
   * `@lightninglabs/lnc-rn`. Present → the app renders the remote-node
   * experience (pairing phrase → user's own litd). The phone hosts NO node.
   */
  readonly resolveLncPort?: () => Promise<LncRpcPort>;
  /** Wallet mode; defaults to everyday (Mode A). */
  readonly mode?: 'everyday' | 'remote-node';
  /**
   * Native slot: a preferences store over the shell's storage module
   * (`NativePreferencesBackend`). Omitted → in-memory, not persisted.
   */
  readonly preferences?: PreferencesStore;
  /** Native slot: device services the shell provides. Omitted → none. */
  readonly platform?: PlatformServices;
  readonly network?: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  readonly dataDir?: string;
}

export default function App(props: NativeAppProps): ReactNode {
  if (props.mode === 'remote-node') {
    return <ModeBEntry {...props} />;
  }
  return <ModeAEntry {...props} />;
}

/** Mode A entry — unchanged behavior (everyday Wavelength wallet). */
function ModeAEntry(props: NativeAppProps): ReactNode {
  const [client, setClient] = useState<WavelengthClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.resolveClient === undefined) return;
    let cancelled = false;
    props
      .resolveClient()
      .then((resolved) => {
        if (!cancelled) setClient(resolved);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [props.resolveClient]);

  if (client !== null) {
    return (
      <ModeAApp
        client={client}
        network={props.network ?? 'mainnet'}
        dataDir={props.dataDir ?? '.'}
        preferences={props.preferences}
        platform={props.platform}
      />
    );
  }
  if (error !== null) {
    return <Text>The wallet failed to start: {error}</Text>;
  }
  if (props.resolveClient !== undefined) {
    return <Text>Starting wallet…</Text>;
  }
  return (
    <Text>
      Native shell not configured: this build needs the platform entry to inject a Wavelength
      client resolver (SDK RN native bindings).
    </Text>
  );
}

/**
 * Mode B entry — the remote-node experience. The shell resolves the LNC port
 * (built on @lightninglabs/lnc-rn); the entry stays diagnosable like Mode A's:
 * a missing resolver names the missing configuration, never a blank screen.
 */
function ModeBEntry(props: NativeAppProps): ReactNode {
  const [controller, setController] = useState<ModeBRemoteController | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve the port once per (resolver, network); the effect does NOT depend
  // on `controller` — a stale-dep loop would mint a new controller per render.
  useEffect(() => {
    if (props.resolveLncPort === undefined) return;
    let cancelled = false;
    props
      .resolveLncPort()
      .then((port) => {
        if (!cancelled) {
          setController(
            new ModeBRemoteController({
              port,
              network: props.network ?? 'mainnet',
              platform: props.platform,
            }),
          );
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [props.resolveLncPort, props.network, props.platform]);

  // Stop the PREVIOUS controller when a new one replaces it, and stop the
  // live one on unmount.
  useEffect(() => {
    return () => {
      controller?.stop();
    };
  }, [controller]);

  if (controller !== null) {
    return (
      <ModeBRemoteApp
        controller={controller}
        network={props.network ?? 'mainnet'}
        preferences={props.preferences}
        platform={props.platform}
      />
    );
  }
  if (error !== null) {
    return <Text>The node connection failed to start: {error}</Text>;
  }
  if (props.resolveLncPort !== undefined) {
    return <Text>Starting wallet…</Text>;
  }
  return (
    <Text>
      Native shell not configured: remote-node mode needs the platform entry to inject an LNC
      port resolver (@lightninglabs/lnc-rn native module).
    </Text>
  );
}
