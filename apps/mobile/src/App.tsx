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
import { Text } from 'react-native';
import { PaymentEngine, InMemoryPaymentIntentStore } from '@sovereign/payments';
import {
  SDK_PIN,
  WavelengthPaymentDispatcher,
  WavelengthProvider,
} from '@sovereign/wavelength-adapter';
import type { WavelengthClient } from '@sovereign/wavelength-adapter';
import { ModeAController } from './flows/modeAController.js';
import {
  BackupConfirmationScreen,
  OnboardingScreen,
  RestoreScreen,
} from './ui/onboardingScreens.js';
import {
  CapabilitiesScreen,
  HomeScreen,
  ReceiveScreen,
  SendScreen,
} from './ui/walletScreens.js';

export interface ModeAAppPorts {
  /** A CONNECTED Wavelength client (native bindings or the harness simulator). */
  readonly client: WavelengthClient;
  readonly network: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  readonly dataDir: string;
  /** Daemon poll cadence for VTXO/exit state; the UI also refreshes on events. */
  readonly pollIntervalMs?: number;
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
  const engine = new PaymentEngine({
    // TODO(native-shell): swap for the SQLCipher-at-rest store and inject the
    // platform UUID source — Hermes has no crypto.randomUUID.
    store: new InMemoryPaymentIntentStore(),
    dispatcher: new WavelengthPaymentDispatcher({ client: ports.client, sdkPin: SDK_PIN }),
    newId: () => globalThis.crypto.randomUUID(),
  });
  return new ModeAController({
    provider,
    engine,
    network: ports.network,
    dataDir: ports.dataDir,
  });
}

export function ModeAApp(ports: ModeAAppPorts): ReactNode {
  const [controller] = useState(() => createModeAController(ports));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    void controller.start();
    return () => {
      void controller.stop();
    };
  }, [controller]);

  switch (state.screen) {
    case 'onboarding':
      return <OnboardingScreen controller={controller} />;
    case 'backup':
      return <BackupConfirmationScreen controller={controller} state={state} />;
    case 'restore':
      return <RestoreScreen controller={controller} state={state} />;
    case 'send':
      return <SendScreen controller={controller} state={state} />;
    case 'receive':
      return <ReceiveScreen controller={controller} state={state} />;
    case 'capabilities':
      return <CapabilitiesScreen controller={controller} />;
    case 'home':
      return <HomeScreen controller={controller} state={state} network={ports.network} />;
  }
}

/**
 * Native entry (registered in index.js). The native shell injects a resolver
 * that hands back the SDK's RN-native-binding client (New Architecture); the
 * resolver prop keeps `ModeAApp` client-agnostic and this entry diagnosable —
 * a missing resolver renders an explicit not-configured state, never a blank screen.
 */
export interface NativeAppProps {
  /** Resolves the connected client before the app mounts (native shell provided). */
  readonly resolveClient?: () => Promise<WavelengthClient>;
  readonly network?: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  readonly dataDir?: string;
}

export default function App(props: NativeAppProps): ReactNode {
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
