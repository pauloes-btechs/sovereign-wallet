/**
 * Scaffold shell with the waved sidecar wired end-to-end: boot on mount,
 * health-gate, render the lifecycle phase, clean teardown on unmount.
 * The real wallet UI arrives with the UI tasks; this shell exists to prove
 * the Mode A sidecar contract in the actual desktop runtime.
 */
import { useEffect, useMemo, useState } from 'react';
import { path } from '@tauri-apps/api';
import { createTauriSidecarRuntime } from './sidecar/tauri-runtime.js';
import { useWavedSidecar, type WavedSidecarState } from './sidecar/use-waved-sidecar.js';
import type { WavedSidecarConfig } from './sidecar/waved.js';

/** True only inside the Tauri WebView (vite dev in a plain browser has no
 *  sidecar runtime — show that state honestly instead of failing to spawn). */
function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

const WAVED_HEALTH_PORT = 10032; // loopback, distinct from waved's rpc/gateway defaults

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

export function App() {
  const config = useWavedSidecarConfig();
  const { phase, error } = useWavedSidecar(config);
  const runtimeMissing = useMemo(() => isTauri() === false, []);

  const status = runtimeMissing
    ? 'Desktop runtime required for the daemon (open the packaged app).'
    : PHASE_COPY[phase];

  return (
    <main
      style={{
        background: '#0d0d10',
        color: '#e8e8ea',
        minHeight: '100vh',
        fontFamily: 'system-ui',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1>Sovereign Wallet</h1>
        <p style={{ color: error ? '#ff6b6b' : '#9aa0a6' }}>
          {error ? `Daemon error: ${error}` : status}
        </p>
      </div>
    </main>
  );
}
