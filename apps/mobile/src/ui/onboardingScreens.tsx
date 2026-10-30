/**
 * Onboarding-path screens: wallet creation with backup confirmation, and
 * seed restore. All wording lives here once — the backup-expiry consequence
 * copy is shared verbatim with desktop from `@sovereign/ui/copy`.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { BACKUP_EXPIRY_CONSEQUENCE, mechanismLabel } from '@sovereign/ui/copy';
import type { ModeAController, ModeAState } from '../flows/modeAController.js';
import { verifyWordInputs, type WordEntry } from './verifyWords.js';
import {
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileField,
  MobileHeader,
  MobileModal,
  MobileScreen,
  MobileWarningBand,
  MobileWords,
  styles,
} from './Primitives.js';

/** Entry screen — new users land here; restore is the explicit second path. */
export function OnboardingScreen({ controller }: { controller: ModeAController }): ReactNode {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, runtimeReady } = controller.getState();
  // Wallet operations require a started provider — disable until the runtime
  // is ready so an early tap cannot race the daemon connection.

  const create = (): void => {
    if (password.length === 0) {
      setError('Choose a wallet password first — it protects this device.');
      return;
    }
    setError(null);
    void controller.createWallet(password).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <MobileScreen>
      <Text style={styles.h2}>Sovereign Wallet</Text>
      <Text style={styles.dim}>
        Everyday Bitcoin and Lightning — your keys stay on this device. Lightning payments here
        are routed through a swap service, not payment channels.
      </Text>
      <MobileWarningBand tone="warning">{BACKUP_EXPIRY_CONSEQUENCE}</MobileWarningBand>
      <MobileField
        label="Wallet password"
        value={password}
        onChangeText={setPassword}
        placeholder="Used to unlock this wallet on this device"
        secure
      />
      <MobileErrorNote error={error} />
      <MobileButtonGroup>
        <MobileButton label="Create a new wallet" onPress={create} disabled={busy || !runtimeReady} />
        <MobileButton
          label="I already have a recovery phrase"
          kind="secondary"
          disabled={!runtimeReady}
          onPress={() => controller.navigate('restore')}
        />
      </MobileButtonGroup>
    </MobileScreen>
  );
}

/**
 * Backup confirmation — show, verify, done. The phrase exists in memory only
 * for this flow and is dropped the moment it completes.
 */
export function BackupConfirmationScreen({
  controller,
  state,
}: {
  controller: ModeAController;
  state: ModeAState;
}): ReactNode {
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [verifyEntries, setVerifyEntries] = useState<WordEntry[]>([]);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const words = state.words ?? [];

  const submitVerify = (): void => {
    const missing = words.filter((_, index) => !verifyEntries.some((e) => e.index === index));
    if (missing.length > 0) {
      setVerifyError('Fill in every blank word before continuing.');
      return;
    }
    const result = verifyWordInputs(words, verifyEntries);
    if (result.correct) {
      controller.confirmBackup();
      return;
    }
    setVerifyError(`Word ${String((result.firstMismatch ?? 0) + 1)} doesn't match. Try again.`);
  };

  return (
    <MobileScreen>
      <MobileHeader title="Back up your wallet" />
      <MobileWarningBand tone="warning">
        Write these words down and keep them offline. {BACKUP_EXPIRY_CONSEQUENCE}
      </MobileWarningBand>

      {state.backupStep === 'show' && (
        <>
          <MobileWords words={words} />
          <MobileButtonGroup>
            <MobileButton
              label="I wrote the words down"
              onPress={() => {
                setVerifyError(null);
                controller.acknowledgeWords();
              }}
            />
            <MobileButton
              label="Show me the words again first"
              kind="secondary"
              onPress={() => setRegenerateOpen(true)}
            />
          </MobileButtonGroup>
          <MobileModal
            open={regenerateOpen}
            title="The words stay the same"
            body="This is the only recovery phrase for this wallet. Scroll up to see it again, and write it down before you continue."
            onClose={() => setRegenerateOpen(false)}
          />
        </>
      )}

      {state.backupStep === 'verify' && (
        <>
          <Text style={styles.dim}>Enter the words you wrote down to confirm your backup.</Text>
          {words.map((_, index) => (
            <MobileField
              key={index}
              label={`Word ${String(index + 1).padStart(2, '0')}`}
              value={verifyEntries.find((e) => e.index === index)?.text ?? ''}
              onChangeText={(text) =>
                setVerifyEntries((prev) => [
                  ...prev.filter((e) => e.index !== index),
                  { index, text },
                ])
              }
            />
          ))}
          <MobileErrorNote error={verifyError} />
          <MobileButtonGroup>
            <MobileButton label="Confirm backup" onPress={submitVerify} />
            <MobileButton
              label="Show the words again"
              kind="secondary"
              onPress={controller.showWordsAgain}
            />
          </MobileButtonGroup>
        </>
      )}
    </MobileScreen>
  );
}

/** Seed restore — must complete before the VTXO batch expires. */
export function RestoreScreen({
  controller,
  state,
}: {
  controller: ModeAController;
  state: ModeAState;
}): ReactNode {
  const rejection = state.restoreRejection;
  return (
    <MobileScreen>
      <MobileHeader title="Restore from recovery phrase" onBack={() => controller.navigate('onboarding')} />
      <MobileWarningBand tone="warning">{BACKUP_EXPIRY_CONSEQUENCE}</MobileWarningBand>

      <MobileField
        label="Recovery phrase"
        value={state.restoreWordsText}
        onChangeText={(text) => controller.setRestoreWords(text)}
        placeholder="12 or 24 words, separated by spaces"
        multiline
      />
      <MobileField
        label="Wallet password"
        value={state.restorePassword}
        onChangeText={(text) => controller.setRestorePassword(text)}
        placeholder="Choose the password for this device"
        secure
      />

      {state.restoreStatus === 'restoring' && (
        <Text style={styles.dim}>Rebuilding your wallet — this can take a moment…</Text>
      )}

      {rejection !== null && (
        <MobileWarningBand tone={rejection.code === 'batch-expired' ? 'danger' : 'warning'}>
          <Text style={styles.dim}>{rejection.message}</Text>
        </MobileWarningBand>
      )}

      {state.restoreStatus === 'restored' && state.restoreSummary !== null && (
        <MobileWarningBand tone="info">
          <Text style={styles.dim}>
            Wallet restored. {state.restoreSummary.recoveredVTXOs} spendable VTXO
            {state.restoreSummary.recoveredVTXOs === 1 ? '' : 's'} recovered
            {state.restoreSummary.recoveryRan ? ' via server-assisted recovery' : ''}.
          </Text>
          <MobileButton label="Go to your wallet" onPress={() => controller.navigate('home')} />
        </MobileWarningBand>
      )}

      {state.restoreStatus !== 'restored' && (
        <MobileButton
          label={state.restoreStatus === 'restoring' ? 'Restoring…' : 'Restore wallet'}
          onPress={() => void controller.restore()}
          disabled={state.restoreStatus === 'restoring' || state.busy}
        />
      )}
      <Text style={styles.faint}>
        Lightning here is {mechanismLabel('swaps').toLowerCase()} — your phrase never moves funds
        by itself and is never shared with any provider.
      </Text>
    </MobileScreen>
  );
}
