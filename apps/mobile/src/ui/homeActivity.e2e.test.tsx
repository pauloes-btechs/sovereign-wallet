/**
 * Home and Activity e2e (headless) in both modes — the real controllers and
 * screens over the simulated backends. Activity is produced by the
 * simulated daemon / node itself (receives, deposits, sends, a failure), so
 * every row, notice and receipt field below is what the backend reported.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NativeApp, { ModeAApp } from '../App.js';
import type { PlatformServices } from '../flows/platform.js';
import { createPreferencesStore, memoryPreferencesBackend } from '../flows/preferences.js';
import { MobileFlowSimulatedClient, SIM_WORDS } from '../testing/simulatedWalletClient.js';
import { SimulatedLncPort } from '../testing/simulatedLncPort.js';
import { encodeSimulatedBolt11, simHashHex } from '../testing/simInvoice.js';
import { formatSatsNumber } from './format.js';

const TEN_WORDS = 'abstract acid acrobat actor actual admit adopt adore advance adventure';

/** Reads a DOM attribute (the mobile tsconfig has no DOM lib). */
function attr(el: unknown, name: string): string | null {
  return (el as { getAttribute(n: string): string | null }).getAttribute(name);
}

function click(label: string | RegExp): void {
  fireEvent.click(screen.getByLabelText(label));
}

function tab(name: 'Home' | 'Activity' | 'Send' | 'Receive' | 'Wallet'): void {
  fireEvent.click(screen.getByRole('tab', { name }));
}

function copySpy(): { platform: PlatformServices; copied: string[] } {
  const copied: string[] = [];
  return { copied, platform: { copyText: (text) => Promise.resolve(void copied.push(text)) } };
}

async function createWallet(sim: MobileFlowSimulatedClient, platform?: PlatformServices): Promise<void> {
  const preferences = createPreferencesStore(memoryPreferencesBackend());
  await preferences.load();
  render(
    <ModeAApp
      client={sim}
      network="regtest"
      dataDir="/tmp/sovereign-mobile-test"
      pollIntervalMs={600_000}
      preferences={preferences}
      platform={platform}
    />,
  );
  await waitFor(() => {
    expect(attr(screen.getByLabelText('Create a new wallet'), 'aria-disabled')).not.toBe('true');
  });
  fireEvent.change(screen.getByLabelText('Wallet password'), { target: { value: 'e2e-password' } });
  click('Create a new wallet');
  await screen.findByText('Back up your wallet');
  click('I wrote the words down');
  SIM_WORDS.forEach((word, i) => {
    fireEvent.change(screen.getByLabelText(`Word ${String(i + 1).padStart(2, '0')}`), { target: { value: word } });
  });
  click('Confirm backup');
  await screen.findByText('Everyday wallet');
}

/** Activity the simulated daemon records: a failed send, a Lightning receive, a deposit. */
async function seedModeAActivity(sim: MobileFlowSimulatedClient): Promise<void> {
  const invoice = encodeSimulatedBolt11({
    network: 'regtest',
    amountMsat: 700_000n,
    paymentHashHex: simHashHex('home-activity-failed'),
    timestamp: Math.floor(Date.now() / 1000),
  });
  const quote = await sim.prepareSend({ invoice });
  const sent = await sim.sendPrepared(quote);
  sim.failEntry(sent.entry.id, 'failed', 'no route to the destination');
  await sim.receive({ amountSat: 2_100, memo: 'coffee' });
  await sim.deposit({ amountSatHint: 50_000 });
  // A send the daemon has not finished (pending — a payment in flight).
  const pendingInvoice = encodeSimulatedBolt11({
    network: 'regtest',
    amountMsat: 1_000_000n,
    paymentHashHex: simHashHex('home-activity-pending'),
    timestamp: Math.floor(Date.now() / 1000),
  });
  await sim.sendPrepared(await sim.prepareSend({ invoice: pendingInvoice }));
}

