/**
 * Mode A screen e2e (headless) — the REAL stack (WavelengthProvider +
 * PaymentDispatcher + PaymentEngine + ModeAController + RN screens) driven
 * through rendered interactions, with only the daemon simulated. Mirrors the
 * brief's mobile flows: create, backup confirmation, restore, send
 * (both rails), receive, VTXO states, capability disclosures.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WAVELENGTH_DECLARATION } from '@sovereign/wallet-core';
import { ModeAApp } from '../App.js';
import {
  MobileFlowSimulatedClient,
  SIM_WORDS,
} from '../testing/simulatedWalletClient.js';

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
  await screen.findByText('Wallet');
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
    expect(screen.queryByText('Wallet')).toBeNull();

    // Fixing the word completes the backup and lands on Home.
    typeInto('Word 12', SIM_WORDS[11] ?? '');
    click('Confirm backup');
    await screen.findByText('Wallet');
  }, 20_000);

  it('Home renders the three buckets and the expiring VTXO roll-forward notice from live balances', async () => {
    const sim = new MobileFlowSimulatedClient();
    sim.depositVTXO('sim-vtxo-fresh', 150_000, 100);
    sim.depositVTXO('sim-vtxo-expiring', 50_000, 10);
    await createAndBackup(sim);

    // providerTotalSat sums every bucket — spendable 200k + locked/expiring 50k.
    // Known shared-helper overlap: a still-spendable expiring VTXO counts in both.
    expect(await screen.findByText('250,000')).toBeTruthy(); // provider total (big figure)
    expect(screen.getByText('Lightning (spendable)')).toBeTruthy();
    expect(screen.getByText('On-chain (confirmed)')).toBeTruthy();
    expect(screen.getByText('Locked / expiring')).toBeTruthy();
    // Both VTXOs stay spendable until expiry — the expiring one also surfaces
    // in the locked/expiring bucket as the roll-forward notice amount.
    expect(screen.getByText('200,000 sats')).toBeTruthy(); // spendable
    expect(screen.getByText('0 sats')).toBeTruthy(); // on-chain confirmed
    expect(screen.getByText('50,000 sats')).toBeTruthy(); // locked / expiring
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

  it('Lightning send: review shows the swap fee, dispatch goes in-flight, reconcile settles it', async () => {
    const sim = new MobileFlowSimulatedClient();
    await createAndBackup(sim);

    click('Send');
    typeInto('Lightning invoice', 'lnbcrt1-sim-test-invoice');
    click('Review payment');
    expect(await screen.findByText('Service fee')).toBeTruthy();
    expect(screen.getByText('30 sats')).toBeTruthy(); // sim.swapFeeSat
    expect(screen.getByText(textMatching(/swap service routes this payment/))).toBeTruthy();

    click('Confirm and send');
    await screen.findByText(textMatching(/Payment in flight/));
    expect(sim.sendPreparedCalls).toBe(1);

    sim.settleEntry(sim.entries[sim.entries.length - 1]?.id ?? '');
    click('Check payment status');
    await screen.findByText('Payment sent.');
  }, 20_000);

  it('on-chain send: amount validation, fee review, settlement', async () => {
    const sim = new MobileFlowSimulatedClient();
    await createAndBackup(sim);

    click('Send');
    click('On-chain');
    typeInto('Recipient address', 'bcrt1q-sim-destination');
    typeInto('Amount (sats)', '50000');
    click('Review payment');
    expect(await screen.findByText('Service fee')).toBeTruthy();

    click('Confirm and send');
    await screen.findByText(textMatching(/Payment in flight/));
    sim.settleEntry(sim.entries[sim.entries.length - 1]?.id ?? '');
    click('Check payment status');
    await screen.findByText('Payment sent.');
  }, 20_000);

  it('receive: generates an on-chain address and a swap-based Lightning invoice', async () => {
    const sim = new MobileFlowSimulatedClient();
    await createAndBackup(sim);

    click('Receive');
    click('Generate address');
    expect(await screen.findByText(textMatching(/bcrt1q-sim-board/))).toBeTruthy();

    click('Lightning');
    expect(
      screen.getByText(textMatching(/Lightning via swap service/)),
    ).toBeTruthy();
    typeInto('Amount (sats)', '25000');
    click('New invoice');
    expect(await screen.findByText(textMatching(/lnbcrt1-sim/))).toBeTruthy();
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
    await screen.findByText('Wallet');
  }, 20_000);
});
