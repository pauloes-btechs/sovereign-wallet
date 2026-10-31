/**
 * Desktop Mode B e2e against the REAL regtest chain: compose stack
 * (bitcoind + 2×LND + litd) plus a fresh litd sidecar binary launched by
 * the REAL bridge process, with the app in plain-browser mode pointed at
 * the bridge through the same-origin /modeb proxy — the SAME session code
 * the packaged Tauri app executes; only the transport bootstrap differs.
 *
 * Ordered single-worker flows (one shared wallet, one shared channel):
 * create → on-chain receive/send → channel open → Lightning out/in →
 * diagnostics → SCB export.
 *
 * Regtest only. No mainnet anywhere in this file.
 */
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Invoice, Payment_PaymentStatus, RouterClient, type SendPaymentUpdate } from '@sovereign/litd-proto';
import {
  ALICE,
  bitcoinSendTo,
  getNewAddress,
  makeLightningClient,
  makeTransport,
  mineBlocks,
  waitForTxInMempool,
} from '@sovereign/harness-regtest';
import { MODEB_BOOTSTRAP_FILE, type ModeBE2eBootstrap } from './bootstrap-path.js';

let bootstrap: ModeBE2eBootstrap;

// Visual-evidence captures land here; CI uploads the directory and the
// QA flow attaches the PNGs to the PR against the tested head SHA.
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? 'test-results/modeb-evidence';

async function capture(page: Page, name: string): Promise<void> {
  const path = join(ARTIFACT_DIR, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

test.beforeAll(async () => {
  bootstrap = JSON.parse(await readFile(MODEB_BOOTSTRAP_FILE, 'utf8')) as ModeBE2eBootstrap;
});

/**
 * Opens the app in dev/e2e mode against the live bridge. The bridge is
 * reached through the vite same-origin proxy (/modeb).
 */
function openApp(page: Page): Promise<void> {
  const params = new URLSearchParams({
    mode: 'b',
    devBridgeUrl: '/modeb',
    devBridgeToken: bootstrap.bridgeToken,
  });
  return page.goto(`/?${params.toString()}`);
}

/** Navigate by clicking the tab buttons in the Mode B nav. */
async function gotoTab(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
}

/**
 * Force a dashboard remount (refetch) and read the total balance as a
 * bigint, retrying until the predicate holds — Neutrino sync trails the
 * chain by a few seconds after mining.
 */
async function pollTotalBalance(
  page: Page,
  predicate: (sats: bigint) => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  // expect.poll chains Playwright matchers only — poll a boolean and toBe(true).
  // (`.satisfies` is a Jest API; chaining it here threw a TypeError in CI.)
  await expect
    .poll(async () => {
      await gotoTab(page, 'On-chain');
      await gotoTab(page, 'Overview');
      const text = await page.getByTestId('balance-total').textContent();
      const digits = (text ?? '').replace(/[^\d]/g, '');
      return digits !== '' && predicate(BigInt(digits));
    }, { timeout: timeoutMs, interval: 5_000 })
    .toBe(true);
}

test('create → ready: aezeed wallet creation over the real sidecar', async ({ page }) => {
  await openApp(page);

  // Fresh sidecar reports phase 'missing' → onboarding choice, verbatim.
  await expect(page.getByRole('heading', { name: 'Advanced node setup' })).toBeVisible();

  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  await page.getByRole('button', { name: 'Generate seed' }).click();

  // 24-word aezeed, shown once, with the write-down confirmation.
  await expect(page.getByTestId('seed-words').locator('li')).toHaveCount(24);

  await page.getByLabel(/I have written the 24 words/).check();
  await page.getByLabel('Unlock password (min 8 chars)').fill('correct horse battery staple');
  await page.getByLabel('Confirm password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create wallet' }).click();

  // Ready wallet: node health renders from the live sidecar.
  await expect(page.getByTestId('node-health')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('node-health')).toContainText(/synced to chain/);
  await capture(page, 'tc-1-wallet-created-dashboard');
});

test('on-chain receive: a mined deposit reaches the Neutrino wallet', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('node-health')).toBeVisible({ timeout: 30_000 });

  await gotoTab(page, 'On-chain');
  await page.getByRole('button', { name: 'New address' }).click();
  const address = await page.getByTestId('receive-address').textContent();
  expect(address ?? '').toMatch(/^bcrt1/);

  // Pay the wallet from the harness bitcoind and mine the deposit.
  const txid = await bitcoinSendTo(address!.trim(), 0.5);
  await waitForTxInMempool(txid);
  await mineBlocks(1);

  await pollTotalBalance(page, (sats) => sats >= 50_000_000n);
  await expect(page.getByTestId('balance-confirmed')).toContainText('50,000,000');
  await capture(page, 'tc-2-onchain-funded');
});

test('on-chain send: review → authorize → txid, verified in the mempool', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('node-health')).toBeVisible({ timeout: 30_000 });

  const dest = await getNewAddress();

  await gotoTab(page, 'On-chain');
  await page.getByLabel('Bitcoin address').fill(dest);
  await page.getByLabel('Amount (sats)').fill('100000000'); // 0.1 BTC
  await page.getByLabel('Fee rate (sat/vbyte)').fill('2');
  await page.getByRole('button', { name: 'Review send' }).click();
  await page.getByRole('button', { name: 'Authorize and send' }).click();

  const txid = await page.getByTestId('send-txid').textContent();
  expect(txid ?? '').toMatch(/[0-9a-f]{64}/);
  await expect(page.getByTestId('send-error')).toHaveCount(0);

  await waitForTxInMempool((txid ?? '').match(/[0-9a-f]{64}/)![0]);
  await mineBlocks(1);
});

