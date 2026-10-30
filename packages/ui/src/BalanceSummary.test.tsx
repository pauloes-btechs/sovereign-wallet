// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BalanceSummary } from './BalanceSummary.js';

function renderSummary(overrides: Partial<Parameters<typeof BalanceSummary>[0]> = {}) {
  return render(
    <BalanceSummary
      lightningSpendableSat={50_000n}
      lightningPendingSat={0n}
      onchainConfirmedSat={120_000n}
      onchainPendingSat={3_000n}
      lockedOrExpiringSat={21_000n}
      vtxoState="fresh"
      {...overrides}
    />,
  );
}

afterEach(cleanup);

describe('BalanceSummary', () => {
  it('shows the spec’s three balances and the pending sub-values', () => {
    renderSummary();
    expect(screen.getByText('Lightning — spendable')).toBeInTheDocument();
    expect(screen.getByText('On-chain')).toBeInTheDocument();
    expect(screen.getByText('Locked / expiring')).toBeInTheDocument();
    expect(screen.getByText(/3,000 sats pending/)).toBeInTheDocument();
  });

  it('sums one provider’s buckets into the headline total', () => {
    renderSummary();
    expect(screen.getByTestId('balance-total')).toHaveTextContent('194,000');
  });

  it('labels the VTXO state as a badge', () => {
    renderSummary({ vtxoState: 'expiring' });
    const notice = within(screen.getByTestId('vtxo-notice'));
    expect(notice.getByText('Expiring soon')).toBeInTheDocument();
  });

  it('renders the at-risk state with the exit action when the operator is unreachable', () => {
    renderSummary({
      vtxoState: 'at-risk',
      operatorReachable: false,
      onStartExit: vi.fn(),
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/operator is unreachable/i);
    expect(screen.getByRole('button', { name: 'Move funds on-chain' })).toBeInTheDocument();
  });

  it('renders the exiting state with ETA and no cancel', () => {
    renderSummary({ vtxoState: 'exiting', exitEtaHours: 28 });
    expect(screen.getByText(/available in ~28 hours\. Cancel not possible\./)).toBeInTheDocument();
  });
});
