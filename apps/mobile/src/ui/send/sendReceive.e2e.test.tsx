/**
 * Remote-node (Mode B) Send and Receive through the rendered screens, over
 * the preview's SimulatedLncPort (labelled simulated; no real node).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NativeApp from '../../App.js';
import type { LncRpcPort } from '../../flows/modeBRemoteController.js';
import { SimulatedLncPort } from '../../testing/simulatedLncPort.js';
import { simSegwitAddress } from '../../testing/simInvoice.js';

const TEN_WORDS = 'abstract acid acrobat actor actual admit adopt adore advance adventure';

function tab(name: 'Home' | 'Activity' | 'Send' | 'Receive' | 'Wallet'): void {
  fireEvent.click(screen.getByRole('tab', { name }));
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function click(label: string): void {
  fireEvent.click(screen.getByLabelText(label));
}

async function pairWith(port: LncRpcPort): Promise<void> {
  render(<NativeApp mode="remote-node" network="regtest" resolveLncPort={() => Promise.resolve(port)} />);
  await screen.findByText('Connect your node');
  typeInto('Pairing phrase', TEN_WORDS);
  click('Connect');
  await screen.findByText('Node wallet');
}

/** Creates an invoice on the Receive tab and returns its text. */
async function createInvoice(amount: string, memo: string): Promise<string> {
  tab('Receive');
  typeInto('Amount (sats)', amount);
  typeInto('Description (optional)', memo);
  click('Create invoice');
  await screen.findByLabelText('QR code for your Lightning invoice');
  let found = '';
  screen.getByText((text) => {
    if (!text.startsWith('lnbcrt')) return false;
    found = text;
    return true;
  });
  return found;
}

/** A node whose payment resolves only when the test says so. */
class DeferredPort extends SimulatedLncPort {
  release: (() => void) | null = null;
  calls = 0;
  override payInvoice(request: Parameters<SimulatedLncPort['payInvoice']>[0]): ReturnType<SimulatedLncPort['payInvoice']> {
    this.calls += 1;
    return new Promise((resolve) => {
      this.release = () => resolve(super.payInvoice(request));
    });
  }
}

/** A node that never reports a final result (e.g. a timeout mid-route). */
class AmbiguousPort extends SimulatedLncPort {
  override async payInvoice(): ReturnType<SimulatedLncPort['payInvoice']> {
    return { outcome: { status: 'timeout' } };
  }
}

