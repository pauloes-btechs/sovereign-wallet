import type { Meta, StoryObj } from '@storybook/react-vite';

import { TextField } from './TextField.js';

const meta = {
  title: 'Primitives/TextField',
  component: TextField,
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    label: 'Recipient address',
    value: '',
    onChange: () => {},
    placeholder: 'bc1…',
  },
};
export const WithHint: Story = {
  args: {
    label: 'Amount (sats)',
    value: '21000',
    onChange: () => {},
    hint: 'The fee is shown before you confirm.',
  },
};
export const WithError: Story = {
  args: {
    label: 'Amount (sats)',
    value: 'abc',
    onChange: () => {},
    error: 'Enter an amount in sats.',
  },
};
export const Disabled: Story = {
  args: { label: 'Invoice', value: 'lnbc210n1pj…', onChange: () => {}, disabled: true },
};
export const Multiline: Story = {
  args: {
    label: 'Recovery phrase (0 words)',
    value: '',
    onChange: () => {},
    multiline: true,
    placeholder: 'twelve or twenty-four words, separated by spaces',
  },
};
