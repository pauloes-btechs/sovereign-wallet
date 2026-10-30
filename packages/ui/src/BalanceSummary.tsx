import { vtxoStateLabel } from './copy.js';
import type { VtxoState } from './copy.js';
import { providerTotalSat } from './totals.js';
import { Amount } from './Amount.js';
import { Badge } from './Badge.js';
import { VtxoStateNotice } from './VtxoStateNotice.js';

export interface BalanceSummaryProps {
  lightningSpendableSat: bigint;
  lightningPendingSat: bigint;
  onchainConfirmedSat: bigint;
  onchainPendingSat: bigint;
  lockedOrExpiringSat: bigint;
  vtxoState: VtxoState;
  operatorReachable?: boolean;
  hoursToExpiry?: number | null;
  exitEtaHours?: number | null;
  onStartExit?: (() => void) | null;
  className?: string;
}

/**
 * Everyday-mode balance: the spec's three visible balances —
 * Lightning-spendable, on-chain, locked/expiring — plus the VTXO
 * lifecycle notice. All values arrive via props from ONE provider.
 */
export function BalanceSummary({
  lightningSpendableSat,
  lightningPendingSat,
  onchainConfirmedSat,
  onchainPendingSat,
  lockedOrExpiringSat,
  vtxoState,
  operatorReachable,
  hoursToExpiry,
  exitEtaHours,
  onStartExit,
  className,
}: BalanceSummaryProps) {
  const total = providerTotalSat({
    lightningSpendableSat,
    lightningPendingSat,
    onchainConfirmedSat,
    onchainPendingSat,
    lockedOrExpiringSat,
  });
  return (
    <section className={className ? `sovl-card sovl-balance ${className}` : 'sovl-card sovl-balance'}>
      <div>
        <div className="sovl-balance-total" data-testid="balance-total">
          <Amount sats={total} size="xl" />
        </div>
        <Badge>{vtxoStateLabel(vtxoState)}</Badge>
      </div>
      <div className="sovl-balance-rows">
        <div className="sovl-balance-row">
          <span className="sovl-balance-row-label">
            Lightning — spendable
            {lightningPendingSat > 0n ? (
              <span className="sovl-balance-row-sub">
                +{lightningPendingSat.toLocaleString('en-US')} sats pending
              </span>
            ) : null}
          </span>
          <Amount sats={lightningSpendableSat} size="md" />
        </div>
        <div className="sovl-balance-row">
          <span className="sovl-balance-row-label">
            On-chain
            {onchainPendingSat > 0n ? (
              <span className="sovl-balance-row-sub">
                +{onchainPendingSat.toLocaleString('en-US')} sats pending
              </span>
            ) : null}
          </span>
          <Amount sats={onchainConfirmedSat} size="md" />
        </div>
        <div className="sovl-balance-row">
          <span className="sovl-balance-row-label">Locked / expiring</span>
          <Amount sats={lockedOrExpiringSat} size="md" />
        </div>
      </div>
      <VtxoStateNotice
        state={vtxoState}
        operatorReachable={operatorReachable}
        hoursToExpiry={hoursToExpiry}
        exitEtaHours={exitEtaHours}
        onStartExit={onStartExit}
      />
    </section>
  );
}
