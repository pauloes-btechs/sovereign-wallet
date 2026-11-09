import { describe, expect, it } from 'vitest';
import { isPublicKey, parseTransactionInputs, revealsPublicKey, scriptPushes, spendRevealsPublicKey } from './spendReveal.js';

// ——— a tiny transaction encoder for test vectors ———
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
const varint = (n: number): string => (n < 0xfd ? n.toString(16).padStart(2, '0') : `fd${hex(Uint8Array.of(n & 0xff, n >> 8))}`);
const u32 = (n: number): string => hex(Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff));
const push = (h: string): string => {
  const n = h.length / 2;
  if (n <= 0x4b) return n.toString(16).padStart(2, '0') + h;
  return `4c${n.toString(16).padStart(2, '0')}${h}`;
};
const reverse = (h: string): string => hex(bytes(h).reverse());

interface In {
  readonly txid: string; // display order
  readonly index: number;
  readonly scriptSig?: string;
  readonly witness?: readonly string[];
}

function encodeTx(inputs: readonly In[], segwit = true): string {
  let s = u32(2);
  if (segwit) s += '0001';
  s += varint(inputs.length);
  for (const i of inputs) {
    const sig = i.scriptSig ?? '';
    s += reverse(i.txid) + u32(i.index) + varint(sig.length / 2) + sig + 'fdffffff';
  }
  s += varint(1) + '1027000000000000' + varint(22) + '0014' + 'ee'.repeat(20);
  if (segwit) {
    for (const i of inputs) {
      const w = i.witness ?? [];
      s += varint(w.length) + w.map((item) => varint(item.length / 2) + item).join('');
    }
  }
  return s + u32(0);
}

const TXID = 'ab'.repeat(31) + 'cd'; // asymmetric so a byte-order mistake can't match
const OTHER = '12'.repeat(32);
const PUB = '02' + '11'.repeat(32); // compressed key
const PUB2 = '03' + '22'.repeat(32);
const SIG = '30' + '44'.repeat(70); // a DER-ish signature (71 bytes), not a key
const PREIMAGE = '55'.repeat(32);
const HASHLOCK = `a8${push('99'.repeat(32))}87`; // OP_SHA256 <h> OP_EQUAL: no key in it
const MULTISIG = `52${push(PUB)}${push(PUB2)}52ae`; // 2 <k1> <k2> 2 OP_CHECKMULTISIG

describe('isPublicKey / scriptPushes', () => {
  it('recognises compressed and uncompressed keys only', () => {
    expect(isPublicKey(bytes(PUB))).toBe(true);
    expect(isPublicKey(bytes('04' + '33'.repeat(64)))).toBe(true);
    expect(isPublicKey(bytes('05' + '33'.repeat(32)))).toBe(false);
    expect(isPublicKey(bytes(PREIMAGE))).toBe(false);
  });

  it('reads pushes, skips opcodes, and refuses a truncated script', () => {
    expect(scriptPushes(bytes(MULTISIG))?.map(hex)).toEqual([PUB, PUB2]);
    expect(scriptPushes(bytes(HASHLOCK))?.map(hex)).toEqual(['99'.repeat(32)]);
    expect(scriptPushes(bytes('21' + '11'.repeat(10)))).toBeNull();
  });
});

describe('spendRevealsPublicKey', () => {
  it('P2WPKH spend: the witness carries the public key', () => {
    const tx = encodeTx([{ txid: TXID, index: 1, witness: [SIG, PUB] }]);
    expect(spendRevealsPublicKey(tx, `${TXID}:1`)).toBe(true);
  });

  it('nested P2WPKH spend: redeem script in scriptSig, key in the witness', () => {
    const tx = encodeTx([{ txid: TXID, index: 0, scriptSig: push('0014' + 'cc'.repeat(20)), witness: [SIG, PUB] }]);
    expect(spendRevealsPublicKey(tx, `${TXID}:0`)).toBe(true);
  });

  it('P2WSH multisig spend: the revealed witness script contains keys', () => {
    const tx = encodeTx([{ txid: TXID, index: 0, witness: ['', SIG, SIG, MULTISIG] }]);
    expect(spendRevealsPublicKey(tx, `${TXID}:0`)).toBe(true);
  });

  it('P2WSH hash-lock spend: the revealed script holds no key', () => {
    const tx = encodeTx([{ txid: TXID, index: 0, witness: [PREIMAGE, HASHLOCK] }]);
    expect(spendRevealsPublicKey(tx, `${TXID}:0`)).toBe(false);
  });

  it('legacy P2SH spends: hash lock reveals no key, multisig does', () => {
    const lock = encodeTx([{ txid: TXID, index: 2, scriptSig: push(PREIMAGE) + push(HASHLOCK) }], false);
    expect(spendRevealsPublicKey(lock, `${TXID}:2`)).toBe(false);
    const multi = encodeTx([{ txid: TXID, index: 2, scriptSig: `00${push(SIG)}${push(SIG)}${push(MULTISIG)}` }], false);
    expect(spendRevealsPublicKey(multi, `${TXID}:2`)).toBe(true);
  });

  it('reads the input that spends the given outpoint, not its neighbours', () => {
    const tx = encodeTx([
      { txid: OTHER, index: 0, witness: [SIG, PUB] },
      { txid: TXID, index: 0, witness: [PREIMAGE, HASHLOCK] },
    ]);
    expect(spendRevealsPublicKey(tx, `${TXID}:0`)).toBe(false);
    expect(spendRevealsPublicKey(tx, `${OTHER}:0`)).toBe(true);
  });

  it('is unknown (null), never true or false, when it cannot tell', () => {
    const tx = encodeTx([{ txid: TXID, index: 0, witness: [SIG, PUB] }]);
    expect(spendRevealsPublicKey(tx, `${TXID}:7`)).toBeNull(); // input not in this tx
    expect(spendRevealsPublicKey(tx, `${reverse(TXID)}:0`)).toBeNull(); // wrong byte order
    expect(spendRevealsPublicKey(tx.slice(0, -10), `${TXID}:0`)).toBeNull(); // truncated
    expect(spendRevealsPublicKey('zz', `${TXID}:0`)).toBeNull();
    expect(spendRevealsPublicKey('', `${TXID}:0`)).toBeNull();
    expect(spendRevealsPublicKey(tx, 'not-an-outpoint')).toBeNull();
    // An input that revealed nothing proves nothing.
    expect(spendRevealsPublicKey(encodeTx([{ txid: TXID, index: 0 }]), `${TXID}:0`)).toBeNull();
    // A malformed revealed script is unknown, not "no key".
    expect(revealsPublicKey(new Uint8Array(), [bytes(PREIMAGE), bytes('4d' + 'ff')])).toBeNull();
  });

  it('parses both encodings and rejects trailing bytes', () => {
    expect(parseTransactionInputs(encodeTx([{ txid: TXID, index: 3, scriptSig: push(PUB) }], false))?.[0]?.prevIndex).toBe(3);
    expect(parseTransactionInputs(encodeTx([{ txid: TXID, index: 3 }]) + '00')).toBeNull();
  });
});
