/**
 * Desktop Mode A wallet session: connects the WavedGatewayClient transport
 * (loopback HTTP/JSON gateway of the waved sidecar) to the WavelengthProvider
 * from the adapter, and derives the UI state machine from live daemon data.
 *
 * Bootstrap honesty: in the packaged Tauri app the sidecar is spawned by the
 * shell plugin and the admin macaroon is read by a Rust command in the MAIN
 * process (the webview never touches the filesystem). In a plain-browser dev
 * or e2e session the daemon is booted externally and the loopback gateway URL
 * + hex macaroon arrive via URL params (`?devGateway=&devMacaroonHex=`) —
 * the SAME session code runs in both; only transport bootstrap differs.
 */
import { createPaymentEngine } from './payments.js';
import { WavelengthProvider, WavedGatewayClient } from '@sovereign/wavelength-adapter';
import type { PaymentEngine } from '@sovereign/payments';
import type { WalletInfo } from '@sovereign/wavelength-adapter';

export const WALLET_POLL_MS = 2_000;

/**
 * How the webview reaches the daemon's gateway. The runtime shape is always
 * the same (loopback URL + hex macaroon); the SOURCE differs — in the
 * packaged app the main process reads the macaroon and passes it over the
 * Tauri IPC; in dev/e2e the daemon is booted externally and both values
 * arrive via URL params.
 */
export interface GatewayBootstrap {
  gatewayUrl: string;
  macaroonHex: string;
}

/**
 * Parse dev-mode URL params. Returns null when absent/malformed — never throws.
 * Loopback-only, but path-tolerant: the e2e/dev proxy base is
 * `http://127.0.0.1:5173/waved` (same-origin through the vite dev server).
 */
export function devGatewayBootstrap(search: string): GatewayBootstrap | null {
  const params = new URLSearchParams(search);
  const gatewayUrl = params.get('devGateway');
  const macaroonHex = params.get('devMacaroonHex');
  if (!gatewayUrl || !macaroonHex || !/^https?:\/\/127\.0\.0\.1:\d+(\/\S*)?$/.test(gatewayUrl)) return null;
  if (!/^[0-9a-f]+$/.test(macaroonHex)) return null;
  return { gatewayUrl, macaroonHex };
}

/**
 * The UI state machine, derived ONLY from backend-declared data (getInfo) —
 * never inferred. `backup-confirm` is the post-create step the client drives
 * while the mnemonic is still on screen; every other state mirrors the daemon.
 */
export type WalletSessionState =
  | { phase: 'connecting' }
  | { phase: 'wallet-missing' } // walletState 'none' → onboarding
  | { phase: 'backup-confirm'; mnemonic: readonly string[] } // created; confirm words NOW
  | { phase: 'locked' } // walletState 'locked' → unlock form
  | { phase: 'ready' } // walletState 'ready' → wallet screens
  | { phase: 'failed'; error: string };

export function sessionPhaseFromInfo(
  info: Pick<WalletInfo, 'walletState'>,
  pendingMnemonic: readonly string[] | null,
): WalletSessionState {
  // A pending backup confirmation outranks every existing-wallet state: the
  // daemon reports the wallet ready the instant create returns, but the words
  // must stay on screen until the user acknowledges them.
  if (pendingMnemonic) return { phase: 'backup-confirm', mnemonic: pendingMnemonic };
  switch (info.walletState) {
    case 'none':
      return { phase: 'wallet-missing' };
    case 'locked':
      return { phase: 'locked' };
    case 'ready':
    case 'syncing':
      return { phase: 'ready' };
    default:
      // Unrecognized states stay conservative — same contract as the transport.
      return { phase: 'locked' };
  }
}

/** One wired session: provider + payment engine + poller. Owns exactly one daemon session. */
export interface WalletSession {
  provider: WavelengthProvider;
  /** Crash-safe payment engine over the same gateway client (intents persist
   *  to localStorage before any dispatch — never blind re-dispatch). */
  engine: PaymentEngine;
  dispose(): Promise<void>;
}

export async function connectGatewaySession(bootstrap: GatewayBootstrap): Promise<WalletSession> {
  const client = new WavedGatewayClient({
    gatewayUrl: bootstrap.gatewayUrl,
    macaroonHex: bootstrap.macaroonHex,
  });
  const provider = new WavelengthProvider({ client });
  await provider.start({ network: 'regtest', dataDir: '' });
  return { provider, engine: createPaymentEngine(client), dispose: () => provider.stop() };
}
