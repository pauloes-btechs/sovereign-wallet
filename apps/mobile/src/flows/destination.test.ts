import { describe, expect, it } from 'vitest';
import {
  buildBip21,
  decodeBolt11,
  formatBip21Amount,
  invoiceAmountSat,
  parseBtcAmount,
  knownBitcoinNetwork,
  encodeSegwitAddress,
  parseDestination,
  parseOnchainAddress,
} from './destination.js';
import { base58CheckDecode, bech32Decode, bech32Encode, convertBits, sha256, utf8Decode, utf8Encode } from './bitcoinEncoding.js';
import { encodeSimulatedBolt11, simHashHex, simSegwitAddress } from '../testing/simInvoice.js';

/** BOLT11 spec test vector: 2500u, "1 cup coffee", expiry 60 (no payment secret, pre-2021 format). */
const SPEC_COFFEE =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
/** BOLT11 spec test vector: amountless donation invoice. */
const SPEC_DONATION =
  'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w';

const SPEC_HASH = '0001020304050607080900010203040506070809000102030405060708090102';

function regtestInvoice(amountMsat: bigint | null, opts: { description?: string; expirySeconds?: number; timestamp?: number } = {}): string {
  return encodeSimulatedBolt11({
    network: 'regtest',
    amountMsat,
    paymentHashHex: simHashHex('test-invoice'),
    description: opts.description,
    expirySeconds: opts.expirySeconds,
    timestamp: opts.timestamp ?? 1_800_000_000,
  });
}

