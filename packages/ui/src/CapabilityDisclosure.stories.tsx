import type { Meta, StoryObj } from '@storybook/react-vite';
import { LITD_LOCAL_DECLARATION, WAVELENGTH_DECLARATION } from '@sovereign/wallet-core';

import { CapabilityDisclosure } from './CapabilityDisclosure.js';

const meta = {
  title: 'Mode A/CapabilityDisclosure',
  component: CapabilityDisclosure,
} satisfies Meta<typeof CapabilityDisclosure>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mode A — swaps, async exit, Ark recovery, two declared operator dependencies. */
export const WavelengthEveryday: Story = {
  args: {
    capabilities: WAVELENGTH_DECLARATION.capabilities,
    seedCompatibility: [...WAVELENGTH_DECLARATION.seedCompatibility],
  },
};

/** Mode B — channels, instant exit, aezeed+SCB, self-hosted. */
export const LitdAdvanced: Story = {
  args: {
    capabilities: LITD_LOCAL_DECLARATION.capabilities,
    seedCompatibility: [...LITD_LOCAL_DECLARATION.seedCompatibility],
  },
};
