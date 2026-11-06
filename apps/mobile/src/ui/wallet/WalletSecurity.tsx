/**
 * App-lock wiring for both wallet roots: one `AppLock` and one
 * `BackupRecordStore` per mounted app, the lock-screen overlay, automatic
 * locking on background/foreground, and screen-capture protection.
 *
 * The overlay covers everything (tab bar included). While it shows, the app
 * underneath stays mounted — controllers keep their state — but is hidden
 * with `display: none`, so balances are neither visible, focusable nor read
 * by screen readers.
 */

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { sovlSpace } from '@sovereign/ui/tokens';
import { AppLock, BackupRecordStore, memorySecureStorage } from '../../flows/appLock.js';
import type { AppLockSnapshot, BackupStoreSnapshot } from '../../flows/appLock.js';
import type { ModeAState } from '../../flows/modeAController.js';
import type { PlatformServices } from '../../flows/platform.js';
import type { PreferencesStore } from '../../flows/preferences.js';
import { usePlatformServices, usePreferences } from '../appContext.js';
import {
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileField,
  MobileHeader,
  MobileScreen,
  mobilePalette,
  styles as base,
} from '../Primitives.js';
import { PinField } from './kit.js';

export interface WalletSecurity {
  readonly lock: AppLock;
  readonly backup: BackupRecordStore;
  /** True when the host injected real secure storage (otherwise PIN is unavailable). */
  readonly hasSecureStorage: boolean;
}

/** Builds (once) and loads the lock and backup record for an app root. */
export function useWalletSecurity(platform: PlatformServices, preferences: PreferencesStore): WalletSecurity {
  const [security] = useState<WalletSecurity>(() => {
    const storage = platform.secureStorage ?? memorySecureStorage('memory');
    return {
      lock: new AppLock({
        storage,
        authenticateBiometric: platform.authenticateBiometric,
        lockTimeoutSeconds: () => preferences.get().lockTimeoutSeconds,
      }),
      backup: new BackupRecordStore({ storage }),
      hasSecureStorage: platform.secureStorage !== undefined,
    };
  });
  useEffect(() => {
    void security.lock.load();
    void security.backup.load();
  }, [security]);
  return security;
}

const SecurityContext = createContext<WalletSecurity | null>(null);

/** The app root's security services; throws outside `WalletSecurityBoundary`. */
export function useWalletSecurityServices(): WalletSecurity {
  const value = useContext(SecurityContext);
  if (value === null) throw new Error('useWalletSecurityServices: no WalletSecurityBoundary above this screen');
  return value;
}

export function useAppLockSnapshot(lock: AppLock): AppLockSnapshot {
  return useSyncExternalStore(lock.subscribe, lock.getSnapshot);
}

export function useBackupSnapshot(backup: BackupRecordStore): BackupStoreSnapshot {
  return useSyncExternalStore(backup.subscribe, backup.getSnapshot);
}

/**
 * Wraps an app root: provides the services, locks on background/foreground
 * per the lock-timeout preference, applies screen-capture protection when
 * the host supports it, and covers the app while locked.
 */
export function WalletSecurityBoundary({
  security,
  children,
}: {
  security: WalletSecurity;
  children: ReactNode;
}): ReactNode {
  const { lock } = security;
  const snapshot = useAppLockSnapshot(lock);
  const platform = usePlatformServices();
  const { preferences } = usePreferences();

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') lock.noteBackground();
      else if (next === 'active') lock.noteForeground();
    });
    return () => subscription.remove();
  }, [lock]);

  const protect = platform.setScreenCaptureProtection;
  const wantProtection = preferences.screenCaptureProtection;
  useEffect(() => {
    if (protect === undefined) return;
    protect(wantProtection).catch((error: unknown) => {
      console.warn('[wallet] screen capture protection failed:', error);
    });
  }, [protect, wantProtection]);

  const covered = snapshot.status === 'loading' || snapshot.status === 'error' || snapshot.status === 'locked';
  return (
    <SecurityContext.Provider value={security}>
      <View
        style={[layout.fill, covered ? layout.hidden : null]}
        accessibilityElementsHidden={covered}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
        aria-hidden={covered}
      >
        {children}
      </View>
      {covered && <LockScreen security={security} snapshot={snapshot} />}
    </SecurityContext.Provider>
  );
}

