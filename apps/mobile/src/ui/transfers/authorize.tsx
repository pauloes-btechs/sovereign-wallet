/**
 * Device authorization before a swap or asset send starts.
 *
 * Uses the app lock (`flows/appLock.ts`, provided by `WalletSecurityBoundary`):
 * - a PIN is set → a sheet asks for it (`AppLock.verifyPin`, which counts
 *   attempts and applies the lockout), with biometrics offered first when the
 *   user turned them on and the host has a prompt;
 * - no PIN, or no boundary above the screen → nothing to authorize with; the
 *   review screen says the confirm tap is the only authorization.
 *
 * Controllers can also inject `authorizeTransfer` (the store calls it before
 * re-quoting); this hook is the UI path that works with the app lock today.
 */

import { useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import type { AppLock } from '../../flows/appLock.js';
import { usePlatformServices } from '../appContext.js';
import { MobileButton, MobileButtonGroup, MobileErrorNote, styles } from '../Primitives.js';
import { Sheet } from '../Sheet.js';
import { PinField } from '../wallet/kit.js';
import { useWalletSecurityServices } from '../wallet/WalletSecurity.js';

const NO_LOCK_SUBSCRIBE = (): (() => void) => () => undefined;
const NO_LOCK_SNAPSHOT = (): null => null;

function useOptionalLock(): AppLock | null {
  try {
    return useWalletSecurityServices().lock;
  } catch {
    return null; // rendered without a WalletSecurityBoundary (tests, older roots)
  }
}

export interface DeviceAuthorization {
  /** 'none' = no app lock to authorize with. */
  readonly mode: 'none' | 'pin' | 'pin-or-biometric';
  /** One line for the review screen. */
  readonly description: string;
  /** Resolves true once authorized (immediately when mode is 'none'). */
  readonly request: (reason: string) => Promise<boolean>;
  /** Render this once on the screen (the PIN sheet). */
  readonly sheet: ReactNode;
}

export function useDeviceAuthorization(): DeviceAuthorization {
  const lock = useOptionalLock();
  const { authenticateBiometric } = usePlatformServices();
  const snapshot = useSyncExternalStore(
    lock?.subscribe ?? NO_LOCK_SUBSCRIBE,
    lock?.getSnapshot ?? NO_LOCK_SNAPSHOT,
  );
  const [open, setOpen] = useState<{ reason: string } | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const pinSet = lock !== null && snapshot !== null && snapshot.pinSet;
  const biometric = pinSet && snapshot.biometricEnabled && authenticateBiometric !== undefined;
  const mode: DeviceAuthorization['mode'] = !pinSet ? 'none' : biometric ? 'pin-or-biometric' : 'pin';

  const finish = (ok: boolean): void => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(null);
    setPin('');
    setError(null);
    setBusy(false);
  };

  const request = (reason: string): Promise<boolean> => {
    if (!pinSet) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setPin('');
      setError(null);
      setOpen({ reason });
    });
  };

  const submitPin = (): void => {
    if (lock === null) return;
    setBusy(true);
    void lock.verifyPin(pin).then((result) => {
      if (result.ok) finish(true);
      else {
        setBusy(false);
        setPin('');
        setError(result.message);
      }
    });
  };

  const sheet = (
    <Sheet open={open !== null} title="Authorize" onClose={() => finish(false)} dismissable={!busy}>
      <Text style={styles.dim}>{open?.reason ?? ''}</Text>
      {biometric && authenticateBiometric !== undefined && (
        <MobileButton
          label="Use biometrics"
          kind="secondary"
          disabled={busy}
          onPress={() => {
            void authenticateBiometric(open?.reason ?? 'Authorize').then(
              (ok) => (ok ? finish(true) : setError('Biometric check failed. Enter your PIN instead.')),
              () => setError('Biometric check failed. Enter your PIN instead.'),
            );
          }}
        />
      )}
      <PinField label="App PIN" value={pin} onChangeText={setPin} onSubmit={submitPin} autoFocus />
      <MobileErrorNote error={error} />
      <MobileButtonGroup>
        <MobileButton label={busy ? 'Checking…' : 'Authorize'} busy={busy} disabled={pin.length === 0} onPress={submitPin} />
        <MobileButton label="Cancel" kind="ghost" disabled={busy} onPress={() => finish(false)} />
      </MobileButtonGroup>
    </Sheet>
  );

  return {
    mode,
    description:
      mode === 'none'
        ? 'Device authorization: no app PIN is set, so your confirm tap is the only authorization. You can set one under Wallet → Security and recovery.'
        : mode === 'pin'
          ? 'You will be asked for your app PIN before it starts.'
          : 'You will be asked for biometrics or your app PIN before it starts.',
    request,
    sheet,
  };
}
