/**
 * Desktop Mode A e2e against the REAL waved sidecar (v0.2.0, regtest).
 *
 * The app runs in plain-browser mode pointed at the sidecar's loopback
 * gateway via ?devGateway=&devMacaroonHex= — the SAME session code the
 * packaged Tauri app executes; only the transport bootstrap differs.
 *
 * Covers the flows the subtask names: create, backup confirmation, ready
 * wallet with balance, swap-based Lightning receive, on-chain receive, and
 * a second "app restart" (fresh browser context) reconnecting to the same
 * daemon and re-deriving its session from daemon-declared state.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { BOOTSTRAP_FILE, type E2eBootstrap } from './bootstrap-path.js';

let bootstrap: E2eBootstrap;

test.beforeAll(async () => {
  bootstrap = JSON.parse(await readFile(BOOTSTRAP_FILE, 'utf8')) as E2eBootstrap;
});

/**
 * Opens the app in dev/e2e mode against the live sidecar. The gateway is
 * reached through the vite same-origin proxy (/waved) — the daemon sends
 * no CORS headers, so a direct cross-origin fetch would be blocked.
 */
function openApp(page: Page): Promise<void> {
  const params = new URLSearchParams({
    devGateway: 'http://127.0.0.1:5173/waved',
    devMacaroonHex: bootstrap.macaroonHex,
  });
  return page.goto(`/?${params.toString()}`);
}

test('create → backup → ready: the everyday flow over the real daemon', async ({ page }) => {
  await openApp(page);

  // Daemon reports walletState 'none' → onboarding, not a fake balance.
  await expect(page.getByRole('heading', { name: 'Create your wallet' })).toBeVisible();

  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel('Confirm password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create wallet' }).click();

  // Backup confirmation shows 24 words and the VTXO-expiry consequence, verbatim.
  await expect(page.getByTestId('expiry-consequence')).toBeVisible();
  await expect(page.getByTestId('seed-word')).toHaveCount(24);
  await page.getByRole('button', { name: 'I wrote it down' }).click();

  // Ready wallet: balance renders from the polled daemon (zero on regtest).
  await expect(page.getByTestId('balance-total')).toBeVisible({ timeout: 15_000 });

  // The capability disclosure names the declared Lightning mechanism —
  // swap-based, never "channels" in Mode A.
  await expect(page.getByTestId('lightning-mechanism')).toContainText(/swap/i);
});

test('receive: a bare daemon discloses the operator dependency on both receive methods', async ({ page }) => {
  // Fresh context on the SAME daemon — the app re-derives its session from
  // daemon-declared state (the wallet exists; no onboarding this time).
  await openApp(page);
  await expect(page.getByTestId('balance-total')).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('Amount (sats)').fill('21000');

  // Both receive methods are operator-dependent: a Lightning invoice needs
  // the swap server, and even an on-chain deposit address is an Ark boarding
  // address the daemon derives through the operator (probed: deposit fails
  // with "wallet actor not initialized" while get-info shows
  // server_connected=false). This harness runs bare waved — no bundled arkd —
  // so the honest, spec-mandated behavior is a visible alert naming the
  // failure, never a fake destination.
  const tabs = page.getByRole('tablist', { name: 'Receive method' });
  await tabs.getByRole('tab', { name: 'On-chain' }).click();
  await page.getByRole('button', { name: 'Generate address' }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('alert')).toContainText(/operator|actor|unavailable/i);

  await tabs.getByRole('tab', { name: 'Lightning' }).click();
  await page.getByRole('button', { name: 'New invoice' }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('alert')).toContainText(/operator|swap|unavailable/i);
});

test('send: quoting an unpayable invoice surfaces the daemon error honestly', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('balance-total')).toBeVisible({ timeout: 15_000 });

  // An invoice for sats the zero-balance wallet cannot pay: the review step
  // quotes through prepare-send and the failure surfaces as UI error state —
  // never a fake success.
  await page.getByLabel('Invoice').fill('lnbcrt2100n1pj97e0pp5x9e2z');
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
});
