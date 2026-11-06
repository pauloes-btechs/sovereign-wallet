/**
 * Wallet tab — the settings center. One router for both wallet types; each
 * screen reads live controller state, `walletCapabilities()`, the
 * preferences store and the app lock, and branches on the wallet kind where
 * the two differ. No setting is shown as working unless something reads it:
 * a setting the active wallet ignores is shown disabled with the reason.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { MobileWalletCapabilities } from '../../flows/capabilities.js';
import {
  PREFERENCE_BOUNDS,
  PreferenceValidationError,
  lightningFeeCapSat,
} from '../../flows/preferences.js';
import type { Preferences } from '../../flows/preferences.js';
import { usePlatformServices, usePreferences } from '../appContext.js';
import { formatSatsNumber } from '../format.js';
import {
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileHeader,
  MobileScreen,
  MobileWarningBand,
  styles as base,
} from '../Primitives.js';
import { Sheet } from '../Sheet.js';
import {
  connectionSummary,
  defaultWalletName,
  walletCapabilities,
  walletNavigate,
} from './host.js';
import type { WalletHost } from './host.js';
import {
  AppliesNote,
  ChoiceList,
  SettingInput,
  SettingLinkRow,
  SettingRow,
  SettingsSection,
  ToggleRow,
} from './kit.js';
import { WALLET_ROUTE_TITLES } from './routes.js';
import { PreferencesStatus, SubHeader, useSetPreference } from './common.js';
import type { WalletRoute } from './routes.js';
import { BackupScreen, SecurityScreen } from './SecuritySettings.js';
import { useAppLockSnapshot, useBackupSnapshot, useWalletSecurityServices } from './WalletSecurity.js';
import { NetworkScreen, PrivacyScreen, WalletManagementScreen } from './ConnectionSettings.js';

/** Renders the Wallet tab screen for `route`. */
export function WalletRouter({ host, route }: { host: WalletHost; route: WalletRoute }): ReactNode {
  switch (route) {
    case 'wallet':
      return <WalletRootScreen host={host} />;
    case 'walletGeneral':
      return <GeneralScreen host={host} />;
    case 'walletPayments':
      return <PaymentPreferencesScreen host={host} />;
    case 'walletSecurity':
      return <SecurityScreen host={host} />;
    case 'walletBackup':
      return <BackupScreen host={host} />;
    case 'walletPrivacy':
      return <PrivacyScreen host={host} />;
    case 'walletNetwork':
      return <NetworkScreen host={host} />;
    case 'walletManage':
      return <WalletManagementScreen host={host} />;
  }
}

// ——— root ———

