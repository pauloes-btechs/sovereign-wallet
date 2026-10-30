import type { Meta, StoryObj } from '@storybook/react-vite';

import { VtxoStateNotice } from './VtxoStateNotice.js';

const meta = {
  title: 'Mode A/VtxoStateNotice',
  component: VtxoStateNotice,
} satisfies Meta<typeof VtxoStateNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fresh: Story = { args: { state: 'fresh' } };
export const Expiring: Story = { args: { state: 'expiring', hoursToExpiry: 18 } };
export const AtRisk: Story = {
  args: { state: 'at-risk', operatorReachable: false, onStartExit: () => {} },
};
export const Exiting: Story = { args: { state: 'exiting', exitEtaHours: 28 } };