describe('remote node Send and Receive', () => {
  afterEach(cleanup);

  it('receive with the expiry preference, then pay it: review shows the fee limit, receipt the routing fee, receive shows paid', async () => {
    const port = new SimulatedLncPort();
    await pairWith(port);

    tab('Receive');
    expect(screen.getByText('Expires after 1 h — from your invoice expiry preference.')).toBeTruthy();
    // On-chain is offered with its reason, not hidden.
    click('On-chain');
    expect(screen.getByText(/On-chain receive addresses aren't available over this connection yet/)).toBeTruthy();
    click('Lightning');

    const invoice = await createInvoice('2100', 'Tacos');
    expect(invoice.startsWith('lnbcrt21u1')).toBe(true);
    expect(screen.getByText('Waiting for payment')).toBeTruthy();
    expect(screen.getByText('Description: Tacos')).toBeTruthy();

    tab('Send');
    typeInto('Pay to', invoice);
    expect(await screen.findByText('“Tacos”')).toBeTruthy();
    click('Review payment');
    expect(await screen.findByText('Routing fee')).toBeTruthy();
    expect(screen.getByText(/routing fee isn't quoted beforehand/)).toBeTruthy();
    expect(screen.getByText('Total, at most')).toBeTruthy();
    expect(screen.getByText('2,110 sats')).toBeTruthy(); // 2,100 + 10-sat cap
    expect(screen.getByText(/Payment timeout: 60 s/)).toBeTruthy();
    expect(port.payRequests).toHaveLength(0);

    click('Confirm and send');
    expect(await screen.findByText('Payment sent.')).toBeTruthy();
    expect(port.payRequests).toEqual([{ bolt11: invoice, timeoutSeconds: 60, feeLimitSat: 10 }]);
    expect(await screen.findByText('2 sats')).toBeTruthy(); // routing fee from the node's record

    tab('Receive');
    expect(await screen.findByText('Payment received.')).toBeTruthy();
  });

  it('an unaffordable payment fails with a plain explanation and a safe retry path', async () => {
    const port = new SimulatedLncPort();
    await pairWith(port);
    const invoice = await createInvoice('5000000', 'Too much');
    tab('Send');
    typeInto('Pay to', invoice);
    expect(await screen.findByText(/More than your spendable balance/)).toBeTruthy();
    click('Review payment');
    // Cap 0.5% of 5,000,000 = 25,000 sats.
    expect(await screen.findByText('Total, at most')).toBeTruthy();
    click('Confirm and send');
    expect(await screen.findByText('Not enough funds')).toBeTruthy();
    expect(screen.getByText('Send a smaller amount, or add funds and try again.')).toBeTruthy();
    click('Edit and try again');
    expect((screen.getByLabelText('Pay to') as unknown as { value: string }).value).toBe(invoice);
  });

  it('an ambiguous outcome stays in flight and only offers a status check', async () => {
    await pairWith(new AmbiguousPort());
    const invoice = await createInvoice('1000', 'Maybe');
    tab('Send');
    typeInto('Pay to', invoice);
    click('Review payment');
    await screen.findByLabelText('Confirm and send');
    click('Confirm and send');
    expect(await screen.findByText('Payment in flight — result not final yet')).toBeTruthy();
    expect(screen.getByLabelText('Check payment status')).toBeTruthy();
    expect(screen.queryByLabelText('Confirm and send')).toBeNull();
  });

  it('while the payment is dispatching, a progress sheet that cannot be dismissed covers the review', async () => {
    const port = new DeferredPort();
    await pairWith(port);
    const invoice = await createInvoice('1500', 'Slow');
    tab('Send');
    typeInto('Pay to', invoice);
    click('Review payment');
    await screen.findByLabelText('Confirm and send');
    click('Confirm and send');
    expect(await screen.findByText('Sending payment')).toBeTruthy();
    expect(screen.getByText('Your payment is on its way. Keep the app open until it finishes.')).toBeTruthy();
    expect(screen.queryByLabelText('Close')).toBeNull(); // not dismissable
    port.release?.();
    expect(await screen.findByText('Payment sent.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('Sending payment')).toBeNull();
    });
  });

  it('a payment link whose amount disagrees with its invoice says so on the review', async () => {
    const port = new SimulatedLncPort();
    await pairWith(port);
    const invoice = await createInvoice('2100', 'Mismatch');
    tab('Send');
    typeInto('Pay to', `bitcoin:${simSegwitAddress('regtest', 'e2e-mismatch')}?amount=0.0001&lightning=${invoice}`);
    expect(await screen.findByText(/asks for 10,000 sats on-chain, but its Lightning invoice is for 2,100 sats/)).toBeTruthy();
    click('Review payment');
    await screen.findByLabelText('Confirm and send');
    expect(screen.getByText(/asks for 10,000 sats on-chain, but its Lightning invoice is for 2,100 sats/)).toBeTruthy();
    expect(port.payRequests).toHaveLength(0);
  });

  it('a double tap on "Confirm and send" dispatches the payment once', async () => {
    const port = new DeferredPort();
    await pairWith(port);
    const invoice = await createInvoice('1500', 'Twice');
    tab('Send');
    typeInto('Pay to', invoice);
    click('Review payment');
    const confirm = await screen.findByLabelText('Confirm and send');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await screen.findByText('Sending payment')).toBeTruthy();
    port.release?.();
    expect(await screen.findByText('Payment sent.')).toBeTruthy();
    expect(port.calls).toBe(1);
  });
});