function WalletRootScreen({ host }: { host: WalletHost }): ReactNode {
  const { preferences } = usePreferences();
  const security = useWalletSecurityServices();
  const lock = useAppLockSnapshot(security.lock);
  const backup = useBackupSnapshot(security.backup);
  const caps = walletCapabilities(host);
  const name = preferences.walletNames[host.kind] ?? defaultWalletName(host);
  const connection = connectionSummary(host);
  const lockLabel = !caps.features.appLock.available
    ? 'Not available'
    : lock.pinSet
      ? lock.biometricEnabled
        ? 'PIN and biometrics'
        : 'PIN on'
      : 'Off';

  return (
    <MobileScreen>
      <MobileHeader title="Wallet" subtitle={`${name} · ${host.network}`} />

      <SettingsSection>
        <SettingRow
          label={host.kind === 'wavelength' ? 'Everyday wallet' : 'Your node'}
          value={host.kind === 'wavelength' ? 'Wavelength (Ark)' : 'LND over LNC'}
          description={
            host.kind === 'wavelength'
              ? 'Keys live on this phone. Lightning works through a swap service.'
              : 'Keys and funds live on your own node. This phone is a remote control.'
          }
        />
        <SettingRow label="Status" badge={{ label: connection.label, tone: connection.tone }} />
        <SettingRow label="App lock" value={lockLabel} />
      </SettingsSection>

      {host.kind === 'wavelength' && backup.status === 'none' && (
        <MobileWarningBand tone="warning">
          <Text style={base.bandText}>No backup recorded on this device</Text>
          <Text style={base.dim}>
            This device has no record that the recovery phrase was checked. Make sure you have it
            written down.
          </Text>
          <MobileButton label="Backup status" kind="secondary" compact onPress={() => walletNavigate(host, 'walletBackup')} />
        </MobileWarningBand>
      )}
      {caps.features.appLock.available && !lock.pinSet && (
        <MobileWarningBand tone="info">
          <Text style={base.bandText}>Set an app PIN</Text>
          <Text style={base.dim}>A PIN keeps your balances and payments behind a lock when someone else holds your phone.</Text>
          <MobileButton label="Set up app lock" kind="secondary" compact onPress={() => walletNavigate(host, 'walletSecurity')} />
        </MobileWarningBand>
      )}

      <SettingsSection title="Money">
        <SettingLinkRow
          label="Transfers & swaps"
          description={
            host.kind === 'wavelength'
              ? 'Move funds between your balances and outside wallets'
              : 'Loop in and out, and move funds between Lightning and on-chain'
          }
          onPress={() => walletNavigate(host, 'transfers')}
        />
        <SettingLinkRow
          label="Liquidity"
          description="What you can send and receive right now"
          onPress={() => walletNavigate(host, 'liquidity')}
        />
        <SettingLinkRow
          label="Assets"
          description={caps.features.taprootAssets.available ? 'Taproot Assets on this wallet' : 'Taproot Assets support for this wallet'}
          onPress={() => walletNavigate(host, 'assets')}
        />
      </SettingsSection>

      <SettingsSection title="Settings">
        <SettingLinkRow
          label={WALLET_ROUTE_TITLES.walletGeneral}
          description="Units, privacy mode, appearance, language"
          onPress={() => walletNavigate(host, 'walletGeneral')}
        />
        <SettingLinkRow
          label={WALLET_ROUTE_TITLES.walletPayments}
          description="Fee limits, invoice expiry, payment timeout"
          onPress={() => walletNavigate(host, 'walletPayments')}
        />
        <SettingLinkRow
          label={WALLET_ROUTE_TITLES.walletSecurity}
          description="App PIN, biometrics, auto-lock, backup"
          onPress={() => walletNavigate(host, 'walletSecurity')}
        />
        <SettingLinkRow
          label={WALLET_ROUTE_TITLES.walletPrivacy}
          description="Services this wallet talks to, screen privacy"
          onPress={() => walletNavigate(host, 'walletPrivacy')}
        />
        <SettingLinkRow
          label={WALLET_ROUTE_TITLES.walletNetwork}
          description={host.kind === 'wavelength' ? 'Network, Ark operator, sync' : 'Network, node, sessions, reconnect'}
          onPress={() => walletNavigate(host, 'walletNetwork')}
        />
        <SettingLinkRow
          label={WALLET_ROUTE_TITLES.walletManage}
          description="Name, wallet type and what it can do"
          onPress={() => walletNavigate(host, 'walletManage')}
        />
        {host.kind === 'wavelength' && (
          <SettingLinkRow
            label="How this wallet works"
            description="Lightning mechanism, exits, recovery and service dependencies"
            onPress={() => walletNavigate(host, 'capabilities')}
          />
        )}
      </SettingsSection>
      <PreferencesStatus />
    </MobileScreen>
  );
}

// ——— General ———

const DENOMINATION_OPTIONS = [
  { value: 'sats' as const, label: 'Sats', detail: '21,000 sats' },
  { value: 'btc' as const, label: 'BTC', detail: '0.00021 BTC' },
];

export function DenominationChoice(): ReactNode {
  const { preferences, error, set } = useSetPreference();
  return (
    <View style={{ gap: 6 }}>
      <ChoiceList
        label="Display unit"
        options={DENOMINATION_OPTIONS}
        selected={preferences.denomination}
        onSelect={(denomination) => set({ denomination })}
      />
      <MobileErrorNote error={error} />
    </View>
  );
}

