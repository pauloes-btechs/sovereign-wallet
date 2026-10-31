import { describe, expect, it, vi } from 'vitest';

// The aezeed passphrase must round-trip: genSeed encrypts the seed with it and
// initWallet must decrypt with the identical value. The modeb e2e caught the
// mismatch (genSeed empty vs initWallet 'sovereign-wallet') as litd's
// "invalid passphrase" refusal on wallet creation — this pins the round-trip
// so the two defaults can never silently diverge again.
const captured: {
  genSeed?: { aezeedPassphrase: Uint8Array };
  initWallet?: { aezeedPassphrase: Uint8Array };
} = {};

vi.mock('../client.js', () => ({
  createLightningClient: vi.fn(async () => ({}) as never),
  createRouterClient: vi.fn(async () => ({}) as never),
  createWalletUnlockerClient: vi.fn(async () => ({
    genSeed: async (req: { aezeedPassphrase: Uint8Array }) => {
      captured.genSeed = req;
      return { response: { cipherSeedMnemonic: ['abstract', 'snow'] } };
    },
    initWallet: async (req: { aezeedPassphrase: Uint8Array }) => {
      captured.initWallet = req;
    },
    unlockWallet: vi.fn(),
  })),
}));

import { createRealBridgeDeps, lightningOpsFromClient } from './session.js';
import { AddressType } from '@sovereign/litd-proto';

describe('lightningOpsFromClient newAddress', () => {
  // The modeb e2e found deposits to UNUSED_* addresses never discovered:
  // block notifications fired (NTFN/GRDN) but no utxo was registered and
  // SendCoins failed with "insufficient funds". Pin the watched variants.
  it('maps p2wkh/np2wkh to the live-watched AddressType variants', async () => {
    const types: number[] = [];
    const ops = lightningOpsFromClient({
      lightning: {
        newAddress: async (req: { type: number }) => {
          types.push(req.type);
          return { response: { address: 'bcrt1qtest' } };
        },
      } as never,
      router: {} as never,
    });
    await ops.newAddress('p2wkh');
    await ops.newAddress('np2wkh');
    expect(types).toEqual([AddressType.WITNESS_PUBKEY_HASH, AddressType.NESTED_PUBKEY_HASH]);
    expect(types).not.toContain(2); // UNUSED_WITNESS_PUBKEY_HASH
    expect(types).not.toContain(3); // UNUSED_NESTED_PUBKEY_HASH
  });
});

describe('createRealBridgeDeps unlocker', () => {
  it('aezeed passphrase round-trips: default initWallet matches genSeed', async () => {
    const deps = await createRealBridgeDeps({
      connectionOptions: { rpcHost: '127.0.0.1', rpcPort: 10009, tlsCertPath: '/tmp/litd-tls.cert' },
    });
    const unlocker = await deps.createUnlocker();
    const seed = await unlocker.genSeed();
    await unlocker.initWallet({ mnemonic: seed.mnemonic, password: 'correct horse battery staple' });

    const genPassphrase = Buffer.from(captured.genSeed!.aezeedPassphrase).toString('utf8');
    const initPassphrase = Buffer.from(captured.initWallet!.aezeedPassphrase).toString('utf8');
    // Same passphrase on both legs, and the default is the empty one — a
    // fresh wallet must create without any seed-passphrase input from the UI.
    expect(initPassphrase).toBe(genPassphrase);
    expect(initPassphrase).toBe('');
  });

  it('an explicit aezeedPassphrase passes through to initWallet', async () => {
    const deps = await createRealBridgeDeps({
      connectionOptions: { rpcHost: '127.0.0.1', rpcPort: 10009, tlsCertPath: '/tmp/litd-tls.cert' },
    });
    const unlocker = await deps.createUnlocker();
    await unlocker.genSeed();
    await unlocker.initWallet({
      mnemonic: ['abstract', 'snow'],
      password: 'correct horse battery staple',
      aezeedPassphrase: 'poem verse',
    });
    expect(Buffer.from(captured.initWallet!.aezeedPassphrase).toString('utf8')).toBe('poem verse');
  });
});
