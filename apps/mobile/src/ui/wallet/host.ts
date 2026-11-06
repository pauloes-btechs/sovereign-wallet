/**
 * The active wallet as the Wallet tab sees it. Everyday (Wavelength) and
 * remote-node (LND over LNC) wallets are separate variants on purpose: the
 * screens branch on `kind` and never treat them as equivalent.
 */

import type { ModeAController, ModeAState } from '../../flows/modeAController.js';
import type { ModeBRemoteController, ModeBRemoteState } from '../../flows/modeBRemoteController.js';
import type { MobileWalletCapabilities } from '../../flows/capabilities.js';
import type { WalletNameKey } from '../../flows/preferences.js';
import type { WalletRoute } from './routes.js';

export type WalletHost =
  | {
      readonly kind: 'wavelength';
      readonly controller: ModeAController;
      readonly state: ModeAState;
      readonly network: string;
    }
  | {
      readonly kind: 'remote-lnd';
      readonly controller: ModeBRemoteController;
      readonly state: ModeBRemoteState;
      readonly network: string;
    };

/** Routes the Wallet tab links to that other areas own. */
export type WalletLinkedRoute = 'capabilities' | 'transfers' | 'liquidity' | 'assets';

export function walletNavigate(host: WalletHost, route: WalletRoute | WalletLinkedRoute): void {
  if (host.kind === 'wavelength') {
    host.controller.navigate(route);
  } else if (route !== 'capabilities') {
    host.controller.navigate(route);
  }
}

export function walletBack(host: WalletHost): void {
  host.controller.goBack();
}

export function walletCapabilities(host: WalletHost): MobileWalletCapabilities {
  return host.controller.walletCapabilities();
}

export function walletNameKey(host: WalletHost): WalletNameKey {
  return host.kind;
}

/** The default name when the user has not named the wallet. */
export function defaultWalletName(host: WalletHost): string {
  return host.kind === 'wavelength' ? 'Everyday wallet' : 'My node';
}

/** Plain-language wallet type, used wherever the two kinds must be told apart. */
export function walletTypeLabel(host: WalletHost): string {
  return host.kind === 'wavelength'
    ? 'Everyday wallet — Wavelength (Ark) on this phone'
    : 'Your own node — remote LND over Lightning Node Connect';
}

/** Connection summary for status rows, from live state only. */
export function connectionSummary(host: WalletHost): { label: string; tone: 'positive' | 'warning' | 'danger' | 'neutral' } {
  if (host.kind === 'wavelength') {
    const vtxo = host.state.vtxo;
    if (!host.state.runtimeReady) return { label: 'Starting', tone: 'neutral' };
    if (vtxo === null) return { label: 'Checking', tone: 'neutral' };
    return vtxo.operatorReachable
      ? { label: 'Ark operator reachable', tone: 'positive' }
      : { label: 'Ark operator unreachable', tone: 'danger' };
  }
  if (host.state.nav === null) return { label: 'Not connected', tone: 'danger' };
  return host.controller.isConnected()
    ? { label: 'Connected to your node', tone: 'positive' }
    : { label: 'Connection lost', tone: 'danger' };
}