function GeneralScreen({ host }: { host: WalletHost }): ReactNode {
  const { preferences, error, set } = useSetPreference();
  const { store } = usePreferences();
  const platform = usePlatformServices();
  const caps = walletCapabilities(host);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <MobileScreen>
      <SubHeader host={host} route="walletGeneral" />
      <SettingsSection
        title="Display unit"
        footnote="Every balance and amount on every tab uses this unit. Amount fields say which unit they expect."
      >
        <View style={{ padding: 12 }}>
          <DenominationChoice />
        </View>
      </SettingsSection>

      <SettingsSection title="Privacy mode">
        <ToggleRow
          label="Hide balances"
          description="Shows •••••• instead of amounts on every screen, and screen readers say “Amount hidden”."
          value={preferences.hideBalances}
          onChange={(hideBalances) => set({ hideBalances })}
        />
      </SettingsSection>

      <SettingsSection title="Feedback and appearance">
        <ToggleRow
          label="Haptic feedback"
          description="A short vibration when a payment is confirmed."
          value={caps.features.haptics.available && preferences.haptics}
          onChange={(haptics) => set({ haptics })}
          disabledReason={caps.features.haptics.available ? null : caps.features.haptics.reason}
        />
        <SettingRow
          label="Appearance"
          value="Dark"
          description={
            preferences.theme === 'system'
              ? 'Your saved choice is to follow the system, but the app is dark-only for now: a light appearance is not built yet.'
              : 'The app is dark-only for now; a light or system-matched appearance is not built yet.'
          }
        />
        <SettingRow
          label="Fiat reference value"
          value="Not available"
          description={caps.features.fiatReference.available ? undefined : caps.features.fiatReference.reason}
        />
        <SettingRow label="Language" value="English" description="Only English is available in this version." />
        <SettingRow
          label="Notifications"
          value="Not available"
          description="This build has no notification module. Payment status shows in the app while it is open."
        />
      </SettingsSection>

      <SettingsSection title="Accessibility">
        <SettingRow
          label="Text size"
          description="Text follows your device's text size setting."
        />
        <SettingRow
          label="Screen readers"
          description="Every control has a spoken label, and statuses are written out rather than shown by color alone. Hidden amounts are announced as “Amount hidden”."
        />
      </SettingsSection>

      <MobileErrorNote error={error} />
      <MobileButton label="Reset all settings" kind="ghost" onPress={() => setConfirmReset(true)} />
      <PreferencesStatus />

      <Sheet
        open={confirmReset}
        title="Reset all settings?"
        onClose={() => setConfirmReset(false)}
        bottomInset={platform.bottomInset}
        footer={
          <MobileButtonGroup>
            <MobileButton
              label="Reset settings"
              onPress={() => {
                setConfirmReset(false);
                void store.reset();
              }}
            />
            <MobileButton label="Cancel" kind="secondary" onPress={() => setConfirmReset(false)} />
          </MobileButtonGroup>
        }
      >
        <Text style={base.dim}>
          Units, privacy mode, payment preferences, lock timeout and wallet names go back to their
          defaults. Your wallet, funds, app PIN and backup record are not touched.
        </Text>
      </Sheet>
    </MobileScreen>
  );
}

// ——— Payment preferences ———

const EXPIRY_OPTIONS = [
  { value: 600, label: '10 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 86_400, label: '24 hours' },
  { value: 604_800, label: '7 days' },
];

const TIMEOUT_OPTIONS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
];

const FEE_PREFERENCE_OPTIONS = [
  { value: 'economy' as const, label: 'Economy', detail: 'Cheaper, may take longer to confirm' },
  { value: 'normal' as const, label: 'Normal', detail: 'Balanced fee and speed' },
  { value: 'priority' as const, label: 'Priority', detail: 'Higher fee, next blocks' },
];

