import type { Meta, StoryObj } from '@storybook/react-vite';

import { BackupConfirmation } from './BackupConfirmation.js';

const meta = {
  title: 'Mode A/BackupConfirmation',
  component: BackupConfirmation,
} satisfies Meta<typeof BackupConfirmation>;

export default meta;
type Story = StoryObj<typeof meta>;

const words = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent',
  'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident',
];

/** Showing the phrase — expiry consequence visible from the first screen. */
export const ShowWords: Story = {
  args: { words, step: 'show', onAcknowledge: () => {} },
};

/** Verification — words masked. */
export const Verify: Story = {
  args: { words, step: 'verify', onBackToShow: () => {} },
};

/** Confirmed. */
export const Done: Story = {
  args: { words, step: 'done' },
};