const LOCK_REASON_TEXT: Record<NonNullable<AppLockSnapshot['lockReason']>, string> = {
  launch: 'Enter your PIN to open your wallet.',
  timeout: 'Locked after the app was in the background. Enter your PIN to continue.',
  manual: 'You locked the app. Enter your PIN to continue.',
};

/** Ticks once a second while a wait is running, so the countdown stays honest. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function waitText(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** Full-screen lock: PIN entry, biometric unlock when on, backoff countdown. */
export function LockScreen({
  security,
  snapshot,
}: {
  security: WalletSecurity;
  snapshot: AppLockSnapshot;
}): ReactNode {
  const { lock } = security;
  const backup = useBackupSnapshot(security.backup);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const waiting = snapshot.lockedUntil !== null;
  const now = useNow(waiting);
  const waitMs = snapshot.lockedUntil === null ? 0 : Math.max(0, snapshot.lockedUntil - now);
  const canBiometric = snapshot.biometricEnabled && snapshot.biometricAvailable;

  // Offer the biometric prompt once each time the app locks.
  const prompted = useRef<string | null>(null);
  useEffect(() => {
    if (snapshot.status !== 'locked' || !canBiometric) return;
    const key = `${snapshot.lockReason ?? ''}`;
    if (prompted.current === key) return;
    prompted.current = key;
    void lock.unlockWithBiometric();
  }, [snapshot.status, snapshot.lockReason, canBiometric, lock]);
  useEffect(() => {
    if (snapshot.status === 'unlocked') prompted.current = null;
  }, [snapshot.status]);

  if (snapshot.status === 'loading') {
    return (
      <View style={layout.overlay}>
        <MobileScreen>
          <MobileHeader title="Sovereign Wallet" />
          <Text style={base.dim}>Checking app lock…</Text>
        </MobileScreen>
      </View>
    );
  }

  if (snapshot.status === 'error') {
    return (
      <View style={layout.overlay}>
        <MobileScreen>
          <MobileHeader title="App lock unavailable" />
          <MobileErrorNote error={snapshot.error ?? 'The app lock could not be read.'} />
          <Text style={base.dim}>
            The wallet stays covered until the lock can be read, so a PIN you set cannot be skipped.
            Try again; if it keeps failing, restart the app.
          </Text>
          <MobileButton label="Try again" onPress={() => void lock.load()} />
        </MobileScreen>
      </View>
    );
  }

  const submit = (): void => {
    if (pin.length === 0 || snapshot.busy || waitMs > 0) return;
    void lock.unlockWithPin(pin).then((result) => {
      setPin('');
      setError(result.ok ? null : result.message);
    });
  };

  return (
    <View style={layout.overlay}>
      <MobileScreen>
        <View style={layout.lockHead}>
          <Text style={layout.lockGlyph} accessibilityElementsHidden importantForAccessibility="no" aria-hidden>
            ●
          </Text>
          <MobileHeader
            title="Wallet locked"
            subtitle={LOCK_REASON_TEXT[snapshot.lockReason ?? 'launch']}
          />
        </View>
        <Text style={base.faint}>Balances and activity are hidden while the app is locked.</Text>
        <PinField label="PIN" value={pin} onChangeText={setPin} onSubmit={submit} autoFocus />
        {waitMs > 0 ? (
          <Text style={[base.dim, { color: mobilePalette.warning }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
            Too many wrong PINs. Try again in {waitText(waitMs)}.
          </Text>
        ) : (
          <MobileErrorNote error={error} />
        )}
        <MobileButtonGroup>
          <MobileButton
            label="Unlock"
            onPress={submit}
            disabled={pin.length === 0 || waitMs > 0}
            busy={snapshot.busy}
          />
          {canBiometric && (
            <MobileButton
              label="Unlock with biometrics"
              kind="secondary"
              onPress={() => void lock.unlockWithBiometric()}
            />
          )}
        </MobileButtonGroup>
        {snapshot.failedAttempts > 0 && waitMs === 0 && (
          <Text style={base.faint}>
            {snapshot.failedAttempts} wrong {snapshot.failedAttempts === 1 ? 'try' : 'tries'} so far. After 5,
            each wrong PIN adds a wait. Nothing is erased.
          </Text>
        )}
        {!forgot && (
          <MobileButton label="Forgot PIN" kind="ghost" compact onPress={() => setForgot(true)} />
        )}
        {forgot && (
          <ForgotPin
            canUsePhrase={backup.status === 'recorded'}
            onCheck={async (phrase) => {
              const matches = await security.backup.check(phrase);
              if (matches !== true) return false;
              const removed = await lock.removePinWithRecoveryProof({ recoveryPhraseChecked: true });
              return removed.ok;
            }}
            onCancel={() => setForgot(false)}
          />
        )}
      </MobileScreen>
    </View>
  );
}

/**
 * Forgotten PIN. The everyday wallet can prove ownership with its recovery
 * phrase (checked against this device's backup record), which removes the
 * PIN. Nothing else can: a PIN that anyone could reset would guard nothing.
 */
function ForgotPin({
  canUsePhrase,
  onCheck,
  onCancel,
}: {
  canUsePhrase: boolean;
  onCheck: (phrase: string) => Promise<boolean>;
  onCancel: () => void;
}): ReactNode {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canUsePhrase) {
    return (
      <View style={layout.forgot}>
        <Text style={base.dim}>
          There is no PIN reset in the app without a recovery check, and this device has no backup
          record to check a recovery phrase against (connected nodes have none). Your funds are not
          affected: an everyday wallet can be restored from its recovery phrase on a fresh install,
          and a node can be paired again. On iOS the Keychain keeps the PIN across reinstalls until
          the app's data is erased.
        </Text>
        <MobileButton label="Back to PIN" kind="secondary" onPress={onCancel} />
      </View>
    );
  }
  return (
    <View style={layout.forgot}>
      <Text style={base.dim}>
        Enter your wallet's recovery phrase. If it matches the backup recorded on this device, the PIN
        is removed and you can set a new one. The phrase is checked on this device and not stored.
      </Text>
      <MobileField label="Recovery phrase" value={phrase} onChangeText={setPhrase} multiline secure={false} />
      <MobileErrorNote error={error} />
      <MobileButtonGroup>
        <MobileButton
          label="Check phrase and remove PIN"
          busy={busy}
          disabled={phrase.trim().length === 0}
          onPress={() => {
            setBusy(true);
            void onCheck(phrase).then((ok) => {
              setBusy(false);
              setPhrase('');
              if (!ok) setError("That phrase doesn't match this wallet's backup. Check the words and their order.");
            });
          }}
        />
        <MobileButton label="Back to PIN" kind="secondary" onPress={onCancel} />
      </MobileButtonGroup>
    </View>
  );
}

const layout = StyleSheet.create({
  forgot: { gap: sovlSpace[3] },
  fill: { flex: 1 },
  hidden: { display: 'none' },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: mobilePalette.bg },
  lockHead: { gap: sovlSpace[2], paddingTop: sovlSpace[6] },
  lockGlyph: { color: mobilePalette.accent, fontSize: 28 },
});

/**
 * Records the everyday wallet's backup on this device: when the backup
 * flow finishes (every word re-entered) or a restore succeeds, a verifier of
 * the phrase is saved so the user can later check a written copy. The
 * phrase is read from controller state only at that transition and never
 * stored.
 */
export function useBackupRecorder(backup: BackupRecordStore, state: ModeAState): void {
  const previous = useRef<ModeAState | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (before === null) return;
    if (before.backupStep === 'verify' && before.words !== null && state.backupStep === 'done') {
      void backup.record('verified-at-creation', before.words);
    }
    if (before.restoreStatus === 'restoring' && state.restoreStatus === 'restored') {
      // Read from the state just before: the controller clears the phrase
      // in the same update that marks the restore complete.
      const words = before.restoreWordsText.split(/\s+/).filter((w) => w.length > 0);
      if (words.length > 0) void backup.record('restored', words);
    }
  }, [state, backup]);
}
