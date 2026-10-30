/**
 * The desktop Mode A wallet screens: onboarding (create), backup
 * confirmation, unlock, and the ready wallet (balance + receive + send +
 * capability disclosure). Every screen consumes the session state machine —
 * the daemon declares what is possible; the UI never assumes.
 */
import { useState } from 'react';
import {
  BackupConfirmation,
  BalanceSummary,
  Button,
  CapabilityDisclosure,
  Card,
  ReceiveFlow,
  SendFlow,
  TextField,
  type ReceiveTab,
  type SendDraft,
  type SendStatus,
} from '@sovereign/ui';
import type { QuotedSend } from '@sovereign/wavelength-adapter';
import { useWalletSession } from './WalletSessionProvider.js';

function OnboardingScreen(): React.ReactNode {
  const { createWallet } = useWalletSession();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createWallet(password); // state flips to backup-confirm
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Create your wallet">
      <p style={{ color: '#9aa0a6', marginTop: 0 }}>
        Your keys stay on this device. Choose a password to encrypt the wallet — it is required
        every time the app starts.
      </p>
      <TextField
        label="Password"
        masked
        value={password}
        onChange={setPassword}
      />
      <TextField
        label="Confirm password"
        masked
        value={confirm}
        onChange={setConfirm}
      />
      {error ? <p role="alert" style={{ color: '#ff6b6b' }}>{error}</p> : null}
      <Button onClick={() => void submit()} disabled={busy}>
        {busy ? 'Creating…' : 'Create wallet'}
      </Button>
    </Card>
  );
}

function BackupScreen(): React.ReactNode {
  const { state, backupAcknowledged, refresh } = useWalletSession();
  if (state.phase !== 'backup-confirm') return null;
  return (
    <Card title="Back up your recovery phrase">
      <BackupConfirmation
        words={state.mnemonic}
        step="show"
        onAcknowledge={() => {
          backupAcknowledged();
          void refresh();
        }}
        onBackToShow={null}
      />
    </Card>
  );
}

function UnlockScreen(): React.ReactNode {
  const { unlockWallet } = useWalletSession();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await unlockWallet(password); // wrong password surfaces as daemon error
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Unlock your wallet">
      <TextField label="Password" masked value={password} onChange={setPassword} />
      {error ? <p role="alert" style={{ color: '#ff6b6b' }}>{error}</p> : null}
      <Button onClick={() => void submit()} disabled={busy || password.length === 0}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </Button>
    </Card>
  );
}