describe('Home and Activity — everyday wallet (Mode A)', () => {
  afterEach(cleanup);

  it('Home: disjoint balance lines, unit and privacy switches write preferences', async () => {
    const sim = new MobileFlowSimulatedClient();
    sim.depositVTXO('sim-vtxo-fresh', 150_000, 100);
    await createWallet(sim);

    expect(await screen.findByText('150,000')).toBeTruthy(); // total, big figure
    expect(screen.getAllByText('Spendable').length).toBeGreaterThan(0);
    expect(screen.getByText('Locked')).toBeTruthy();
    expect(screen.getByText(/Held off-chain as Ark VTXOs/)).toBeTruthy();
    // No fiat line: no exchange-rate source exists.
    expect(screen.queryByText(/USD|EUR/)).toBeNull();

    click('Show amounts in BTC');
    expect(await screen.findByText('0.00150000')).toBeTruthy();
    expect(attr(screen.getByLabelText('Show amounts in BTC'), 'aria-checked')).toBe('true');
    click('Show amounts in sats');
    expect(await screen.findByText('150,000')).toBeTruthy();

    click('Hide amounts');
    await waitFor(() => expect(screen.queryByText('150,000')).toBeNull());
    expect(screen.getAllByLabelText('Amount hidden').length).toBeGreaterThan(0);
  }, 20_000);

  it('Home notices and recent activity come from the daemon and link into Activity and receipts', async () => {
    const sim = new MobileFlowSimulatedClient();
    sim.depositVTXO('sim-vtxo-fresh', 150_000, 100);
    await seedModeAActivity(sim);
    const { platform, copied } = copySpy();
    await createWallet(sim, platform);

    // Recent activity: four rows from the daemon. An unpaid invoice and an
    // unfunded deposit address are "awaiting payment", not received.
    expect(await screen.findByText('Recent activity')).toBeTruthy();
    expect(await screen.findByText('Deposit · On-chain')).toBeTruthy();
    expect(screen.getByText('Invoice · Lightning')).toBeTruthy();
    expect(screen.getAllByText('Sent · Lightning')).toHaveLength(2);
    expect(screen.getAllByText('Awaiting payment')).toHaveLength(2);

    // Notices from state: the failed send and the one payment in flight.
    expect(screen.getByText('Your last payment failed')).toBeTruthy();
    expect(screen.getByText('1 payment pending')).toBeTruthy();

    // "View pending" opens Activity already filtered (in flight + awaiting payment).
    click('View pending');
    await screen.findByText('Payments recorded by this wallet');
    expect(attr(screen.getByLabelText('Status: Pending'), 'aria-checked')).toBe('true');
    expect(screen.getByText('3 matches of 4')).toBeTruthy();
    expect(screen.getAllByText('Sent · Lightning')).toHaveLength(1);

    // Type filter (two rails present), then search by memo.
    click('Type: On-chain');
    expect(await screen.findByText('1 match of 4')).toBeTruthy();
    click('Clear filters');
    fireEvent.change(screen.getByLabelText('Search activity'), { target: { value: 'coffee' } });
    expect(await screen.findByText('1 match of 4')).toBeTruthy();
    expect(screen.getByText('Invoice · Lightning')).toBeTruthy();
    // Grouped by the day the daemon reported.
    expect(screen.getByText('Fri 30 Oct 2026')).toBeTruthy();

    // Receipt: pushed onto the Activity stack, copyable identifiers.
    click(/^Invoice · Lightning, /);
    expect(await screen.findByText('Identifiers')).toBeTruthy();
    expect(screen.getByText('Payment hash')).toBeTruthy();
    expect(screen.getByText('coffee')).toBeTruthy();
    expect(screen.getByText('Swap service')).toBeTruthy();
    expect(screen.getByText('Waiting for payment')).toBeTruthy(); // the daemon's current phase
    click('Copy payment hash');
    await screen.findByText('Copied');
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatch(/^[0-9a-f]{64}$|^recv-ph-/); // the payment hash the daemon reported
    click('Back');
    expect(await screen.findByText('1 match of 4')).toBeTruthy(); // filters survive the round trip

    // From Home, the failed-payment notice opens that receipt with the reason.
    tab('Home');
    click('View details');
    // The reason the daemon gave, in the failure band and on the timeline's failed step.
    expect((await screen.findAllByText('no route to the destination')).length).toBe(2);
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getByText('failed')).toBeTruthy(); // failure code as reported
  }, 20_000);

  it('Activity: empty state, then a read failure with retry', async () => {
    const sim = new MobileFlowSimulatedClient();
    await createWallet(sim);
    tab('Activity');
    expect(await screen.findByText(/No activity yet/)).toBeTruthy();

    const list = sim.list.bind(sim);
    sim.list = () => Promise.reject(new Error('daemon unavailable'));
    click('Refresh');
    expect(await screen.findByText('Activity could not be read: daemon unavailable')).toBeTruthy();
    sim.list = list;
    await sim.receive({ amountSat: 1_000 });
    click('Try again');
    expect(await screen.findByText('Invoice · Lightning')).toBeTruthy();
  }, 20_000);
});

