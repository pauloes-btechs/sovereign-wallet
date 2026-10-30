import type { Meta, StoryObj } from '@storybook/react-vite';
import { LITD_LOCAL_DECLARATION, WAVELENGTH_DECLARATION } from '@sovereign/wallet-core';

import { OperatorDependencyPanel } from './OperatorDependencyPanel.js';

const meta = {
  title: 'Mode A/OperatorDependencyPanel',
  component: OperatorDependencyPanel,
} satisfies Meta<typeof OperatorDependencyPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mode A — the declared swap server + Ark operator dependencies, verbatim. */
export const WavelengthDependencies: Story = {
  args: {
    dependencies: WAVELENGTH_DECLARATION.capabilities.operatorDependencies,
  },
};

/** Mode B base declaration — fully self-hosted, nothing to disclose. */
export const SelfHosted: Story = {
  args: { dependencies: LITD_LOCAL_DECLARATION.capabilities.operatorDependencies },
};
