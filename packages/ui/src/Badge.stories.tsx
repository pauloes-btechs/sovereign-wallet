import type { Meta, StoryObj } from '@storybook/react-vite';

import { Badge } from './Badge.js';

const meta = {
  title: 'Primitives/Badge',
  component: Badge,
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = { args: { children: 'Neutral' } };
export const Positive: Story = { args: { tone: 'positive', children: 'Spendable' } };
export const Warning: Story = { args: { tone: 'warning', children: 'Expiring soon' } };
export const Danger: Story = { args: { tone: 'danger', children: 'At risk' } };
export const Info: Story = { args: { tone: 'info', children: 'Exiting to on-chain' } };