test('channel open: pending (confirming funding) → open after 6 blocks', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('node-health')).toBeVisible({ timeout: 30_000 });

  await gotoTab(page, 'Channels');
  await page.getByLabel('Peer node pubkey (66 hex)').fill(bootstrap.peerPubkey);
  await page.getByLabel(/Peer host/).fill(bootstrap.peerHost);
  await page.getByLabel('Funding amount (sats, min 20,000)').fill('100000000');
  await page.getByRole('button', { name: 'Open channel' }).click();

  await expect(page.getByTestId('channel-opened')).toBeVisible();

  // Pending row while the funding tx confirms — with the honest label.
  await expect(page.getByTestId('pending-channels')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('pending-channels')).toContainText('confirming funding transaction');

  // Funding tx → mempool → 6 confirmations → channel goes active.
  const channelPoint = await page
    .getByTestId('pending-channels')
    .getByTestId('channel-row')
    .first()
    .getAttribute('data-channel-point');
  if (channelPoint !== null && channelPoint !== '') {
    await waitForTxInMempool(channelPoint.split(':')[0]);
  }
  await mineBlocks(6);

  await gotoTab(page, 'Overview');
  await gotoTab(page, 'Channels');
  await expect(page.getByTestId('open-channels')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('open-channels').getByTestId('channel-row').first()).toContainText('open');
  // Channel funds appear in the Lightning balance card.
  await expect(page.getByTestId('channel-balance')).toContainText('Spendable');
  await capture(page, 'tc-4-channel-open');
});

test('lightning outbound: decode → review → pay succeeds over the channel', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('node-health')).toBeVisible({ timeout: 30_000 });

  // Alice requests 21,000 sats; our wallet pays her over the fresh channel.
  const alice = await makeLightningClient(ALICE);
  const invoice = await alice
    .addInvoice(Invoice.create({ memo: 'e2e outbound', value: 21_000n }))
    .then((call) => call.response);
  expect(invoice.paymentRequest).toMatch(/^lntb/);

  await gotoTab(page, 'Lightning');
  await page.getByLabel('Invoice (BOLT-11)').fill(invoice.paymentRequest);
  await page.getByRole('button', { name: 'Decode and review' }).click();

  await expect(page.getByTestId('payment-review')).toContainText('21,000');
  // Advanced routing settings are visible, not buried: fixed fee cap default.
  await page.getByLabel('Fee cap (sats)').fill('5000');
  await page.getByRole('button', { name: /Pay 21,000 sats/ }).click();

  await expect(page.getByTestId('payment-outcome')).toContainText('succeeded', { timeout: 60_000 });
  await expect(page.getByTestId('pay-error')).toHaveCount(0);
  await capture(page, 'tc-5-lightning-payment-succeeded');
});

test('lightning inbound: alice pays our invoice through the channel', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('node-health')).toBeVisible({ timeout: 30_000 });

  await gotoTab(page, 'Lightning');
  await page.getByLabel('Amount (sats — leave empty for a zero-amount invoice)').fill('12000');
  await page.getByRole('button', { name: 'Create invoice' }).click();
  const ourInvoice = await page.getByTestId('invoice-request').textContent();
  expect(ourInvoice ?? '').toMatch(/^lntb/);

  // Alice pays it over the channel (router streaming API).
  const transport = await makeTransport(ALICE);
  const router = new RouterClient(transport);
  const updates: SendPaymentUpdate[] = [];
  for await (const update of router
    .sendPaymentV2({ paymentRequest: ourInvoice!.trim(), noInflightLimit: true }).responses) {
    updates.push(update);
    if (update.state !== Payment_PaymentStatus.IN_FLIGHT) break;
  }
  expect(updates.length).toBeGreaterThan(0);
  expect(updates[updates.length - 1].state).toBe(Payment_PaymentStatus.SUCCEEDED);
});

test('diagnostics: node health renders live data; faraday section honest either way', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('node-health')).toBeVisible({ timeout: 30_000 });

  await gotoTab(page, 'Node health');
  await expect(page.getByTestId('diagnostics-node')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('diagnostics-node')).toContainText(/synced to chain/);
  await expect(page.getByTestId('diagnostics-node')).toContainText(/height \d+/);

  // Faraday either answers (data) or discloses unavailability — never blank.
  await expect(page.getByTestId('faraday-available').or(page.getByTestId('faraday-unavailable'))).toBeVisible();
  // Forwarded payments section renders (possibly the honest empty state).
  await expect(page.getByTestId('forwarding-events').or(page.getByText('No forwarded payments'))).toBeVisible();
});

test('backups: SCB export offers a multi-channel backup blob', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('node-health')).toBeVisible({ timeout: 30_000 });

  await gotoTab(page, 'Backups');
  await page.getByRole('button', { name: 'Export channel backup' }).click();
  await expect(page.getByTestId('backup-hex')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('backup-hex')).toContainText(/hex chars/);
});
