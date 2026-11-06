/**
 * Bitcoin text encodings the Send and Receive flows read and write:
 * bech32 / bech32m (BIP173 / BIP350), base58check, and SHA-256 over bytes.
 *
 * Pure TypeScript with no dependencies, so it runs the same on Hermes, in
 * the web preview and in tests. Nothing here signs or holds keys.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

export type Bech32Variant = 'bech32' | 'bech32m';

export interface Bech32Decoded {
  /** Lowercased human-readable part. */
  readonly hrp: string;
  /** 5-bit data words, checksum removed. */
  readonly words: readonly number[];
  readonly variant: Bech32Variant;
}

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if (((top >>> i) & 1) === 1) chk ^= GENERATORS[i] ?? 0;
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/**
 * Decodes a bech32 or bech32m string. Null when the case is mixed, a
 * character is outside the charset, the string exceeds `maxLength`, or the
 * checksum does not verify.
 */
export function bech32Decode(text: string, maxLength = 90): Bech32Decoded | null {
  if (text.length > maxLength) return null;
  const lower = text.toLowerCase();
  if (text !== lower && text !== text.toUpperCase()) return null;
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length) return null;
  const hrp = lower.slice(0, sep);
  for (let i = 0; i < hrp.length; i += 1) {
    const code = hrp.charCodeAt(i);
    if (code < 33 || code > 126) return null;
  }
  const data: number[] = [];
  for (const ch of lower.slice(sep + 1)) {
    const value = CHARSET.indexOf(ch);
    if (value === -1) return null;
    data.push(value);
  }
  const check = polymod([...hrpExpand(hrp), ...data]);
  const variant: Bech32Variant | null =
    check === BECH32_CONST ? 'bech32' : check === BECH32M_CONST ? 'bech32m' : null;
  if (variant === null) return null;
  return { hrp, words: data.slice(0, -6), variant };
}

/** Encodes 5-bit words with a bech32/bech32m checksum. */
export function bech32Encode(hrp: string, words: readonly number[], variant: Bech32Variant): string {
  const lowerHrp = hrp.toLowerCase();
  const values = [...hrpExpand(lowerHrp), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ (variant === 'bech32' ? BECH32_CONST : BECH32M_CONST);
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return `${lowerHrp}1${[...words, ...checksum].map((w) => CHARSET.charAt(w)).join('')}`;
}

/**
 * Regroups bits (8→5 or 5→8). With `pad` false, leftover bits must be zero
 * and fewer than `from` — the strict rule segwit programs use. Null on failure.
 */
export function convertBits(
  data: readonly number[],
  from: number,
  to: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

/** 5-bit words → bytes, dropping trailing padding bits (BOLT11 fields). */
export function wordsToBytes(words: readonly number[]): Uint8Array {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Big-endian unsigned integer from 5-bit words. */
export function wordsToInt(words: readonly number[]): number {
  let value = 0;
  for (const w of words) value = value * 32 + w;
  return value;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Strict UTF-8 decode; invalid sequences become U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    let cp = 0xfffd;
    let size = 1;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc2 && b0 < 0xe0 && i + 1 < bytes.length) {
      cp = ((b0 & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f);
      size = 2;
    } else if (b0 >= 0xe0 && b0 < 0xf0 && i + 2 < bytes.length) {
      cp = ((b0 & 0x0f) << 12) | (((bytes[i + 1] ?? 0) & 0x3f) << 6) | ((bytes[i + 2] ?? 0) & 0x3f);
      size = 3;
    } else if (b0 >= 0xf0 && b0 < 0xf5 && i + 3 < bytes.length) {
      cp =
        ((b0 & 0x07) << 18) |
        (((bytes[i + 1] ?? 0) & 0x3f) << 12) |
        (((bytes[i + 2] ?? 0) & 0x3f) << 6) |
        ((bytes[i + 3] ?? 0) & 0x3f);
      size = 4;
    }
    out += String.fromCodePoint(cp);
    i += size;
  }
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

// ——— SHA-256 over bytes (base58check) ———

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export function sha256(message: Uint8Array): Uint8Array {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bitLen = message.length * 8;
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(message);
  bytes[message.length] = 0x80;
  for (let i = 0; i < 8; i += 1) {
    bytes[paddedLength - 1 - i] = Math.floor(bitLen / 2 ** (8 * i)) & 0xff;
  }
  const w = new Array<number>(64).fill(0);
  for (let off = 0; off < paddedLength; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] =
        ((bytes[off + i * 4] ?? 0) << 24) |
        ((bytes[off + i * 4 + 1] ?? 0) << 16) |
        ((bytes[off + i * 4 + 2] ?? 0) << 8) |
        (bytes[off + i * 4 + 3] ?? 0);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) | 0;
    }
    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    const round = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = ((h[i] ?? 0) + (round[i] ?? 0)) | 0;
  }
  const out = new Uint8Array(32);
  h.forEach((word, i) => {
    out[i * 4] = (word >>> 24) & 0xff;
    out[i * 4 + 1] = (word >>> 16) & 0xff;
    out[i * 4 + 2] = (word >>> 8) & 0xff;
    out[i * 4 + 3] = word & 0xff;
  });
  return out;
}

// ——— base58check (legacy addresses) ———

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decodes base58check; null when malformed or the checksum fails. Returns version + payload bytes. */
export function base58CheckDecode(text: string): Uint8Array | null {
  if (text.length === 0 || text.length > 64) return null;
  let value = 0n;
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit === -1) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  if (bytes.length < 5) return null;
  const payload = Uint8Array.from(bytes.slice(0, -4));
  const checksum = bytes.slice(-4);
  const digest = sha256(sha256(payload));
  for (let i = 0; i < 4; i += 1) {
    if (digest[i] !== checksum[i]) return null;
  }
  return payload;
}

/** Encodes version + payload bytes as base58check (tests and simulators). */
export function base58CheckEncode(payload: Uint8Array): string {
  const digest = sha256(sha256(payload));
  const bytes = [...payload, ...digest.slice(0, 4)];
  let value = 0n;
  for (const b of bytes) value = value * 256n + BigInt(b);
  let out = '';
  while (value > 0n) {
    out = BASE58.charAt(Number(value % 58n)) + out;
    value /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
