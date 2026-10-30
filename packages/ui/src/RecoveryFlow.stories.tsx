import type { Meta, StoryObj } from '@storybook/react-vite';

import { RecoveryFlow } from './RecoveryFlow.js';

const meta = {
  title: 'Mode A/RecoveryFlow',
  component: RecoveryFlow,
} satisfies Meta<typeof RecoveryFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

const words = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent',
  'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident',
].join(' ');

/** Entering a phrase — deadline stated before any input. */
export const Entering: Story = {
  args: {
    wordsText: '',
    onWordsTextChange: () => {},
    acceptedSeedTypes: ['mnemonic-ark'],
    onRestore: () => {},
  },
};

/** Restore in progress with the operator reachable. */
export const Restoring: Story = {
  args: {
    wordsText: words,
    onWordsTextChange: () => {},
    acceptedSeedTypes: ['mnemonic-ark'],
    status: 'restoring',
    onRestore: () => {},
  },
};

/** Operator unreachable mid-restore — unilateral-exit fallback surfaced. */
export const OperatorUnreachableFallback: Story = {
  args: {
    wordsText: words,
    onWordsTextChange: () => {},
    acceptedSeedTypes: ['mnemonic-ark'],
    status: 'restoring',
    operatorReachable: false,
    unilateralExitFallback: true,
    onRestore: () => {},
  },
};

/** Cross-provider seed — refused with an explicit explanation, never partial. */
export const CrossProviderSeedRejected: Story = {
  args: {
    wordsText: words,
    onWordsTextChange: () => {},
    acceptedSeedTypes: ['mnemonic-ark'],
    rejection: {
      code: 'cross-provider-seed',
      message:
        'These words were created by the advanced (self-hosted node) mode. This everyday wallet cannot restore them — open the advanced mode instead.',
    },
    onRestore: () => {},
  },
};

/** Restore completed — rebuild underway. */
export const Restored: Story = {
  args: {
    wordsText: words,
    onWordsTextChange: () => {},
    acceptedSeedTypes: ['mnemonic-ark'],
    status: 'restored',
    onRestore: () => {},
  },
};
