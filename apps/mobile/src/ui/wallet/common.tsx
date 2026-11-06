/**
 * Pieces shared by the Wallet tab screens: the pushed-screen header, the
 * settings-persistence status line, a validated preference setter, and the
 * capability rows each wallet type lists.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { PreferenceValidationError } from '../../flows/preferences.js';
import type { Preferences } from '../../flows/preferences.js';
import { usePreferences } from '../appContext.js';
import { MobileErrorNote, MobileHeader, mobilePalette, styles as base } from '../Primitives.js';
import { walletBack } from './host.js';
import type { WalletHost } from './host.js';
import { WALLET_ROUTE_TITLES } from './routes.js';
import type { WalletRoute } from './routes.js';

/** Header with a back control for pushed Wallet screens. */
export function SubHeader({ host, route, subtitle }: { host: WalletHost; route: WalletRoute; subtitle?: string }): ReactNode {
  return <MobileHeader title={WALLET_ROUTE_TITLES[route]} subtitle={subtitle} onBack={() => walletBack(host)} />;
}

/** Where settings are kept, and any problem reading or writing them. */
export function PreferencesStatus(): ReactNode {
  const { persistence, writeError, loadIssues } = usePreferences();
  const where =
    persistence === 'native'
      ? 'Settings are saved on this device.'
      : persistence === 'web'
        ? 'Settings are saved in this browser (preview).'
        : 'Settings last for this session only: this build has no settings storage yet, so they reset when the app restarts.';
  return (
    <View style={{ gap: 6 }}>
      <Text style={base.faint}>{where}</Text>
      {writeError !== null && (
        <MobileErrorNote error={`Your last change applies now but was not saved: ${writeError}`} />
      )}
      {loadIssues.map((issue) => (
        <Text key={issue} style={[base.faint, { color: mobilePalette.danger }]} accessibilityRole="alert">
          {issue}
        </Text>
      ))}
    </View>
  );
}

/** Applies a patch; validation errors come back as text instead of throwing. */
export function useSetPreference(): {
  readonly preferences: Preferences;
  readonly error: string | null;
  set(patch: Partial<Preferences>): void;
} {
  const { preferences, store } = usePreferences();
  const [error, setError] = useState<string | null>(null);
  return {
    preferences,
    error,
    set(patch) {
      setError(null);
      store.set(patch).catch((e: unknown) => {
        setError(e instanceof PreferenceValidationError || e instanceof Error ? e.message : String(e));
      });
    },
  };
}

/** Capability rows shown under Wallet management. */
export const WALLET_SUMMARY_FEATURES = {
  wavelength: [
    { id: 'lightningSend', label: 'Lightning payments' },
    { id: 'onchainSend', label: 'On-chain payments' },
    { id: 'activity', label: 'Payment history' },
    { id: 'sendFeeQuote', label: 'Fee shown before paying' },
    { id: 'exitInformation', label: 'Exit information' },
    { id: 'channelSummary', label: 'Channels' },
    { id: 'loopSwaps', label: 'Loop swaps' },
    { id: 'taprootAssets', label: 'Taproot Assets' },
    { id: 'qrScan', label: 'QR scanning' },
    { id: 'appLock', label: 'App PIN' },
    { id: 'biometricUnlock', label: 'Biometric unlock' },
  ],
  'remote-lnd': [
    { id: 'lightningSend', label: 'Lightning payments' },
    { id: 'onchainSend', label: 'On-chain payments' },
    { id: 'activity', label: 'Payment history' },
    { id: 'channelSummary', label: 'Channels' },
    { id: 'sendFeeQuote', label: 'Fee shown before paying' },
    { id: 'loopSwaps', label: 'Loop swaps' },
    { id: 'taprootAssets', label: 'Taproot Assets' },
    { id: 'sessionList', label: 'Session list' },
    { id: 'qrScan', label: 'QR scanning' },
    { id: 'appLock', label: 'App PIN' },
    { id: 'biometricUnlock', label: 'Biometric unlock' },
  ],
} as const;

