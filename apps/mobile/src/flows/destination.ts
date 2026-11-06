/**
 * Send destinations: what the user pasted or scanned, parsed into something
 * the Send flow can act on. Pure and synchronous — no network, no backend.
 *
 * Recognized:
 * - BOLT11 Lightning invoices (bare, or in a `lightning:` URI), decoded on
 *   the phone: network, amount, description, expiry, payment hash. The
 *   bech32 checksum is verified; the node signature is NOT (that needs
 *   secp256k1) — the backend checks it when it quotes or pays.
 * - On-chain addresses: segwit v0 (bech32) and v1+ (bech32m) with checksum
 *   and witness-program rules, and legacy base58check P2PKH / P2SH.
 * - BIP21 `bitcoin:` URIs: address, `amount` (BTC), `label`, `message`, and
 *   a `lightning=` BOLT11 fallback (unified QR). Unknown `req-` parameters
 *   are refused, as BIP21 requires.
 *
 * Every address and invoice is checked against the wallet's network: a
 * testnet address on a mainnet wallet is an error, never a warning.
 *
 * Recognized but not payable (named so the user knows why): BOLT12 offers,
 * LNURL, Lightning addresses, Ark addresses.
 */

import {
  base58CheckDecode,
  bech32Decode,
  bech32Encode,
  bytesToHex,
  convertBits,
  utf8Decode,
  wordsToBytes,
  wordsToInt,
} from './bitcoinEncoding.js';
import { SATS_PER_BTC } from '../ui/format.js';

export type BitcoinNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export const NETWORK_LABEL: Readonly<Record<BitcoinNetwork, string>> = {
  mainnet: 'mainnet',
  testnet: 'testnet',
  signet: 'signet',
  regtest: 'regtest',
};

/**
 * Maps a backend's network name to the address/invoice family this app
 * checks against. Known names only: `mainnet`/`bitcoin`, `testnet`/
 * `testnet3`/`testnet4` (same prefixes), `signet`, `regtest`.
 * Anything else is null — an unknown network, never silently mainnet.
 */
export function knownBitcoinNetwork(name: string): BitcoinNetwork | null {
  switch (name.trim().toLowerCase()) {
    case 'mainnet':
    case 'bitcoin':
    case 'main':
      return 'mainnet';
    case 'testnet':
    case 'testnet3':
    case 'testnet4':
    case 'test':
      return 'testnet';
    case 'signet':
      return 'signet';
    case 'regtest':
      return 'regtest';
    default:
      return null;
  }
}

/** Why sends are refused on a network this app doesn't recognize. */
export function unknownNetworkReason(name: string): string {
  return `This wallet reports the network "${name}", which this app doesn't recognize, so it can't check that addresses and invoices belong to it. Sending is turned off.`;
}

// ——— BOLT11 ———

/** BOLT11 currency prefixes, longest first so `bcrt` wins over `bc`. */
const BOLT11_PREFIXES: ReadonlyArray<{ prefix: string; network: BitcoinNetwork }> = [
  { prefix: 'bcrt', network: 'regtest' },
  { prefix: 'tbs', network: 'signet' },
  { prefix: 'bc', network: 'mainnet' },
  { prefix: 'tb', network: 'testnet' },
];

/** BOLT11 default when the invoice carries no `x` field. */
export const BOLT11_DEFAULT_EXPIRY_SECONDS = 3600;

/** Words in a BOLT11 signature (64-byte signature + recovery id). */
const SIGNATURE_WORDS = 104;

export interface Bolt11Invoice {
  /** The invoice, lowercased (what is sent to the backend). */
  readonly invoice: string;
  readonly network: BitcoinNetwork;
  /** Requested amount in millisatoshis; null for an amountless invoice. */
  readonly amountMsat: bigint | null;
  /** Unix seconds when the invoice was created. */
  readonly timestamp: number;
  readonly expirySeconds: number;
  /** Unix seconds when it stops being payable. */
  readonly expiresAt: number;
  /** The `d` field; null when absent (e.g. only a description hash). */
  readonly description: string | null;
  /** True when the invoice commits to a description by hash (`h`). */
  readonly hasDescriptionHash: boolean;
  /** Hex payment hash — the identifier the node and the history use. */
  readonly paymentHash: string;
}

