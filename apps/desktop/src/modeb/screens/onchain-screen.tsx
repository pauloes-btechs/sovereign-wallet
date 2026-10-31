/**
 * Mode B on-chain: receive (fresh address) and send (address + amount +
 * fee-rate with estimate + explicit confirmation). Send-all supported; fee
 * estimate is advisory and shown before authorization.
 */
import { useState } from 'react';
import { Button, Card, TextField } from '@sovereign/ui';

import {
  BridgeHttpError,
  type BridgeClient,
  type FeeEstimateView,
} from '../bridge-client.js';
import { formatSats, parseSatsInput } from '../sats.js';

function errorMessage(err: unknown): string {
  return err instanceof BridgeHttpError ? err.message : err instanceof Error ? err.message : String(err);
}

function ReceiveCard({ client }: { readonly client: BridgeClient }): React.ReactNode {
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const getNew = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { address: next } = await client.newAddress('p2wkh');
      setAddress(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Receive on-chain">
      <p style={{ color: '#9aa0a6' }}>
        Each button press generates a fresh bech32 address. Funds sent here stay on-chain until
        you open a channel or spend them.
      </p>
      <Button disabled={busy} onClick={() => void getNew()}>
        New address
      </Button>
      {address !== null ? (
        <p
          data-testid="receive-address"
          style={{ fontFamily: 'monospace', fontSize: 14, wordBreak: 'break-all', marginTop: 8 }}
        >
          {address}
        </p>
      ) : null}
      {error !== null ? (
        <p data-testid="receive-error" style={{ color: '#ff6b6b' }}>{error}</p>
      ) : null}
    </Card>
  );
}

function SendCard({ client }: { readonly client: BridgeClient }): React.ReactNode {
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [sendAll, setSendAll] = useState(false);
  const [feeRate, setFeeRate] = useState('5');
  const [estimate, setEstimate] = useState<FeeEstimateView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);

  const requestEstimate = async (): Promise<void> => {
    setError(null);
    try {
      const target = Math.max(1, Math.min(100, Math.round(Number(feeRate) * 10) / 10));
      const fee = await client.estimateFee(target);
      setEstimate(fee);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const submit = async (): Promise<void> => {
    let amountSat: string | undefined;
    try {
      amountSat = parseSatsInput(amount);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    if (address.trim() === '') {
      setError('Enter a Bitcoin address.');
      return;
    }
    if (!sendAll && amountSat === undefined) {
      setError('Enter an amount in sats.');
      return;
    }
    if (!sendAll && amountSat !== undefined && BigInt(amountSat) <= 546n) {
      setError('Amounts below the dust limit (546 sats) are rejected.');
      return;
    }
    setConfirming(true);
  };

  const authorize = async (): Promise<void> => {
    let amountSat: string | undefined;
    try {
      amountSat = parseSatsInput(amount);
    } catch {
      // already validated in submit()
    }
    setBusy(true);
    setError(null);
    try {
      const result = await client.sendCoins({
        address: address.trim(),
        ...(sendAll || amountSat === undefined ? { sendAll: true } : { amountSat }),
        ...(Number.isFinite(Number(feeRate)) && Number(feeRate) > 0 ? { satPerVbyte: Number(feeRate) } : {}),
        label: 'mode-b-send',
      });
      setTxid(result.txid);
      setConfirming(false);
      setAmount('');
      setSendAll(false);
      setEstimate(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Send on-chain">
      <TextField label="Bitcoin address" value={address} onChange={setAddress} placeholder="bcrt1q…" />
      {sendAll ? (
        <p style={{ color: '#9aa0a6' }}>Amount: the full confirmed balance minus fees.</p>
      ) : (
        <TextField label="Amount (sats)" value={amount} onChange={setAmount} />
      )}
      <label style={{ display: 'block', margin: '8px 0', color: '#9aa0a6' }}>
        <input type="checkbox" checked={sendAll} onChange={(e) => setSendAll(e.target.checked)} /> Send
        everything
      </label>
      <TextField
        label="Fee rate (sat/vbyte)"
        value={feeRate}
        onChange={setFeeRate}
        hint={estimate !== null ? `Estimated fee at ${estimate.satPerVbyte} sat/vbyte: ${formatSats(estimate.feeSat)} sats` : undefined}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="secondary" onClick={() => void requestEstimate()}>
          Estimate fee
        </Button>
        <Button disabled={busy} onClick={() => void submit()}>
          Review send
        </Button>
      </div>
      {confirming ? (
        <div style={{ marginTop: 8, border: '1px solid #2a2a30', borderRadius: 8, padding: 8 }}>
          <p style={{ color: '#f7b955' }}>
            Review before authorizing — on-chain sends cannot be undone.
          </p>
          <div style={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}>
            To: {address.trim()}
          </div>
          <div>{sendAll ? 'Amount: full balance (send-all)' : `Amount: ${amount} sats`}</div>
          <div>Fee rate: {feeRate} sat/vbyte</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button variant="danger" disabled={busy} onClick={() => void authorize()}>
              Authorize and send
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {txid !== null ? (
        <p data-testid="send-txid" style={{ color: '#3ddc97', fontFamily: 'monospace', fontSize: 13 }}>
          Sent — txid {txid}
        </p>
      ) : null}
      {error !== null ? (
        <p data-testid="send-error" style={{ color: '#ff6b6b' }}>{error}</p>
      ) : null}
    </Card>
  );
}

export function OnchainScreen({ client }: { readonly client: BridgeClient }): React.ReactNode {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <ReceiveCard client={client} />
      <SendCard client={client} />
    </div>
  );
}
