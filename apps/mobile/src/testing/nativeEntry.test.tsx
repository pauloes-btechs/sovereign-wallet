/**
 * Native entry states — headless over React Native Web. The native shell
 * (iOS/Android projects) injects `resolveClient`; these tests pin the three
 * diagnosable states the entry guarantees: not configured, starting/failed,
 * and mounted with a resolved client.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { WavelengthClient } from '@sovereign/wavelength-adapter';
import NativeApp from '../App.js';
import { MobileFlowSimulatedClient } from './simulatedWalletClient.js';

describe('Mode A native entry', () => {
  afterEach(cleanup);

  it('without a resolver it names the missing configuration instead of rendering blank', () => {
    render(<NativeApp />);
    expect(
      screen.getByText(textContaining('Native shell not configured')),
    ).toBeTruthy();
  });

  it('resolver failure surfaces the error instead of a blank screen', async () => {
    render(<NativeApp resolveClient={() => Promise.reject(new Error('binding crashed'))} />);
    await screen.findByText(textContaining('The wallet failed to start: binding crashed'));
  });

  it('a resolved client mounts the real Mode A app on onboarding', async () => {
    const sim = new MobileFlowSimulatedClient();
    render(
      <NativeApp
        resolveClient={(): Promise<WavelengthClient> => Promise.resolve(sim)}
        network="regtest"
        dataDir="/tmp/sovereign-mobile-test"
      />,
    );
    await screen.findByText('Sovereign Wallet');
    // The controller starts the provider; onboarding unlocks once ready.
    await waitFor(() => {
      const create = screen.getByLabelText('Create a new wallet') as unknown as {
        getAttribute(name: string): string | null;
      };
      expect(create.getAttribute('aria-disabled')).not.toBe('true');
    });
    expect(sim.walletCreated).toBe(false); // no wallet was silently created
  }, 20_000);
});

/** Matches any element whose full text contains the given fragment. */
function textContaining(fragment: string): (content: string) => boolean {
  return (content) => content.includes(fragment);
}
