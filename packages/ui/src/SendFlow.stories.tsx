import type { Meta, StoryObj } from '@storybook/react-vite';

import { SendFlow } from './SendFlow.js';
import type { SendDraft } from './SendFlow.js';

const meta = {
  title: 'Mode A/SendFlow',
  component: SendFlow,
} satisfies Meta<typeof SendFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

const lightningDraft: SendDraft = {
  kind: 'lightning',
  destination: 'lnbc210n1pjyqp2sp5zyg3jqdm4t8h…',
  amountText: '',
};

const onchainDraft: SendDraft = {
  kind: 'onchain',
  destination: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
  amountText: '21000',
};

/** Lightning default — mechanism labeled via the declared capability. */
export const LightningInvoice: Story = {
  args: {
    draft: lightningDraft,
    lightningMechanism: 'swaps',
    onDraftChange: () => {},
    onReview: () => {},
    onConfirm: () => {},
  },
};

/** On-chain draft with amount entry. */
export const Onchain: Story = {
  args: {
    draft: onchainDraft,
    lightningMechanism: 'swaps',
    onDraftChange: () => {},
    onReview: () => {},
    onConfirm: () => {},
  },
};

/** Review step — swap service fee shown before confirming. */
export const ReviewWithSwapFee: Story = {
  args: {
    draft: lightningDraft,
    lightningMechanism: 'swaps',
    status: 'review',
    reviewAmountSat: 2_100n,
    feeQuoteSat: 30n,
    onDraftChange: () => {},
    onReview: () => {},
    onConfirm: () => {},
  },
};

/** On-chain review — on-chain fee line. */
export const ReviewOnchainFee: Story = {
  args: {
    draft: onchainDraft,
    lightningMechanism: 'swaps',
    status: 'review',
    reviewAmountSat: 21_000n,
    feeQuoteSat: 154n,
    onDraftChange: () => {},
    onReview: () => {},
    onConfirm: () => {},
  },
};

/** In flight — do-not-close warning. */
export const Sending: Story = {
  args: {
    draft: lightningDraft,
    lightningMechanism: 'swaps',
    status: 'sending',
    onDraftChange: () => {},
    onReview: () => {},
    onConfirm: () => {},
  },
};

/** Settled. */
export const Settled: Story = {
  args: {
    draft: lightningDraft,
    lightningMechanism: 'swaps',
    status: 'settled',
    onDraftChange: () => {},
    onReview: () => {},
    onConfirm: () => {},
    onSendAnother: () => {},
  },
};

/** Failed — funds honestly unmoved. */
export const Failed: Story = {
  args: {
    draft: lightningDraft,
    lightningMechanism: 'swaps',
    status: 'failed',
    errorMessage: 'The swap service rejected the payment.',
    onDraftChange: () => {},
    onReview: () => {},
    onConfirm: () => {},
  },
};

/** Swap server down — Lightning blocked, on-chain unaffected. */
export const SwapServiceUnreachable: Story = {
  args: {
    draft: lightningDraft,
    lightningMechanism: 'swaps',
    swapServiceReachable: false,
    onDraftChange: () => {},
    onReview: () => {},
    onConfirm: () => {},
  },
};
