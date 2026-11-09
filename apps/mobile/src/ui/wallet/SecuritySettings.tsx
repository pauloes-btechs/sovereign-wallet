/**
 * Security and recovery: app PIN (set / change / turn off), biometric
 * unlock, auto-lock timeout, lock now, sensitive-data notes, screen-capture
 * protection, and the backup screen (status, check a written copy,
 * recovery instructions per wallet type).
 *
 * Nothing here shows a recovery phrase or key. The everyday wallet does not
 * keep its phrase in a form the app can show, and a connected node's seed
 * never leaves the node — so there is no reveal flow to protect.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { describeSecureStorage, pinFormatProblem } from '../../flows/appLock.js';
import type { AppLock, AppLockSnapshot, PinResult } from '../../flows/appLock.js';
import { LOCK_TIMEOUT_CHOICES } from '../../flows/preferences.js';
import type { LockTimeoutSeconds } from '../../flows/preferences.js';
import { usePlatformServices } from '../appContext.js';
import {
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileField,
  MobileScreen,
  MobileWarningBand,
  mobilePalette,
  styles as base,
} from '../Primitives.js';
import { Sheet } from '../Sheet.js';
import { walletCapabilities, walletNavigate } from './host.js';
import type { WalletHost } from './host.js';
import { ChoiceList, PinField, SettingLinkRow, SettingRow, SettingsSection, ToggleRow } from './kit.js';
import { PreferencesStatus, SubHeader, useSetPreference } from './common.js';
import { useAppLockSnapshot, useBackupSnapshot, useWalletSecurityServices } from './WalletSecurity.js';

const LOCK_TIMEOUT_LABELS: Readonly<Record<LockTimeoutSeconds, string>> = {
  0: 'Immediately',
  60: 'After 1 minute',
  300: 'After 5 minutes',
  900: 'After 15 minutes',
  3600: 'After 1 hour',
};

function utcDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const text = new Date(ms).toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

type PinSheetMode = 'set' | 'change' | 'remove' | 'biometric' | null;

export function SecurityScreen({ host }: { host: WalletHost }): ReactNode {
  const security = useWalletSecurityServices();
  const lock = useAppLockSnapshot(security.lock);
  const backup = useBackupSnapshot(security.backup);
  const caps = walletCapabilities(host);
  const platform = usePlatformServices();
  const { preferences, error, set } = useSetPreference();
  const [sheet, setSheet] = useState<PinSheetMode>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [biometricError, setBiometricError] = useState<string | null>(null);

  const appLock = caps.features.appLock;
  const biometric = caps.features.biometricUnlock;
  const capture = caps.features.screenCaptureProtection;
  const biometricBlocker = !biometric.available
    ? biometric.reason
    : !lock.pinSet
      ? 'Set a PIN first; biometric unlock is a shortcut to it.'
      : null;

  return (
    <MobileScreen>
      <SubHeader host={host} route="walletSecurity" />

      <SettingsSection title="App lock">
        {appLock.available ? (
          <SettingRow
            label="App PIN"
            badge={lock.pinSet ? { label: 'On', tone: 'positive' } : { label: 'Off', tone: 'neutral' }}
            description={
              lock.pinSet
                ? 'The app opens locked and asks for your PIN. Balances stay hidden until it is entered.'
                : 'Lock the app with a 6 to 12 digit PIN. It is stored only as a salted, slow hash.'
            }
          >
            <Text style={base.faint}>{describeSecureStorage(lock.protection)}</Text>
            {lock.pinSet ? (
              <MobileButtonGroup row>
                <MobileButton label="Change PIN" kind="secondary" compact onPress={() => setSheet('change')} />
                <MobileButton label="Turn off PIN" kind="ghost" compact onPress={() => setSheet('remove')} />
              </MobileButtonGroup>
            ) : (
              <MobileButton label="Set up PIN" compact onPress={() => setSheet('set')} />
            )}
          </SettingRow>
        ) : (
          <SettingRow label="App PIN" value="Not available" description={appLock.reason} />
        )}
        <ToggleRow
          label="Biometric unlock"
          description="Unlock with Face ID, Touch ID or your fingerprint. Your PIN always works too."
          value={lock.biometricEnabled}
          busy={lock.busy}
          disabledReason={biometricBlocker}
          onChange={(next) => {
            setBiometricError(null);
            // Turning it on asks for the PIN first (in the sheet); turning it off doesn't.
            if (next) {
              setSheet('biometric');
              return;
            }
            void security.lock.setBiometricEnabled(false).then((result) => {
              if (!result.ok) setBiometricError(result.message);
            });
          }}
        />
        <SettingRow
          label="Auto-lock"
          description={
            lock.pinSet
              ? 'Lock the app after it has been in the background this long.'
              : 'Applies once a PIN is set.'
          }
        >
          <ChoiceList
            label="Auto-lock"
            options={LOCK_TIMEOUT_CHOICES.map((value) => ({ value, label: LOCK_TIMEOUT_LABELS[value] }))}
            selected={preferences.lockTimeoutSeconds}
            onSelect={(lockTimeoutSeconds) => set({ lockTimeoutSeconds })}
            disabledReason={lock.pinSet ? null : 'Set a PIN to use auto-lock.'}
          />
        </SettingRow>
        {lock.pinSet && (
          <SettingRow label="Lock now" description="Covers the app until the PIN is entered.">
            <MobileButton label="Lock now" kind="secondary" compact onPress={() => security.lock.lockNow()} />
          </SettingRow>
        )}
      </SettingsSection>
      <MobileErrorNote error={biometricError ?? error ?? lock.error} />
      {notice !== null && (
        <Text style={[base.dim, { color: mobilePalette.positive }]} accessibilityRole="alert">
          {notice}
        </Text>
      )}
      {lock.protection === 'browser-preview' && appLock.available && (
        <MobileWarningBand tone="warning">
          Preview only: the PIN hash is kept in browser storage, which is not secure. On iOS and
          Android it lives in the Keychain or Keystore.
        </MobileWarningBand>
      )}

      <SettingsSection title="Backup and recovery">
        <SettingLinkRow
          label="Backup"
          value={
            host.kind === 'remote-lnd'
              ? 'On your node'
              : backup.status === 'recorded'
                ? backup.record.kind === 'restored'
                  ? 'Restored here'
                  : 'Verified'
                : backup.status === 'none'
                  ? 'Not recorded'
                  : backup.status === 'loading'
                    ? 'Checking'
                    : 'Unreadable'
          }
          description="Backup status, check your written phrase, how to recover"
          onPress={() => walletNavigate(host, 'walletBackup')}
        />
        <SettingRow
          label="Recovery phrase and keys"
          description={
            host.kind === 'wavelength'
              ? "The app never shows your recovery phrase after setup — the wallet doesn't keep it in a form the app can show. Keep the copy you wrote down when you created the wallet."
              : "Your node's seed and channel backups stay on your node. This app does not store your pairing phrase."
          }
        />
        {host.kind === 'remote-lnd' && (
          <SettingLinkRow
            label="Connected sessions"
            description="See and revoke this node's connection sessions"
            onPress={() => walletNavigate(host, 'walletNetwork')}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Sensitive data">
        <SettingRow
          label="Clipboard"
          description="Addresses and invoices you copy stay on the clipboard until you copy something else, and other apps can read it. The app does not clear it for you. Always check what you paste before paying."
        />
        <ToggleRow
          label="Hide from screenshots and app switcher"
          description="Blanks the app in screenshots, screen recordings and the recent-apps view."
          value={capture.available && preferences.screenCaptureProtection}
          disabledReason={capture.available ? null : capture.reason}
          onChange={(screenCaptureProtection) => set({ screenCaptureProtection })}
        />
      </SettingsSection>

      <SettingsSection title="Quantum exposure">
        {host.kind === 'wavelength' ? (
          <SettingRow
            label="Quantum exposure"
            value="Exposed"
            description="Your Ark funds (VTXOs) are taproot outputs, so their public keys are not hidden behind a hash. A future quantum computer could target keys like these first. Nothing on Bitcoin today is quantum-safe, and there is no post-quantum output type to move to yet."
          />
        ) : (
          <SettingRow
            label="Quantum exposure"
            value="See the desktop app"
            description="Which of your node's coins and channels have a public key visible on the blockchain needs the node's coin list, which this connection does not read. The desktop app shows it under Account, Quantum exposure."
          />
        )}
      </SettingsSection>
      <PreferencesStatus />

      <PinSheet
        mode={sheet}
        lock={security.lock}
        snapshot={lock}
        bottomInset={platform.bottomInset}
        onClose={() => setSheet(null)}
        onDone={(message) => {
          setSheet(null);
          setNotice(message);
        }}
      />
    </MobileScreen>
  );
}

const SHEET_TITLES: Record<Exclude<PinSheetMode, null>, string> = {
  set: 'Set up PIN',
  change: 'Change PIN',
  remove: 'Turn off PIN',
  biometric: 'Turn on biometric unlock',
};

/** One sheet for set / change / remove, each asking only for what it needs. */
function PinSheet({
  mode,
  lock,
  snapshot,
  bottomInset,
  onClose,
  onDone,
}: {
  mode: PinSheetMode;
  lock: AppLock;
  snapshot: AppLockSnapshot;
  bottomInset?: number;
  onClose: () => void;
  onDone: (message: string) => void;
}): ReactNode {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = (): void => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    onClose();
  };

  const finish = (result: PinResult, message: string): void => {
    if (result.ok) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
      onDone(message);
    } else {
      setError(result.message);
      setCurrent('');
    }
  };

  const submit = (): void => {
    if (mode === null) return;
    if (mode === 'biometric') {
      void lock.setBiometricEnabled(true, current).then((r) => finish(r, 'Biometric unlock is on. Your PIN still works too.'));
      return;
    }
    if (mode !== 'remove') {
      const problem = pinFormatProblem(next);
      if (problem !== null) {
        setError(problem);
        return;
      }
      if (next !== confirm) {
        setError("The two new PINs don't match.");
        return;
      }
    }
    if (mode === 'set') void lock.setPin(next).then((r) => finish(r, 'PIN set. The app now opens locked.'));
    if (mode === 'change') void lock.changePin(current, next).then((r) => finish(r, 'PIN changed.'));
    if (mode === 'remove') void lock.removePin(current).then((r) => finish(r, 'PIN turned off. Biometric unlock is off too.'));
  };

  const action =
    mode === null
      ? ''
      : mode === 'set'
        ? 'Set PIN'
        : mode === 'change'
          ? 'Change PIN'
          : mode === 'biometric'
            ? 'Continue'
            : 'Turn off PIN';
  return (
    <Sheet
      open={mode !== null}
      title={mode === null ? 'PIN settings' : SHEET_TITLES[mode]}
      onClose={close}
      bottomInset={bottomInset}
      dismissable={!snapshot.busy}
      footer={
        <MobileButtonGroup>
          <MobileButton label={action} onPress={submit} busy={snapshot.busy} />
          <MobileButton label="Cancel" kind="secondary" onPress={close} disabled={snapshot.busy} />
        </MobileButtonGroup>
      }
    >
      {mode === 'remove' && (
        <Text style={base.dim}>
          Without a PIN, anyone holding your unlocked phone can open the wallet and see your balances.
        </Text>
      )}
      {mode === 'biometric' && (
        <Text style={base.dim}>
          Enter your PIN, then confirm with your fingerprint or face. If the phone&apos;s biometrics
          change later, biometric unlock turns itself off and the app asks for your PIN.
        </Text>
      )}
      {mode !== 'set' && (
        <PinField
          label="Current PIN"
          value={current}
          onChangeText={setCurrent}
          onSubmit={mode === 'biometric' ? submit : undefined}
          autoFocus
        />
      )}
      {mode !== 'remove' && mode !== 'biometric' && (
        <>
          <PinField label="New PIN" value={next} onChangeText={setNext} autoFocus={mode === 'set'} />
          <PinField label="Confirm new PIN" value={confirm} onChangeText={setConfirm} onSubmit={submit} />
          <Text style={base.faint}>
            6 to 12 digits. Avoid repeated digits and straight runs like 123456. After 5 wrong tries,
            each wrong PIN adds a wait; nothing is erased.
          </Text>
        </>
      )}
      <MobileErrorNote error={error} />
    </Sheet>
  );
}

