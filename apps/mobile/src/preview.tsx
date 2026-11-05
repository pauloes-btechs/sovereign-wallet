/**
 * Web preview entry — mounts the real app (controllers + RN screens) over
 * react-native-web against simulated backends. This is the visual-verification
 * path for native screens in environments without iOS/Android simulators; it
 * runs the same components the native shell mounts.
 *
 * - default: everyday mode (Mode A) over the harness's simulated Wavelength client.
 * - `?mode=remote-node`: the remote-node screens (Mode B) over a simulated LNC port.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App, { ModeAApp } from './App.js';
import type { LncRpcPort } from './flows/modeBRemoteController.js';
import { MobileFlowSimulatedClient } from './testing/simulatedWalletClient.js';
import { SimulatedLncPort } from './testing/simulatedLncPort.js';

const container = document.getElementById('root');
if (container === null) throw new Error('preview: no #root element');

const remoteNode = new URLSearchParams(window.location.search).get('mode') === 'remote-node';

if (remoteNode) {
  const note = document.getElementById('demo-backend');
  if (note !== null) note.textContent = 'simulated remote node (LNC)';
  const port = new SimulatedLncPort();
  const resolveLncPort = (): Promise<LncRpcPort> => Promise.resolve(port);
  createRoot(container).render(
    <StrictMode>
      <App mode="remote-node" network="regtest" resolveLncPort={resolveLncPort} />
    </StrictMode>,
  );
} else {
  const sim = new MobileFlowSimulatedClient();
  createRoot(container).render(
    <StrictMode>
      <ModeAApp client={sim} network="regtest" dataDir="/tmp/sovereign-mobile-preview" />
    </StrictMode>,
  );
}
