import type { Meta, StoryObj } from '@storybook/react-vite';

import { BalanceSummary } from './BalanceSummary.js';

const meta = {
  title: 'Mode A/BalanceSummary',
  component: BalanceSummary,
} satisfies Meta<typeof BalanceSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

const base = {
  lightningSpendableSat: 50_000n,
  lightningPendingSat: 0n,
  onchainConfirmedSat: 120_000n,
  onchainPendingSat: 3_000n,
  lockedOrExpiringSat: 21_000n,
} as const;

/** Fresh VTXOs — quiet, spendable, nothing asked of the user. */
export const Fresh: Story = { args: { ...base, vtxoState: 'fresh' } };

/** Expiry window approaching — background roll-forward, no action needed. */
export const Expiring: Story = {
  args: { ...base, vtxoState: 'expiring', hoursToExpiry: 18 },
};

/** Operator unreachable inside the window — at-risk, exit path offered. */
export const AtRisk: Story = {
  args: {
    ...base,
    vtxoState: 'at-risk',
    operatorReachable: false,
    onStartExit: () => {},
  },
};

/** Unilateral exit in flight — ETA shown, cancellation not possible. */
export const Exiting: Story = {
  args: { ...base, vtxoState: 'exiting', exitEtaHours: 28 },
};