describe('Home and Activity — remote node (Mode B)', () => {
  afterEach(cleanup);

  async function pair(port: SimulatedLncPort, platform?: PlatformServices): Promise<void> {
    render(
      <NativeApp
        mode="remote-node"
        network="regtest"
        resolveLncPort={() => Promise.resolve(port)}
        platform={platform}
      />,
    );
    await screen.findByText('Connect your node');
    fireEvent.change(screen.getByLabelText('Pairing phrase'), { target: { value: TEN_WORDS } });
    click('Connect');
    await screen.findByText('Node wallet');
  }

  it('Home shows node balances, receiving capacity apart from the total, and recent activity', async () => {
    const port = new SimulatedLncPort(() => new Date('2026-11-05T12:00:00Z'));
    const { bolt11 } = await port.addInvoice({ valueSat: 2_100n, memo: 'coffee' });
    await port.payInvoice({ bolt11, timeoutSeconds: 60 });
    const { platform, copied } = copySpy();
    await pair(port, platform);

    // Total = the node's Lightning + on-chain figures; capacity = active channels' remote side.
    const balances = await port.getBalances();
    const total = balances.lightningSpendableSat + balances.onchainConfirmedSat;
    const inbound = balances.channels.filter((c) => c.active).reduce((sum, c) => sum + c.remoteSat, 0n);
    expect(await screen.findByText(formatSatsNumber(total))).toBeTruthy();
    expect(screen.getByText('Can receive over Lightning')).toBeTruthy();
    expect(screen.getAllByText(`${formatSatsNumber(inbound)} sats`).length).toBeGreaterThan(0);
    // The simulated self-payment settles the invoice and records the payment.
    expect(await screen.findByText('Received · Lightning')).toBeTruthy();
    expect(screen.getByText('Sent · Lightning')).toBeTruthy();

    click('See all activity');
    await screen.findByText('Lightning payments and invoices on your node');
    // One rail only → no type filter row.
    expect(screen.queryByLabelText('Type: Lightning')).toBeNull();
    click('Status: Sent');
    expect(await screen.findByText('1 match of 2')).toBeTruthy();
    click(/^Sent · Lightning, /);
    expect(await screen.findByText('Payment request')).toBeTruthy();
    expect(screen.getByText('2 sats')).toBeTruthy(); // routing fee the node reported
    expect(screen.getByText('Not reported over this connection')).toBeTruthy(); // preimage
    click('Copy payment request');
    await screen.findByText('Copied');
    expect(copied).toEqual([bolt11]);
  });

  it('a node with no receiving capacity says so on Home and links to the liquidity screen', async () => {
    const port = new SimulatedLncPort();
    port.getBalances = () =>
      Promise.resolve({
        lightningSpendableSat: 300_000n,
        onchainConfirmedSat: 0n,
        channels: [{ chanId: 'c', active: true, localSat: 300_000n, remoteSat: 0n, capacitySat: 300_000n }],
      });
    await pair(port);
    expect(await screen.findByText('No receiving capacity')).toBeTruthy();
    expect(
      screen.getByText('Your wallet currently has insufficient receiving capacity for Lightning payments.'),
    ).toBeTruthy();
    // The action opens the liquidity screen on Home's stack (a pushed screen has Back).
    click('View liquidity');
    expect(await screen.findByLabelText('Back')).toBeTruthy();
    expect(screen.queryByText('Node wallet')).toBeNull();
  });
});
