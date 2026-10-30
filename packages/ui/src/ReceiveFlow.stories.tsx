import type { Meta, StoryObj } from '@storybook/react-vite';

import { ReceiveFlow } from './ReceiveFlow.js';

const meta = {
  title: 'Mode A/ReceiveFlow',
  component: ReceiveFlow,
} satisfies Meta<typeof ReceiveFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** On-chain tab with a generated address. */
export const OnchainAddress: Story = {
  args: {
    lightningMechanism: 'swaps',
    activeTab: 'onchain',
    onTabChange: () => {},
    onchainAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
    invoice: null,
  },
};

/** Lightning tab — mechanism labeled, invoice ready, fee disclosed. */
export const LightningInvoice: Story = {
  args: {
    lightningMechanism: 'swaps',
    activeTab: 'lightning',
    onTabChange: () => {},
    onchainAddress: null,
    invoice: 'lnbc210n1pjyqp2sp5zyg3jqdm4t8h5xrfsnkxk…',
    swapFeeSat: 12n,
  },
};

/** Lightning tab before invoice generation. */
export const NeedsInvoice: Story = {
  args: {
    lightningMechanism: 'swaps',
    activeTab: 'lightning',
    onTabChange: () => {},
    onchainAddress: null,
    invoice: null,
    onGenerateInvoice: () => {},
  },
};

/** Swap server down — Lightning receive paused, on-chain unaffected. */
export const SwapServiceUnreachable: Story = {
  args: {
    lightningMechanism: 'swaps',
    activeTab: 'lightning',
    onTabChange: () => {},
    onchainAddress: null,
    invoice: null,
    swapServiceReachable: false,
  },
};
