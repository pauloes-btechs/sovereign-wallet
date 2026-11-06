/**
 * Mode B screens (headless) — the real ModeBRemoteController and screens
 * over the preview's SimulatedLncPort: pairing, the five tabs, Lightning
 * activity read from the port, and capability-driven Wallet rows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import NativeApp from '../App.js';
import type { LncRpcPort } from '../flows/modeBRemoteController.js';
import { SimulatedLncPort } from '../testing/simulatedLncPort.js';

const TEN_WORDS = 'abstract acid acrobat actor actual admit adopt adore advance adventure';

/** Reads a DOM attribute (the mobile tsconfig has no DOM lib). */
function attr(el: unknown, name: string): string | null {
  return (el as { getAttribute(n: string): string | null }).getAttribute(name);
}

function tab(name: 'Home' | 'Activity' | 'Send' | 'Receive' | 'Wallet'): void {
  fireEvent.click(screen.getByRole('tab', { name }));
}

async function pairWith(port: LncRpcPort): Promise<void> {
  render(<NativeApp mode="remote-node" network="regtest" resolveLncPort={() => Promise.resolve(port)} />);
  await screen.findByText('Connect your node');
  fireEvent.change(screen.getByLabelText('Pairing phrase'), { target: { value: TEN_WORDS } });
  fireEvent.click(screen.getByLabelText('Connect'));
  await screen.findByText('Node wallet');
}

describe('Mode B screens over the simulated LNC port', () => {
  afterEach(cleanup);

  it('shows the same five tabs as the everyday wallet once paired', async () => {
    await pairWith(new SimulatedLncPort());
    expect(screen.getAllByRole('tab').map((t) => attr(t, 'aria-label'))).toEqual([
      'Home',
      'Activity',
      'Send',
      'Receive',
      'Wallet',
    ]);
  });

  it('Activity reads Lightning invoices and payments from the node', async () => {
    await pairWith(new SimulatedLncPort(() => new Date('2026-11-05T12:00:00Z')));
    tab('Activity');
    expect(await screen.findByText('No Lightning payments or invoices on your node yet.')).toBeTruthy();

    tab('Receive');
    fireEvent.change(screen.getByLabelText('Amount (sats)'), { target: { value: '2100' } });
    fireEvent.click(screen.getByLabelText('Create invoice'));
    expect(await screen.findByLabelText('QR code for your Lightning invoice')).toBeTruthy();
    expect(screen.getByText('lnbcrt2100n1sim1')).toBeTruthy();

    tab('Activity');
    expect(await screen.findByText('Awaiting payment')).toBeTruthy();
    expect(screen.getByText('2,100 sats')).toBeTruthy();
    expect(screen.getByText('2026-11-05 12:00 UTC')).toBeTruthy();
  });

  it('Activity without a port method says it is unavailable instead of showing an empty list', async () => {
    const port = new SimulatedLncPort();
    const limited: LncRpcPort = {
      connect: (w) => port.connect(w),
      disconnect: () => port.disconnect(),
      isConnected: () => port.isConnected(),
      onConnectionEvent: (l) => port.onConnectionEvent(l),
      getInfo: () => port.getInfo(),
      getBalances: () => port.getBalances(),
      addInvoice: (r) => port.addInvoice(r),
      payInvoice: (r) => port.payInvoice(r),
      lookupPayment: (h) => port.lookupPayment(h),
    };
    await pairWith(limited);
    tab('Activity');
    expect(await screen.findByText(/Payment history isn't available over this connection yet/)).toBeTruthy();
    expect(screen.queryByText('No Lightning payments or invoices on your node yet.')).toBeNull();
  });

  it('Wallet lists what this connection cannot do, with reasons', async () => {
    await pairWith(new SimulatedLncPort());
    tab('Wallet');
    expect(await screen.findByText('sim-node')).toBeTruthy();
    expect(screen.getByText(/On-chain sending isn't available over this connection yet/)).toBeTruthy();
    expect(screen.getByText(/so the fee is known only afterwards/)).toBeTruthy();
  });
});
