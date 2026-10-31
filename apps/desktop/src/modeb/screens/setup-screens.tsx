/**
 * Mode B wallet-setup screens — create (aezeed), restore (aezeed), unlock.
 *
 * Honest-copy rules:
 * - Create shows the seed ONCE with an explicit write-it-down confirmation.
 * - Restore is scoped to the SAME backend (aezeed words), never cross-provider.
 * - Unlock errors surface the daemon's refusal verbatim (wrong passphrase etc.).
 */
import { useState } from 'react';
import { Button, Card, TextField } from '@sovereign/ui';

import type { BridgeClient } from '../bridge-client.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Missing-wallet entry: create a new wallet or restore from aezeed words. */
export function MissingWalletScreen(props: {
  readonly client: BridgeClient;
  readonly onDone: () => void;
  /** Raw probe error (why the wallet state could not be proven) — disclosed. */
  readonly error?: string;
}): React.ReactNode {
  const [flow, setFlow] = useState<'choose' | 'create' | 'restore'>('choose');

  if (flow === 'create') {
    return <CreateWalletScreen client={props.client} onDone={props.onDone} />;
  }
  if (flow === 'restore') {
    return <RestoreWalletScreen client={props.client} onDone={props.onDone} />;
  }
  return (
    <Card title="Advanced node setup">
      <p style={{ color: '#9aa0a6' }}>
        This node runs your own LND (via Lightning Terminal). Create a new wallet or restore an
        existing aezeed seed. Seeds belong to exactly one wallet type — a Wavelength (Mode A) seed
        cannot be used here.
      </p>
      {props.error !== undefined ? (
        <p style={{ color: '#9aa0a6', fontFamily: 'monospace', fontSize: 12 }}>{props.error}</p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button onClick={() => setFlow('create')}>Create a new wallet</Button>
        <Button variant="secondary" onClick={() => setFlow('restore')}>
          Restore from seed
        </Button>
      </div>
    </Card>
  );
}

/** Create: generate aezeed → show once → confirm → init. */
export function CreateWalletScreen(props: {
  readonly client: BridgeClient;
  readonly onDone: () => void;
}): React.ReactNode {
  const [mnemonic, setMnemonic] = useState<readonly string[] | null>(null);
  const [writeDown, setWriteDown] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { mnemonic: words } = await props.client.generateSeed();
      setMnemonic(words);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (mnemonic === null || !writeDown) {
      setError('Confirm you have written the seed down first.');
      return;
    }
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
      await props.client.initWallet({ mnemonic, password });
      props.onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (mnemonic === null) {
    return (
      <Card title="Create a new node wallet">
        <p style={{ color: '#9aa0a6' }}>
          A 24-word aezeed seed will be generated on this device. It is the only way to recover
          this wallet.
        </p>
        <Button disabled={busy} onClick={() => void generate()}>
          Generate seed
        </Button>
        {error !== null ? (
          <p data-testid="setup-error" style={{ color: '#ff6b6b' }}>{error}</p>
        ) : null}
      </Card>
    );
  }

  return (
    <Card title="Write your seed down">
      <p data-testid="seed-warning" style={{ color: '#f7b955' }}>
        This seed is shown ONCE. Anyone with these words can take your funds. Write them down and
        keep them offline.
      </p>
      <ol data-testid="seed-words" style={{ columns: 3, fontFamily: 'monospace' }}>
        {mnemonic.map((word, i) => (
          <li key={`${word}-${i}`}>{word}</li>
        ))}
      </ol>
      <label style={{ display: 'block', margin: '8px 0' }}>
        <input type="checkbox" checked={writeDown} onChange={(e) => setWriteDown(e.target.checked)} />{' '}
        I have written the 24 words down and understand this wallet needs them to recover.
      </label>
      <TextField label="Unlock password (min 8 chars)" value={password} onChange={setPassword} masked />
      <TextField label="Confirm password" value={confirm} onChange={setConfirm} masked />
      <Button disabled={busy} onClick={() => void submit()}>
        Create wallet
      </Button>
      {error !== null ? (
        <p data-testid="setup-error" style={{ color: '#ff6b6b' }}>{error}</p>
      ) : null}
    </Card>
  );
}

/** Restore: aezeed words → password → init with recovery window. */
export function RestoreWalletScreen(props: {
  readonly client: BridgeClient;
  readonly onDone: () => void;
}): React.ReactNode {
  const [words, setWords] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const parsed = words.trim().split(/\s+/).filter((w) => w.length > 0);
    if (parsed.length < 24) {
      setError('An aezeed seed has 24 words.');
      return;
    }
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
      // A generous recovery window re-scans for old channel funds (SCB).
      await props.client.initWallet({ mnemonic: parsed, password, recoveryWindow: 5000 });
      props.onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Restore from seed">
      <p style={{ color: '#9aa0a6' }}>
        Enter the 24 aezeed words. Restore rebuilds on-chain and channel state; keep this wallet
        online while it rescans for channel funds.
      </p>
      <TextField
        label="Seed words (space separated)"
        value={words}
        onChange={setWords}
        multiline
        placeholder="abandon ability able …"
      />
      <TextField label="New unlock password (min 8 chars)" value={password} onChange={setPassword} masked />
      <TextField label="Confirm password" value={confirm} onChange={setConfirm} masked />
      <Button disabled={busy} onClick={() => void submit()}>
        Restore wallet
      </Button>
      {error !== null ? (
        <p data-testid="setup-error" style={{ color: '#ff6b6b' }}>{error}</p>
      ) : null}
    </Card>
  );
}

/** Unlock: password → daemon. Refusals surface verbatim. */
export function UnlockScreen(props: {
  readonly client: BridgeClient;
  readonly onDone: () => void;
}): React.ReactNode {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.client.unlockWallet(password);
      props.onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Unlock your node">
      <p style={{ color: '#9aa0a6' }}>
        The node wallet is locked. Enter its unlock password. The node auto-locks when the daemon
        restarts.
      </p>
      <TextField label="Unlock password" value={password} onChange={setPassword} masked />
      <Button disabled={busy} onClick={() => void submit()}>
        Unlock
      </Button>
      {error !== null ? (
        <p data-testid="unlock-error" style={{ color: '#ff6b6b' }}>{error}</p>
      ) : null}
    </Card>
  );
}
