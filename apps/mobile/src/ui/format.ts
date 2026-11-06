/**
 * Amount and identifier formatting shared by every tab. Pure functions (no
 * React Native imports) so they are unit-tested directly.
 *
 * All arithmetic is on bigint satoshis — never floats — so BTC display and
 * BTC input are exact to the satoshi.
 */

import type { Denomination } from '../flows/preferences.js';

export const SATS_PER_BTC = 100_000_000n;

/** What a masked amount looks like (privacy mode). Same glyphs as desktop. */
export const AMOUNT_MASK = '••••••';

/** Spoken in place of a masked amount. */
export const HIDDEN_AMOUNT_LABEL = 'Amount hidden';

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "1,250,000" — whole sats with thousands separators. */
export function formatSatsNumber(sats: bigint): string {
  const negative = sats < 0n;
  const text = groupThousands((negative ? -sats : sats).toString());
  return negative ? `-${text}` : text;
}

/** "0.01250000" — always 8 decimals, exact (bigint). */
export function formatBtcNumber(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = groupThousands((abs / SATS_PER_BTC).toString());
  const frac = (abs % SATS_PER_BTC).toString().padStart(8, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export interface FormatAmountOptions {
  readonly denomination: Denomination;
  /** Privacy mode: the digits are replaced by AMOUNT_MASK; the unit stays. */
  readonly hidden?: boolean;
  /** Explicit direction sign; amounts are otherwise unsigned in lists. */
  readonly sign?: '+' | '−' | null;
  /** Append the unit ("sats" / "BTC"). Default true. */
  readonly withUnit?: boolean;
}

/** "1,250,000 sats", "0.01250000 BTC", "+5,000 sats", "•••••• sats". */
export function formatAmount(sats: bigint, options: FormatAmountOptions): string {
  const unit = options.withUnit === false ? '' : ` ${unitLabel(options.denomination)}`;
  if (options.hidden === true) return `${AMOUNT_MASK}${unit}`;
  const digits =
    options.denomination === 'btc' ? formatBtcNumber(sats) : formatSatsNumber(sats);
  return `${options.sign ?? ''}${digits}${unit}`;
}

/** What a screen reader should say for an amount (never the mask glyphs). */
export function amountAccessibilityLabel(sats: bigint, options: FormatAmountOptions): string {
  if (options.hidden === true) return HIDDEN_AMOUNT_LABEL;
  const direction = options.sign === '+' ? 'plus ' : options.sign === '−' ? 'minus ' : '';
  return `${direction}${formatAmount(sats, { ...options, sign: null, withUnit: true })}`;
}

export function unitLabel(denomination: Denomination): string {
  return denomination === 'btc' ? 'BTC' : 'sats';
}

/**
 * Commas are only thousands separators, and only in the whole-number part:
 * "1,000.5" is fine, "0,001" and "1,5" are refused rather than read as 1
 * and 15 (in many locales the comma is the decimal mark, so guessing could
 * send 1,000× the intended amount).
 */
const GROUPED_WHOLE = /^[1-9]\d{0,2}(?:,\d{3})+$/;

const COMMA_PROBLEM = 'Use a dot for decimals, like 0.001. Commas can only separate thousands, like 1,000.5.';

/**
 * Why what the user typed can't be read as an amount in this denomination;
 * null when it can (or the field is empty).
 */
export function amountInputProblem(text: string, denomination: Denomination): string | null {
  const compact = text.replace(/[\s_]/g, '');
  if (compact === '') return null;
  if (compact.includes(',')) {
    const dot = compact.indexOf('.');
    const whole = dot === -1 ? compact : compact.slice(0, dot);
    const frac = dot === -1 ? '' : compact.slice(dot + 1);
    if (frac.includes(',') || !GROUPED_WHOLE.test(whole)) return COMMA_PROBLEM;
  }
  if (parseAmountInput(text, denomination) !== null) return null;
  return denomination === 'btc' ? 'Enter BTC with up to 8 decimals.' : 'Enter a whole number of sats.';
}

/**
 * Parses what the user typed in the current denomination into sats.
 * sats: digits only (spaces and thousands commas allowed as grouping).
 * BTC: up to 8 decimals, a dot as the decimal mark. Returns null for empty,
 * malformed (including commas that aren't thousands groups), zero or negative.
 */
export function parseAmountInput(text: string, denomination: Denomination): bigint | null {
  const compact = text.replace(/[\s_]/g, '');
  if (compact === '') return null;
  const dot = compact.indexOf('.');
  const wholeRaw = dot === -1 ? compact : compact.slice(0, dot);
  const fracRaw = dot === -1 ? null : compact.slice(dot + 1);
  if (fracRaw !== null && fracRaw.includes(',')) return null;
  if (wholeRaw.includes(',') && !GROUPED_WHOLE.test(wholeRaw)) return null;
  const cleaned = wholeRaw.replace(/,/g, '') + (fracRaw === null ? '' : `.${fracRaw}`);
  if (denomination === 'sats') {
    if (!/^\d+$/.test(cleaned)) return null;
    const value = BigInt(cleaned);
    return value > 0n ? value : null;
  }
  const match = /^(\d*)(?:\.(\d{0,8}))?$/.exec(cleaned);
  if (match === null) return null;
  const whole = match[1] ?? '';
  const frac = match[2] ?? '';
  if (whole === '' && frac === '') return null;
  const value = BigInt(whole === '' ? '0' : whole) * SATS_PER_BTC + BigInt(frac.padEnd(8, '0') || '0');
  return value > 0n ? value : null;
}

/** Replaces any text with the mask when privacy mode is on. */
export function maskText(text: string, hidden: boolean): string {
  return hidden ? AMOUNT_MASK : text;
}

/** "lnbcrt12…9xk2f4" — keeps both ends of ids, invoices and addresses. */
export function shortenMiddle(text: string, head = 8, tail = 6): string {
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}
