import { describeSeedType } from './copy.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Card } from './Card.js';
import { TextField } from './TextField.js';

export type RecoveryStatus = 'entering' | 'restoring' | 'restored' | 'failed';

/**
 * Why a restore was refused. `cross-provider-seed` enforces the boundary
 * invariant: the UI refuses seeds from another wallet mode with an explicit
 * explanation instead of a partial restore.
 */
export interface RecoveryRejection {
  code: 'cross-provider-seed' | 'invalid-words' | 'batch-expired';
  message: string;
}

export interface RecoveryFlowProps {
  /** Controlled textarea content — whitespace-separated words. */
  wordsText: string;
  onWordsTextChange: (next: string) => void;
  /** Seed types this provider accepts, from its declaration (disjoint lists). */
  acceptedSeedTypes: readonly ('mnemonic-ark' | 'aezeed+scb' | 'remote-macaroon')[];
  status?: RecoveryStatus;
  rejection?: RecoveryRejection | null;
  operatorReachable?: boolean;
  /**
   * True when restore raced batch expiry or the operator is unreachable:
   * the only remaining path is the slower unilateral exit.
   */
  unilateralExitFallback?: boolean;
  onRestore: () => void;
  className?: string;
}

/**
 * Everyday-mode recovery. Restoring rebuilds off-chain VTXO state and must
 * complete before the batch expires — the deadline is stated up front, the
 * operator-unreachable fallback routes to unilateral exit, and cross-provider
 * seeds are refused explicitly.
 */
export function RecoveryFlow({
  wordsText,
  onWordsTextChange,
  acceptedSeedTypes,
  status = 'entering',
  rejection = null,
  operatorReachable = true,
  unilateralExitFallback = false,
  onRestore,
  className,
}: RecoveryFlowProps) {
  const accepted = acceptedSeedTypes.map((t) => describeSeedType(t)).join(', ');
  const words = wordsText.split(/\s+/).filter((w) => w.length > 0);

  return (
    <Card title="Restore a wallet" className={className}>
      <div className="sovl-notice sovl-notice--warning" role="note" style={{ marginBottom: '14px' }}>
        <p className="sovl-notice-title">Restore works against a deadline</p>
        <p className="sovl-notice-body">
          Restore must complete before the current VTXO batch expires. If it
          doesn't, funds move on-chain through a slower unilateral exit.
        </p>
      </div>

      <p className="sovl-hint" style={{ margin: '0 0 14px' }}>
        This wallet accepts: {accepted}. Seeds never cross between wallet
        modes — use the mode that created the phrase.
      </p>

      {rejection ? (
        <div className="sovl-notice sovl-notice--danger" role="alert" data-testid="recovery-rejection">
          <p className="sovl-notice-title">
            {rejection.code === 'cross-provider-seed'
              ? 'This phrase belongs to a different wallet mode'
              : rejection.code === 'batch-expired'
                ? 'The restore window closed'
                : 'These words do not match a wallet'}
          </p>
          <p className="sovl-notice-body">{rejection.message}</p>
        </div>
      ) : null}

      {status === 'restored' ? (
        <div className="sovl-notice sovl-notice--positive" role="status">
          <p className="sovl-notice-title">Wallet restored.</p>
          <p className="sovl-notice-body">Balances and payment history are rebuilding now.</p>
        </div>
      ) : (
        <div>
          <TextField
            label={`Recovery phrase (${words.length} words)`}
            value={wordsText}
            onChange={onWordsTextChange}
            placeholder="twelve or twenty-four words, separated by spaces"
            multiline
            disabled={status === 'restoring'}
          />

          {status === 'restoring' ? (
            <div className="sovl-notice sovl-notice--info" role="status">
              <p className="sovl-notice-title">Restoring…</p>
              <p className="sovl-notice-body">
                {operatorReachable
                  ? 'Rebuilding your off-chain funds from the phrase. Keep this window open.'
                  : 'The Ark operator is unreachable right now. Restoring what can be restored locally.'}
              </p>
            </div>
          ) : (
            <div className="sovl-notice-actions">
              <Button onClick={onRestore} disabled={words.length < 12}>
                Restore
              </Button>
            </div>
          )}

          {status === 'failed' && !rejection ? (
            <p className="sovl-error" role="alert">
              Restore failed — no funds were moved. Check the phrase and try again.
            </p>
          ) : null}
        </div>
      )}

      {unilateralExitFallback ? (
        <div className="sovl-notice sovl-notice--danger" role="alert" style={{ marginTop: '14px' }} data-testid="exit-fallback">
          <p className="sovl-notice-title">
            Operator unreachable — your funds will exit on-chain{' '}
            <Badge tone="danger">Slow path</Badge>
          </p>
          <p className="sovl-notice-body">
            The restore could not reach the Ark operator before the deadline, so
            your funds move on-chain through a unilateral exit. This pays
            on-chain fees and typically completes in hours to days.
          </p>
        </div>
      ) : null}
    </Card>
  );
}
