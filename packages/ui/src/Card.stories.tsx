import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card } from './Card.js';
import { Amount } from './Amount.js';

const meta = {
  title: 'Primitives/Card',
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Untitled: Story = {
  args: { children: <p style={{ margin: 0 }}>A quiet surface.</p> },
};
export const Titled: Story = {
  args: {
    title: 'Send',
    children: (
      <p style={{ margin: 0 }}>
        <Amount sats={21000n} /> to bc1qw508d6qej…
      </p>
    ),
  },
};
