/**
 * Pure bech32 / bech32m codec (BIP-173 / BIP-350), no dependencies.
 *
 * Used by destination validation. Encoding exists so tests can build valid
 * inputs (encoder→decoder round-trip is the primary oracle); production code
 * only ever decodes.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export const BECH32_CONST = 1;
export const BECH32M_CONST = 0x2bc830a3;

function polymod(values: readonly number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i]!;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  for (const c of hrp) high.push(c.charCodeAt(0) >> 5);
  const low: number[] = [];
  for (const c of hrp) low.push(c.charCodeAt(0) & 31);
  return [...high, 0, ...low];
}

function verifyChecksum(hrp: string, data: readonly number[]): number | null {
  const values = [...hrpExpand(hrp), ...data];
  const chk = polymod(values);
  if (chk === BECH32_CONST) return BECH32_CONST;
  if (chk === BECH32M_CONST) return BECH32M_CONST;
  return null;
}

/** 8-bit bytes → 5-bit groups; throws on lossy input. */
export function convertBits(
  data: ArrayLike<number>,
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of Array.from(data)) {
    if (value < 0 || value >> fromBits !== 0) return null;
    acc = ((acc << fromBits) | value) & maxAcc;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || (acc << (toBits - bits)) & maxv) {
    return null;
  }
  return out;
}

/** 5-bit groups → 8-bit bytes; returns null on non-canonical padding. */
function convertBits5to8(data: readonly number[]): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << 8) - 1;
  for (const value of data) {
    if (value < 0 || value >> 5 !== 0) return null;
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & maxv);
    }
  }
  if (bits >= 5 || (acc << (8 - bits)) & maxv) return null;
  return out;
}

export interface Bech32Decode {
  hrp: string;
  /** 5-bit data groups excluding the checksum. */
  words: number[];
  /** Which checksum constant verified: bech32 or bech32m. */
  variant: 'bech32' | 'bech32m';
}

/**
 * Decodes a bech32/bech32m string per BIP-173 §Decoding (mixed case and
 * >90 chars are rejected). Returns null on any failure — never throws.
 */
export function bech32Decode(input: string, maxLength = 90): Bech32Decode | null {
  if (input.length < 8 || input.length > maxLength) return null;
  // Reject mixed case; lowercase is canonical.
  const hasLower = input !== input.toUpperCase();
  const hasUpper = input !== input.toLowerCase();
  if (hasLower && hasUpper) return null;
  const lowered = input.toLowerCase();

  const sep = lowered.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lowered.length) return null;
  const hrp = lowered.slice(0, sep);
  for (const c of hrp) {
    const code = c.charCodeAt(0);
    if (code < 33 || code > 126) return null;
  }
  const dataChars = lowered.slice(sep + 1);
  const words: number[] = [];
  for (const c of dataChars) {
    const value = CHARSET.indexOf(c);
    if (value === -1) return null;
    words.push(value);
  }
  const variant = verifyChecksum(hrp, words);
  if (variant === null) return null;
  return {
    hrp,
    words: words.slice(0, -6),
    variant: variant === BECH32_CONST ? 'bech32' : 'bech32m',
  };
}

/** Encodes 5-bit words with a bech32 or bech32m checksum. */
export function bech32Encode(
  hrp: string,
  words: readonly number[],
  variant: 'bech32' | 'bech32m',
): string {
  const checksumConst = variant === 'bech32' ? BECH32_CONST : BECH32M_CONST;
  const values = [...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const chk = polymod(values) ^ checksumConst;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((chk >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}

export interface SegwitAddress {
  witnessVersion: number;
  program: Uint8Array;
  variant: 'bech32' | 'bech32m';
}

/**
 * Decodes a segwit address (BIP-173 §Segwit address format + BIP-350
 * bech32m rule: v0 uses bech32, v1+ uses bech32m). HRP must be one of the
 * provided network prefixes. Returns null on any failure — never throws.
 */
export function segwitAddressDecode(
  input: string,
  allowedHrps: readonly string[],
): SegwitAddress | null {
  const decoded = bech32Decode(input);
  if (!decoded) return null;
  if (!allowedHrps.includes(decoded.hrp)) return null;
  const [version, ...rest] = decoded.words;
  if (version === undefined || version < 0 || version > 16) return null;
  // Witness program limits are in BYTES (2..40), checked after conversion.
  // (A 32-byte program is 52 words — the word count is not the byte count.)
  const program = convertBits5to8(rest);
  if (!program || program.length < 2 || program.length > 40) return null;
  // Witness v0 is always 20 or 32 bytes and uses bech32.
  if (version === 0) {
    if (program.length !== 20 && program.length !== 32) return null;
    if (decoded.variant !== 'bech32') return null;
  } else if (decoded.variant !== 'bech32m') {
    return null;
  }
  return { witnessVersion: version, program: Uint8Array.from(program), variant: decoded.variant };
}

/** Encodes a segwit address (test oracle — production code only decodes). */
export function segwitAddressEncode(
  hrp: string,
  witnessVersion: number,
  program: readonly number[],
): string | null {
  const words = convertBits(program, 8, 5, true);
  if (!words) return null;
  const variant = witnessVersion === 0 ? 'bech32' : 'bech32m';
  return bech32Encode(hrp, [witnessVersion, ...words], variant);
}
