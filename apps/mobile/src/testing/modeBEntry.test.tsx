/**
 * Mode B native entry states — headless over React Native Web, following the
 * Mode A entry test pattern: diagnosable states, never a blank screen, and a
 * mounted pairing screen once the shell resolves an LNC port.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import NativeApp from '../App.js';
import type { LncRpcPort } from '../flows/modeBRemoteController.js';

function fakePort(): LncRpcPort {
  return {
    async connect() {
      return undefined;
    },
    async disconnect() {
      return undefined;
    },
    isConnected: () => false,
    onConnectionEvent: () => () => undefined,
    async getInfo() {
      return {
        identityPubkey: '02' + 'a'.repeat(62),
        alias: 'home-node',
        version: 'test',
        network: 'regtest',
        blockHeight: 1,
      };
    },
    async getBalances() {
      return { lightningSpendableSat: 1n, onchainConfirmedSat: 0n, channels: [] };
    },
    async addInvoice() {
      return { bolt11: 'lnbcrt1test' };
    },
    async payInvoice() {
      return { outcome: { status: 'settled', backendRef: 'x' } as const };
    },
    async lookupPayment() {
      return { status: 'unknown' } as const;
    },
  } as unknown as LncRpcPort;
}

describe('Mode B native entry', () => {
  afterEach(cleanup);

  it('remote-node mode without an LNC resolver names the missing configuration', () => {
    render(<NativeApp mode="remote-node" />);
    expect(
      screen.getByText((text) => text.includes('LNC port resolver')),
    ).toBeTruthy();
  });

  it('a resolved LNC port mounts the remote-node pairing screen', async () => {
    render(
      <NativeApp
        mode="remote-node"
        network="regtest"
        resolveLncPort={() => Promise.resolve(fakePort())}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Connect your node')).toBeTruthy();
    });
  });

  it('resolver failure surfaces the error instead of a blank screen', async () => {
    render(
      <NativeApp
        mode="remote-node"
        resolveLncPort={() => Promise.reject(new Error('lnc-rn missing'))}
      />,
    );
    await screen.findByText((text) => text.includes('lnc-rn missing'));
  });

  it('everyday mode is the default and shows the Mode A not-configured state', () => {
    render(<NativeApp />);
    expect(screen.getByText((text) => text.includes('Wavelength'))).toBeTruthy();
  });
});
