/**
 * Mode A screen e2e (headless) — the REAL stack (WavelengthProvider +
 * PaymentDispatcher + PaymentEngine + ModeAController + RN screens) driven
 * through rendered interactions, with only the daemon simulated. Mirrors the
 * brief's mobile flows: create, backup confirmation, restore, send
 * (both rails), receive, VTXO states, capability disclosures.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WAVELENGTH_DECLARATION } from '@sovereign/wallet-core';
import { ModeAApp } from '../App.js';
import { createPreferencesStore, memoryPreferencesBackend } from '../flows/preferences.js';
import {
  MobileFlowSimulatedClient,
  SIM_WORDS,
} from '../testing/simulatedWalletClient.js';
import { encodeSimulatedBolt11, simHashHex, simSegwitAddress } from '../testing/simInvoice.js';

/** A well-formed regtest invoice created now (1 h expiry). */
function simInvoice(amountMsat: bigint, label: string): string {
  return encodeSimulatedBolt11({
    network: 'regtest',
    amountMsat,
    paymentHashHex: simHashHex(label),
    description: label,
    expirySeconds: 3600,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

/** Minimal DOM shape — the RN program deliberately excludes the DOM lib. */
interface DomLike {
  readonly children: unknown[];
  readonly textContent: string | null;
}

/** Matches composed JSX text across the text nodes of one RN <Text>. */
function textMatching(pattern: RegExp): (content: string, element: Element | null) => boolean {
  return (_content, element) => {
    if (element === null) return false;
    const dom = element as unknown as DomLike;
    return dom.children.length === 0 && pattern.test(dom.textContent ?? '');
  };
}

/** Escapes regex metacharacters so disclosure prose can be asserted verbatim. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function click(label: string): void {
  fireEvent.click(screen.getByLabelText(label));
}

/** Reads a DOM attribute (the mobile tsconfig has no DOM lib). */
function attr(el: unknown, name: string): string | null {
  return (el as { getAttribute(n: string): string | null }).getAttribute(name);
}

/** Selects a bottom tab (Home, Activity, Send, Receive, Wallet) by its accessible name. */
function tab(name: 'Home' | 'Activity' | 'Send' | 'Receive' | 'Wallet'): void {
  fireEvent.click(screen.getByRole('tab', { name }));
}

/**
 * Waits until the controller finished starting the provider — the onboarding
 * buttons are disabled until runtimeReady flips, so interactions must follow it.
 */
async function awaitRuntimeReady(): Promise<void> {
  await waitFor(() => {
    // The mobile program excludes the DOM lib; read the attribute structurally.
    const create = screen.getByLabelText('Create a new wallet') as unknown as {
      getAttribute(name: string): string | null;
    };
    expect(create.getAttribute('aria-disabled')).not.toBe('true');
  });
}

/** Creates + confirms the backup, landing on Home with a live wallet. */
async function createAndBackup(sim: MobileFlowSimulatedClient): Promise<void> {
  render(<ModeAApp client={sim} network="regtest" dataDir="/tmp/sovereign-mobile-test" pollIntervalMs={600_000} />);
  await awaitRuntimeReady();
  typeInto('Wallet password', 'e2e-password');
  click('Create a new wallet');
  await screen.findByText('Back up your wallet');
  click('I wrote the words down');
  for (let i = 0; i < SIM_WORDS.length; i += 1) {
    const label = `Word ${String(i + 1).padStart(2, '0')}`;
    typeInto(label, SIM_WORDS[i] ?? '');
  }
  click('Confirm backup');
  await screen.findByText('Everyday wallet');
}

describe('Mode A mobile screens (real stack, simulated daemon)', () => {
  // vitest globals are off, so RTL cannot auto-register cleanup — do it here.
  afterEach(cleanup);

  it('onboarding → backup shows 12 words and the expiry consequence; a wrong word blocks; correct words reach Home', async () => {
    const sim = new MobileFlowSimulatedClient();
    render(<ModeAApp client={sim} network="regtest" dataDir="/tmp/sovereign-mobile-test" pollIntervalMs={600_000} />);
    expect(sim.walletCreated).toBe(false);

    await awaitRuntimeReady();
    typeInto('Wallet password', 'e2e-password');
    click('Create a new wallet');
    await screen.findByText('Back up your wallet');
    expect(sim.walletCreated).toBe(true);
    // Spec-verbatim consequence + the 12 numbered words (11 'abandon' + 'about').
    expect(screen.getByText(textMatching(/waiting too long can force a slower on-chain exit/))).toBeTruthy();
    expect(screen.getAllByText('abandon')).toHaveLength(11);
    expect(screen.getByText('about')).toBeTruthy();

    // A wrong word is rejected before the backup completes.
    click('I wrote the words down');
    for (let i = 0; i < SIM_WORDS.length; i += 1) {
      const label = `Word ${String(i + 1).padStart(2, '0')}`;
      typeInto(label, i === 11 ? 'zebra' : (SIM_WORDS[i] ?? ''));
    }
    click('Confirm backup');
    expect(screen.getByText(textMatching(/Word 12 doesn't match/))).toBeTruthy();
    expect(screen.queryByText('Everyday wallet')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull(); // no tabs before the wallet exists

    // Fixing the word completes the backup and lands on Home.
    typeInto('Word 12', SIM_WORDS[11] ?? '');
    click('Confirm backup');
    await screen.findByText('Everyday wallet');
  }, 20_000);

  it('Home renders the three buckets and the expiring VTXO roll-forward notice from live balances', async () => {
    const sim = new MobileFlowSimulatedClient();
    sim.depositVTXO('sim-vtxo-fresh', 150_000, 100);
    sim.depositVTXO('sim-vtxo-expiring', 50_000, 10);
    await createAndBackup(sim);

    // Buckets are disjoint: the expiring VTXO moves from spendable into
    // locked/expiring, so the total is each sat once — 150k + 50k.
    expect(await screen.findByText('200,000')).toBeTruthy(); // provider total (big figure)
    expect(screen.getByText('Lightning (spendable)')).toBeTruthy();
    expect(screen.getByText('On-chain (confirmed)')).toBeTruthy();
    expect(screen.getByText('Locked / expiring')).toBeTruthy();
    expect(screen.getByText('150,000 sats')).toBeTruthy(); // spendable (fresh VTXO)
    expect(screen.getByText('0 sats')).toBeTruthy(); // on-chain confirmed
    expect(screen.getByText('50,000 sats')).toBeTruthy(); // locked / expiring (expiring VTXO)
    expect(screen.queryByText('250,000')).toBeNull(); // never counted twice
    // The expiring VTXO surfaces the spec's roll-forward state.
    expect(screen.getByText('Expiring soon')).toBeTruthy();
    expect(screen.getByText(textMatching(/Your funds are being rolled forward automatically/))).toBeTruthy();
  }, 20_000);

  it('an expired VTXO renders the at-risk band with the unilateral exit path', async () => {
    const sim = new MobileFlowSimulatedClient();
    sim.depositVTXO('sim-vtxo-dead', 30_000, 5);
    for (let i = 0; i < 5; i += 1) sim.addBlock(); // expiry passes before mount
    await createAndBackup(sim);

    expect(await screen.findByText('At risk')).toBeTruthy();
    expect(
      screen.getByText(textMatching(/Some funds could not be refreshed in time/)),
    ).toBeTruthy();
    expect(screen.getAllByText('30,000 sats').length).toBeGreaterThan(0); // bucket + at-risk band
  }, 20_000);

  it('operator unreachable inside the refresh window discloses paused cooperative payments', async () => {
    const sim = new MobileFlowSimulatedClient();
    sim.depositVTXO('sim-vtxo-window', 25_000, 10);
    sim.connectOperator(false); // operator down INSIDE the free-refresh window
    await createAndBackup(sim);

    expect(await screen.findByText('At risk')).toBeTruthy();
    expect(
      screen.getByText(textMatching(/cooperative payments are paused/)),
    ).toBeTruthy();
  }, 20_000);

  it('Lightning send: one input parses the invoice; review shows the swap fee, total and cap; in-flight; reconcile settles it', async () => {
    const sim = new MobileFlowSimulatedClient();
    await createAndBackup(sim);

    tab('Send');
    typeInto('Pay to', `lightning:${simInvoice(25_000_000n, 'e2e-ln')}`);
    // Parsed on the phone before anything is quoted.
    expect(await screen.findByText('Lightning invoice')).toBeTruthy();
    expect(screen.getByText(textMatching(/^Maximum Lightning fee: 125 sats \(0.5% of the amount, at least 10 sats\)/))).toBeTruthy();
    click('Review payment');
    expect(await screen.findByText('Service fee')).toBeTruthy();
    expect(screen.getByText('30 sats')).toBeTruthy(); // sim.swapFeeSat, from the live quote
    expect(screen.getByText('25,030 sats')).toBeTruthy(); // quoted total outflow
    expect(screen.getByText(textMatching(/Quoted by the swap service that pays the invoice\. Your limit for this payment: 125 sats\./))).toBeTruthy();
    expect(sim.sendPreparedCalls).toBe(0); // review moves nothing

    click('Confirm and send');
    await screen.findByText(textMatching(/Payment in flight/));
    expect(sim.sendPreparedCalls).toBe(1);

    sim.settleEntry(sim.entries[sim.entries.length - 1]?.id ?? '');
    click('Check payment status');
    await screen.findByText('Payment sent.');
    expect(screen.getByText('Receipt')).toBeTruthy();
    expect(screen.getByText('Payment hash')).toBeTruthy();
    expect(sim.sendPreparedCalls).toBe(1); // reconcile never re-sends
  }, 20_000);

  it('a quote above the maximum Lightning fee is refused before anything is sent, in plain language', async () => {
    const sim = new MobileFlowSimulatedClient();
    await createAndBackup(sim);

    tab('Send');
    // 2,000 sats → cap max(0.5%, 10 sats) = 10 sats < the 30-sat swap fee.
    typeInto('Pay to', simInvoice(2_000_000n, 'e2e-cap'));
    click('Review payment');
    expect(await screen.findByText('The fee is higher than your limit')).toBeTruthy();
    expect(screen.getByText(textMatching(/Raise the maximum Lightning fee/))).toBeTruthy();
    expect(sim.sendPreparedCalls).toBe(0);
    expect(screen.getByLabelText('Pay to')).toBeTruthy(); // the draft stays for editing
  }, 20_000);

  it('on-chain send: address checked, amount validated in the user denomination, fee review, settlement', async () => {
    const sim = new MobileFlowSimulatedClient();
    await createAndBackup(sim);

    tab('Send');
    // Wrong network is refused before quoting.
    typeInto('Pay to', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    expect(await screen.findByText(textMatching(/This is a mainnet address, but this wallet is on regtest/))).toBeTruthy();
    click('Review payment'); // inert: nothing is quoted
    expect(sim.preparedQuotes.size).toBe(0);

    typeInto('Pay to', simSegwitAddress('regtest', 'e2e-dest'));
    expect(await screen.findByText('Bitcoin address')).toBeTruthy();
    typeInto('Amount (sats)', 'abc');
    expect(screen.getByText('Enter a whole number of sats.')).toBeTruthy();
    click('Review payment');
    expect(sim.preparedQuotes.size).toBe(0);
    typeInto('Amount (sats)', '50000');
    click('Review payment');
    expect(await screen.findByText('Fee')).toBeTruthy();
    expect(screen.getByText('50,030 sats')).toBeTruthy(); // total
    expect(screen.getByText(textMatching(/On-chain payments can't be reversed/))).toBeTruthy();

    click('Confirm and send');
    await screen.findByText(textMatching(/Payment in flight/));
    sim.settleEntry(sim.entries[sim.entries.length - 1]?.id ?? '');
    click('Check payment status');
    await screen.findByText('Payment sent.');
  }, 20_000);

  it('receive: fresh on-chain address with the reuse warning; swap-based invoice tracked until paid', async () => {
    const sim = new MobileFlowSimulatedClient();
    await createAndBackup(sim);

    tab('Receive');
    click('Generate address');
    const first = await screen.findByText(textMatching(/^bcrt1q[a-z0-9]{38}$/));
    expect(screen.getByText(textMatching(/Use this address once/))).toBeTruthy();
    const firstAddress = (first as unknown as DomLike).textContent;
    click('New address');
    await waitFor(() => {
      expect(screen.queryByText(firstAddress ?? '')).toBeNull();
    });

    click('Lightning');
    expect(screen.getByText(textMatching(/Invoices are paid through the swap service and need an amount/))).toBeTruthy();
    expect(screen.getByText(textMatching(/The wallet sets invoice expiry itself/))).toBeTruthy();
    typeInto('Amount (sats)', '25000');
    typeInto('Description (optional)', 'Coffee');
    click('Create invoice');
    expect(await screen.findByLabelText('QR code for your Lightning invoice')).toBeTruthy();
    expect(screen.getByText(textMatching(/^lnbcrt250u1/))).toBeTruthy();
    expect(screen.getByText('Waiting for payment')).toBeTruthy();
    expect(screen.getByText('Description: Coffee')).toBeTruthy();

    // The swap service pays it; the status comes from the wallet's own record.
    const receiveEntry = sim.entries.find((e) => e.kind === 'receive');
    sim.settleEntry(receiveEntry?.id ?? '');
    tab('Activity');
    tab('Receive');
    expect(await screen.findByText('Payment received.')).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
  }, 20_000);

  it('capabilities screen renders provider-declared disclosures, never hardcoded parity', async () => {
    const sim = new MobileFlowSimulatedClient();
    await createAndBackup(sim);

    click('How this wallet works');
    expect(await screen.findByText('Ark operator')).toBeTruthy();
    expect(screen.getByText('Swap service')).toBeTruthy();
    // Every declared operator dependency renders its verbatim disclosure —
    // the declaration is the single source, the screen never invents copy.
    for (const dependency of WAVELENGTH_DECLARATION.capabilities.operatorDependencies) {
      // Disclosures render verbatim wherever the screen repeats them (card + summary).
      expect(
        screen.getAllByText(textMatching(new RegExp(escapeRegExp(dependency.disclosure)))).length,
      ).toBeGreaterThan(0);
    }
    // Status strings repeat across the screen (dependency cards + summary rows).
    expect(screen.getAllByText('Available — hours to days, on-chain fees apply').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ark recovery phrase').length).toBeGreaterThan(0);
    expect(screen.getAllByText(textMatching(/Required for:/)).length).toBeGreaterThan(0);
  }, 20_000);

  it('tab bar: five tabs; Activity lists the send from the daemon, Send keeps its draft, Wallet shows live status', async () => {
    const sim = new MobileFlowSimulatedClient();
    await createAndBackup(sim);

    expect(screen.getAllByRole('tab').map((t) => attr(t, 'aria-label'))).toEqual([
      'Home',
      'Activity',
      'Send',
      'Receive',
      'Wallet',
    ]);
    expect(attr(screen.getByRole('tab', { name: 'Home' }), 'aria-selected')).toBe('true');

    // The status line comes from the last successful read, not the render clock.
    expect(screen.getByText(textMatching(/^Updated \d\d:\d\d:\d\d UTC$/))).toBeTruthy();
    expect(screen.getByText('regtest · Ark operator reachable')).toBeTruthy();

    tab('Activity');
    expect(await screen.findByText(textMatching(/No activity yet/))).toBeTruthy();

    tab('Send');
    const draft = simInvoice(10_000_000n, 'e2e-tab');
    typeInto('Pay to', draft);
    tab('Receive'); // a draft survives a tab switch
    tab('Send');
    expect(
      (screen.getByLabelText('Pay to') as unknown as { value: string }).value,
    ).toBe(draft);
    click('Review payment');
    await screen.findByText('Service fee');
    click('Confirm and send');
    await screen.findByText(textMatching(/Payment in flight/));

    tab('Activity');
    expect(await screen.findByText('Sent · Lightning')).toBeTruthy();
    expect(screen.getByLabelText(/^Sent · Lightning, .*, pending, /)).toBeTruthy();

    tab('Wallet');
    expect(await screen.findByText('Wavelength (Ark)')).toBeTruthy();
    expect(screen.getByText('Ark operator reachable')).toBeTruthy();
    // Capability rows render from walletCapabilities(), reasons included.
    click('Wallet management');
    expect(await screen.findByText(textMatching(/Loop needs your own Lightning node/))).toBeTruthy();
    click('Back');

    // A pushed screen gets a back control that returns to the tab root.
    click('How this wallet works');
    await screen.findByText('Services this wallet depends on');
    click('Back');
    await screen.findByText('Wavelength (Ark)');

    tab('Home');
    await screen.findByText('Everyday wallet');
  }, 20_000);

  it('privacy mode masks every amount and the BTC denomination formats exactly', async () => {
    const sim = new MobileFlowSimulatedClient();
    sim.depositVTXO('sim-vtxo-fresh', 150_000, 100);
    const preferences = createPreferencesStore(memoryPreferencesBackend());
    await preferences.load();
    await preferences.set({ denomination: 'btc' });
    render(
      <ModeAApp
        client={sim}
        network="regtest"
        dataDir="/tmp/sovereign-mobile-test"
        pollIntervalMs={600_000}
        preferences={preferences}
      />,
    );
    await awaitRuntimeReady();
    typeInto('Wallet password', 'e2e-password');
    click('Create a new wallet');
    await screen.findByText('Back up your wallet');
    click('I wrote the words down');
    SIM_WORDS.forEach((word, i) => typeInto(`Word ${String(i + 1).padStart(2, '0')}`, word));
    click('Confirm backup');
    expect(await screen.findByText('0.00150000')).toBeTruthy(); // hero total in BTC
    expect(screen.getByText('0.00150000 BTC')).toBeTruthy(); // Lightning bucket

    await act(() => preferences.set({ hideBalances: true }));
    expect(screen.queryByText('0.00150000 BTC')).toBeNull();
    expect(screen.getAllByLabelText('Amount hidden').length).toBeGreaterThan(0);
  }, 20_000);

  it('restore rejects a wrong-length phrase with the 12-or-24 rule', async () => {
    const sim = new MobileFlowSimulatedClient();
    render(<ModeAApp client={sim} network="regtest" dataDir="/tmp/sovereign-mobile-test" pollIntervalMs={600_000} />);
    await awaitRuntimeReady();
    click('I already have a recovery phrase');
    await screen.findByText('Restore from recovery phrase');

    typeInto('Recovery phrase', 'one two three');
    typeInto('Wallet password', 'e2e-password');
    click('Restore wallet');
    expect(
      await screen.findByText(textMatching(/A recovery phrase has 12 or 24 words/)),
    ).toBeTruthy();
    expect(sim.walletCreated).toBe(false);
  }, 20_000);

  it('restore succeeds from a valid phrase and reports recovered VTXOs', async () => {
    const sim = new MobileFlowSimulatedClient();
    render(<ModeAApp client={sim} network="regtest" dataDir="/tmp/sovereign-mobile-test" pollIntervalMs={600_000} />);
    await awaitRuntimeReady();
    click('I already have a recovery phrase');
    await screen.findByText('Restore from recovery phrase');

    typeInto('Recovery phrase', SIM_WORDS.join(' '));
    typeInto('Wallet password', 'e2e-password');
    click('Restore wallet');
    expect(await screen.findByText(textMatching(/3 spendable VTXOs recovered/))).toBeTruthy();
    expect(sim.restoredFromWords).toEqual([...SIM_WORDS]);

    click('Go to your wallet');
    await screen.findByText('Everyday wallet');
  }, 20_000);
});
