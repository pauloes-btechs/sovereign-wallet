/**
 * Test/preview-only encoders for well-formed BOLT11 invoices and segwit
 * addresses, so the simulated backends hand out strings that the Send
 * parser accepts the same way it accepts real ones.
 *
 * The invoices carry a valid bech32 checksum and real tagged fields
 * (payment hash, description, expiry) but an all-zero signature: no node
 * signed them, and nothing outside the simulators ever produces them.
 */

import { bech32Encode, convertBits, hexToBytes, sha256, utf8Encode } from '../flows/bitcoinEncoding.js';
import type { BitcoinNetwork } from '../flows/destination.js';
import { encodeSegwitAddress } from '../flows/destination.js';

const CURRENCY: Readonly<Record<BitcoinNetwork, string>> = {
  mainnet: 'bc',
  testnet: 'tb',
  signet: 'tbs',
  regtest: 'bcrt',
};

function intToWords(value: number, minLength = 1): number[] {
  const words: number[] = [];
  let v = value;
  while (v > 0) {
    words.unshift(v % 32);
    v = Math.floor(v / 32);
  }
  while (words.length < minLength) words.unshift(0);
  return words;
}

function tagged(type: number, data: readonly number[]): number[] {
  return [type, Math.floor(data.length / 32), data.length % 32, ...data];
}

function hrpAmount(msat: bigint): string {
  const units: ReadonlyArray<[string, bigint]> = [
    ['', 100_000_000_000n],
    ['m', 100_000_000n],
    ['u', 100_000n],
    ['n', 100n],
  ];
  for (const [suffix, size] of units) {
    if (msat % size === 0n) return `${msat / size}${suffix}`;
  }
  return `${msat * 10n}p`;
}

export interface SimulatedInvoiceInput {
  readonly network: BitcoinNetwork;
  /** Null = amountless invoice. */
  readonly amountMsat: bigint | null;
  /** 64 hex chars. */
  readonly paymentHashHex: string;
  readonly description?: string;
  readonly expirySeconds?: number;
  /** Unix seconds. */
  readonly timestamp: number;
}

export function encodeSimulatedBolt11(input: SimulatedInvoiceInput): string {
  const hash = hexToBytes(input.paymentHashHex);
  if (hash === null || hash.length !== 32) throw new Error('sim invoice: payment hash must be 32 bytes of hex');
  const hrp = `ln${CURRENCY[input.network]}${input.amountMsat === null ? '' : hrpAmount(input.amountMsat)}`;
  const words: number[] = [...intToWords(input.timestamp, 7)];
  words.push(...tagged(1, convertBits([...hash], 8, 5, true) ?? []));
  if (input.description !== undefined) {
    words.push(...tagged(13, convertBits([...utf8Encode(input.description)], 8, 5, true) ?? []));
  }
  if (input.expirySeconds !== undefined) words.push(...tagged(6, intToWords(input.expirySeconds)));
  words.push(...new Array<number>(104).fill(0)); // unsigned: simulation only
  return bech32Encode(hrp, words, 'bech32');
}

/** 32-byte hex digest of a label — deterministic simulated payment hashes. */
export function simHashHex(label: string): string {
  return [...sha256(utf8Encode(label))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A valid P2WPKH address for `network`, derived from a label (simulation only). */
export function simSegwitAddress(network: BitcoinNetwork, label: string): string {
  return encodeSegwitAddress(network, 0, sha256(utf8Encode(label)).slice(0, 20));
}
