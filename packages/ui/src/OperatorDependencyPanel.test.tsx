// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { WAVELENGTH_DECLARATION } from '@sovereign/wallet-core';

import { OperatorDependencyPanel } from './OperatorDependencyPanel.js';

afterEach(cleanup);

describe('OperatorDependencyPanel', () => {
  it('renders each declared dependency with its scope chips', () => {
    render(
      <OperatorDependencyPanel dependencies={WAVELENGTH_DECLARATION.capabilities.operatorDependencies} />,
    );
    const deps = screen.getAllByTestId('operator-dependency');
    expect(deps).toHaveLength(2);
    expect(screen.getByText('Swap service')).toBeInTheDocument();
    expect(screen.getByText('Ark operator')).toBeInTheDocument();
    expect(screen.getAllByText('Sending')).toHaveLength(2);
    expect(screen.getByText('Recovery')).toBeInTheDocument();
  });

  it('renders the declared disclosure text verbatim — no paraphrasing', () => {
    render(
      <OperatorDependencyPanel dependencies={WAVELENGTH_DECLARATION.capabilities.operatorDependencies} />,
    );
    for (const dep of WAVELENGTH_DECLARATION.capabilities.operatorDependencies) {
      expect(screen.getByText(dep.disclosure)).toBeInTheDocument();
    }
  });

  it('states self-hosting plainly when there are no dependencies', () => {
    render(<OperatorDependencyPanel dependencies={[]} />);
    expect(screen.getByTestId('no-dependencies')).toHaveTextContent(/fully self-hosted/);
  });
});
