/**
 * Wallet tab e2e (headless, react-native-web): settings persist through the
 * preferences store, unsupported settings say why, the app lock covers the
 * app and unlocks with the right PIN, backups are recorded and checkable,
 * and node sessions can be listed and revoked with confirmation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NativeApp, { ModeAApp } from '../../App.js';
import { APP_LOCK_STORAGE_KEY, memorySecureStorage } from '../../flows/appLock.js';
import type { RemoteSessionSummary } from '../../flows/modeBRemoteController.js';
import type { PlatformServices } from '../../flows/platform.js';
import {
  createPreferencesStore,
  memoryPreferencesBackend,
  parseStoredPreferences,
} from '../../flows/preferences.js';
import type { PreferencesStore } from '../../flows/preferences.js';
import { MobileFlowSimulatedClient, SIM_WORDS } from '../../testing/simulatedWalletClient.js';
import { SimulatedLncPort } from '../../testing/simulatedLncPort.js';

const TEN_WORDS = 'abstract acid acrobat actor actual admit adopt adore advance adventure';

/** Reads a DOM attribute (the mobile tsconfig has no DOM lib). */
function attr(el: unknown, name: string): string | null {
  if (typeof el !== 'object' || el === null) return null;
  const getAttribute: unknown = Reflect.get(el, 'getAttribute');
  if (typeof getAttribute !== 'function') return null;
  const value: unknown = getAttribute.call(el, name);
  return typeof value === 'string' ? value : null;
}

function click(label: string | RegExp): void {
  fireEvent.click(screen.getByLabelText(label));
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function tab(name: 'Home' | 'Wallet'): void {
  fireEvent.click(screen.getByRole('tab', { name }));
}

async function open(label: string): Promise<void> {
  fireEvent.click(await screen.findByLabelText(label));
}

class SessionPort extends SimulatedLncPort {
  sessions: RemoteSessionSummary[] = [
    { localPublicKey: '02aa'.padEnd(66, '1'), label: 'This phone', state: 'in-use' },
    { localPublicKey: '03bb'.padEnd(66, '2'), label: 'Old laptop', state: 'created' },
  ];
  readonly revoked: string[] = [];
  listSessions = (): Promise<readonly RemoteSessionSummary[]> => Promise.resolve([...this.sessions]);
  revokeSession = (key: string): Promise<void> => {
    this.revoked.push(key);
    this.sessions = this.sessions.map((s) => (s.localPublicKey === key ? { ...s, state: 'revoked' } : s));
    return Promise.resolve();
  };
}

async function pairWith(
  port: SimulatedLncPort,
  options: { preferences?: PreferencesStore; platform?: PlatformServices } = {},
): Promise<void> {
  render(
    <NativeApp
      mode="remote-node"
      network="regtest"
      resolveLncPort={() => Promise.resolve(port)}
      preferences={options.preferences}
      platform={options.platform}
    />,
  );
  await screen.findByText('Connect your node');
  typeInto('Pairing phrase', TEN_WORDS);
  click('Connect');
  await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(5));
}

