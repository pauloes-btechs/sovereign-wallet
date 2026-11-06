import { describe, expect, it } from 'vitest';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { freshDemoMnemonic } from './demoMnemonic.js';
import { MobileFlowSimulatedClient, SIM_WORDS } from './simulatedWalletClient.js';

describe('freshDemoMnemonic', () => {
  it('returns a valid 12-word BIP-39 phrase (128-bit) from the English wordlist', () => {
    const words = freshDemoMnemonic();
    expect(words).toHaveLength(12);
    expect(words.every((w) => wordlist.includes(w))).toBe(true);
    expect(validateMnemonic(words.join(' '), wordlist)).toBe(true);
  });

  it('returns 24 words for 256-bit strength', () => {
    const words = freshDemoMnemonic(256);
    expect(words).toHaveLength(24);
    expect(validateMnemonic(words.join(' '), wordlist)).toBe(true);
  });

  it('never repeats across many draws and is not the fixed test phrase', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(freshDemoMnemonic().join(' '));
    expect(seen.size).toBe(500);
    expect(seen.has(SIM_WORDS.join(' '))).toBe(false);
  });
});

describe('MobileFlowSimulatedClient phrase source', () => {
  const req = { password: 'pw' } as Parameters<MobileFlowSimulatedClient['createWallet']>[0];

  it('keeps the fixed test phrase by default (tests type known words)', async () => {
    expect((await new MobileFlowSimulatedClient().createWallet(req)).mnemonic).toEqual([...SIM_WORDS]);
  });

  it('uses the injected generator for fresh wallets, so each demo wallet differs', async () => {
    const sim = new MobileFlowSimulatedClient({ freshMnemonic: () => freshDemoMnemonic() });
    const a = (await sim.createWallet(req)).mnemonic;
    const b = (await sim.createWallet(req)).mnemonic;
    expect(a).not.toEqual(b);
  });
});
