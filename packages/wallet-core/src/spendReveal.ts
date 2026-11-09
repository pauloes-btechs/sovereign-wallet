/**
 * Did spending an output reveal a public key?
 *
 * Spending a key-hash output (P2PKH, P2WPKH, nested P2WPKH) always puts its
 * public key on-chain. Spending a generic script-hash output (P2SH, P2WSH)
 * reveals the redeem/witness script, which may or may not contain keys (a
 * hash lock or timelock-only script has none). This reads the actual spending
 * input of a raw transaction and answers:
 *
 *   true  — a public key appears in the scriptSig, the witness, or a script
 *           revealed by them (redeem script / witness script);
 *   false — everything the input revealed was read and holds no public key;
 *   null  — unknown: the transaction could not be parsed or the input is not
 *           in it. Callers must treat null as "unknown", never as either side.
 *
 * A 33-byte push starting 02/03 or a 65-byte push starting 04 counts as a
 * public key. That is how keys are serialized in scripts; a hash preimage
 * that happens to match would be counted as a key (erring towards
 * "exposed" for that rare item, never towards "hidden").
 */

export type SpendReveal = boolean | null;

class ParseError extends Error {}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.trim().toLowerCase();
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new ParseError('not hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

class Reader {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  get remaining(): number {
    return this.b.length - this.pos;
  }
  peek(): number {
    if (this.pos >= this.b.length) throw new ParseError('eof');
    return this.b[this.pos] ?? 0;
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.b.length) throw new ParseError('eof');
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u8(): number {
    return this.bytes(1)[0] ?? 0;
  }
  u32(): number {
    const v = this.bytes(4);
    return ((v[0] ?? 0) | ((v[1] ?? 0) << 8) | ((v[2] ?? 0) << 16)) + (v[3] ?? 0) * 0x1000000;
  }
  varint(): number {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = this.bytes(2);
      return (v[0] ?? 0) | ((v[1] ?? 0) << 8);
    }
    if (first === 0xfe) return this.u32();
    const lo = this.u32();
    const hi = this.u32();
    if (hi !== 0) throw new ParseError('varint too large');
    return lo;
  }
}

interface ParsedInput {
  readonly prevTxid: string; // display byte order
  readonly prevIndex: number;
  readonly scriptSig: Uint8Array;
  witness: readonly Uint8Array[];
}

/** Parses a serialized transaction's inputs (legacy or SegWit encoding). */
export function parseTransactionInputs(rawTxHex: string): readonly ParsedInput[] | null {
  try {
    const r = new Reader(hexToBytes(rawTxHex));
    r.bytes(4); // version
    let segwit = false;
    if (r.peek() === 0x00) {
      r.u8();
      if (r.u8() !== 0x01) throw new ParseError('bad segwit flag');
      segwit = true;
    }
    const inCount = r.varint();
    if (inCount === 0) throw new ParseError('no inputs');
    const inputs: ParsedInput[] = [];
    for (let i = 0; i < inCount; i += 1) {
      const prev = r.bytes(32);
      const prevTxid = toHex(Uint8Array.from(prev).reverse());
      const prevIndex = r.u32();
      const scriptSig = r.bytes(r.varint());
      r.bytes(4); // sequence
      inputs.push({ prevTxid, prevIndex, scriptSig, witness: [] });
    }
    const outCount = r.varint();
    for (let i = 0; i < outCount; i += 1) {
      r.bytes(8);
      r.bytes(r.varint());
    }
    if (segwit) {
      for (const input of inputs) {
        const items: Uint8Array[] = [];
        const n = r.varint();
        for (let j = 0; j < n; j += 1) items.push(r.bytes(r.varint()));
        input.witness = items;
      }
    }
    r.bytes(4); // locktime
    if (r.remaining !== 0) throw new ParseError('trailing bytes');
    return inputs;
  } catch {
    return null;
  }
}

/** The data pushes of a script; null when the script is malformed. Non-push opcodes are skipped. */
export function scriptPushes(script: Uint8Array): readonly Uint8Array[] | null {
  try {
    const r = new Reader(script);
    const pushes: Uint8Array[] = [];
    while (r.remaining > 0) {
      const op = r.u8();
      if (op >= 0x01 && op <= 0x4b) pushes.push(r.bytes(op));
      else if (op === 0x4c) pushes.push(r.bytes(r.u8()));
      else if (op === 0x4d) {
        const v = r.bytes(2);
        pushes.push(r.bytes((v[0] ?? 0) | ((v[1] ?? 0) << 8)));
      } else if (op === 0x4e) pushes.push(r.bytes(r.u32()));
    }
    return pushes;
  } catch {
    return null;
  }
}

export function isPublicKey(b: Uint8Array): boolean {
  return (b.length === 33 && (b[0] === 0x02 || b[0] === 0x03)) || (b.length === 65 && b[0] === 0x04);
}

/**
 * Whether the items an input revealed (scriptSig pushes and witness items)
 * contain a public key, directly or inside a revealed script. The last
 * scriptSig push and the last witness item are read as scripts too (redeem
 * script / witness script); a nested P2WPKH redeem script defers to the
 * witness, which then carries the key.
 */
export function revealsPublicKey(scriptSig: Uint8Array, witness: readonly Uint8Array[]): SpendReveal {
  const sigPushes = scriptPushes(scriptSig);
  if (sigPushes === null) return null;
  const direct = [...sigPushes, ...witness];
  if (direct.some(isPublicKey)) return true;
  const revealedScripts = [sigPushes.at(-1), witness.at(-1)].filter((s): s is Uint8Array => s !== undefined && s.length > 0);
  for (const script of revealedScripts) {
    const inner = scriptPushes(script);
    if (inner === null) return null;
    if (inner.some(isPublicKey)) return true;
  }
  // Nothing revealed at all (e.g. an input with empty scriptSig and witness)
  // proves nothing about the script: unknown, not "no key".
  if (direct.length === 0) return null;
  return false;
}

/**
 * Did the input of `rawTxHex` that spends `prevOutpoint` ("txid:index",
 * display byte order) reveal a public key? Null when unknown.
 */
export function spendRevealsPublicKey(rawTxHex: string, prevOutpoint: string): SpendReveal {
  const [txid, indexText] = prevOutpoint.toLowerCase().split(':');
  const index = Number(indexText);
  if (txid === undefined || txid.length !== 64 || !Number.isInteger(index) || index < 0) return null;
  const inputs = parseTransactionInputs(rawTxHex);
  if (inputs === null) return null;
  const input = inputs.find((i) => i.prevTxid === txid && i.prevIndex === index);
  if (input === undefined) return null;
  return revealsPublicKey(input.scriptSig, input.witness);
}
