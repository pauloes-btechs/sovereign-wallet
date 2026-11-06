/**
 * Transfers, liquidity, Loop and assets screens (headless) — the real
 * ModeBRemoteController and screens over the simulated node, plus the
 * everyday wallet's Transfers picker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WAVELENGTH_DECLARATION } from '@sovereign/wallet-core';
import { ModeBRemoteController } from '../../flows/modeBRemoteController.js';
import { wavelengthCapabilities } from '../../flows/capabilities.js';
import { NO_PLATFORM_SERVICES } from '../../flows/platform.js';
import type { RouteEnv } from '../../flows/transfers.js';
import { SimulatedLncPort } from '../../testing/simulatedLncPort.js';
import { simulatedAssetAddress } from '../../testing/simulatedLiquidity.js';
import { ModeBRemoteApp } from '../modeBScreens.js';
import { MobileAppProvider } from '../appContext.js';
import { createPreferencesStore, memoryPreferencesBackend } from '../../flows/preferences.js';
import { TransfersScreen } from './TransfersScreen.js';

const TEN_WORDS = 'abstract acid acrobat actor actual admit adopt adore advance adventure';

async function paired(): Promise<{ controller: ModeBRemoteController; advance: (ms: number) => void; port: SimulatedLncPort }> {
  let now = Date.parse('2026-11-05T12:00:00Z');
  const port = new SimulatedLncPort(() => new Date(now));
  const controller = new ModeBRemoteController({ port, network: 'regtest', pollIntervalMs: 3_600_000 });
  controller.enterPairingPhrase(TEN_WORDS);
  await controller.pair();
  render(<ModeBRemoteApp controller={controller} network="regtest" />);
  return { controller, port, advance: (ms) => (now += ms) };
}

describe('remote node: liquidity → Loop Out → progress', () => {
  afterEach(() => {
    cleanup();
  });

  it('recommends Loop Out for low receiving capacity and runs it to completion', async () => {
    const { controller, advance } = await paired();
    act(() => controller.navigate('liquidity'));
    expect(await screen.findByText(/You can receive only/)).toBeTruthy();
    expect(screen.getByText(/Simulated node:/)).toBeTruthy();
    fireEvent.click(await screen.findByLabelText('Loop Out to receive more'));

    expect(await screen.findByText(/Swap server limits: 100,000 to 2,000,000 sats/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Get quote'));
    expect(await screen.findByText('Total fees you approve')).toBeTruthy();
    expect(screen.getByText('Of which paid up front')).toBeTruthy();
    expect(screen.getByText(/your confirm tap is the only authorization/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Start Loop Out'));

    expect(await screen.findByText('Progress')).toBeTruthy();
    expect(screen.getByText(/Waiting for the swap server to lock the funds on-chain/)).toBeTruthy();
    advance(15_000);
    expect(await screen.findByText(/Loop Out completed/, {}, { timeout: 4_000 })).toBeTruthy();
    expect(screen.getByText('Receipt')).toBeTruthy();
    controller.stop();
  });

  it('a Loop In without inbound room is caught before quoting the user into it', async () => {
    const { controller } = await paired();
    act(() => controller.navigate('swap-flow', { direction: 'loop-in', amount: '300000' }));
    await screen.findByText(/Swap server limits/);
    fireEvent.click(screen.getByLabelText('Get quote'));
    expect(await screen.findByText(/Your channels can receive at most/)).toBeTruthy();
    controller.stop();
  });
});

describe('remote node: assets', () => {
  afterEach(cleanup);

  it('lists assets as issuer unverified and flags a stablecoin name', async () => {
    const { controller } = await paired();
    act(() => controller.navigate('assets'));
    expect(await screen.findByText('beans')).toBeTruthy();
    expect(screen.getAllByText('Issuer unverified').length).toBe(2);
    expect(screen.getByText('Possible imitation')).toBeTruthy();
    controller.stop();
  });

  it('decodes, reviews and sends an asset', async () => {
    const { controller, port } = await paired();
    const beans = port.liquidity.listAssets().find((a) => a.name === 'beans');
    if (beans === undefined) throw new Error('no beans');
    act(() => controller.navigate('assets'));
    act(() => controller.navigate('asset', { id: beans.assetIdHex }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    fireEvent.change(await screen.findByLabelText('Taproot Assets address'), {
      target: { value: simulatedAssetAddress(beans.assetIdHex, 40n) },
    });
    fireEvent.click(screen.getByLabelText('Review send'));
    fireEvent.click(await screen.findByLabelText('Send 40 units'));
    expect(await screen.findByText(/Sent\. Your node broadcast the anchor transaction/)).toBeTruthy();
    expect(screen.getByText('On-chain fee paid')).toBeTruthy();
    controller.stop();
  });
});

describe('everyday wallet: Transfers picker', () => {
  afterEach(cleanup);

  it('offers only Wavelength routes and hands off to Send', () => {
    const env: RouteEnv = {
      backend: 'wavelength',
      features: wavelengthCapabilities({
        declared: WAVELENGTH_DECLARATION.capabilities,
        walletReady: true,
        operatorReachable: true,
        platform: NO_PLATFORM_SERVICES,
      }).features,
      lightningSpendableSat: 50_000n,
      onchainSat: null,
      receivableSat: null,
      activeChannels: null,
      loopRunnable: false,
      loopTermsError: null,
      assetCount: null,
    };
    const onHandoff = vi.fn();
    const preferences = createPreferencesStore(memoryPreferencesBackend());
    render(
      <MobileAppProvider preferences={preferences} platform={NO_PLATFORM_SERVICES}>
        <TransfersScreen env={env} simulated={false} onBack={() => undefined} onStartSwap={() => undefined} onHandoff={onHandoff} />
      </MobileAppProvider>,
    );
    expect(screen.queryByText(/Lightning balance/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Bitcoin address'));
    expect(screen.getByText('Withdraw on-chain')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Continue in Send'));
    expect(onHandoff).toHaveBeenCalledWith('send-onchain');
    fireEvent.click(screen.getByLabelText('Another blockchain'));
    expect(screen.getByText(/There is no cross-chain route/)).toBeTruthy();
  });
});
