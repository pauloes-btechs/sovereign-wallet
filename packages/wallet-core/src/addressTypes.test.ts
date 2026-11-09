import { describe, expect, it } from 'vitest';
import {
  OUTPUT_TYPES,
  P2MR_UNAVAILABLE_REASON,
  UNACTIVATED_V2_REASON,
  isOutputTypeActive,
  outputType,
  parseDestination,
  segwitAddressDecode,
  segwitAddressEncode,
  unactivatedWitnessRefusal,
  witnessVersionPolicy,
} from './index.js';

/** The example P2MR address from the BIP-360 text (mainnet, SegWit v2). */
const BIP360_EXAMPLE = 'bc1zzmv50jjgxxhww6ve4g5zpewrkjqhr06fyujpm20tuezdlxmfphcqfc80ve';
const PROGRAM32 = Array.from({ length: 32 }, (_, i) => i + 1);

describe('output type registry', () => {
  it('lists the five active types and P2MR as proposed (BIP-360, Draft)', () => {
    expect(OUTPUT_TYPES.map((t) => t.id)).toEqual(['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2wsh', 'p2tr', 'p2mr']);
    for (const id of ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2wsh', 'p2tr'] as const) expect(isOutputTypeActive(id)).toBe(true);
    const p2mr = outputType('p2mr');
    expect(p2mr.witnessVersion).toBe(2);
    expect(p2mr.mainnetPrefix).toBe('bc1z');
    expect(p2mr.status).toEqual({
      state: 'proposed',
      bip: 360,
      bipTitle: 'Pay-to-Merkle-Root (P2MR)',
      bipStatus: 'Draft',
      reason: P2MR_UNAVAILABLE_REASON,
    });
  });

  it('notes key exposure per type: Taproot exposes its key, P2WPKH hides it until spent', () => {
    expect(outputType('p2tr').keyExposure).toBe('exposed-in-output');
    expect(outputType('p2wpkh').keyExposure).toBe('hidden-until-spend');
    expect(outputType('p2mr').keyExposure).toBe('no-key-path');
    for (const t of OUTPUT_TYPES) expect(t.exposureNote.length).toBeGreaterThan(20);
  });

  it('witness versions and prefixes match the address format', () => {
    expect(outputType('p2pkh').witnessVersion).toBeNull();
    expect(outputType('p2sh-p2wpkh')).toMatchObject({ witnessVersion: 0, nested: true, mainnetPrefix: '3' });
    expect(outputType('p2wpkh')).toMatchObject({ witnessVersion: 0, mainnetPrefix: 'bc1q' });
    expect(outputType('p2tr')).toMatchObject({ witnessVersion: 1, mainnetPrefix: 'bc1p' });
  });
});

describe('witnessVersionPolicy', () => {
  it('allows v0 and v1', () => {
    expect(witnessVersionPolicy(0)).toEqual({ allowed: true });
    expect(witnessVersionPolicy(1)).toEqual({ allowed: true });
    expect(witnessVersionPolicy(1, { programLength: 32 })).toEqual({ allowed: true });
  });

  it('refuses v2 until BIP-360 activates, with the reason', () => {
    expect(witnessVersionPolicy(2)).toEqual({ allowed: false, reason: UNACTIVATED_V2_REASON, outputType: 'p2mr' });
    expect(UNACTIVATED_V2_REASON).toBe('Coins sent to a version-2 address before BIP-360 activates can be taken by anyone.');
  });

  it('allows v2 when P2MR is explicitly activated, only with a 32-byte program', () => {
    expect(witnessVersionPolicy(2, { activated: ['p2mr'] })).toEqual({ allowed: true });
    expect(witnessVersionPolicy(2, { activated: ['p2mr'], programLength: 32 })).toEqual({ allowed: true });
    expect(witnessVersionPolicy(2, { activated: ['p2mr'], programLength: 20 }).allowed).toBe(false);
  });

  it('refuses v3–v16 even when P2MR is activated', () => {
    for (let v = 3; v <= 16; v++) {
      const p = witnessVersionPolicy(v, { activated: ['p2mr'] });
      expect(p.allowed).toBe(false);
      if (!p.allowed) expect(p.reason).toContain(`version-${v} address can be taken by anyone`);
    }
  });

  it('refuses v1 with a non-32-byte program (also unencumbered) and impossible versions', () => {
    expect(witnessVersionPolicy(1, { programLength: 20 }).allowed).toBe(false);
    expect(witnessVersionPolicy(17).allowed).toBe(false);
    expect(witnessVersionPolicy(-1).allowed).toBe(false);
  });
});

describe('unactivatedWitnessRefusal with real address vectors', () => {
  it('decodes the BIP-360 example as a mainnet SegWit v2, 32-byte program, bech32m', () => {
    const d = segwitAddressDecode(BIP360_EXAMPLE, ['bc']);
    expect(d).not.toBeNull();
    expect(d?.witnessVersion).toBe(2);
    expect(d?.program.length).toBe(32);
    expect(d?.variant).toBe('bech32m');
    expect(unactivatedWitnessRefusal(BIP360_EXAMPLE)).toEqual({ witnessVersion: 2, reason: UNACTIVATED_V2_REASON, outputType: 'p2mr' });
    expect(unactivatedWitnessRefusal(BIP360_EXAMPLE.toUpperCase())?.witnessVersion).toBe(2);
  });

  it('refuses self-encoded testnet/signet and regtest v2 addresses', () => {
    const tb = segwitAddressEncode('tb', 2, PROGRAM32)!;
    const bcrt = segwitAddressEncode('bcrt', 2, PROGRAM32)!;
    expect(tb.startsWith('tb1z')).toBe(true);
    expect(bcrt.startsWith('bcrt1z')).toBe(true);
    expect(unactivatedWitnessRefusal(tb)?.reason).toBe(UNACTIVATED_V2_REASON);
    expect(unactivatedWitnessRefusal(` ${bcrt} `)?.reason).toBe(UNACTIVATED_V2_REASON);
    expect(unactivatedWitnessRefusal(bcrt, { activated: ['p2mr'] })).toBeNull();
  });

  it('refuses v3 and v16 addresses', () => {
    expect(unactivatedWitnessRefusal(segwitAddressEncode('bc', 3, PROGRAM32)!)?.witnessVersion).toBe(3);
    expect(unactivatedWitnessRefusal(segwitAddressEncode('bcrt', 16, [1, 2])!)?.witnessVersion).toBe(16);
  });

  it('lets v0 and Taproot through, and ignores non-SegWit text', () => {
    expect(unactivatedWitnessRefusal('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBeNull();
    expect(unactivatedWitnessRefusal(segwitAddressEncode('bc', 1, PROGRAM32)!)).toBeNull();
    expect(unactivatedWitnessRefusal('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBeNull();
    expect(unactivatedWitnessRefusal('not an address')).toBeNull();
  });

  it('refuses a v1 address with a 20-byte program', () => {
    const odd = segwitAddressEncode('bc', 1, PROGRAM32.slice(0, 20))!;
    expect(unactivatedWitnessRefusal(odd)?.witnessVersion).toBe(1);
  });
});

describe('parseDestination refuses unactivated SegWit versions', () => {
  it('returns the BIP-360 reason for a v2 address', () => {
    const r = parseDestination(BIP360_EXAMPLE, { networks: ['mainnet'] });
    expect(r).toEqual({ ok: false, kind: 'unknown', reason: UNACTIVATED_V2_REASON });
  });

  it('still accepts Taproot', () => {
    expect(parseDestination(segwitAddressEncode('bcrt', 1, PROGRAM32)!, { networks: ['regtest'] }).ok).toBe(true);
  });
});
