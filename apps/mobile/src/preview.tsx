/**
 * Web preview entry — mounts the real app (controllers + RN screens) over
 * react-native-web against simulated backends. This is the visual-verification
 * path for native screens in environments without iOS/Android simulators; it
 * runs the same components the native shell mounts.
 *
 * - default: everyday mode (Mode A) over the harness's simulated Wavelength client.
 * - `?mode=remote-node`: the remote-node screens (Mode B) over a simulated LNC port.
 *
 * Preferences persist in this browser's localStorage (key
 * `sovereign.mobile.preferences`); the only device service is the clipboard.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App, { ModeAApp } from './App.js';
import type { LncRpcPort } from './flows/modeBRemoteController.js';
import type { PlatformServices } from './flows/platform.js';
import { createPreferencesStore, webPreferencesBackend } from './flows/preferences.js';
import { freshDemoMnemonic } from './testing/demoMnemonic.js';
import { MobileFlowSimulatedClient } from './testing/simulatedWalletClient.js';
import { SimulatedLncPort } from './testing/simulatedLncPort.js';

const container = document.getElementById('root');
if (container === null) throw new Error('preview: no #root element');

const remoteNode = new URLSearchParams(window.location.search).get('mode') === 'remote-node';

const preferences = createPreferencesStore(
  webPreferencesBackend(() => {
    try {
      return window.localStorage;
    } catch {
      return null; // storage blocked — preferences still work for this session
    }
  }),
);

const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
const platform: PlatformServices =
  clipboard !== undefined && typeof clipboard.writeText === 'function'
    ? { copyText: (text) => clipboard.writeText(text) }
    : {};

// Render after preferences load so the first frame uses the saved denomination/privacy.
await preferences.load();

if (remoteNode) {
  const note = document.getElementById('demo-backend');
  if (note !== null) note.textContent = 'simulated remote node (LNC)';
  const port = new SimulatedLncPort();
  const resolveLncPort = (): Promise<LncRpcPort> => Promise.resolve(port);
  createRoot(container).render(
    <StrictMode>
      <App
        mode="remote-node"
        network="regtest"
        resolveLncPort={resolveLncPort}
        preferences={preferences}
        platform={platform}
      />
    </StrictMode>,
  );
} else {
  // A new random 12-word phrase (128-bit) for every wallet created in the demo.
  const sim = new MobileFlowSimulatedClient({ freshMnemonic: () => freshDemoMnemonic(128) });
  createRoot(container).render(
    <StrictMode>
      <ModeAApp
        client={sim}
        network="regtest"
        dataDir="/tmp/sovereign-mobile-preview"
        preferences={preferences}
        platform={platform}
      />
    </StrictMode>,
  );
}
