import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button.js';

const meta = {
  title: 'Primitives/Button',
  component: Button,
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { children: 'Confirm payment' } };
export const Secondary: Story = { args: { variant: 'secondary', children: 'Show words again' } };
export const Danger: Story = { args: { variant: 'danger', children: 'Move funds on-chain' } };
export const Ghost: Story = { args: { variant: 'ghost', children: 'Details' } };
export const Disabled: Story = { args: { children: 'Restore', disabled: true } };