function withCustom<T extends number>(
  options: ReadonlyArray<{ value: T; label: string }>,
  current: T,
  describe: (value: T) => string,
): ReadonlyArray<{ value: T; label: string }> {
  return options.some((o) => o.value === current) ? options : [...options, { value: current, label: `${describe(current)} (custom)` }];
}

function describeSeconds(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

/** ppm → "0.5%". */
export function ppmToPercent(ppm: number): string {
  return `${(ppm / 10_000).toFixed(4).replace(/\.?0+$/, '')}%`;
}

/** "0.5" (percent) → 5000 ppm; null when not a number with at most 4 decimals. */
export function percentToPpm(text: string): number | null {
  const trimmed = text.trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 10_000);
}

function PaymentPreferencesScreen({ host }: { host: WalletHost }): ReactNode {
  const { preferences, error, set } = useSetPreference();
  const caps = walletCapabilities(host);
  const [editingFee, setEditingFee] = useState(false);
  const platform = usePlatformServices();
  const exampleCap = lightningFeeCapSat(preferences, 100_000n);
  const feeLimit = caps.features.lightningFeeLimit;

  return (
    <MobileScreen>
      <SubHeader
        host={host}
        route="walletPayments"
        subtitle={`What ${host.kind === 'wavelength' ? 'your everyday wallet' : 'this connection to your node'} actually uses is marked on each setting.`}
      />

      <SettingsSection title="Maximum Lightning fee">
        <SettingRow
          label="Maximum Lightning fee"
          value={`${ppmToPercent(preferences.maxLightningFeePpm)}, at least ${formatSatsNumber(BigInt(preferences.maxLightningFeeSat))} sats`}
          description="The most you're willing to pay to complete a Lightning payment. The limit is the larger of the percentage and the minimum in sats, so small payments can still go through."
        >
          <Text style={base.faint}>
            Example: for a 100,000 sat payment the fee can be at most {formatSatsNumber(exampleCap)} sats.
          </Text>
          <AppliesNote status={feeLimit} />
          <MobileButton
            label="Change maximum fee"
            kind="secondary"
            compact
            disabled={!feeLimit.available}
            onPress={() => setEditingFee(true)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Payment timeout">
        <SettingRow
          label="Payment timeout"
          description="How long a payment may keep trying before the app reports it as not finished yet. A payment that runs out of time is checked, never sent twice."
        >
          <ChoiceList
            label="Payment timeout"
            options={withCustom(TIMEOUT_OPTIONS, preferences.paymentTimeoutSeconds, describeSeconds)}
            selected={preferences.paymentTimeoutSeconds}
            onSelect={(paymentTimeoutSeconds) => set({ paymentTimeoutSeconds })}
            disabledReason={caps.features.paymentTimeout.available ? null : caps.features.paymentTimeout.reason}
          />
          {caps.features.paymentTimeout.available && <AppliesNote status={caps.features.paymentTimeout} />}
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Invoices">
        <SettingRow
          label="Invoice expiry"
          description="How long a Lightning invoice you create can be paid before it expires."
        >
          <ChoiceList
            label="Invoice expiry"
            options={withCustom(EXPIRY_OPTIONS, preferences.invoiceExpirySeconds, describeSeconds)}
            selected={preferences.invoiceExpirySeconds}
            onSelect={(invoiceExpirySeconds) => set({ invoiceExpirySeconds })}
            disabledReason={caps.features.invoiceExpiry.available ? null : caps.features.invoiceExpiry.reason}
          />
          {caps.features.invoiceExpiry.available && <AppliesNote status={caps.features.invoiceExpiry} />}
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="On-chain">
        <SettingRow
          label="On-chain fee preference"
          description="How fast you want on-chain payments to confirm, and so how much fee to pay."
        >
          <ChoiceList
            label="On-chain fee preference"
            options={FEE_PREFERENCE_OPTIONS}
            selected={preferences.onchainFeePreference}
            onSelect={(onchainFeePreference) => set({ onchainFeePreference })}
            disabledReason={
              caps.features.onchainFeePreference.available ? null : caps.features.onchainFeePreference.reason
            }
          />
          {caps.features.onchainFeePreference.available && <AppliesNote status={caps.features.onchainFeePreference} />}
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Before you pay">
        <SettingRow
          label="Fee shown before you confirm"
          badge={caps.features.sendFeeQuote.available ? { label: 'Yes', tone: 'positive' } : { label: 'No', tone: 'neutral' }}
          description={
            caps.features.sendFeeQuote.available
              ? (caps.features.sendFeeQuote.note ?? 'Each payment is quoted before you confirm.')
              : caps.features.sendFeeQuote.reason
          }
        />
        <SettingRow
          label="Payment labels"
          value="Not available"
          description="This version does not save your own labels on payments."
        />
      </SettingsSection>

      <SettingsSection title="Display unit">
        <View style={{ padding: 12 }}>
          <DenominationChoice />
        </View>
      </SettingsSection>

      <MobileErrorNote error={error} />
      <PreferencesStatus />

      <FeeLimitSheet
        open={editingFee}
        preferences={preferences}
        caps={caps}
        bottomInset={platform.bottomInset}
        onClose={() => setEditingFee(false)}
      />
    </MobileScreen>
  );
}

function FeeLimitSheet({
  open,
  preferences,
  caps,
  bottomInset,
  onClose,
}: {
  open: boolean;
  preferences: Preferences;
  caps: MobileWalletCapabilities;
  bottomInset?: number;
  onClose: () => void;
}): ReactNode {
  const { store } = usePreferences();
  const [percent, setPercent] = useState(() => ppmToPercent(preferences.maxLightningFeePpm).replace('%', ''));
  const [floor, setFloor] = useState(() => String(preferences.maxLightningFeeSat));
  const [error, setError] = useState<string | null>(null);
  const ppmBounds = PREFERENCE_BOUNDS.maxLightningFeePpm;
  const satBounds = PREFERENCE_BOUNDS.maxLightningFeeSat;

  const save = (): void => {
    const ppm = percentToPpm(percent);
    if (ppm === null) {
      setError('Enter the percentage as a number, for example 0.5.');
      return;
    }
    if (!/^\d+$/.test(floor.trim())) {
      setError('Enter the minimum as a whole number of sats.');
      return;
    }
    store
      .set({ maxLightningFeePpm: ppm, maxLightningFeeSat: Number(floor.trim()) })
      .then(() => {
        setError(null);
        onClose();
      })
      .catch((e: unknown) => {
        setError(
          e instanceof PreferenceValidationError && e.key === 'maxLightningFeePpm'
            ? `The percentage must be from ${ppmToPercent(ppmBounds.min)} to ${ppmToPercent(ppmBounds.max)}.`
            : e instanceof Error
              ? e.message
              : String(e),
        );
      });
  };

  return (
    <Sheet
      open={open}
      title="Maximum Lightning fee"
      onClose={onClose}
      bottomInset={bottomInset}
      footer={
        <MobileButtonGroup>
          <MobileButton label="Save fee limit" onPress={save} />
          <MobileButton label="Cancel" kind="secondary" onPress={onClose} />
        </MobileButtonGroup>
      }
    >
      <SettingInput
        label="Percentage of the amount"
        value={percent}
        onChangeText={setPercent}
        hint={`From ${ppmToPercent(ppmBounds.min)} to ${ppmToPercent(ppmBounds.max)}.`}
      />
      <SettingInput
        label="Minimum limit (sats)"
        value={floor}
        onChangeText={setFloor}
        numeric
        hint={`From ${satBounds.min} to ${formatSatsNumber(BigInt(satBounds.max))} sats. Lets small payments through when the percentage would round to almost nothing.`}
      />
      <MobileErrorNote error={error} />
      {!caps.features.lightningFeeLimit.available && (
        <Text style={base.faint}>{caps.features.lightningFeeLimit.reason}</Text>
      )}
    </Sheet>
  );
}

