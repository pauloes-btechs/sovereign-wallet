import { BACKUP_EXPIRY_CONSEQUENCE } from './copy.js';
import { Button } from './Button.js';
import { Card } from './Card.js';

export type BackupStep = 'show' | 'verify' | 'done';

export interface BackupConfirmationProps {
  /** Recovery phrase words, in order. Parent owns storage and generation. */
  words: readonly string[];
  step: BackupStep;
  /**
   * Spec-verbatim expiry consequence, shown on every step. Override only to
   * localize — never to soften.
   */
  expiryConsequence?: string;
  onAcknowledge?: (() => void) | null;
  onBackToShow?: (() => void) | null;
  className?: string;
}

/**
 * Backup confirmation: word grid, verification step, and the spec's
 * expiry-consequence disclosure on every step — restore urgency is stated
 * plainly ("waiting too long can force a slower on-chain exit").
 */
export function BackupConfirmation({
  words,
  step,
  expiryConsequence = BACKUP_EXPIRY_CONSEQUENCE,
  onAcknowledge,
  onBackToShow,
  className,
}: BackupConfirmationProps) {
  return (
    <Card title="Back up your wallet" className={className}>
      {step === 'show' ? (
        <p className="sovl-hint" style={{ margin: '0 0 4px' }}>
          Write these words down, in order, and keep them offline.
        </p>
      ) : null}
      {step === 'verify' ? (
        <p className="sovl-hint" style={{ margin: '0 0 4px' }}>
          Confirm each word to finish backing up.
        </p>
      ) : null}
      {step === 'done' ? (
        <div className="sovl-notice sovl-notice--positive" role="status" style={{ marginBottom: '12px' }}>
          <p className="sovl-notice-title">Backup confirmed.</p>
          <p className="sovl-notice-body">
            Your recovery phrase is the only way to restore this wallet.
          </p>
        </div>
      ) : null}

      <div className="sovl-seed-grid" aria-label="Recovery phrase">
        {words.map((word, index) => (
          <div className="sovl-seed-word" key={`${index}-${word}`} data-testid="seed-word">
            <span className="sovl-seed-index">{index + 1}</span>
            {step === 'verify' ? '•••' : word}
          </div>
        ))}
      </div>

      <div className="sovl-notice sovl-notice--warning" role="note">
        <p className="sovl-notice-title">Restoring works against a deadline</p>
        <p className="sovl-notice-body" data-testid="expiry-consequence">
          {expiryConsequence}
        </p>
      </div>

      <div className="sovl-notice-actions">
        {step === 'show' && onAcknowledge ? <Button onClick={onAcknowledge}>I wrote it down</Button> : null}
        {step === 'verify' && onBackToShow ? (
          <Button variant="secondary" onClick={onBackToShow}>
            Show words again
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
