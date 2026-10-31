/**
 * Wallet-owned destination validation — the first gate for every Send flow.
 *
 * All user-supplied destination strings pass through parseDestination BEFORE
 * any provider, adapter, or daemon sees them. Every parser here is total:
 * it returns a result object and never throws, so fuzzing the surface can
 * assert crash-freedom. Upstream (Wavelength SDK, LND) re-validates with
 * full semantics; this layer enforces structure and refuses malformed input
 * early, fail-closed.
 *
 * Scope note: bech32-native addresses (P2WPKH/P2WSH/P2TR), BOLT-11 invoice
 * structure, and Taproot Assets identifiers are covered. Legacy base58check
 * addresses are intentionally not accepted yet — adding them requires a
 * pure-TS SHA-256 and will ship with its own fuzz target.
 */

import { bech32Decode, segwitAddressDecode } from './bech32.js';

export type DestinationKind = 'onchain' | 'lightning-invoice' | 'asset-id' | 'unknown';

export interface ParseDestinationOk {
  ok: true;
  kind: DestinationKind;
  /** Lowercased canonical form when kind is onchain/lightning-invoice. */
  normalized: string;
  /** Populated for lightning-invoice: millisatoshis, null = any amount. */
  amountMsat?: number | null;
}

export interface ParseDestinationErr {
  ok: false;
  kind: 'unknown';
  reason: string;
}

export type ParseDestinationResult = ParseDestinationOk | ParseDestinationErr;

export type BitcoinNetwork = 'mainnet' | 'testnet' | 'regtest';

const HRP_BY_NETWORK: Record<BitcoinNetwork, string[]> = {
  mainnet: ['bc'],
  testnet: ['tb'],
  regtest: ['bcrt'],
};

/** Sane transport cap; real invoices with route hints stay far below it. */
const MAX_INVOICE_LENGTH = 65_536;
const MAX_DESTINATION_LENGTH = 65_536;

/** bolt11 BOLT-11 multiplier → BTC fraction. */
const BOLT11_MULTIPLIERS: Record<string, number> = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };
const MSAT_PER_BTC = 100_000_000_000;

export interface ParseDestinationOptions {
  networks?: BitcoinNetwork[];
}

function isPrintableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function isHex(s: string): boolean {
  for (const c of s) {
    const code = c.charCodeAt(0);
    const ok =
      (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46);
    if (!ok) return false;
  }
  return true;
}

/**
 * BOLT-11 structural walk of the tag section (5-bit words): alternating
 * field-type (1 word), length (2 words), payload. Returns null on any
 * misalignment. Timestamp is the first 7 words; the payment hash must
 * follow as the first field.
 */
function parseBolt11Data(words: readonly number[]): { paymentHash: string } | null {
  if (words.length < 7 + 55) return null; // timestamp(7) + phash field(1+2+52)
  let offset = 7;
  let paymentHash: string | null = null;
  while (offset < words.length) {
    const fieldType = words[offset];
    offset += 1;
    if (offset + 2 > words.length) return null;
    const lenHi = words[offset];
    const lenLo = words[offset + 1];
    if (lenHi === undefined || lenLo === undefined) return null;
    const len = (lenHi << 5) | lenLo;
    offset += 2;
    if (offset + len > words.length) return null;
    if (fieldType === 1 && paymentHash === null) {
      if (len !== 52) return null; // 256-bit payment hash
      paymentHash = words
        .slice(offset, offset + len)
        .map((w) => w.toString(16).padStart(2, '0'))
        .join('');
    }
    offset += len;
  }
  if (paymentHash === null) return null;
  return { paymentHash };
}

