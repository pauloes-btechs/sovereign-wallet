/**
 * Web preview entry — mounts the real Mode A app (provider + engine +
 * controller + RN screens) over react-native-web with the harness's
 * simulated Wavelength client. This is the visual-verification path for
 * native screens in environments without iOS/Android simulators; it runs
 * the same components the native shell mounts, against the same adapter.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ModeAApp } from './App.js';
import { MobileFlowSimulatedClient } from './testing/simulatedWalletClient.js';

const sim = new MobileFlowSimulatedClient();

const container = document.getElementById('root');
if (container === null) throw new Error('preview: no #root element');

createRoot(container).render(
  <StrictMode>
    <ModeAApp client={sim} network="regtest" dataDir="/tmp/sovereign-mobile-preview" />
  </StrictMode>,
);