export type Bolt11Failure = 'not-bolt11' | 'checksum' | 'malformed';

/** Amount part of a BOLT11 HRP → millisatoshis. Null = malformed. */
function hrpAmountMsat(amount: string): bigint | null | 'none' {
  if (amount === '') return 'none';
  const match = /^([1-9]\d*)([munp]?)$/.exec(amount);
  if (match === null) return null;
  const value = BigInt(match[1] ?? '0');
  switch (match[2]) {
    case '':
      return value * 100_000_000_000n;
    case 'm':
      return value * 100_000_000n;
    case 'u':
      return value * 100_000n;
    case 'n':
      return value * 100n;
    case 'p':
      // 1 pico-BTC = 0.1 msat; BOLT11 requires a whole number of msat.
      return value % 10n === 0n ? value / 10n : null;
    default:
      return null;
  }
}

/**
 * Decodes a BOLT11 invoice. The signature is not verified (see file
 * header). Never throws: anything unexpected while decoding is `malformed`.
 */
export function decodeBolt11(text: string): { ok: true; invoice: Bolt11Invoice } | { ok: false; failure: Bolt11Failure } {
  try {
    return decodeBolt11Unchecked(text);
  } catch {
    return { ok: false, failure: 'malformed' };
  }
}

function decodeBolt11Unchecked(text: string): { ok: true; invoice: Bolt11Invoice } | { ok: false; failure: Bolt11Failure } {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('ln')) return { ok: false, failure: 'not-bolt11' };
  const sep = lower.lastIndexOf('1');
  if (sep < 3) return { ok: false, failure: 'not-bolt11' };
  const hrpTail = lower.slice(2, sep);
  const currency = BOLT11_PREFIXES.find((c) => hrpTail.startsWith(c.prefix));
  if (currency === undefined) return { ok: false, failure: 'not-bolt11' };
  const decoded = bech32Decode(trimmed, Number.POSITIVE_INFINITY);
  if (decoded === null || decoded.variant !== 'bech32') return { ok: false, failure: 'checksum' };
  const amount = hrpAmountMsat(hrpTail.slice(currency.prefix.length));
  if (amount === null) return { ok: false, failure: 'malformed' };
  const words = decoded.words;
  if (words.length < 7 + SIGNATURE_WORDS) return { ok: false, failure: 'malformed' };
  const timestamp = wordsToInt(words.slice(0, 7));
  const tagged = words.slice(7, words.length - SIGNATURE_WORDS);

  let paymentHash: string | null = null;
  let description: string | null = null;
  let hasDescriptionHash = false;
  let expirySeconds = BOLT11_DEFAULT_EXPIRY_SECONDS;
  let i = 0;
  while (i < tagged.length) {
    if (i + 3 > tagged.length) return { ok: false, failure: 'malformed' };
    const type = tagged[i] ?? 0;
    const length = (tagged[i + 1] ?? 0) * 32 + (tagged[i + 2] ?? 0);
    const data = tagged.slice(i + 3, i + 3 + length);
    if (data.length !== length) return { ok: false, failure: 'malformed' };
    i += 3 + length;
    switch (type) {
      case 1: // p — payment hash (readers skip a p field of the wrong length)
        if (length === 52 && paymentHash === null) paymentHash = bytesToHex(wordsToBytes(data));
        break;
      case 13: // d — description
        if (description === null) description = utf8Decode(wordsToBytes(data));
        break;
      case 23: // h — description hash
        if (length === 52) hasDescriptionHash = true;
        break;
      case 6: // x — expiry seconds
        // Ten 5-bit words is already 50 bits (decades); anything longer can't
        // fit a safe JavaScript integer and is not a real expiry.
        if (length === 0 || length > 10) return { ok: false, failure: 'malformed' };
        expirySeconds = wordsToInt(data);
        break;
      default:
        break; // other fields (payee, routes, features…) are for the node
    }
  }
  if (paymentHash === null) return { ok: false, failure: 'malformed' };
  // BOLT11: a writer MUST include exactly one of d (description) or h
  // (description hash); an invoice with neither is not well-formed.
  if (description === null && !hasDescriptionHash) return { ok: false, failure: 'malformed' };
  return {
    ok: true,
    invoice: {
      invoice: lower,
      network: currency.network,
      amountMsat: amount === 'none' ? null : amount,
      timestamp,
      expirySeconds,
      expiresAt: timestamp + expirySeconds,
      description,
      hasDescriptionHash,
      paymentHash,
    },
  };
}

