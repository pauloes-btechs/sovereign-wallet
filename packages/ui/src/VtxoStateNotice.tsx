import { vtxoStateLabel } from './copy.js';
import type { VtxoState } from './copy.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';

export interface VtxoStateNoticeProps {
  state: VtxoState;
  /** False when the Ark operator cannot be reached (drives the at-risk path). */
  operatorReachable?: boolean;
  /** Hours until the current VTXO batch expires (expiring state). */
  hoursToExpiry?: number | null;
  /** Estimated hours until an in-flight exit settles (exiting state). */
  exitEtaHours?: number | null;
  /** Fee-funded unilateral exit action (at-risk state only). */
  onStartExit?: (() => void) | null;
  className?: string;
}

/**
 * VTXO lifecycle state machine, rendered per the spec's user-visible copy.
 * Fresh is quiet-positive; expiring reassures; at-risk discloses and offers
 * the exit path; exiting states the ETA and that it cannot be cancelled.
 */
export function VtxoStateNotice({
  state,
  operatorReachable = true,
  hoursToExpiry,
  exitEtaHours,
  onStartExit,
  className,
}: VtxoStateNoticeProps) {
  const wrapperClass = className ? `sovl-notice ${className}` : 'sovl-notice';
  switch (state) {
    case 'fresh':
      return (
        <div className={`${wrapperClass} sovl-notice--positive`} role="status" data-testid="vtxo-notice">
          <p className="sovl-notice-title">
            Funds are spendable.{' '}
            <Badge tone="positive">{vtxoStateLabel('fresh')}</Badge>
          </p>
        </div>
      );
    case 'expiring':
      return (
        <div className={`${wrapperClass} sovl-notice--warning`} role="status" data-testid="vtxo-notice">
          <p className="sovl-notice-title">
            Your funds are being rolled forward automatically.{' '}
            <Badge tone="warning">{vtxoStateLabel('expiring')}</Badge>
          </p>
          <p className="sovl-notice-body">
            No action is needed — the wallet keeps your funds fresh while the
            Ark operator is reachable.
            {typeof hoursToExpiry === 'number'
              ? ` Current batch expires in about ${hoursToExpiry} hours.`
              : ''}
          </p>
        </div>
      );
    case 'at-risk': {
      const unreachable = !operatorReachable;
      return (
        <div className={`${wrapperClass} sovl-notice--danger`} role="alert" data-testid="vtxo-notice">
          <p className="sovl-notice-title">
            {unreachable
              ? 'Cooperative payments are paused — the Ark operator is unreachable.'
              : 'Your funds need attention.'}{' '}
            <Badge tone="danger">{vtxoStateLabel('at-risk')}</Badge>
          </p>
          <p className="sovl-notice-body">
            Your funds can still be moved on-chain with a unilateral exit. This
            pays on-chain fees and typically completes in hours to days.
          </p>
          {onStartExit ? (
            <div className="sovl-notice-actions">
              <Button variant="danger" onClick={onStartExit}>
                Move funds on-chain
              </Button>
            </div>
          ) : null}
        </div>
      );
    }
    case 'exiting': {
      const eta =
        typeof exitEtaHours === 'number' ? `available in ~${exitEtaHours} hours` : 'on the way';
      return (
        <div className={`${wrapperClass} sovl-notice--info`} role="status" data-testid="vtxo-notice">
          <p className="sovl-notice-title">
            Exiting to on-chain — {eta}. Cancel not possible.{' '}
            <Badge tone="info">{vtxoStateLabel('exiting')}</Badge>
          </p>
          <p className="sovl-notice-body">
            Your funds will appear on-chain once the exit settles.
          </p>
        </div>
      );
    }
  }
}
