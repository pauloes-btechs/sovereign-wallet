import type { Preview } from '@storybook/react-vite';
import '../src/env.d.ts';
import '../src/styles.css';

const preview: Preview = {
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="sovl-root" style={{ padding: '24px', minWidth: '360px' }}>
        <Story />
      </div>
    ),
  ],
};

export default preview;