describe('encodings', () => {
  it('sha256 matches the FIPS vectors', () => {
    const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    expect(hex(sha256(utf8Encode('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256(utf8Encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // Two-block message (56 bytes).
    expect(hex(sha256(utf8Encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('bech32 rejects mixed case and a bad checksum', () => {
    expect(bech32Decode('A12UEL5L')).not.toBeNull();
    expect(bech32Decode('a12uel5l')).not.toBeNull();
    expect(bech32Decode('A12uEL5L')).toBeNull();
    expect(bech32Decode('a12uel5m')).toBeNull();
  });

  it('base58check verifies its checksum', () => {
    expect(base58CheckDecode('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')?.[0]).toBe(0);
    expect(base58CheckDecode('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3')).toBeNull();
  });
});

describe('decodeBolt11', () => {
  it('rejects an invoice with neither a description nor a description hash (BOLT11 requires one)', () => {
    const text = encodeSimulatedBolt11({
      network: 'regtest',
      amountMsat: 1_000_000n,
      paymentHashHex: simHashHex('no-description'),
      omitDescription: true,
      timestamp: 1_800_000_000,
    });
    expect(decodeBolt11(text)).toEqual({ ok: false, failure: 'malformed' });
  });

  it('accepts an empty description, and rejects an expiry field too long to be a real expiry', () => {
    expect(decodeBolt11(regtestInvoice(1_000_000n, { description: '' })).ok).toBe(true);
    // A 3600-second expiry encodes in 3 words; build one with an 11-word x field instead.
    const ok = regtestInvoice(1_000_000n, { expirySeconds: 3600 });
    expect(decodeBolt11(ok).ok).toBe(true);
    const huge = encodeSimulatedBolt11({
      network: 'regtest',
      amountMsat: 1_000_000n,
      paymentHashHex: simHashHex('huge-expiry'),
      expirySeconds: 2 ** 52, // 11 five-bit words: past a safe 50-bit expiry
      timestamp: 1_800_000_000,
    });
    expect(decodeBolt11(huge)).toEqual({ ok: false, failure: 'malformed' });
  });

  it('decodes the BOLT11 spec coffee invoice: amount, description, expiry, hash, timestamp', () => {
    const result = decodeBolt11(SPEC_COFFEE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.network).toBe('mainnet');
    expect(result.invoice.amountMsat).toBe(250_000_000n);
    expect(invoiceAmountSat(result.invoice)).toBe(250_000n);
    expect(result.invoice.description).toBe('1 cup coffee');
    expect(result.invoice.expirySeconds).toBe(60);
    expect(result.invoice.timestamp).toBe(1_496_314_658);
    expect(result.invoice.expiresAt).toBe(1_496_314_718);
    expect(result.invoice.paymentHash).toBe(SPEC_HASH);
  });

  it('decodes an amountless invoice with the default one-hour expiry', () => {
    const result = decodeBolt11(SPEC_DONATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.amountMsat).toBeNull();
    expect(invoiceAmountSat(result.invoice)).toBeNull();
    expect(result.invoice.expirySeconds).toBe(3600);
    expect(result.invoice.description).toBe('Please consider supporting this project');
  });

  it('accepts upper case (QR alphanumeric mode) and returns the invoice lowercased', () => {
    const result = decodeBolt11(SPEC_COFFEE.toUpperCase());
    expect(result.ok && result.invoice.invoice).toBe(SPEC_COFFEE);
  });

  it('rejects a single changed character as a checksum failure', () => {
    const broken = `${SPEC_COFFEE.slice(0, 40)}${SPEC_COFFEE[40] === 'q' ? 'p' : 'q'}${SPEC_COFFEE.slice(41)}`;
    expect(decodeBolt11(broken)).toEqual({ ok: false, failure: 'checksum' });
  });

  it('round-trips the simulator encoder for every network and multiplier', () => {
    for (const network of ['mainnet', 'testnet', 'signet', 'regtest'] as const) {
      for (const msat of [1_000n, 2_100_000n, 150_000_000n, 100_000_000_000n, 1_500n]) {
        const text = encodeSimulatedBolt11({
          network,
          amountMsat: msat,
          paymentHashHex: SPEC_HASH,
          description: 'Coffee ☕',
          expirySeconds: 900,
          timestamp: 1_800_000_000,
        });
        const result = decodeBolt11(text);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.invoice.network).toBe(network);
        expect(result.invoice.amountMsat).toBe(msat);
        expect(result.invoice.description).toBe('Coffee ☕');
        expect(result.invoice.expiresAt).toBe(1_800_000_900);
        expect(result.invoice.paymentHash).toBe(SPEC_HASH);
      }
    }
  });

  it('rounds a sub-satoshi amount up so a review never under-states it', () => {
    const result = decodeBolt11(regtestInvoice(1_500n));
    expect(result.ok && invoiceAmountSat(result.invoice)).toBe(2n);
  });
});

describe('parseOnchainAddress', () => {
  it('accepts BIP173/BIP350 vectors with the right type and network', () => {
    const cases: ReadonlyArray<[string, string, string]> = [
      ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'p2wpkh', 'mainnet'],
      ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'p2wsh', 'testnet'],
      ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'p2tr', 'mainnet'],
      ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'p2pkh', 'mainnet'],
      ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'p2sh', 'mainnet'],
    ];
    for (const [text, type, network] of cases) {
      const result = parseOnchainAddress(text);
      expect(result.ok, text).toBe(true);
      if (!result.ok) continue;
      expect(result.address.type).toBe(type);
      expect(result.address.networks).toContain(network);
    }
    // Lowercased for sending.
    const upper = parseOnchainAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4');
    expect(upper.ok && upper.address.address).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  });

  it('rejects a bad checksum, the wrong checksum variant, and junk', () => {
    expect(parseOnchainAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')).toEqual({ ok: false, failure: 'checksum' });
    // v0 program with a bech32m checksum (BIP350 invalid vector).
    expect(parseOnchainAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh').ok).toBe(false);
    expect(parseOnchainAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLz')).toEqual({ ok: false, failure: 'checksum' });
    expect(parseOnchainAddress('hello')).toEqual({ ok: false, failure: 'not-address' });
  });

  it('treats tb1 as both testnet and signet, and bcrt1 as regtest only', () => {
    const tb = parseOnchainAddress('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7');
    expect(tb.ok && tb.address.networks).toEqual(['testnet', 'signet']);
    const rt = parseOnchainAddress(simSegwitAddress('regtest', 'x'));
    expect(rt.ok && rt.address.networks).toEqual(['regtest']);
  });
});

describe('BIP21', () => {
  it('parses exact BTC amounts without floating point', () => {
    expect(parseBtcAmount('0.00000001')).toBe(1n);
    expect(parseBtcAmount('20.3')).toBe(2_030_000_000n);
    expect(parseBtcAmount('.5')).toBe(50_000_000n);
    expect(parseBtcAmount('0.123456789')).toBeNull();
    expect(parseBtcAmount('1e-3')).toBeNull();
    expect(parseBtcAmount('0')).toBeNull();
    expect(formatBip21Amount(50_000n)).toBe('0.0005');
    expect(formatBip21Amount(100_000_000n)).toBe('1');
  });

  it('builds a URI that parses back to the same address, amount and label', () => {
    const address = simSegwitAddress('regtest', 'bip21');
    const uri = buildBip21(address, { amountSat: 50_000n, label: 'Rent & bills' });
    expect(uri).toBe(`bitcoin:${address}?amount=0.0005&label=Rent%20%26%20bills`);
    const parsed = parseDestination(uri, 'regtest');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.destination.source).toBe('bip21');
    expect(parsed.destination.onchain?.address).toBe(address);
    expect(parsed.destination.onchainAmountSat).toBe(50_000n);
    expect(parsed.destination.label).toBe('Rent & bills');
    expect(buildBip21(address)).toBe(`bitcoin:${address}`);
  });

  it('reads a unified QR (address + lightning fallback)', () => {
    const address = simSegwitAddress('regtest', 'unified');
    const invoice = regtestInvoice(25_000_000n);
    const parsed = parseDestination(`BITCOIN:${address.toUpperCase()}?amount=0.00025&lightning=${invoice}`, 'regtest');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.destination.onchain?.address).toBe(address);
    expect(parsed.destination.lightning?.invoice).toBe(invoice);
    expect(parsed.destination.onchainAmountSat).toBe(25_000n);
  });

  it('refuses unknown required parameters and bad amounts', () => {
    const address = simSegwitAddress('regtest', 'req');
    const req = parseDestination(`bitcoin:${address}?req-somethingyoudontunderstand=50`, 'regtest');
    expect(req.ok === false && req.error.code).toBe('unsupported-requirement');
    const amount = parseDestination(`bitcoin:${address}?amount=-1`, 'regtest');
    expect(amount.ok === false && amount.error.code).toBe('invalid-amount');
    // Unknown optional parameters are ignored.
    expect(parseDestination(`bitcoin:${address}?somethingyoudontunderstand=50`, 'regtest').ok).toBe(true);
  });
});

describe('parseDestination', () => {
  it('reads a bare invoice and a lightning: URI (any case)', () => {
    const invoice = regtestInvoice(2_100_000n, { description: 'Tea' });
    const bare = parseDestination(`  ${invoice}\n`, 'regtest');
    expect(bare.ok && bare.destination.source).toBe('invoice');
    expect(bare.ok && bare.destination.lightning?.description).toBe('Tea');
    const uri = parseDestination(`LIGHTNING:${invoice.toUpperCase()}`, 'regtest');
    expect(uri.ok && uri.destination.source).toBe('lightning-uri');
    expect(uri.ok && uri.destination.lightning?.invoice).toBe(invoice);
  });

  it('reads a bare address', () => {
    const address = simSegwitAddress('regtest', 'bare');
    const parsed = parseDestination(address, 'regtest');
    expect(parsed.ok && parsed.destination.source).toBe('address');
    expect(parsed.ok && parsed.destination.onchain?.type).toBe('p2wpkh');
  });

  it('refuses another network with a plain explanation', () => {
    const main = parseDestination('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'regtest');
    expect(main.ok).toBe(false);
    if (main.ok) return;
    expect(main.error.code).toBe('wrong-network');
    expect(main.error.message).toBe(
      'This is a mainnet address, but this wallet is on regtest. Ask for a regtest address instead.',
    );
    const inv = parseDestination(SPEC_COFFEE, 'regtest');
    expect(inv.ok === false && inv.error.code).toBe('wrong-network');
    expect(parseDestination(SPEC_COFFEE, 'mainnet').ok).toBe(true);
    // A legacy testnet address is valid on testnet, signet and regtest.
    expect(parseDestination('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'regtest').ok).toBe(true);
    expect(parseDestination('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'mainnet').ok).toBe(false);
  });

  it('names formats it recognizes but cannot pay', () => {
    const cases: ReadonlyArray<[string, RegExp]> = [
      ['lno1qcp4256ypq', /BOLT12 offer/],
      ['LNURL1DP68GURN8GHJ7', /LNURL/],
      ['alice@example.com', /Lightning address/],
      ['tark1qqellv3', /Ark address/],
    ];
    for (const [text, message] of cases) {
      const result = parseDestination(text, 'regtest');
      expect(result.ok, text).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('unsupported-format');
      expect(result.error.message).toMatch(message);
    }
  });

  it('explains empty, unrecognized and damaged input', () => {
    expect(parseDestination('   ', 'regtest')).toMatchObject({ ok: false, error: { code: 'empty' } });
    expect(parseDestination('pizza', 'regtest')).toMatchObject({ ok: false, error: { code: 'unrecognized' } });
    const invoice = regtestInvoice(1_000n);
    const damaged = `${invoice.slice(0, -1)}${invoice.endsWith('q') ? 'p' : 'q'}`;
    expect(parseDestination(damaged, 'regtest')).toMatchObject({ ok: false, error: { code: 'checksum' } });
    expect(parseDestination('lnbcrt1-sim-test-invoice', 'regtest')).toMatchObject({ ok: false, error: { code: 'checksum' } });
  });
});

describe('UTF-8 decoding and never-throwing parsers', () => {
  const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

  it('decodes valid UTF-8 and replaces each ill-formed sequence with U+FFFD', () => {
    expect(utf8Decode(utf8Encode('Café ☕ 𝄞'))).toBe('Café ☕ 𝄞');
    expect(utf8Decode(bytes(0xf4, 0x8f, 0xbf, 0xbf))).toBe('\u{10FFFF}');
    // Above U+10FFFF: F4 90+ is ill-formed (one U+FFFD per maximal subpart).
    expect(utf8Decode(bytes(0xf4, 0xbf, 0xbf, 0xbf))).toBe('\ufffd\ufffd\ufffd\ufffd');
    expect(utf8Decode(bytes(0xf5, 0x80, 0x80, 0x80))).toBe('\ufffd\ufffd\ufffd\ufffd');
    // Overlongs.
    expect(utf8Decode(bytes(0xc0, 0xaf))).toBe('\ufffd\ufffd');
    expect(utf8Decode(bytes(0xe0, 0x80, 0xaf))).toBe('\ufffd\ufffd\ufffd');
    expect(utf8Decode(bytes(0xf0, 0x80, 0x80, 0xaf))).toBe('\ufffd\ufffd\ufffd\ufffd');
    // Surrogates.
    expect(utf8Decode(bytes(0xed, 0xa0, 0x80))).toBe('\ufffd\ufffd\ufffd');
    // Bad or missing continuation bytes.
    expect(utf8Decode(bytes(0xc3, 0x41))).toBe('\ufffdA');
    expect(utf8Decode(bytes(0xe2, 0x98))).toBe('\ufffd');
    expect(utf8Decode(bytes(0x80))).toBe('\ufffd');
  });

  function words(n: number, len: number): number[] {
    const out: number[] = [];
    for (let i = len - 1; i >= 0; i--) out.push(Math.floor(n / 32 ** i) % 32);
    return out;
  }
  function tag(type: number, data: number[]): number[] {
    return [type, Math.floor(data.length / 32), data.length % 32, ...data];
  }
  function rawInvoice(hrp: string, description: number[]): string {
    const ph = convertBits(new Array<number>(32).fill(7), 8, 5, true) ?? [];
    const d = convertBits(description, 8, 5, true) ?? [];
    return bech32Encode(hrp, [...words(1_700_000_000, 7), ...tag(1, ph), ...tag(13, d), ...new Array<number>(104).fill(0)], 'bech32');
  }

  it('an invoice description with bytes above U+10FFFF decodes with U+FFFD instead of throwing', () => {
    const text = rawInvoice('lnbc10u', [0xf4, 0xbf, 0xbf, 0xbf]);
    const decoded = decodeBolt11(text);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.invoice.description).toBe('\ufffd\ufffd\ufffd\ufffd');
    expect(() => parseDestination(text, 'mainnet')).not.toThrow();
    expect(parseDestination(text, 'mainnet').ok).toBe(true);
  });

  it('never throws on arbitrary input (fuzz)', () => {
    let seed = 0x5eed;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed;
    };
    const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7lQPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L1lnbcrtbitcoin:?&=.%#/ \u0000\uffff\ud800é';
    const prefixes = ['', 'ln', 'lnbc', 'lnbcrt1', 'lnbc10u1', 'bitcoin:', 'lightning:', 'bc1', 'bcrt1q', 'tb1p', '1', '3', 'm'];
    for (let n = 0; n < 2000; n++) {
      const length = next() % 120;
      let text = prefixes[next() % prefixes.length] ?? '';
      for (let i = 0; i < length; i++) text += alphabet[next() % alphabet.length] ?? '';
      for (const network of ['mainnet', 'testnet', 'signet', 'regtest'] as const) {
        expect(() => parseDestination(text, network)).not.toThrow();
      }
      expect(() => decodeBolt11(text)).not.toThrow();
      expect(() => parseOnchainAddress(text)).not.toThrow();
    }
    // Valid-checksum invoices with random data parts.
    for (let n = 0; n < 500; n++) {
      const data = Array.from({ length: 7 + (next() % 200) }, () => next() % 32);
      const text = bech32Encode(['lnbc', 'lnbc1p', 'lnbcrt25m', 'lntb'][next() % 4] ?? 'lnbc', data, 'bech32');
      expect(() => decodeBolt11(text)).not.toThrow();
      expect(() => parseDestination(text, 'mainnet')).not.toThrow();
    }
  });
});

describe('network names', () => {
  it('maps known names and leaves anything else unknown (never mainnet)', () => {
    expect(knownBitcoinNetwork('mainnet')).toBe('mainnet');
    expect(knownBitcoinNetwork('bitcoin')).toBe('mainnet');
    expect(knownBitcoinNetwork('testnet')).toBe('testnet');
    expect(knownBitcoinNetwork('testnet4')).toBe('testnet');
    expect(knownBitcoinNetwork('signet')).toBe('signet');
    expect(knownBitcoinNetwork('regtest')).toBe('regtest');
    expect(knownBitcoinNetwork('liquidv1')).toBeNull();
    expect(knownBitcoinNetwork('')).toBeNull();
  });
});

describe('BIP21 amount disagreement', () => {
  it('warns when the link amount and the invoice amount differ, and says which rail pays which', () => {
    const address = simSegwitAddress('regtest', 'bip21-mismatch');
    const inv = encodeSimulatedBolt11({
      network: 'regtest',
      amountMsat: 2_100_000n,
      paymentHashHex: simHashHex('bip21-mismatch'),
      description: 'x',
      timestamp: Math.floor(Date.now() / 1000),
    });
    const mismatch = parseDestination(`bitcoin:${address}?amount=0.0001&lightning=${inv}`, 'regtest');
    expect(mismatch.ok).toBe(true);
    if (mismatch.ok) {
      expect(mismatch.destination.amountWarning).toMatch(/10,000 sats on-chain, but its Lightning invoice is for 2,100 sats/);
    }
    const agree = parseDestination(`bitcoin:${address}?amount=0.000021&lightning=${inv}`, 'regtest');
    expect(agree.ok && agree.destination.amountWarning).toBeNull();
  });
});

describe('unactivated SegWit versions (BIP-360 P2MR and beyond)', () => {
  /** The example P2MR address from the BIP-360 text: mainnet, SegWit v2. */
  const BIP360_EXAMPLE = 'bc1zzmv50jjgxxhww6ve4g5zpewrkjqhr06fyujpm20tuezdlxmfphcqfc80ve';
  const program = new Uint8Array(32).fill(7);
  const regtestV2 = encodeSegwitAddress('regtest', 2, program);
  const testnetV2 = encodeSegwitAddress('testnet', 2, program);
  const REASON = 'Coins sent to a version-2 address before BIP-360 activates can be taken by anyone.';

  it('still recognizes v2 addresses (so the refusal is specific) and marks them unsendable', () => {
    const main = parseOnchainAddress(BIP360_EXAMPLE);
    expect(main.ok).toBe(true);
    if (!main.ok) return;
    expect(main.address.type).toBe('p2mr');
    expect(main.address.witnessVersion).toBe(2);
    expect(main.address.sendRefusal).toContain(REASON);
    expect(main.address.sendRefusal).toContain('Pay-to-Merkle-Root (P2MR)');
    expect(regtestV2.startsWith('bcrt1z')).toBe(true);
    expect(testnetV2.startsWith('tb1z')).toBe(true);
  });

  it('refuses a bare v2 address with the reason, on every network', () => {
    const main = parseDestination(BIP360_EXAMPLE, 'mainnet');
    expect(main.ok === false && main.error.code).toBe('unactivated-witness-version');
    expect(main.ok === false && main.error.message).toContain(REASON);
    const rt = parseDestination(regtestV2, 'regtest');
    expect(rt.ok === false && rt.error.code).toBe('unactivated-witness-version');
    const tb = parseDestination(testnetV2.toUpperCase(), 'signet');
    expect(tb.ok === false && tb.error.code).toBe('unactivated-witness-version');
  });

  it('still reports the wrong network first', () => {
    const r = parseDestination(BIP360_EXAMPLE, 'regtest');
    expect(r.ok === false && r.error.code).toBe('wrong-network');
  });

  it('refuses a BIP21 link whose only payable part is a v2 address', () => {
    const r = parseDestination(`bitcoin:${regtestV2}?amount=0.001`, 'regtest');
    expect(r.ok === false && r.error.code).toBe('unactivated-witness-version');
    expect(r.ok === false && r.error.message).toContain(REASON);
  });

  it('keeps the Lightning part of a unified BIP21 link, with the on-chain part marked unsendable', () => {
    const inv = encodeSimulatedBolt11({
      network: 'regtest',
      amountMsat: 5_000_000n,
      paymentHashHex: simHashHex('p2mr-unified'),
      description: 'x',
      timestamp: Math.floor(Date.now() / 1000),
    });
    const r = parseDestination(`bitcoin:${regtestV2}?lightning=${inv}`, 'regtest');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.destination.onchain?.sendRefusal).toContain(REASON);
  });

  it('refuses v3–v16 and a non-32-byte v1 program; leaves v0 and Taproot sendable', () => {
    for (const v of [3, 16]) {
      const r = parseDestination(encodeSegwitAddress('regtest', v, program), 'regtest');
      expect(r.ok === false && r.error.code).toBe('unactivated-witness-version');
      expect(r.ok === false && r.error.message).toContain(`version-${v} address can be taken by anyone`);
    }
    const oddV1 = parseDestination(encodeSegwitAddress('regtest', 1, program.slice(0, 20)), 'regtest');
    expect(oddV1.ok === false && oddV1.error.code).toBe('unactivated-witness-version');
    const taproot = parseDestination(encodeSegwitAddress('regtest', 1, program), 'regtest');
    expect(taproot.ok && taproot.destination.onchain?.sendRefusal).toBeNull();
    const v0 = parseDestination(simSegwitAddress('regtest', 'v0'), 'regtest');
    expect(v0.ok && v0.destination.onchain?.sendRefusal).toBeNull();
  });
});