/** BOLT-11 amount (digits + optional multiplier) → millisatoshis or null. */
function parseBolt11Amount(s: string): number | null {
  if (s === '') return null; // any-amount invoice
  const match = /^(\d+)([munp])?$/.exec(s);
  if (!match) return null;
  const value = Number(match[1]);
  if (value === 0) return null; // BOLT-11 forbids zero amounts
  const multiplier = match[2] ? (BOLT11_MULTIPLIERS[match[2]] ?? 0) : 1;
  if (multiplier <= 0) return null;
  const msat = value * multiplier * MSAT_PER_BTC;
  if (!Number.isSafeInteger(msat) || msat <= 0) return null;
  // Pico amounts must land exactly on millisatoshis.
  if (match[2] === 'p' && (value % 10 !== 0)) return null;
  return msat;
}

/**
 * Classifies and validates a payment destination. Total function: returns
 * { ok: false } on any malformed input, never throws.
 */
export function parseDestination(
  raw: string,
  options: ParseDestinationOptions = {},
): ParseDestinationResult {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DESTINATION_LENGTH) {
    return { ok: false, kind: 'unknown', reason: 'destination is empty, oversized, or not a string' };
  }
  if (!isPrintableAscii(raw)) {
    return { ok: false, kind: 'unknown', reason: 'destination contains non-printable or non-ASCII characters' };
  }
  const input = raw.trim();
  const networks = options.networks ?? ['mainnet', 'testnet', 'regtest'];
  const hrps = networks.flatMap((n) => HRP_BY_NETWORK[n]);

  // On-chain segwit address. Match case-insensitively so uppercase (also
  // valid per BIP-173) dispatches here; the decoder lowercases internally.
  const hrpMatch = /^([a-z]+)1/i.exec(input);
  const hrpCandidate = hrpMatch?.[1]?.toLowerCase() ?? '';
  if (hrpMatch && hrps.includes(hrpCandidate) && hrpCandidate.length <= 5) {
    const decoded = segwitAddressDecode(input, hrps);
    if (decoded) {
      return { ok: true, kind: 'onchain', normalized: input.toLowerCase() };
    }
    return { ok: false, kind: 'unknown', reason: 'malformed on-chain address' };
  }

  // BOLT-11 invoice: 'ln' + network hrp + optional amount, bech32 checksum.
  const invoiceMatch = /^ln(bc|tb|bcrt)((?:\d+[munp])?)1/.exec(input);
  if (invoiceMatch) {
    const [, netHrp = '', amountPart = ''] = invoiceMatch;
    if (netHrp === '' || !hrps.includes(netHrp)) {
      return { ok: false, kind: 'unknown', reason: `invoice network '${netHrp}' is not enabled` };
    }
    const amountMsat = parseBolt11Amount(amountPart);
    if (amountPart !== '' && amountMsat === null) {
      return { ok: false, kind: 'unknown', reason: 'invalid invoice amount' };
    }
    if (input.length > MAX_INVOICE_LENGTH) {
      return { ok: false, kind: 'unknown', reason: 'invoice exceeds length limit' };
    }
    const decoded = bech32Decode(input, MAX_INVOICE_LENGTH);
    if (!decoded || decoded.variant !== 'bech32') {
      return { ok: false, kind: 'unknown', reason: 'invalid invoice checksum or structure' };
    }
    const data = parseBolt11Data(decoded.words);
    if (!data) {
      return { ok: false, kind: 'unknown', reason: 'invoice tag section is malformed' };
    }
    return { ok: true, kind: 'lightning-invoice', normalized: input.toLowerCase(), amountMsat: amountMsat ?? null };
  }

  // Taproot Assets identifier: 32-byte (asset id) or 33-byte (group key) hex.
  if (/^[0-9a-fA-F]{64}$/.test(input) || /^[0-9a-fA-F]{66}$/.test(input)) {
    if (!isHex(input)) {
      return { ok: false, kind: 'unknown', reason: 'malformed asset identifier' };
    }
    return { ok: true, kind: 'asset-id', normalized: input.toLowerCase() };
  }

  return { ok: false, kind: 'unknown', reason: 'unrecognized destination format' };
}
