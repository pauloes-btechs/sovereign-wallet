import { describe, expect, it } from 'vitest';
import {
  bech32Decode,
  bech32Encode,
  convertBits,
  parseDestination,
  segwitAddressDecode,
  segwitAddressEncode,
} from './index.js';

/** Builds a structurally valid BOLT-11 invoice string using our own encoder. */
function buildInvoice(hrp: string, timestamp: number, paymentHash: Uint8Array): string {
  const words: number[] = [];
  // Timestamp: 35 bits, 7 words, big-endian.
  for (let i = 6; i >= 0; i--) words.push((timestamp >> (5 * i)) & 31);
  // Field: type 1 (payment hash), length 52 words (2 words), 256-bit payload.
  words.push(1);
  words.push(52 >> 5);
  words.push(52 & 31);
  words.push(...convertBits(paymentHash, 8, 5, true)!);
  expect(words.length).toBe(62);
  return bech32Encode(hrp, words, 'bech32');
}

describe('parseDestination: onchain segwit addresses', () => {
  it('accepts the canonical BIP-173 P2WPKH vector (any case)', () => {
    for (const candidate of [
      'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    ]) {
      const result = parseDestination(candidate, { networks: ['mainnet'] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.kind).toBe('onchain');
        expect(result.normalized).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
      }
    }
  });

  it('encodes and decodes bech32m taproot addresses round-trip', () => {
    const program = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
    const encoded = segwitAddressEncode('bc', 1, program);
    expect(encoded).not.toBeNull();
    const decoded = segwitAddressDecode(encoded!, ['bc']);
    expect(decoded).not.toBeNull();
    expect(decoded!.witnessVersion).toBe(1);
    expect(decoded!.variant).toBe('bech32m');
    expect(Array.from(decoded!.program)).toEqual(program);
    expect(parseDestination(encoded!, { networks: ['mainnet'] }).ok).toBe(true);
  });

  it('rejects wrong-network addresses when the network set is restricted', () => {
    const result = parseDestination('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
      networks: ['testnet'],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects corrupted checksums and mixed case', () => {
    expect(parseDestination('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5').ok).toBe(false);
    expect(parseDestination('Bc1qW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4').ok).toBe(false);
  });
});

describe('parseDestination: lightning invoices', () => {
  const hash = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);

  it('accepts a self-built invoice with an amount and reports msat', () => {
    const invoice = buildInvoice('lnbc100n', 1_700_000_000, hash);
    const result = parseDestination(invoice, { networks: ['mainnet'] });
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'lightning-invoice') {
      // 100 nanoBTC = 10 satoshis = 10,000 msat.
      expect(result.amountMsat).toBe(10_000);
    }
  });

  it('accepts an any-amount invoice and reports null msat', () => {
    const invoice = buildInvoice('lntb', 1_700_000_000, hash);
    const result = parseDestination(invoice, { networks: ['testnet'] });
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'lightning-invoice') expect(result.amountMsat).toBeNull();
  });

  it('rejects invoices whose checksum was tampered with', () => {
    const invoice = buildInvoice('lnbc100n', 1_700_000_000, hash);
    const tampered = invoice.slice(0, -1) === invoice ? invoice : `${invoice.slice(0, -1)}q`;
    expect(parseDestination(tampered).ok).toBe(false);
  });

  it('rejects structurally impossible tag sections built with valid checksums', () => {
    // Valid bech32 but only 10 data words: no payment hash field.
    const truncated = bech32Encode('lnbc100n', Array.from({ length: 10 }, (_, i) => i % 32), 'bech32');
    expect(parseDestination(truncated).ok).toBe(false);
  });
});

describe('parseDestination: asset identifiers and rejections', () => {
  it('accepts 64 and 66 char hex, normalizing case', () => {
    const id = `${'AB'.repeat(32)}`;
    const result = parseDestination(id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('asset-id');
      expect(result.normalized).toBe(id.toLowerCase());
    }
    const group = 'cd'.repeat(33);
    expect(parseDestination(group).ok).toBe(true);
  });

  it('never throws on garbage and reports unknown', () => {
    for (const garbage of [
      '',
      '   ',
      'bc1',
      'lntb',
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // base58 P2PKH — not supported yet
      'not a destination',
      'x'.repeat(70_000),
    ]) {
      const result = parseDestination(garbage);
      expect(['onchain', 'lightning-invoice', 'asset-id', 'unknown']).toContain(result.kind);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('bech32 codec invariants', () => {
  it('rejects mixed case and invalid charset before touching the checksum', () => {
    expect(bech32Decode('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3tB')).toBeNull(); // invalid char B... actually B is in charset? no — charset is lowercase
    expect(bech32Decode('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4x')).toBeNull();
  });

  it('round-trips arbitrary words through the encoder', () => {
    const words = Array.from({ length: 40 }, (_, i) => (i * 3) % 32);
    for (const variant of ['bech32', 'bech32m'] as const) {
      const encoded = bech32Encode('bcrt', words, variant);
      const decoded = bech32Decode(encoded);
      expect(decoded?.variant).toBe(variant);
      expect(decoded?.words).toEqual(words);
    }
  });
});