/** Whole sats of an invoice amount (rounded up, so a review never under-states it). */
export function invoiceAmountSat(invoice: Bolt11Invoice): bigint | null {
  if (invoice.amountMsat === null) return null;
  return (invoice.amountMsat + 999n) / 1000n;
}

// ——— on-chain addresses ———

export type AddressType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'segwit-future';

export interface OnchainAddress {
  /** As it must be sent (bech32 lowercased; base58 untouched). */
  readonly address: string;
  /** Networks this address is valid on (`tb1…` is both testnet and signet). */
  readonly networks: readonly BitcoinNetwork[];
  readonly type: AddressType;
}

export const ADDRESS_TYPE_LABEL: Readonly<Record<AddressType, string>> = {
  p2pkh: 'Legacy (P2PKH)',
  p2sh: 'Script (P2SH)',
  p2wpkh: 'Native SegWit (P2WPKH)',
  p2wsh: 'SegWit script (P2WSH)',
  p2tr: 'Taproot (P2TR)',
  'segwit-future': 'Future SegWit version',
};

const SEGWIT_HRPS: ReadonlyArray<{ hrp: string; networks: readonly BitcoinNetwork[] }> = [
  { hrp: 'bc', networks: ['mainnet'] },
  { hrp: 'tb', networks: ['testnet', 'signet'] },
  { hrp: 'bcrt', networks: ['regtest'] },
];

export type AddressFailure = 'not-address' | 'checksum' | 'malformed';

export function parseOnchainAddress(text: string): { ok: true; address: OnchainAddress } | { ok: false; failure: AddressFailure } {
  try {
    return parseOnchainAddressUnchecked(text);
  } catch {
    return { ok: false, failure: 'malformed' };
  }
}

function parseOnchainAddressUnchecked(text: string): { ok: true; address: OnchainAddress } | { ok: false; failure: AddressFailure } {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const segwitHrp = SEGWIT_HRPS.find((s) => lower.startsWith(`${s.hrp}1`));
  if (segwitHrp !== undefined) {
    const decoded = bech32Decode(trimmed);
    if (decoded === null || decoded.hrp !== segwitHrp.hrp) return { ok: false, failure: 'checksum' };
    const version = decoded.words[0];
    if (version === undefined || version > 16) return { ok: false, failure: 'malformed' };
    const program = convertBits(decoded.words.slice(1), 5, 8, false);
    if (program === null || program.length < 2 || program.length > 40) return { ok: false, failure: 'malformed' };
    if (version === 0 && decoded.variant !== 'bech32') return { ok: false, failure: 'checksum' };
    if (version !== 0 && decoded.variant !== 'bech32m') return { ok: false, failure: 'checksum' };
    let type: AddressType;
    if (version === 0) {
      if (program.length === 20) type = 'p2wpkh';
      else if (program.length === 32) type = 'p2wsh';
      else return { ok: false, failure: 'malformed' };
    } else {
      type = version === 1 && program.length === 32 ? 'p2tr' : 'segwit-future';
    }
    return { ok: true, address: { address: lower, networks: segwitHrp.networks, type } };
  }
  if (!/^[123mn][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(trimmed)) return { ok: false, failure: 'not-address' };
  const payload = base58CheckDecode(trimmed);
  if (payload === null) return { ok: false, failure: 'checksum' };
  if (payload.length !== 21) return { ok: false, failure: 'malformed' };
  const testNets: readonly BitcoinNetwork[] = ['testnet', 'signet', 'regtest'];
  switch (payload[0]) {
    case 0x00:
      return { ok: true, address: { address: trimmed, networks: ['mainnet'], type: 'p2pkh' } };
    case 0x05:
      return { ok: true, address: { address: trimmed, networks: ['mainnet'], type: 'p2sh' } };
    case 0x6f:
      return { ok: true, address: { address: trimmed, networks: testNets, type: 'p2pkh' } };
    case 0xc4:
      return { ok: true, address: { address: trimmed, networks: testNets, type: 'p2sh' } };
    default:
      return { ok: false, failure: 'malformed' };
  }
}

// ——— BIP21 ———

/** Parses a BIP21 decimal BTC amount exactly into sats. Null when malformed or zero. */
export function parseBtcAmount(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text) ?? /^\.(\d{1,8})$/.exec(text);
  if (match === null) return null;
  const isFractionOnly = text.startsWith('.');
  const whole = isFractionOnly ? '0' : (match[1] ?? '0');
  const frac = (isFractionOnly ? match[1] : match[2]) ?? '';
  const sats = BigInt(whole) * SATS_PER_BTC + BigInt(frac.padEnd(8, '0') || '0');
  return sats > 0n ? sats : null;
}

