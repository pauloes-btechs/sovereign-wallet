/**
 * waved (Wavelength daemon v0.2.0) sidecar assembly for the desktop app.
 *
 * Liveness = /livez 200 AND the REST gateway accepting connections. waved
 * v0.2.1 answers /livez before its gateway listens, so /livez alone let the
 * app's first gateway call fail with ECONNREFUSED. Readiness = /readyz, 503
 * until the wallet is initialized (verified against waved v0.2.0). The
 * lifecycle engine gates start() on liveness; the UI reads readiness
 * separately — "daemon alive" and "wallet ready" are different states.
 */
import {
  SidecarLifecycle,
  allProbes,
  httpListeningProbe,
  httpOkProbe,
  type HealthProbe,
  type SidecarLifecycleOptions,
  type SidecarRuntime,
} from '@sovereign/daemon-lifecycle';
import { validateSidecarListenArgs } from '@sovereign/privacy/loopback';

export interface WavedSidecarConfig {
  /** Port for waved's loopback health server (/livez, /readyz). */
  healthPort: number;
  /** Daemon data directory (the app's data dir, per platform). */
  dataDir: string;
  /** Bitcoin network. Default 'regtest' while the app is in dev. */
  network?: 'regtest' | 'testnet' | 'testnet4' | 'signet' | 'mainnet';
  runtime: SidecarRuntime;
  bootTimeoutMs?: number;
}

/** waved's loopback REST gateway port (the webview's transport), pinned. */
export const WAVED_GATEWAY_PORT = 10031;

export function wavedLivenessProbe(healthPort: number, gatewayPort: number = WAVED_GATEWAY_PORT): HealthProbe {
  return allProbes(
    httpOkProbe(`http://127.0.0.1:${healthPort}/livez`),
    httpListeningProbe(`http://127.0.0.1:${gatewayPort}/`),
  );
}

/**
 * Calls `attempt` until it resolves, retrying every `intervalMs` until
 * `timeoutMs` has passed; then rejects with the last error. For startup
 * artifacts that appear shortly after liveness (waved's admin macaroon).
 */
export async function retryUntil<T>(
  attempt: () => Promise<T>,
  { timeoutMs, intervalMs }: { readonly timeoutMs: number; readonly intervalMs: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/** Readiness is surfaced separately from liveness — the UI gates wallet
 *  setup flows on this, never on /livez. */
export async function wavedReadiness(port: number): Promise<{ ready: boolean }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    return { ready: response.ok };
  } catch {
    return { ready: false };
  }
}

/**
 * The exact args the sidecar runs with — pure so tests can pin them. Every
 * listener is loopback-bound and the list is validated against the privacy
 * package's fail-closed checker before a sidecar may be constructed: a
 * future edit that moves a listener off loopback throws at assembly, not at
 * first payment.
 */
export function wavedSidecarArgs(config: {
  healthPort: number;
  dataDir: string;
  network: string;
}): string[] {
  return [
    `--health.listen=127.0.0.1:${config.healthPort}`,
    `--datadir=${config.dataDir}`,
    '--rpc.listenaddr=127.0.0.1:10029', // waved loopback defaults, pinned
    `--rpc.gateway.listenaddr=127.0.0.1:${WAVED_GATEWAY_PORT}`,
    // The gateway 403s any browser origin not on this list (verified waved
    // v0.2.0). Cover both Tauri 2 webview origins: tauri://localhost on
    // macOS/Linux, http://tauri.localhost on Windows.
    '--rpc.gateway.allowedorigins=tauri://localhost',
    '--rpc.gateway.allowedorigins=http://tauri.localhost',
    `--network=${config.network}`,
    // The default lwwallet backend requires an Esplora URL. Fresh-install
    // boot uses an unreachable loopback placeholder until wallet setup
    // replaces it — the daemon still initializes and serves health.
    '--wallet.esploraurl=http://127.0.0.1:1',
  ];
}

export function createWavedSidecar(config: WavedSidecarConfig): SidecarLifecycle {
  const { healthPort, dataDir, network = 'regtest', runtime, bootTimeoutMs = 30_000 } = config;
  const args = (): string[] => wavedSidecarArgs({ healthPort, dataDir, network });
  // Fail-closed loopback enforcement (see validateSidecarListenArgs).
  validateSidecarListenArgs(args(), { label: 'waved' });
  const options: SidecarLifecycleOptions = {
    runtime,
    health: wavedLivenessProbe(healthPort),
    args,
    bootTimeoutMs,
  };
  return new SidecarLifecycle(options);
}
