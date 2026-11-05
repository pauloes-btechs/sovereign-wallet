/**
 * The advanced (litd) wallet once the node is ready: providers + shell.
 * Lifecycle gates (create / restore / unlock) stay in modeb/ModeBApp.
 */
import '@sovereign/ui/styles.css';
import './platform.css';
import type { BridgeClient, BridgeStateView } from '../modeb/bridge-client.js';
import { PlatformProvider, PrefsProvider } from './context.js';
import { Shell } from './shell.js';

export function PlatformApp({ client, state }: { client: BridgeClient; state: BridgeStateView }) {
  return (
    <PrefsProvider>
      <PlatformProvider bridge={client} node={state}>
        <div data-testid="modeb-ready" style={{ height: '100%' }}>
          <Shell />
        </div>
      </PlatformProvider>
    </PrefsProvider>
  );
}
