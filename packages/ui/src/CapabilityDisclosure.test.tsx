// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LITD_LOCAL_DECLARATION,
  PROOF_COURIER_DISCLOSURE,
  WAVELENGTH_DECLARATION,
} from '@sovereign/wallet-core';

import { CapabilityDisclosure } from './CapabilityDisclosure.js';

afterEach(cleanup);

describe('CapabilityDisclosure — Mode A (Wavelength declaration)', () => {
  it('renders the declared swap mechanism verbatim', () => {
    render(
      <CapabilityDisclosure
        capabilities={WAVELENGTH_DECLARATION.capabilities}
        seedCompatibility={[...WAVELENGTH_DECLARATION.seedCompatibility]}
      />,
    );
    expect(screen.getByTestId('lightning-mechanism')).toHaveTextContent(
      'Supported — Lightning via swap service',
    );
  });

  it('never uses the word "channel" anywhere in the Mode A surface', () => {
    const { container } = render(
      <CapabilityDisclosure
        capabilities={WAVELENGTH_DECLARATION.capabilities}
        seedCompatibility={[...WAVELENGTH_DECLARATION.seedCompatibility]}
      />,
    );
    expect(container.textContent).not.toMatch(/channel/i);
  });

  it('discloses the async exit and the Ark recovery model', () => {
    render(<CapabilityDisclosure capabilities={WAVELENGTH_DECLARATION.capabilities} />);
    expect(screen.getByText('Available — hours to days, on-chain fees apply')).toBeInTheDocument();
    expect(screen.getByText('Ark recovery phrase')).toBeInTheDocument();
    expect(screen.getByText('Not supported in this mode')).toBeInTheDocument(); // assets
  });
});

describe('CapabilityDisclosure — Mode B (litd declaration)', () => {
  it('renders the declared channel mechanism for the advanced mode', () => {
    render(
      <CapabilityDisclosure
        capabilities={LITD_LOCAL_DECLARATION.capabilities}
        seedCompatibility={[...LITD_LOCAL_DECLARATION.seedCompatibility]}
      />,
    );
    expect(screen.getByTestId('lightning-mechanism')).toHaveTextContent(
      'Supported — Lightning via payment channels',
    );
  });

  it("discloses the proof courier as the mode's only external dependency", () => {
    render(
      <CapabilityDisclosure
        capabilities={LITD_LOCAL_DECLARATION.capabilities}
        seedCompatibility={[...LITD_LOCAL_DECLARATION.seedCompatibility]}
      />,
    );
    // The proof-courier disclosure is the honest dependency set for
    // litd-local now that Taproot asset transfers are layer-1 core scope.
    expect(screen.getAllByTestId('operator-dependency')).toHaveLength(1);
    expect(screen.getByText(PROOF_COURIER_DISCLOSURE)).toBeInTheDocument();
  });
});