function ReadyWallet(): React.ReactNode {
  const { balance, provider, engine, receiveLightningInvoice, onchainDepositAddress, refresh } =
    useWalletSession();
  const [activeTab, setActiveTab] = useState<ReceiveTab>('lightning');
  const [onchainAddress, setOnchainAddress] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [receiveAmountText, setReceiveAmountText] = useState('');
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SendDraft>({ kind: 'lightning', destination: '', amountText: '' });
  const [sendStatus, setSendStatus] = useState<SendStatus>('idle');
  const [quoted, setQuoted] = useState<QuotedSend | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const capabilities = provider?.capabilities ?? null;

  /** Parses the amount field; null when not a positive integer. */
  const receiveAmountSat = (): number | null => {
    const n = Number(receiveAmountText);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  const generateReceive = async (tab: ReceiveTab): Promise<void> => {
    const amountSat = receiveAmountSat();
    if (amountSat === null) {
      setReceiveError('Enter a whole number of sats above zero first.');
      return;
    }
    setReceiveError(null);
    try {
      if (tab === 'onchain') {
        setOnchainAddress(await onchainDepositAddress(amountSat));
      } else {
        setInvoice(await receiveLightningInvoice(amountSat, 'desktop receive'));
      }
    } catch (err: unknown) {
      setReceiveError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Quote step: fee is enforced against the LIVE quote; the review card
   *  renders only once the quote has landed (nothing dispatches here). */
  const reviewSend = async (): Promise<void> => {
    if (!provider) return;
    setSendError(null);
    try {
      if (draft.kind === 'lightning') {
        setQuoted(await provider.quoteLightning({ invoice: draft.destination.trim() }));
      } else {
        const amountSat = Number(draft.amountText);
        setQuoted(
          await provider.quoteOnchain({
            onchainAddress: draft.destination.trim(),
            amountSat: Number.isInteger(amountSat) && amountSat > 0 ? amountSat : undefined,
          }),
        );
      }
      setSendStatus('review');
    } catch (err: unknown) {
      setQuoted(null);
      setSendStatus('failed');
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Confirm step: the engine persists the intent (with the approved quote)
   *  BEFORE any dispatch; a crash lands in reconcile, never blind retry. */
  const confirmSend = async (): Promise<void> => {
    if (!engine || !quoted || quoted.quote === undefined) return;
    setSendStatus('sending');
    setSendError(null);
    try {
      const kind = draft.kind === 'lightning' ? 'lightning-invoice' : 'onchain';
      const intent = await engine.submit(kind, { ...quoted.payload, quote: quoted.quote });
      await engine.execute(intent.intentId);
      setSendStatus('settled');
      void refresh();
    } catch (err: unknown) {
      setSendStatus('failed');
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ display: 'grid', gap: 24, maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <BalanceSummary
        lightningSpendableSat={balance?.lightningSpendableSat ?? 0n}
        lightningPendingSat={balance?.lightningPendingSat ?? 0n}
        onchainConfirmedSat={balance?.onchainConfirmedSat ?? 0n}
        onchainPendingSat={balance?.onchainPendingSat ?? 0n}
        lockedOrExpiringSat={balance?.lockedOrExpiringSat ?? 0n}
        vtxoState="fresh"
        operatorReachable={true}
        hoursToExpiry={null}
        exitEtaHours={null}
        onStartExit={null}
      />
      <TextField label="Amount (sats)" value={receiveAmountText} onChange={setReceiveAmountText} />
      <ReceiveFlow
        lightningMechanism="swaps"
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
          setInvoice(null);
          setOnchainAddress(null);
        }}
        onchainAddress={onchainAddress}
        invoice={invoice}
        swapServiceReachable={capabilities?.lightningReceive ?? false}
        swapFeeSat={null}
        onGenerateAddress={() => void generateReceive('onchain')}
        onGenerateInvoice={() => void generateReceive('lightning')}
      />
      <SendFlow
        draft={draft}
        onDraftChange={setDraft}
        lightningMechanism="swaps"
        swapServiceReachable={capabilities?.lightningSend ?? false}
        status={sendStatus}
        reviewAmountSat={null}
        feeQuoteSat={null}
        errorMessage={sendError}
        onReview={() => void reviewSend()}
        onConfirm={() => void confirmSend()}
        onSendAnother={() => {
          setSendStatus('idle');
          setQuoted(null);
          setSendError(null);
          setDraft({ kind: 'lightning', destination: '', amountText: '' });
        }}
      />
      {capabilities ? (
        <CapabilityDisclosure capabilities={capabilities} seedCompatibility={provider?.seedCompatibility} />
      ) : null}
      {receiveError ? <p role="alert" style={{ color: '#ff6b6b' }}>{receiveError}</p> : null}
    </div>
  );
}

/** Routes the session state machine onto screens. */
export function WalletApp(): React.ReactNode {
  const { state, connectError } = useWalletSession();

  if (state.phase === 'connecting') {
    return <main style={{ padding: 24, color: '#e8e8ea' }}>Connecting to daemon…</main>;
  }
  if (state.phase === 'failed') {
    return (
      <main style={{ padding: 24, color: '#ff6b6b' }} role="alert">
        Wallet session failed: {state.error}
        {connectError ? ` (${connectError})` : null}
      </main>
    );
  }

  switch (state.phase) {
    case 'wallet-missing':
      return (
        <main style={{ padding: 24 }}>
          <OnboardingScreen />
        </main>
      );
    case 'backup-confirm':
      return (
        <main style={{ padding: 24 }}>
          <BackupScreen />
        </main>
      );
    case 'locked':
      return (
        <main style={{ padding: 24 }}>
          <UnlockScreen />
        </main>
      );
    case 'ready':
      return <ReadyWallet />;
    default:
      return null;
  }
}