/** Sats → BIP21 decimal BTC ("0.0005", never exponent notation). */
export function formatBip21Amount(sats: bigint): string {
  const whole = sats / SATS_PER_BTC;
  const frac = (sats % SATS_PER_BTC).toString().padStart(8, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

function decodeComponent(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** Builds a BIP21 URI for a receive QR. Empty optional fields are left out. */
export function buildBip21(
  address: string,
  options: { amountSat?: bigint | null; label?: string | null; message?: string | null; lightning?: string | null } = {},
): string {
  const params: string[] = [];
  if (options.amountSat !== undefined && options.amountSat !== null && options.amountSat > 0n) {
    params.push(`amount=${formatBip21Amount(options.amountSat)}`);
  }
  if (options.label !== undefined && options.label !== null && options.label.trim() !== '') {
    params.push(`label=${encodeURIComponent(options.label.trim())}`);
  }
  if (options.message !== undefined && options.message !== null && options.message.trim() !== '') {
    params.push(`message=${encodeURIComponent(options.message.trim())}`);
  }
  if (options.lightning !== undefined && options.lightning !== null && options.lightning !== '') {
    params.push(`lightning=${options.lightning}`);
  }
  return `bitcoin:${address}${params.length > 0 ? `?${params.join('&')}` : ''}`;
}

// ——— the combined parser ———

export type DestinationErrorCode =
  | 'empty'
  | 'unrecognized'
  | 'checksum'
  | 'malformed'
  | 'wrong-network'
  | 'invalid-amount'
  | 'unsupported-requirement'
  | 'unsupported-format';

export interface DestinationError {
  readonly code: DestinationErrorCode;
  /** Plain-language explanation with what to do next. */
  readonly message: string;
}

export interface ParsedDestination {
  /** What the user supplied, for the review screen. */
  readonly source: 'invoice' | 'lightning-uri' | 'address' | 'bip21';
  readonly onchain: OnchainAddress | null;
  readonly lightning: Bolt11Invoice | null;
  /** BIP21 `amount` (on-chain rail); the invoice carries its own amount. */
  readonly onchainAmountSat: bigint | null;
  readonly label: string | null;
  readonly message: string | null;
  /**
   * BIP21 only: the link's `amount` and its Lightning invoice's amount
   * disagree. Each rail pays its own amount; the review shows this so the
   * user can check with the recipient. Absent/null = no disagreement.
   */
  readonly amountWarning?: string | null;
}

export type DestinationResult =
  | { readonly ok: true; readonly destination: ParsedDestination }
  | { readonly ok: false; readonly error: DestinationError };

const fail = (code: DestinationErrorCode, message: string): DestinationResult => ({
  ok: false,
  error: { code, message },
});

function wrongNetwork(kind: 'invoice' | 'address', found: readonly BitcoinNetwork[], expected: BitcoinNetwork): DestinationResult {
  const what = kind === 'invoice' ? 'invoice' : 'address';
  const foundLabel = found.map((n) => NETWORK_LABEL[n]).join(' or ');
  return fail(
    'wrong-network',
    `This is a ${foundLabel} ${what}, but this wallet is on ${NETWORK_LABEL[expected]}. Ask for a ${NETWORK_LABEL[expected]} ${what} instead.`,
  );
}

function invoiceFailure(failure: Bolt11Failure): DestinationResult {
  return failure === 'checksum'
    ? fail('checksum', "This invoice doesn't check out — a character is wrong or missing. Copy it again from the source.")
    : fail('malformed', "This looks like a Lightning invoice but it can't be read. Ask the recipient for a new one.");
}

function addressFailure(failure: AddressFailure): DestinationResult {
  return failure === 'checksum'
    ? fail('checksum', "This address doesn't check out — a character is wrong or missing. Copy it again from the source.")
    : fail('malformed', "This looks like a Bitcoin address but it isn't valid. Check it with the recipient.");
}

function parseInvoiceFor(text: string, network: BitcoinNetwork): { ok: true; invoice: Bolt11Invoice } | { ok: false; result: DestinationResult } {
  const decoded = decodeBolt11(text);
  if (!decoded.ok) {
    return {
      ok: false,
      result:
        decoded.failure === 'not-bolt11'
          ? fail('unrecognized', 'The Lightning part is not a BOLT11 invoice this wallet can read.')
          : invoiceFailure(decoded.failure),
    };
  }
  if (decoded.invoice.network !== network) {
    return { ok: false, result: wrongNetwork('invoice', [decoded.invoice.network], network) };
  }
  return { ok: true, invoice: decoded.invoice };
}

function unsupportedFormat(lower: string): DestinationResult | null {
  if (lower.startsWith('lno1')) {
    return fail('unsupported-format', "This is a BOLT12 offer. This wallet can't pay offers yet — ask for a BOLT11 invoice.");
  }
  if (lower.startsWith('lnurl')) {
    return fail('unsupported-format', "This is an LNURL code. This wallet can't use LNURL yet — ask for a Lightning invoice.");
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) {
    return fail(
      'unsupported-format',
      "This is a Lightning address. This wallet can't look those up yet — ask for a Lightning invoice.",
    );
  }
  if (/^t?ark1/.test(lower)) {
    return fail('unsupported-format', "This is an Ark address. This wallet can't send to Ark addresses yet.");
  }
  return null;
}

/**
 * Parses a pasted or scanned destination for a wallet on `network`.
 * Whitespace around the text is ignored; schemes are case-insensitive.
 */
export function parseDestination(raw: string, network: BitcoinNetwork): DestinationResult {
  try {
    return parseDestinationUnchecked(raw, network);
  } catch {
    // Whatever was pasted or scanned, the screen gets an explanation, not a crash.
    return fail('malformed', "This payment request couldn't be read. Check that it was copied completely, or ask for a new one.");
  }
}

function parseDestinationUnchecked(raw: string, network: BitcoinNetwork): DestinationResult {
  const text = raw.trim();
  if (text === '') return fail('empty', 'Paste an invoice or a Bitcoin address.');
  const lower = text.toLowerCase();

  if (lower.startsWith('lightning:')) {
    const inner = text.slice('lightning:'.length).replace(/^\/\//, '');
    const unsupported = unsupportedFormat(inner.toLowerCase());
    if (unsupported !== null) return unsupported;
    const parsed = parseInvoiceFor(inner, network);
    if (!parsed.ok) return parsed.result;
    return {
      ok: true,
      destination: { source: 'lightning-uri', onchain: null, lightning: parsed.invoice, onchainAmountSat: null, label: null, message: null },
    };
  }

  if (lower.startsWith('bitcoin:')) return parseBip21(text, network);

  const unsupported = unsupportedFormat(lower);
  if (unsupported !== null) return unsupported;

  if (/^ln(bcrt|tbs|bc|tb)/.test(lower)) {
    const parsed = parseInvoiceFor(text, network);
    if (!parsed.ok) return parsed.result;
    return {
      ok: true,
      destination: { source: 'invoice', onchain: null, lightning: parsed.invoice, onchainAmountSat: null, label: null, message: null },
    };
  }

  const address = parseOnchainAddress(text);
  if (!address.ok) {
    return address.failure === 'not-address'
      ? fail('unrecognized', "This isn't a Lightning invoice or a Bitcoin address. Check what you pasted.")
      : addressFailure(address.failure);
  }
  if (!address.address.networks.includes(network)) return wrongNetwork('address', address.address.networks, network);
  return {
    ok: true,
    destination: { source: 'address', onchain: address.address, lightning: null, onchainAmountSat: null, label: null, message: null },
  };
}

function parseBip21(text: string, network: BitcoinNetwork): DestinationResult {
  const body = text.slice('bitcoin:'.length).replace(/^\/\//, '');
  const q = body.indexOf('?');
  const addressPart = q === -1 ? body : body.slice(0, q);
  const query = q === -1 ? '' : body.slice(q + 1);

  let amountSat: bigint | null = null;
  let label: string | null = null;
  let message: string | null = null;
  let lightningText: string | null = null;
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    const value = decodeComponent(rawValue);
    if (value === null) return fail('malformed', 'This payment link is damaged (bad escape sequence). Copy it again.');
    switch (key) {
      case 'amount': {
        const sats = parseBtcAmount(value);
        if (sats === null) return fail('invalid-amount', `This payment link has an invalid amount ("${value}").`);
        amountSat = sats;
        break;
      }
      case 'label':
        label = value;
        break;
      case 'message':
        message = value;
        break;
      case 'lightning':
        lightningText = value;
        break;
      default:
        if (key.startsWith('req-')) {
          return fail(
            'unsupported-requirement',
            `This payment link requires "${key.slice(4)}", which this wallet doesn't support, so it can't be paid safely here.`,
          );
        }
    }
  }

  let lightning: Bolt11Invoice | null = null;
  if (lightningText !== null) {
    const parsed = parseInvoiceFor(lightningText, network);
    if (!parsed.ok) return parsed.result;
    lightning = parsed.invoice;
  }

  let onchain: OnchainAddress | null = null;
  if (addressPart !== '') {
    const address = parseOnchainAddress(addressPart);
    if (!address.ok) {
      return address.failure === 'not-address'
        ? fail('unrecognized', "This payment link doesn't contain a valid Bitcoin address.")
        : addressFailure(address.failure);
    }
    if (!address.address.networks.includes(network)) return wrongNetwork('address', address.address.networks, network);
    onchain = address.address;
  }
  if (onchain === null && lightning === null) {
    return fail('unrecognized', 'This payment link has no address or invoice in it.');
  }
  const invoiceSat = lightning === null ? null : invoiceAmountSat(lightning);
  const amountWarning =
    amountSat !== null && invoiceSat !== null && invoiceSat !== amountSat
      ? `This payment link asks for ${formatSatsPlain(amountSat)} on-chain, but its Lightning invoice is for ${formatSatsPlain(invoiceSat)}. Paying with Lightning sends the invoice's ${formatSatsPlain(invoiceSat)}; paying on-chain sends ${formatSatsPlain(amountSat)}. Check with the recipient which amount is right.`
      : null;
  return {
    ok: true,
    destination: { source: 'bip21', onchain, lightning, onchainAmountSat: amountSat, label, message, amountWarning },
  };
}

/** "12,345 sats" — plain text for messages built in this file. */
function formatSatsPlain(sats: bigint): string {
  return `${sats.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} sats`;
}

/** For tests and simulators: a valid segwit v0 address with a given 20/32-byte program. */
export function encodeSegwitAddress(network: BitcoinNetwork, version: number, program: Uint8Array): string {
  const hrp = network === 'mainnet' ? 'bc' : network === 'regtest' ? 'bcrt' : 'tb';
  const words = convertBits([...program], 8, 5, true) ?? [];
  return bech32Encode(hrp, [version, ...words], version === 0 ? 'bech32' : 'bech32m');
}
