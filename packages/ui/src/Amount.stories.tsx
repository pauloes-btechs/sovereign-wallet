import type { Meta, StoryObj } from '@storybook/react-vite';

import { Amount } from './Amount.js';

const meta = {
  title: 'Primitives/Amount',
  component: Amount,
} satisfies Meta<typeof Amount>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Small: Story = { args: { sats: 154n, size: 'sm' } };
export const Medium: Story = { args: { sats: 21000n, size: 'md' } };
export const Large: Story = { args: { sats: 1234567n, size: 'lg' } };
export const Headline: Story = { args: { sats: 194000n, size: 'xl' } };
export const WithoutUnit: Story = { args: { sats: 21000n, unit: false, size: 'md' } };
