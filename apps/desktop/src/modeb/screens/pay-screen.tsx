/**
 * Mode B Lightning: create invoices (receive) and pay invoices.
 *
 * Payment always shows a decoded review (amount, destination, CLTV) before
 * the user authorizes, and fee settings are exposed (fixed cap or percent of
 * the amount) — advanced routing settings stay visible, not buried.
 */
import { useState } from 'react';
import { Button, Card, TextField } from '@sovereign/ui';

import {
  BridgeHttpError,
  type BridgeClient,
  type DecodedInvoiceView,
  type PaymentOutcomeView,
} from '../bridge-client.js';
import { formatSats, parseSatsInput } from '../sats.js';

function errorMessage(err: unknown): string {
  return err instanceof BridgeHttpError ? err.message : err instanceof Error ? err.message : String(err);
}

function InvoiceCard({ client }: { readonly client: BridgeClient }): React.ReactNode {
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentRequest, setPaymentRequest] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    let amountSat: string | undefined;
    try {
      amountSat = parseSatsInput(amount);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await client.createInvoice({
        ...(amountSat === undefined ? {} : { amountSat }),
        ...(memo.trim() === '' ? {} : { memo: memo.trim() }),
      });
      setPaymentRequest(result.paymentRequest);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Create a Lightning invoice">
      <TextField label="Amount (sats — leave empty for a zero-amount invoice)" value={amount} onChange={setAmount} />
      <TextField label="Memo (optional)" value={memo} onChange={setMemo} />
      <Button disabled={busy} onClick={() => void submit()}>
        Create invoice
      </Button>
      {paymentRequest !== null ? (
        <p
          data-testid="invoice-request"
          style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', marginTop: 8 }}
        >
          {paymentRequest}
        </p>
      ) : null}
      {error !== null ? (
        <p data-testid="invoice-error" style={{ color: '#ff6b6b' }}>{error}</p>
      ) : null}
    </Card>
  );
}

function PayCard({ client }: { readonly client: BridgeClient }): React.ReactNode {
  const [paymentRequest, setPaymentRequest] = useState('');
  const [decoded, setDecoded] = useState<DecodedInvoiceView | null>(null);
  const [feeMode, setFeeMode] = useState<'cap' | 'percent'>('cap');
  const [feeLimitSat, setFeeLimitSat] = useState('10');
  const [feeLimitPercent, setFeeLimitPercent] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PaymentOutcomeView | null>(null);

  const review = async (): Promise<void> => {
    const trimmed = paymentRequest.trim();
    if (trimmed === '') {
      setError('Paste a Lightning invoice (BOLT-11 payment request).');
      return;
    }
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const next = await client.decodeInvoice(trimmed);
      setDecoded(next);
    } catch (err) {
      setDecoded(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pay = async (): Promise<void> => {
    if (decoded === null) return;
    let capSat: string | undefined;
    try {
      capSat = feeMode === 'cap' ? parseSatsInput(feeLimitSat) : undefined;
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await client.payInvoice({
        paymentRequest: paymentRequest.trim(),
        ...(capSat === undefined ? {} : { feeLimitSat: capSat }),
        ...(feeMode === 'percent' ? { feeLimitPercent: Math.max(0.1, Number(feeLimitPercent) || 1) } : {}),
        allowSelfPayment: true,
      });
      setOutcome(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Pay a Lightning invoice">
      <TextField
        label="Invoice (BOLT-11)"
        value={paymentRequest}
        onChange={(v) => {
          setPaymentRequest(v);
          setDecoded(null);
          setOutcome(null);
        }}
        multiline
        placeholder="lnbc…"
      />
      <Button disabled={busy} onClick={() => void review()}>
        Decode and review
      </Button>

      {decoded !== null ? (
        <div data-testid="payment-review" style={{ border: '1px solid #2a2a30', borderRadius: 8, padding: 8, marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontWeight: 600 }}>
              {decoded.amountSat !== undefined ? `${formatSats(decoded.amountSat)} sats` : 'Zero-amount invoice'}
            </span>
          </div>
          <div style={{ color: '#9aa0a6', fontSize: 13 }}>
            To: {decoded.destination.slice(0, 16)}… · CLTV {decoded.cltvExpiry}
          </div>
          {decoded.memo !== '' ? <div style={{ color: '#9aa0a6', fontSize: 13 }}>Memo: {decoded.memo}</div> : null}
          <div style={{ margin: '8px 0', color: '#9aa0a6' }}>
            <div style={{ marginBottom: 4 }}>Routing fee limit (advanced):</div>
            <label style={{ marginRight: 12 }}>
              <input type="radio" checked={feeMode === 'cap'} onChange={() => setFeeMode('cap')} /> Fixed:{' '}
            </label>
            {feeMode === 'cap' ? <TextField label="Fee cap (sats)" value={feeLimitSat} onChange={setFeeLimitSat} /> : null}
            <label style={{ marginRight: 12, marginTop: 4 }}>
              <input type="radio" checked={feeMode === 'percent'} onChange={() => setFeeMode('percent')} /> Percent of amount:{' '}
            </label>
            {feeMode === 'percent' ? <TextField label="Fee percent" value={feeLimitPercent} onChange={setFeeLimitPercent} /> : null}
          </div>
          <Button variant="danger" disabled={busy} onClick={() => void pay()}>
            Pay {decoded.amountSat !== undefined ? `${formatSats(decoded.amountSat)} sats` : ''}
          </Button>
        </div>
      ) : null}

      {outcome !== null ? (
        <p data-testid="payment-outcome" style={{ color: outcome.status === 'succeeded' ? '#3ddc97' : '#ff6b6b', marginTop: 8 }}>
          {outcome.status === 'succeeded'
            ? 'Payment succeeded.'
            : outcome.status === 'failed'
              ? `Payment failed: ${outcome.failureReason ?? 'unknown reason'}`
              : 'No final payment result yet — check the payments list on the overview.'}
        </p>
      ) : null}
      {error !== null ? (
        <p data-testid="pay-error" style={{ color: '#ff6b6b' }}>{error}</p>
      ) : null}
    </Card>
  );
}

export function PayScreen({ client }: { readonly client: BridgeClient }): React.ReactNode {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <PayCard client={client} />
      <InvoiceCard client={client} />
    </div>
  );
}
