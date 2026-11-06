/**
 * What the active wallet can actually do on this device — the single source
 * screens render from.
 *
 * Built from three inputs, never from assumptions:
 * 1. the backend's DECLARED capabilities (`@sovereign/wallet-core`
 *    provider declarations — Wavelength vs remote LND over LNC);
 * 2. what the live connection exposes (operator reachability for
 *    Wavelength; which optional `LncRpcPort` methods exist, connection and
 *    foreground state for remote LND);
 * 3. which device services the host injected (`PlatformServices`).
 *
 * `available: true` means the backend and the device support the feature.
 * A screen that does not offer the feature yet simply doesn't show it; a
 * screen that shows it while unavailable must show `reason`.
 *
 * Wavelength and remote LND are derived by separate functions on purpose:
 * their capabilities differ and must never be presented as equivalent.
 */

import type { WalletCapabilities as DeclaredWalletCapabilities } from '@sovereign/wallet-core';
import type { PlatformServices } from './platform.js';

export const FEATURE_IDS = [
  // Money movement and balances
  'balances',
  'lightningSend',
  'lightningReceive',
  'onchainSend',
  'onchainReceive',
  /** The fee is quoted and shown before the user confirms. */
  'sendFeeQuote',
  'activity',
  // Wallet lifecycle (on this device)
  'createWallet',
  'restoreWallet',
  'backupVerification',
  // Payment preferences the backend honours
  'lightningFeeLimit',
  'onchainFeePreference',
  'invoiceExpiry',
  'paymentTimeout',
  // Simplified advanced features
  'exitInformation',
  'unilateralExit',
  'channelSummary',
  'loopSwaps',
  'taprootAssets',
  'sessionList',
  'sessionRevoke',
  // Device
  'qrScan',
  'copyToClipboard',
  'nativeShare',
  'haptics',
  'appLock',
  'biometricUnlock',
  'screenCaptureProtection',
  'fiatReference',
  'systemTheme',
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

export type FeatureStatus =
  | { readonly available: true; readonly note?: string }
  | { readonly available: false; readonly reason: string };

export type BackendKind = 'wavelength' | 'remote-lnd';

/**
 * Named `MobileWalletCapabilities` because `@sovereign/wallet-core` already
 * exports `WalletCapabilities` (the static declaration, carried here as
 * `declared`).
 */
export interface MobileWalletCapabilities {
  readonly backend: BackendKind;
  /** Plain-language name of the wallet type, for status rows. */
  readonly backendLabel: string;
  readonly declared: Readonly<DeclaredWalletCapabilities>;
  readonly features: Readonly<Record<FeatureId, FeatureStatus>>;
}

export function isAvailable(caps: MobileWalletCapabilities, feature: FeatureId): boolean {
  return caps.features[feature].available;
}

/** The user-facing reason a feature is unavailable; null when it is available. */
export function unavailableReason(caps: MobileWalletCapabilities, feature: FeatureId): string | null {
  const status = caps.features[feature];
  return status.available ? null : status.reason;
}

const yes = (note?: string): FeatureStatus => (note === undefined ? { available: true } : { available: true, note });
const no = (reason: string): FeatureStatus => ({ available: false, reason });

// ——— device services (both backends) ———

export function platformFeatures(
  platform: PlatformServices,
): Pick<
  Record<FeatureId, FeatureStatus>,
  | 'qrScan'
  | 'copyToClipboard'
  | 'nativeShare'
  | 'haptics'
  | 'appLock'
  | 'biometricUnlock'
  | 'screenCaptureProtection'
  | 'fiatReference'
  | 'systemTheme'
> {
  const keystore = platform.secureStorage !== undefined;
  return {
    qrScan:
      platform.scanQrCode !== undefined
        ? yes()
        : no('Scanning needs the camera QR scanner, which this build does not include yet. Paste the text instead.'),
    copyToClipboard:
      platform.copyText !== undefined
        ? yes()
        : no('This build cannot reach the system clipboard. Select the text to copy it.'),
    nativeShare:
      platform.shareText !== undefined
        ? yes()
        : no('Sharing needs the system share sheet, which this build does not connect to yet.'),
    haptics:
      platform.hapticConfirm !== undefined
        ? yes()
        : no('This build has no haptics module, so there is no vibration feedback.'),
    appLock: keystore
      ? yes()
      : no(
          'An app PIN needs the iOS Keychain or Android Keystore, which this build does not include yet.',
        ),
    biometricUnlock:
      keystore && platform.authenticateBiometric !== undefined
        ? yes()
        : no('Biometric unlock needs the device keystore and biometric prompt, which this build does not include yet.'),
    screenCaptureProtection:
      platform.setScreenCaptureProtection !== undefined
        ? yes()
        : no('Hiding the app from screenshots and the app switcher needs a native module this build does not include yet.'),
    fiatReference: no(
      "No exchange-rate source is configured. This wallet doesn't contact price services, so it shows no fiat values.",
    ),
    systemTheme: no('Only the dark appearance exists in this build.'),
  };
}

// ——— Wavelength (everyday wallet) ———

export interface WavelengthCapabilityInput {
  readonly declared: Readonly<DeclaredWalletCapabilities>;
  /** A wallet exists and the runtime is started (past onboarding). */
  readonly walletReady: boolean;
  /** From the daemon's wallet info; null until the first read. */
  readonly operatorReachable: boolean | null;
  readonly platform: PlatformServices;
}

export function wavelengthCapabilities(input: WavelengthCapabilityInput): MobileWalletCapabilities {
  const { declared, walletReady, operatorReachable } = input;
  const notReady = no('Available once your wallet is set up.');

  /** A declared operation, gated by the declared operator dependency it needs. */
  const operation = (
    declaredSupport: boolean,
    op: 'send' | 'receive',
    unsupported: string,
    note?: string,
  ): FeatureStatus => {
    if (!declaredSupport) return no(unsupported);
    if (!walletReady) return notReady;
    const needsOperator = declared.operatorDependencies.some(
      (d) => d.kind === 'ark-operator' && d.requiredFor.includes(op),
    );
    if (needsOperator && operatorReachable === false) {
      return no(
        op === 'send'
          ? 'The Ark operator is unreachable, so sending is paused. Your funds stay yours; see exit information.'
          : 'The Ark operator is unreachable, so receiving is paused until it is back.',
      );
    }
    return yes(note);
  };

  const exitSupported = declared.unilateralExit !== 'unsupported';

  return {
    backend: 'wavelength',
    backendLabel: 'Everyday wallet (Wavelength)',
    declared,
    features: {
      balances: walletReady ? yes() : notReady,
      lightningSend: operation(
        declared.lightningSend,
        'send',
        'This wallet type cannot send Lightning payments.',
        declared.lightningMechanism === 'swaps' ? 'Paid through the swap service; its fee is shown before you confirm.' : undefined,
      ),
      lightningReceive: operation(
        declared.lightningReceive,
        'receive',
        'This wallet type cannot receive Lightning payments.',
        declared.lightningMechanism === 'swaps' ? 'Invoices are paid through the swap service and need an amount.' : undefined,
      ),
      onchainSend: operation(declared.onchainSend, 'send', 'This wallet type cannot send on-chain.'),
      onchainReceive: operation(declared.onchainReceive, 'receive', 'This wallet type cannot receive on-chain.'),
      sendFeeQuote: yes('Every send is quoted by the wallet before you confirm.'),
      activity: walletReady ? yes() : notReady,
      createWallet: yes(),
      restoreWallet: yes('Restore must finish before the VTXO batch expires.'),
      backupVerification: yes(),
      lightningFeeLimit: yes('Applied as a maximum fee in sats when each payment is quoted.'),
      onchainFeePreference: no(
        'The wallet picks the on-chain fee rate itself. The fee is quoted and shown before you confirm.',
      ),
      invoiceExpiry: no('The wallet sets invoice expiry itself; this app cannot choose it.'),
      paymentTimeout: yes('Applies the next time the wallet starts.'),
      exitInformation: exitSupported ? yes() : no('This wallet type has no exit path to show.'),
      unilateralExit: exitSupported
        ? yes('Moves funds on-chain without the operator. Slow (hours to days) and on-chain fees apply.')
        : no('This wallet type does not support a unilateral exit.'),
      channelSummary: no('This wallet has no payment channels; Lightning works through a swap service.'),
      loopSwaps: no(
        'Loop needs your own Lightning node. Connect a node to use it; this everyday wallet uses its swap service instead.',
      ),
      taprootAssets:
        declared.assets === 'none'
          ? no('This wallet type does not hold Taproot Assets.')
          : no('Taproot Assets are not supported in the everyday wallet on mobile.'),
      sessionList: no('Connection sessions apply only to a connected node.'),
      sessionRevoke: no('Connection sessions apply only to a connected node.'),
      ...platformFeatures(input.platform),
    },
  };
}

// ——— Remote LND over Lightning Node Connect ———

/** Which optional methods the live LNC port implements (feature detection). */
export interface RemotePortSurface {
  readonly listLightningActivity: boolean;
  readonly listSessions: boolean;
  readonly revokeSession: boolean;
  /** `listChannels` (peer names and reserves). Without it, channel rows come from `getBalances`. */
  readonly listChannels?: boolean;
  /** Every Loop method needed to quote and start swaps (terms, quote, Loop Out, Loop In). */
  readonly loop?: boolean;
  /** `listSwaps` + `swapStatus`: swaps can be monitored. */
  readonly loopMonitor?: boolean;
  /** `listAssets`: Taproot Assets can be read. */
  readonly assets?: boolean;
}

export interface RemoteLndCapabilityInput {
  readonly declared: Readonly<DeclaredWalletCapabilities>;
  readonly connected: boolean;
  /** Payments run only while the app is open. */
  readonly foregrounded: boolean;
  readonly port: RemotePortSurface;
  readonly platform: PlatformServices;
}

export function remoteLndCapabilities(input: RemoteLndCapabilityInput): MobileWalletCapabilities {
  const { declared, connected, foregrounded, port } = input;
  const offline = no('Connect to your node first.');
  const desktopNode = 'Use the desktop app connected to the same node.';

  const whenConnected = (status: FeatureStatus): FeatureStatus => (connected ? status : offline);

  return {
    backend: 'remote-lnd',
    backendLabel: 'Your node (remote LND over Lightning Node Connect)',
    declared,
    features: {
      balances: whenConnected(yes()),
      lightningSend: !declared.lightningSend
        ? no('This connection cannot send Lightning payments.')
        : whenConnected(
            foregrounded ? yes() : no('Payments run only while the app is open. Reopen the app to pay.'),
          ),
      lightningReceive: !declared.lightningReceive
        ? no('This connection cannot receive Lightning payments.')
        : whenConnected(yes()),
      // Declared by the backend, but the LNC port has no on-chain methods yet.
      onchainSend: no(`On-chain sending isn't available over this connection yet. ${desktopNode}`),
      onchainReceive: no(`On-chain receive addresses aren't available over this connection yet. ${desktopNode}`),
      sendFeeQuote: no('Your node picks the route when it pays, so the fee is known only afterwards.'),
      activity: port.listLightningActivity
        ? whenConnected(yes('Lightning payments and invoices from your node. On-chain transactions are not read over this connection.'))
        : no(`Payment history isn't available over this connection yet. ${desktopNode}`),
      createWallet: no('Your node holds the keys; there is no wallet to create on this phone.'),
      restoreWallet: no("Your node's seed and channel backups are restored on the node, not on this phone."),
      backupVerification: no("Your node's seed and channel backups are managed on the node."),
      lightningFeeLimit: yes("Sent with each payment as your node's fee limit; the node won't pay more."),
      onchainFeePreference: no("On-chain sending isn't available over this connection yet."),
      invoiceExpiry: yes('Set on each new invoice your node creates.'),
      paymentTimeout: yes('Sent with each payment as its timeout.'),
      exitInformation: no('Ark exits apply only to everyday wallets. Channel closes for your node are done from the desktop app.'),
      unilateralExit: no('Channel safety operations need a live, continuously connected node — do them from the desktop app.'),
      channelSummary: whenConnected(yes('Read-only: channel counts and balances from your node.')),
      loopSwaps:
        port.loop === true && port.loopMonitor === true
          ? whenConnected(
              foregrounded
                ? yes('Loop In and Loop Out run on your node; quotes come from its swap server.')
                : no('Swaps start only while the app is open. Reopen the app to start one.'),
            )
          : no(`Loop runs on your node, but this connection does not read it yet. ${desktopNode}`),
      taprootAssets: port.assets === true
        ? whenConnected(yes("Read from your node's Taproot Assets daemon. Issuers are not verified."))
        : no(`Taproot Assets aren't read over this connection yet. ${desktopNode}`),
      sessionList: port.listSessions
        ? whenConnected(yes())
        : no("This connection can't list node sessions. Manage sessions from the desktop app."),
      sessionRevoke: port.revokeSession
        ? whenConnected(yes())
        : no("This connection can't revoke sessions. Revoke it from the desktop app."),
      ...platformFeatures(input.platform),
    },
  };
}