// ——— Backup ———

export function BackupScreen({ host }: { host: WalletHost }): ReactNode {
  const caps = walletCapabilities(host);
  if (host.kind === 'remote-lnd') {
    return (
      <MobileScreen>
        <SubHeader host={host} route="walletBackup" />
        <SettingsSection title="Your node's backups">
          <SettingRow
            label="Backup check"
            value="On your node"
            description={caps.features.backupVerification.available ? undefined : caps.features.backupVerification.reason}
          />
          <SettingRow
            label="What to keep safe"
            description="Your node's 24-word seed (aezeed) and its static channel backup file (channel.backup). Together they recover on-chain funds and let channel peers close channels back to you."
          />
          <SettingRow
            label="How to recover"
            description="Restore the seed on a new node, then load the channel backup. Use the desktop app or your node's own tools; this phone holds no keys to recover."
          />
        </SettingsSection>
      </MobileScreen>
    );
  }
  return <EverydayBackup host={host} />;
}

function EverydayBackup({ host }: { host: WalletHost }): ReactNode {
  const security = useWalletSecurityServices();
  const backup = useBackupSnapshot(security.backup);
  const caps = walletCapabilities(host);
  const [phrase, setPhrase] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<'match' | 'mismatch' | null>(null);

  const check = (): void => {
    setChecking(true);
    setResult(null);
    void security.backup.check(phrase).then((matches) => {
      setChecking(false);
      setPhrase('');
      setResult(matches === true ? 'match' : 'mismatch');
    });
  };

  return (
    <MobileScreen>
      <SubHeader host={host} route="walletBackup" />
      <SettingsSection title="Status on this device" footnote={describeSecureStorage(security.backup.protection)}>
        {backup.status === 'recorded' ? (
          <>
            <SettingRow
              label={backup.record.kind === 'restored' ? 'Restored from the phrase' : 'Every word verified'}
              badge={{ label: 'Recorded', tone: 'positive' }}
              description={
                backup.record.kind === 'restored'
                  ? `This wallet was restored from its recovery phrase on this device (${utcDate(backup.record.at)}).`
                  : `You re-entered every word when the wallet was created (${utcDate(backup.record.at)}).`
              }
            />
            <SettingRow
              label="Last check of your written copy"
              value={backup.record.lastCheckedAt === null ? 'Never' : utcDate(backup.record.lastCheckedAt)}
            />
          </>
        ) : backup.status === 'none' ? (
          <SettingRow
            label="No backup recorded"
            badge={{ label: 'Unknown', tone: 'warning' }}
            description="This device has no record that the phrase was verified — for example, the wallet was set up before this version, or on a build without secure storage. The app cannot show the words again, so make sure your written copy is complete."
          />
        ) : backup.status === 'error' ? (
          <SettingRow label="Backup record" badge={{ label: 'Unreadable', tone: 'danger' }} description={backup.error} />
        ) : (
          <SettingRow label="Backup record" value="Checking…" />
        )}
      </SettingsSection>

      {backup.status === 'recorded' && (
        <SettingsSection
          title="Check your written copy"
          footnote="The phrase is compared on this device with a one-way fingerprint saved at setup, then cleared. It is never saved or sent."
        >
          <View style={{ padding: 16, gap: 12 }}>
            <MobileField
              label="Recovery phrase"
              value={phrase}
              onChangeText={(text) => {
                setPhrase(text);
                setResult(null);
              }}
              placeholder="12 or 24 words, separated by spaces"
              multiline
            />
            <MobileButton
              label="Check phrase"
              onPress={check}
              busy={checking}
              disabled={phrase.trim().split(/\s+/).length < 12}
            />
            {result === 'match' && (
              <Text style={[base.dim, { color: mobilePalette.positive }]} accessibilityRole="alert">
                That matches. Your written copy can restore this wallet.
              </Text>
            )}
            {result === 'mismatch' && (
              <MobileErrorNote error="That doesn't match this wallet. Check each word and the order; a phrase from another wallet won't match." />
            )}
          </View>
        </SettingsSection>
      )}

      <SettingsSection title="How to recover this wallet">
        <SettingRow
          label="On a new phone"
          description="Install Sovereign Wallet, choose Restore, enter the 12 or 24 words in order, and set a new password."
        />
        <SettingRow
          label="Restore deadline"
          description={
            caps.features.restoreWallet.available
              ? (caps.features.restoreWallet.note ?? 'Restore promptly.')
              : caps.features.restoreWallet.reason
          }
        />
        <SettingRow
          label="If the deadline passes"
          description="Funds are not lost: they leave the Ark through a slower unilateral exit to an on-chain address. See How this wallet works."
        />
        <SettingRow
          label="Only this wallet type"
          description="This phrase restores an everyday (Wavelength) wallet. Phrases from other wallet apps and node seeds are refused, never partly restored."
        />
      </SettingsSection>
    </MobileScreen>
  );
}
