// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReceiveFlow } from './ReceiveFlow.js';

const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
const INVOICE = 'lnbc210n1pjyqp2…';

afterEach(cleanup);

describe('ReceiveFlow', () => {
  it('shows a generated on-chain address', () => {
    render(
      <ReceiveFlow
        lightningMechanism="swaps"
        activeTab="onchain"
        onTabChange={() => {}}
        onchainAddress={ADDRESS}
        invoice={null}
      />,
    );
    expect(screen.getByTestId('onchain-address')).toHaveTextContent(ADDRESS);
  });

  it('labels the Lightning tab with the declared mechanism', () => {
    render(
      <ReceiveFlow
        lightningMechanism="swaps"
        activeTab="lightning"
        onTabChange={() => {}}
        onchainAddress={null}
        invoice={INVOICE}
      />,
    );
    expect(screen.getByTestId('lightning-mechanism-tag')).toHaveTextContent(
      'Lightning via swap service',
    );
    expect(document.body.textContent).not.toMatch(/channel/i);
  });

  it('shows the swap service fee for an incoming payment', () => {
    render(
      <ReceiveFlow
        lightningMechanism="swaps"
        activeTab="lightning"
        onTabChange={() => {}}
        onchainAddress={null}
        invoice={INVOICE}
        swapFeeSat={12n}
      />,
    );
    expect(screen.getByText('Swap service fee')).toBeInTheDocument();
  });

  it('pauses Lightning receive when the swap service is unreachable, on-chain unaffected', () => {
    render(
      <ReceiveFlow
        lightningMechanism="swaps"
        activeTab="lightning"
        onTabChange={() => {}}
        onchainAddress={null}
        invoice={null}
        swapServiceReachable={false}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Lightning receive is paused/);
    expect(screen.getByRole('status')).toHaveTextContent(/On-chain receiving is unaffected/);
  });

  it('switches tabs via the callback', () => {
    const onTabChange = vi.fn();
    render(
      <ReceiveFlow
        lightningMechanism="swaps"
        activeTab="onchain"
        onTabChange={onTabChange}
        onchainAddress={ADDRESS}
        invoice={null}
      />,
    );
    screen.getByRole('tab', { name: 'Lightning' }).click();
    expect(onTabChange).toHaveBeenCalledWith('lightning');
  });

  it('offers invoice generation when none exists', () => {
    const onGenerateInvoice = vi.fn();
    render(
      <ReceiveFlow
        lightningMechanism="swaps"
        activeTab="lightning"
        onTabChange={() => {}}
        onchainAddress={null}
        invoice={null}
        onGenerateInvoice={onGenerateInvoice}
      />,
    );
    screen.getByRole('button', { name: 'New invoice' }).click();
    expect(onGenerateInvoice).toHaveBeenCalledOnce();
  });
});
