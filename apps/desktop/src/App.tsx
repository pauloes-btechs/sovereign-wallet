/**
 * Desktop app shell: two bootstrap paths, one wallet.
 *
 * - Packaged Tauri app: the waved sidecar boots through the lifecycle
 *   engine; when it is live, the main process hands over the admin
 *   macaroon (read_admin_macaroon command) and the session connects to
 *   the sidecar's pinned loopback gateway port.
 * - Plain-browser dev/e2e: `?devGateway=&devMacaroonHex=` URL params point
 *   the SAME session at an externally booted daemon (no sidecar spawn).
 *
 * In both paths the wallet screens render backend-declared state only.
 */
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { path } from '@tauri-apps/api';
import { createTauriSidecarRuntime } from './sidecar/tauri-runtime.js';
import { useWavedSidecar, type WavedSidecarState } from './sidecar/use-waved-sidecar.js';
import type { WavedSidecarConfig } from './sidecar/waved.js';
import { WalletSessionProvider } from './wallet/WalletSessionProvider.js';
import { WalletApp } from './wallet/WalletApp.js';
import { devGatewayBootstrap, type GatewayBootstrap } from './wallet/session.js';
import { ModeBApp } from './modeb/ModeBApp.js';

/** True only inside the Tauri WebView (vite dev in a plain browser has no
 *  sidecar runtime — show that state honestly instead of failing to spawn). */
function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

const WAVED_HEALTH_PORT = 10032; // loopback, distinct from waved's rpc/gateway defaults
const WAVED_GATEWAY_PORT = 10031; // pinned in sidecar/waved.ts

function useWavedSidecarConfig(): WavedSidecarConfig | null {
  const [config, setConfig] = useState<WavedSidecarConfig | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void path
      .appDataDir()
      .then((dataDir) => {
        if (cancelled) return;
        setConfig({
          healthPort: WAVED_HEALTH_PORT,
          dataDir,
          network: 'regtest', // dev default; mainnet requires explicit product sign-off
          runtime: createTauriSidecarRuntime('waved'),
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) console.error('resolving app data dir failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}

const PHASE_COPY: Record<WavedSidecarState['phase'], string> = {
  idle: 'Starting daemon…',
  starting: 'Starting daemon…',
  live: 'Daemon healthy',
  restarting: 'Daemon restarting…',
  stopping: 'Stopping daemon…',
  failed: 'Daemon failed',
  stopped: 'Daemon stopped',
};

/**
 * Resolves the gateway bootstrap for the CURRENT runtime:
 * - dev/e2e: URL params (validated; null when absent or malformed)
 * - Tauri: sidecar live + main-process macaroon read
 */
function useGatewayBootstrap(sidecar: WavedSidecarConfig | null, sidecarPhase: WavedSidecarState['phase']): GatewayBootstrap | null {
  const [bootstrap, setBootstrap] = useState<GatewayBootstrap | null>(null);

  // Dev/e2e path — computed once from the URL.
  const [devBootstrap] = useState<GatewayBootstrap | null>(() =>
    isTauri() ? null : devGatewayBootstrap(window.location.search),
  );

  const readTauriMacaroon = useCallback(async (dataDir: string, network: string): Promise<string> => {
    return invoke<string>('read_admin_macaroon', { dataDir, network });
  }, []);

  useEffect(() => {
    if (devBootstrap) {
      setBootstrap(devBootstrap);
      return;
    }
    if (!isTauri() || !sidecar || sidecarPhase !== 'live') return;
    let cancelled = false;
    void readTauriMacaroon(sidecar.dataDir, sidecar.network ?? 'regtest')
      .then((macaroonHex) => {
        if (cancelled) return;
        setBootstrap({ gatewayUrl: `http://127.0.0.1:${WAVED_GATEWAY_PORT}`, macaroonHex });
      })
      .catch((err: unknown) => {
        if (!cancelled) console.error('admin macaroon read failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [devBootstrap, sidecar, sidecarPhase, readTauriMacaroon]);

  return bootstrap;
}

export function App() {
  // Mode B (litd advanced node) is a separate experience behind its own
  // bridge process. Packaged-shell mode switching is Tauri-shell work; in
  // dev/e2e the mode is chosen by URL, and both modes are never mounted
  // together — distinct seeds, balances, and identities.
  const isModeB = new URLSearchParams(window.location.search).get('mode') === 'b';

  const config = useWavedSidecarConfig();
  const { phase, error } = useWavedSidecar(config);
  const bootstrap = useGatewayBootstrap(config, phase);

  if (isModeB) {
    return (
      <main
        style={{
          background: '#0d0d10',
          color: '#e8e8ea',
          minHeight: '100vh',
          fontFamily: 'system-ui',
        }}
      >
        <h1 style={{ textAlign: 'center', paddingTop: 16, margin: 0 }}>Sovereign Wallet — Node mode</h1>
        <ModeBApp />
      </main>
    );
  }

  const daemonStatus = isTauri()
    ? PHASE_COPY[phase]
    : bootstrap
      ? null // dev/e2e: daemon is external; the wallet screens speak for it
      : 'Desktop runtime required for the daemon (open the packaged app), or pass ?devGateway=&devMacaroonHex= for a dev session.';

  return (
    <main
      style={{
        background: '#0d0d10',
        color: '#e8e8ea',
        minHeight: '100vh',
        fontFamily: 'system-ui',
      }}
    >
      <h1 style={{ textAlign: 'center', paddingTop: 16, margin: 0 }}>Sovereign Wallet</h1>
      {daemonStatus ? (
        <p style={{ textAlign: 'center', color: error ? '#ff6b6b' : '#9aa0a6' }} data-testid="daemon-status">
          {error ? `Daemon error: ${error}` : daemonStatus}
        </p>
      ) : null}
      <WalletSessionProvider bootstrap={bootstrap}>
        <WalletApp />
      </WalletSessionProvider>
    </main>
  );
}
