import { mechanismLabel } from './copy.js';
import { Amount } from './Amount.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Card } from './Card.js';
import { TextField } from './TextField.js';

export type SendKind = 'lightning' | 'onchain';
export type SendStatus = 'idle' | 'review' | 'sending' | 'settled' | 'failed';

/** Controlled draft — the parent parses and validates; the component never does. */
export interface SendDraft {
  kind: SendKind;
  destination: string;
  /** Raw text; parsing to sats is the parent's job. Empty for exact-invoice pays. */
  amountText: string;
}

export interface SendFlowProps {
  draft: SendDraft;
  onDraftChange: (next: SendDraft) => void;
  /** Declared Lightning mechanism — copy always names it. */
  lightningMechanism: 'channels' | 'swaps';
  /** Mode A: the swap server's availability gates Lightning sending. */
  swapServiceReachable?: boolean;
  status?: SendStatus;
  /** Amount parsed by the parent, shown on the review step. */
  reviewAmountSat?: bigint | null;
  /** Swap-service fee (Lightning) or on-chain fee — shown before confirming. */
  feeQuoteSat?: bigint | null;
  errorMessage?: string | null;
  onReview: () => void;
  onConfirm: () => void;
  onSendAnother?: () => void;
  className?: string;
}

/**
 * Everyday-mode Send flow. Fully controlled: every value arrives via props,
 * every change leaves via callbacks — no API calls, no local state, no global
 * state. Lightning sending is labeled with the declared mechanism.
 */
export function SendFlow({
  draft,
  onDraftChange,
  lightningMechanism,
  swapServiceReachable = true,
  status = 'idle',
  reviewAmountSat = null,
  feeQuoteSat = null,
  errorMessage = null,
  onReview,
  onConfirm,
  onSendAnother,
  className,
}: SendFlowProps) {
  const label = mechanismLabel(lightningMechanism);

  if (status === 'settled') {
    return (
      <Card title="Send" className={className}>
        <div className="sovl-notice sovl-notice--positive" role="status">
          <p className="sovl-notice-title">Payment sent.</p>
          <p className="sovl-notice-body">
            {draft.kind === 'lightning'
              ? `Delivered over ${label.toLowerCase()}.`
              : 'Broadcast to the Bitcoin network.'}
          </p>
          <div className="sovl-notice-actions">
            {onSendAnother ? (
              <Button variant="secondary" onClick={onSendAnother}>
                Send another
              </Button>
            ) : null}
          </div>
        </div>
      </Card>
    );
  }

  if (status === 'review') {
    return (
      <Card title="Review payment" className={className}>
        {reviewAmountSat !== null ? (
          <p style={{ margin: '0 0 8px' }}>
            <Amount sats={reviewAmountSat} size="lg" />
          </p>
        ) : null}
        <p className="sovl-hint" style={{ margin: '0 0 12px', overflowWrap: 'anywhere' }}>
          To {draft.destination}
        </p>
        {feeQuoteSat !== null ? (
          <div className="sovl-fee-line">
            <span className="sovl-fee-line-label">
              {draft.kind === 'lightning' ? 'Swap service fee' : 'On-chain fee'}
            </span>
            <Amount sats={feeQuoteSat} size="sm" />
          </div>
        ) : null}
        <div className="sovl-notice-actions" style={{ marginTop: '14px' }}>
          <Button onClick={onConfirm}>Confirm payment</Button>
        </div>
        {errorMessage ? (
          <p className="sovl-error" role="alert" style={{ marginBottom: 0 }}>
            {errorMessage}
          </p>
        ) : null}
      </Card>
    );
  }

  if (status === 'sending') {
    return (
      <Card title="Send" className={className}>
        <div className="sovl-notice sovl-notice--info" role="status">
          <p className="sovl-notice-title">Sending…</p>
          <p className="sovl-notice-body">Do not close the wallet while the payment is in flight.</p>
        </div>
      </Card>
    );
  }

  const lightningBlocked = draft.kind === 'lightning' && !swapServiceReachable;

  return (
    <Card title="Send" className={className}>
      <div className="sovl-tabs" role="tablist" aria-label="Payment type">
        <button
          type="button"
          role="tab"
          aria-selected={draft.kind === 'lightning'}
          className={draft.kind === 'lightning' ? 'sovl-tab sovl-tab--active' : 'sovl-tab'}
          onClick={() => onDraftChange({ ...draft, kind: 'lightning' })}
        >
          Lightning
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={draft.kind === 'onchain'}
          className={draft.kind === 'onchain' ? 'sovl-tab sovl-tab--active' : 'sovl-tab'}
          onClick={() => onDraftChange({ ...draft, kind: 'onchain' })}
        >
          On-chain
        </button>
      </div>

      {draft.kind === 'lightning' ? (
        <p style={{ margin: '0 0 14px' }}>
          <span className="sovl-mechanism-tag">{label}</span>
        </p>
      ) : null}

      {lightningBlocked ? (
        <div className="sovl-notice sovl-notice--warning" role="status" style={{ marginBottom: '14px' }}>
          <p className="sovl-notice-title">Swap service unreachable</p>
          <p className="sovl-notice-body">
            Lightning payments pause until the swap service is reachable again.
            On-chain sending is unaffected.
          </p>
        </div>
      ) : null}

      <TextField
        label={draft.kind === 'lightning' ? 'Invoice' : 'Recipient address'}
        value={draft.destination}
        onChange={(destination) => onDraftChange({ ...draft, destination })}
        placeholder={draft.kind === 'lightning' ? 'lnbc…' : 'bc1…'}
      />

      {draft.kind === 'onchain' ? (
        <TextField
          label="Amount (sats)"
          value={draft.amountText}
          onChange={(amountText) => onDraftChange({ ...draft, amountText })}
          placeholder="21000"
        />
      ) : (
        <p className="sovl-hint">Invoices carry their own amount — no entry needed.</p>
      )}

      {draft.kind === 'lightning' ? (
        <p className="sovl-hint">
          The swap service's fee is shown before you confirm.
        </p>
      ) : null}

      <div className="sovl-notice-actions">
        <Button onClick={onReview} disabled={lightningBlocked}>
          Review
        </Button>
      </div>

      {status === 'failed' && errorMessage ? (
        <p className="sovl-error" role="alert" style={{ marginTop: '10px', marginBottom: 0 }}>
          {errorMessage}
        </p>
      ) : null}
      {status === 'failed' && !errorMessage ? (
        <p className="sovl-error" role="alert" style={{ marginTop: '10px', marginBottom: 0 }}>
          The payment failed — no funds were moved. Try again when ready.
        </p>
      ) : null}

      <p style={{ margin: '14px 0 0' }}>
        <Badge>{draft.kind === 'lightning' ? label : 'On-chain'}</Badge>
      </p>
    </Card>
  );
}
