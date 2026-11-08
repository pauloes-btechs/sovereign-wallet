import { describe, expect, it } from 'vitest';
import { segwitAddressEncode } from '@sovereign/wallet-core';
import { addressLooksWrong } from './send-kit.js';
import { externalAddressProblem, looksLikeAddress, unactivatedAddressProblem } from './address-guard.js';

const BIP360_EXAMPLE = 'bc1zzmv50jjgxxhww6ve4g5zpewrkjqhr06fyujpm20tuezdlxmfphcqfc80ve';
const REASON = 'Coins sent to a version-2 address before BIP-360 activates can be taken by anyone.';
const P32 = Array.from({ length: 32 }, (_, i) => 255 - i);
const regtestV2 = segwitAddressEncode('bcrt', 2, P32) ?? '';
const regtestV1 = segwitAddressEncode('bcrt', 1, P32) ?? '';

describe('desktop on-chain address guard', () => {
  it('refuses the BIP-360 example and a regtest v2 address, naming P2MR', () => {
    expect(looksLikeAddress(BIP360_EXAMPLE)).toBe(true);
    const main = unactivatedAddressProblem(BIP360_EXAMPLE);
    expect(main).toContain(REASON);
    expect(main).toContain('Pay-to-Merkle-Root (P2MR) address (SegWit version 2)');
    expect(externalAddressProblem(` ${regtestV2} `)).toContain(REASON);
  });

  it('refuses v3+ generically and lets v0 and Taproot through', () => {
    expect(externalAddressProblem(segwitAddressEncode('bcrt', 5, P32) ?? '')).toContain('SegWit version-5 address');
    expect(externalAddressProblem(regtestV1)).toBeNull();
    expect(externalAddressProblem('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).toBeNull();
    expect(externalAddressProblem('')).toBeNull();
    expect(externalAddressProblem('nope')).toBe('That doesn’t look like a Bitcoin address.');
  });

  it('the Send page check refuses v2 after its network prefix check', () => {
    expect(addressLooksWrong(regtestV2, 'regtest')).toContain(REASON);
    expect(addressLooksWrong(BIP360_EXAMPLE, 'mainnet')).toContain(REASON);
    expect(addressLooksWrong(BIP360_EXAMPLE, 'regtest')).toMatch(/doesn't look like a regtest address/);
    expect(addressLooksWrong(regtestV1, 'regtest')).toBeNull();
  });
});