describe('Wallet tab settings', () => {
  afterEach(cleanup);

  it('changes persist through the preferences store and survive a reload', async () => {
    const backend = memoryPreferencesBackend();
    const preferences = createPreferencesStore(backend);
    await preferences.load();
    await pairWith(new SimulatedLncPort(), { preferences });
    tab('Wallet');
    await open('General');
    fireEvent.click(screen.getByRole('radio', { name: 'BTC' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Hide balances' }));
    await waitFor(() => {
      const stored = parseStoredPreferences(backend.snapshot());
      expect(stored.value.denomination).toBe('btc');
      expect(stored.value.hideBalances).toBe(true);
    });
    expect(attr(screen.getByRole('switch', { name: 'Hide balances' }), 'aria-checked')).toBe('true');

    // Unsupported settings are inert and say why.
    const haptics = screen.getByRole('switch', { name: 'Haptic feedback' });
    expect(attr(haptics, 'aria-disabled')).toBe('true');
    expect(screen.getByText(/This build has no haptics module/)).toBeTruthy();
    expect(screen.getByText(/dark-only for now/)).toBeTruthy();
    expect(screen.getByText(/No exchange-rate source is configured/)).toBeTruthy();

    // A fresh store over the same backend reads the saved values.
    const reloaded = createPreferencesStore(backend);
    const values = await reloaded.load();
    expect(values.denomination).toBe('btc');
    expect(values.hideBalances).toBe(true);
  });

  it('payment preferences say which settings this backend applies, and refuse invalid values', async () => {
    const preferences = createPreferencesStore(memoryPreferencesBackend());
    await preferences.load();
    await pairWith(new SimulatedLncPort(), { preferences });
    tab('Wallet');
    await open('Payment preferences');
    expect(screen.getByText(/The most you're willing to pay to complete a Lightning payment/)).toBeTruthy();
    // Invoice expiry is applied by this connection: selectable, marked applied, and persisted.
    fireEvent.click(screen.getByRole('radio', { name: '24 hours' }));
    await waitFor(() => expect(preferences.get().invoiceExpirySeconds).toBe(86_400));
    expect(screen.getByText('Set on each new invoice your node creates.')).toBeTruthy();
    // On-chain fee preference is not: the radios are inert and say why.
    const priority = screen.getByRole('radio', { name: 'Priority' });
    expect(attr(priority, 'aria-disabled')).toBe('true');
    fireEvent.click(priority);
    expect(preferences.get().onchainFeePreference).toBe('normal');
    expect(screen.getByText("On-chain sending isn't available over this connection yet.")).toBeTruthy();
    // Every applies/not-applied badge comes from capabilities.
    expect(screen.getAllByText(/Applied by this wallet|Not applied by this wallet/).length).toBeGreaterThan(0);
    // The store refuses out-of-bounds values outright.
    await expect(preferences.set({ maxLightningFeePpm: 999_999 })).rejects.toThrow(/0 to 50000/);
  });

  it('wallet rename persists per wallet type and validates', async () => {
    const preferences = createPreferencesStore(memoryPreferencesBackend());
    await preferences.load();
    await pairWith(new SimulatedLncPort(), { preferences });
    tab('Wallet');
    await open('Wallet management');
    click('Rename wallet');
    typeInto('Wallet name', '   ');
    click('Save name');
    expect(await screen.findByText('A wallet name cannot be empty.')).toBeTruthy();
    typeInto('Wallet name', 'Home node');
    click('Save name');
    await waitFor(() => expect(preferences.get().walletNames).toEqual({ 'remote-lnd': 'Home node' }));
    expect(screen.getByText(/Switching between wallets|Keeping several wallets/)).toBeTruthy();
  });
});

describe('App lock', () => {
  afterEach(cleanup);

  it('sets a PIN, locks, hides the app, refuses a wrong PIN and unlocks with the right one', async () => {
    const storage = memorySecureStorage();
    await pairWith(new SimulatedLncPort(), { platform: { secureStorage: storage } });
    tab('Wallet');
    await open('Security and recovery');
    expect(screen.getByText(/Kept in memory for this session only/)).toBeTruthy();
    // Biometric unlock is unavailable without a host prompt — inert, with the reason.
    expect(attr(screen.getByRole('switch', { name: 'Biometric unlock' }), 'aria-disabled')).toBe('true');

    click('Set up PIN');
    typeInto('New PIN', '123456');
    typeInto('Confirm new PIN', '123456');
    click('Set PIN');
    expect(await screen.findByText(/straight run of digits/)).toBeTruthy();
    typeInto('New PIN', '482913');
    typeInto('Confirm new PIN', '482913');
    click('Set PIN');
    await screen.findByText('PIN set. The app now opens locked.', {}, { timeout: 15_000 });
    expect(storage.dump().get(APP_LOCK_STORAGE_KEY)).not.toContain('482913');

    click('Lock now');
    await screen.findByText('Wallet locked');
    // The app underneath is hidden from assistive tech and the tab bar is unreachable.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);

    typeInto('PIN', '000001');
    click('Unlock');
    expect(await screen.findByText(/Wrong PIN\. 4 tries before a wait\./, {}, { timeout: 15_000 })).toBeTruthy();
    typeInto('PIN', '482913');
    click('Unlock');
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(5), { timeout: 15_000 });
    expect(screen.queryByText('Wallet locked')).toBeNull();
  }, 60_000);

  it('opens locked on launch when a PIN exists', async () => {
    const storage = memorySecureStorage();
    const first = await (async () => {
      const { AppLock } = await import('../../flows/appLock.js');
      const lock = new AppLock({ storage, lockTimeoutSeconds: () => 300 });
      await lock.load();
      return lock.setPin('482913');
    })();
    expect(first).toEqual({ ok: true });
    render(
      <NativeApp
        mode="remote-node"
        network="regtest"
        resolveLncPort={() => Promise.resolve(new SimulatedLncPort())}
        platform={{ secureStorage: storage }}
      />,
    );
    expect(await screen.findByText('Wallet locked')).toBeTruthy();
    expect(screen.getByText('Enter your PIN to open your wallet.')).toBeTruthy();
  }, 30_000);

  it('turning on biometric unlock asks for the PIN before the biometric prompt', async () => {
    const storage = memorySecureStorage();
    const prompts: string[] = [];
    const { AppLock } = await import('../../flows/appLock.js');
    const seed = new AppLock({ storage, lockTimeoutSeconds: () => 300 });
    await seed.load();
    expect(await seed.setPin('482913')).toEqual({ ok: true });
    const platform: PlatformServices = {
      secureStorage: storage,
      authenticateBiometric: (reason) => {
        prompts.push(reason);
        return Promise.resolve(true);
      },
    };
    render(
      <NativeApp
        mode="remote-node"
        network="regtest"
        resolveLncPort={() => Promise.resolve(new SimulatedLncPort())}
        platform={platform}
      />,
    );
    await screen.findByText('Wallet locked');
    typeInto('PIN', '482913');
    click('Unlock');
    await screen.findByText('Connect your node', {}, { timeout: 15_000 });
    typeInto('Pairing phrase', TEN_WORDS);
    click('Connect');
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(5));
    tab('Wallet');
    await open('Security and recovery');
    fireEvent.click(screen.getByRole('switch', { name: 'Biometric unlock' }));
    expect(await screen.findByText(/Enter your PIN, then confirm with your fingerprint or face/)).toBeTruthy();
    expect(prompts).toEqual([]); // nothing prompted before the PIN
    typeInto('Current PIN', '000001');
    click('Continue');
    expect(await screen.findByText(/Wrong PIN/, {}, { timeout: 15_000 })).toBeTruthy();
    expect(prompts).toEqual([]);
    typeInto('Current PIN', '482913');
    click('Continue');
    await screen.findByText('Biometric unlock is on. Your PIN still works too.', {}, { timeout: 15_000 });
    expect(prompts).toEqual(['Turn on biometric unlock']);
    expect(JSON.parse(storage.dump().get(APP_LOCK_STORAGE_KEY) ?? '{}')).toMatchObject({ biometric: true });
  }, 60_000);
});

describe('Backup (everyday wallet)', () => {
  afterEach(cleanup);

  it('records the verified backup at creation and checks a written copy later', async () => {
    const sim = new MobileFlowSimulatedClient();
    render(
      <ModeAApp
        client={sim}
        network="regtest"
        dataDir="/tmp/sovereign-mobile-test"
        pollIntervalMs={600_000}
        platform={{ secureStorage: memorySecureStorage() }}
      />,
    );
    await waitFor(() => expect(attr(screen.getByLabelText('Create a new wallet'), 'aria-disabled')).not.toBe('true'));
    typeInto('Wallet password', 'e2e-password');
    click('Create a new wallet');
    await screen.findByText('Back up your wallet');
    click('I wrote the words down');
    for (let i = 0; i < SIM_WORDS.length; i += 1) {
      typeInto(`Word ${String(i + 1).padStart(2, '0')}`, SIM_WORDS[i] ?? '');
    }
    click('Confirm backup');
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(5));

    tab('Wallet');
    await open('Security and recovery');
    // Ark VTXOs are taproot outputs: stated as exposed, never as quantum-safe.
    expect(screen.getByText(/Your Ark funds \(VTXOs\) are taproot outputs/)).toBeTruthy();
    expect(screen.getByText('Exposed')).toBeTruthy();
    await open('Backup');
    expect(await screen.findByText('Every word verified', {}, { timeout: 15_000 })).toBeTruthy();
    typeInto('Recovery phrase', [...SIM_WORDS.slice(0, 11), 'zoo'].join(' '));
    click('Check phrase');
    expect(await screen.findByText(/doesn't match this wallet/, {}, { timeout: 15_000 })).toBeTruthy();
    typeInto('Recovery phrase', SIM_WORDS.join(' '));
    click('Check phrase');
    expect(await screen.findByText(/That matches/, {}, { timeout: 15_000 })).toBeTruthy();
  }, 60_000);
});

describe('Network and sessions (remote node)', () => {
  afterEach(cleanup);

  it('shows the fixed network and node, and revokes another session after confirmation', async () => {
    const port = new SessionPort();
    await pairWith(port);
    tab('Wallet');
    await open('Network and connection');
    expect(screen.getByText(/The app has no network switch/)).toBeTruthy();
    expect(screen.getByText('sim-node')).toBeTruthy();
    click('Load sessions');
    expect(await screen.findByText('Old laptop')).toBeTruthy();
    click('Revoke Old laptop');
    expect(await screen.findByText('Revoke this session?')).toBeTruthy();
    expect(port.revoked).toEqual([]); // nothing happens before confirming
    click('Revoke session');
    await screen.findByText(/Session revoked\. Apps using it can no longer reach your node\./);
    expect(port.revoked).toEqual(['03bb'.padEnd(66, '2')]);
    // This phone's session is still connected.
    expect(screen.getAllByRole('tab')).toHaveLength(5);
  });

  it('points to the desktop app for quantum exposure (the LNC port has no coin list)', async () => {
    await pairWith(new SimulatedLncPort());
    tab('Wallet');
    await open('Security and recovery');
    expect(screen.getByText('See the desktop app')).toBeTruthy();
    expect(screen.getByText(/this connection does not read/)).toBeTruthy();
  });

  it('says why sessions are unavailable when the port cannot list them', async () => {
    await pairWith(new SimulatedLncPort());
    tab('Wallet');
    await open('Network and connection');
    expect(screen.getByText(/This connection can't list node sessions/)).toBeTruthy();
  });
});
