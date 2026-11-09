import { describe, expect, it } from 'vitest';
import {
  classifyExposure,
  REASON_ORDER,
  REASON_STATUS,
  scriptFamily,
  type ExposureChannelInput,
  type ExposureUtxoInput,
} from './index.js';

const P2TR = '5120' + '4d'.repeat(32);
const P2WPKH = '0014' + 'f2'.repeat(20);
const P2WSH = '0020' + 'aa'.repeat(32);
const P2SH = 'a914' + 'bb'.repeat(20) + '87';
const P2PKH = '76a914' + 'cc'.repeat(20) + '88ac';
const P2PK_C = '21' + '02' + 'dd'.repeat(32) + 'ac';
const P2PK_U = '41' + '04' + 'ee'.repeat(64) + 'ac';

const utxo = (outpoint: string, address: string, pkScript: string, amountSat: number, extra: Partial<ExposureUtxoInput> = {}): ExposureUtxoInput => ({
  outpoint,
  address,
  pkScript,
  amountSat,
  ...extra,
});

const channel = (commitmentType: string | undefined, extra: Partial<ExposureChannelInput> = {}): ExposureChannelInput => ({
  channelPoint: 'ch:0',
  commitmentType,
  state: 'open',
  localBalanceSat: 600,
  capacitySat: 1_000,
  ...extra,
});

describe('scriptFamily', () => {
  it('reads every standard template from the output script', () => {
    expect(scriptFamily(P2TR)).toBe('p2tr');
    expect(scriptFamily(P2WPKH)).toBe('p2wpkh');
    expect(scriptFamily(P2WSH)).toBe('p2wsh');
    expect(scriptFamily(P2SH)).toBe('p2sh');
    expect(scriptFamily(P2PKH)).toBe('p2pkh');
    expect(scriptFamily(P2PK_C)).toBe('p2pk');
    expect(scriptFamily(P2PK_U)).toBe('p2pk');
    expect(scriptFamily(P2TR.toUpperCase())).toBe('p2tr');
  });

  it('never guesses: wrong lengths, odd hex and other witness versions are unknown', () => {
    expect(scriptFamily('')).toBe('unknown');
    expect(scriptFamily('5120abcd')).toBe('unknown');
    expect(scriptFamily(P2WPKH + '00')).toBe('unknown');
    expect(scriptFamily('zz' + P2WPKH.slice(2))).toBe('unknown');
    expect(scriptFamily(P2WPKH.slice(1))).toBe('unknown');
    // A SegWit v2 (BIP-360 P2MR) program is not something this wallet makes; not classified.
    expect(scriptFamily('5220' + 'ab'.repeat(32))).toBe('unknown');
    expect(scriptFamily('6a' + '04deadbeef')).toBe('unknown');
  });
});

describe('classifyExposure — on-chain outputs', () => {
  it('marks taproot and pay-to-public-key outputs exposed now', () => {
    const r = classifyExposure({
      utxos: [utxo('t:0', 'bcrt1p1', P2TR, 100), utxo('k:0', '', P2PK_C, 7)],
      spentFromAddresses: [],
    });
    expect(r.items.map((i) => [i.id, i.status, i.reason])).toEqual([
      ['t:0', 'exposed', 'taproot-output'],
      ['k:0', 'exposed', 'bare-public-key'],
    ]);
    expect(r.exposedSat).toBe(107);
    expect(r.hiddenSat).toBe(0);
  });

  it('keeps hashed outputs hidden until spent, and never calls them quantum-safe', () => {
    const r = classifyExposure({
      utxos: [utxo('a:0', 'q1', P2WPKH, 10), utxo('b:0', '3np', P2SH, 20), utxo('c:0', '1leg', P2PKH, 30), utxo('d:0', 'wsh', P2WSH, 40)],
      spentFromAddresses: [],
    });
    expect(r.items.every((i) => i.status === 'hidden' && i.reason === 'hashed-unspent')).toBe(true);
    expect(r.hiddenSat).toBe(100);
    for (const i of r.items) expect(`${i.why} ${i.reduce}`.toLowerCase()).not.toMatch(/quantum[- ]safe|quantum[- ]proof|secure against/);
  });

  it('marks a hashed address exposed once it was spent from (address reused after a spend)', () => {
    const r = classifyExposure({
      utxos: [utxo('a:1', 'reused', P2WPKH, 25), utxo('a:2', 'fresh', P2WPKH, 5)],
      spentFromAddresses: ['reused', 'elsewhere'],
    });
    const reused = r.items.find((i) => i.id === 'a:1');
    expect(reused).toMatchObject({ status: 'exposed', reason: 'reused-after-spend', amountSat: 25 });
    expect(reused?.why).toMatch(/spent from before/);
    expect(r.items.find((i) => i.id === 'a:2')).toMatchObject({ status: 'hidden', reason: 'hashed-unspent' });
    expect(r.exposedSat).toBe(25);
    expect(r.hiddenSat).toBe(5);
  });

  describe('generic P2SH / P2WSH spent from (spending reveals a script, not necessarily a key)', () => {
    it('without spend data is unknown, never exposed', () => {
      const r = classifyExposure({
        utxos: [utxo('s:1', 'wsh', P2WSH, 40), utxo('s:2', 'sh', P2SH, 30)],
        spentFromAddresses: ['wsh', 'sh'],
      });
      for (const id of ['s:1', 's:2']) {
        expect(r.items.find((i) => i.id === id)).toMatchObject({ status: 'unclassified', reason: 'script-spend-unverified' });
      }
      expect(r.exposedSat).toBe(0);
      expect(r.unclassifiedSat).toBe(70);
    });

    it('unknown evidence (null) stays unknown', () => {
      const r = classifyExposure({
        utxos: [utxo('s:1', 'wsh', P2WSH, 40)],
        spentFromAddresses: ['wsh'],
        spendEvidence: [{ address: 'wsh', revealsPublicKey: null }],
      });
      expect(r.items[0]).toMatchObject({ status: 'unclassified', reason: 'script-spend-unverified' });
    });

    it('a spend that showed a key makes it exposed; one that showed a keyless script keeps it hidden', () => {
      const r = classifyExposure({
        utxos: [utxo('s:1', 'multisig', P2WSH, 40), utxo('s:2', 'hashlock', P2WSH, 10)],
        spentFromAddresses: ['multisig', 'hashlock'],
        spendEvidence: [
          { address: 'multisig', revealsPublicKey: true },
          { address: 'hashlock', revealsPublicKey: false },
        ],
      });
      expect(r.items.find((i) => i.id === 's:1')).toMatchObject({ status: 'exposed', reason: 'reused-after-spend' });
      const lock = r.items.find((i) => i.id === 's:2');
      expect(lock).toMatchObject({ status: 'hidden', reason: 'script-spent-no-key' });
      expect(lock?.why).toMatch(/contains no public key/);
      expect(r.exposedSat).toBe(40);
      expect(r.hiddenSat).toBe(10);
    });

    it('several spends from one address: any key wins, otherwise any unknown wins over "no key"', () => {
      const one = (ev: readonly (boolean | null)[]) =>
        classifyExposure({
          utxos: [utxo('s:1', 'x', P2WSH, 1)],
          spentFromAddresses: ['x'],
          spendEvidence: ev.map((revealsPublicKey) => ({ address: 'x', revealsPublicKey })),
        }).items[0]?.reason;
      expect(one([false, true, null])).toBe('reused-after-spend');
      expect(one([false, null])).toBe('script-spend-unverified');
      expect(one([false, false])).toBe('script-spent-no-key');
    });

    it('key-hash addresses keep the definite rule: P2PKH and nested P2WPKH are exposed after a spend without evidence', () => {
      const r = classifyExposure({
        utxos: [utxo('k:1', 'legacy', P2PKH, 3), utxo('k:2', 'nested', P2SH, 4, { addressType: 'np2wkh' })],
        spentFromAddresses: ['legacy', 'nested'],
      });
      for (const id of ['k:1', 'k:2']) {
        expect(r.items.find((i) => i.id === id)).toMatchObject({ status: 'exposed', reason: 'reused-after-spend' });
      }
    });

    it('evidence for a key-hash address cannot downgrade it: its spend revealed the key by definition', () => {
      const r = classifyExposure({
        utxos: [utxo('k:1', 'a', P2WPKH, 9)],
        spentFromAddresses: ['a'],
        spendEvidence: [{ address: 'a', revealsPublicKey: false }],
      });
      expect(r.items[0]).toMatchObject({ status: 'exposed', reason: 'reused-after-spend' });
    });

    it('an unspent generic script address says "hash of the script", not of a key', () => {
      const r = classifyExposure({ utxos: [utxo('s:1', 'wsh', P2WSH, 1)], spentFromAddresses: [] });
      expect(r.items[0]).toMatchObject({ status: 'hidden', reason: 'hashed-unspent' });
      expect(r.items[0]?.why).toMatch(/hash of the script/);
    });
  });

  it('a taproot output stays "taproot-output" even if its address was spent from (already exposed)', () => {
    const r = classifyExposure({ utxos: [utxo('t:0', 'bcrt1p1', P2TR, 9)], spentFromAddresses: ['bcrt1p1'] });
    expect(r.items[0]?.reason).toBe('taproot-output');
  });

  it('warns when several unspent coins share one hashed address, without calling them exposed', () => {
    const r = classifyExposure({
      utxos: [utxo('a:0', 'same', P2WPKH, 1), utxo('b:0', 'same', P2WPKH, 2)],
      spentFromAddresses: [],
    });
    for (const i of r.items) {
      expect(i.status).toBe('hidden');
      expect(i.coinsAtAddress).toBe(2);
      expect(i.why).toMatch(/2 coins share this address/);
      expect(i.reduce).toMatch(/spend all of its coins together/);
    }
  });

  it('reads the script, not the backend label, and falls back to the label only when the script is missing', () => {
    const lying = classifyExposure({ utxos: [utxo('x:0', 'a', P2TR, 1, { addressType: 'p2wkh' })], spentFromAddresses: [] });
    expect(lying.items[0]?.reason).toBe('taproot-output');
    const noScript = classifyExposure({ utxos: [utxo('y:0', 'b', '', 1, { addressType: 'p2tr' })], spentFromAddresses: [] });
    expect(noScript.items[0]?.reason).toBe('taproot-output');
    const neither = classifyExposure({ utxos: [utxo('z:0', 'c', '', 3)], spentFromAddresses: [] });
    expect(neither.items[0]).toMatchObject({ status: 'unclassified', reason: 'unknown-script' });
    expect(neither.unclassifiedSat).toBe(3);
  });

  it('does not count a duplicated outpoint twice', () => {
    const r = classifyExposure({ utxos: [utxo('a:0', 'q', P2WPKH, 10), utxo('A:0', 'q', P2WPKH, 10)], spentFromAddresses: [] });
    expect(r.items).toHaveLength(1);
    expect(r.hiddenSat).toBe(10);
  });
});

describe('classifyExposure — channels', () => {
  it('taproot channels are exposed; amount is the local balance, capacity is carried separately', () => {
    for (const t of ['simple_taproot', 'simple_taproot_overlay', 'taproot']) {
      const r = classifyExposure({ utxos: [], spentFromAddresses: [], channels: [channel(t)] });
      expect(r.items[0]).toMatchObject({ source: 'channel', status: 'exposed', reason: 'taproot-channel', amountSat: 600, capacitySat: 1_000 });
      expect(r.items[0]?.why).toMatch(/your side/);
      expect(r.exposedSat).toBe(600);
    }
  });

  it('P2WSH multisig channels (legacy, static remote key, anchors, lease) are hidden until the channel closes', () => {
    for (const t of ['legacy', 'static_remote_key', 'anchors', 'script_enforced_lease']) {
      const r = classifyExposure({ utxos: [], spentFromAddresses: [], channels: [channel(t)] });
      expect(r.items[0]).toMatchObject({ status: 'hidden', reason: 'multisig-channel', amountSat: 600 });
      expect(r.items[0]?.why).toMatch(/Closing the channel publishes them/);
    }
  });

  it('classifies opening channels by type, and an unreported type as unclassified', () => {
    const r = classifyExposure({
      utxos: [],
      spentFromAddresses: [],
      channels: [channel('anchors', { channelPoint: 'o:0', state: 'opening' }), channel(undefined, { channelPoint: 'u:0' }), channel('unknown', { channelPoint: 'v:0' })],
    });
    expect(r.items.find((i) => i.id === 'o:0')?.reason).toBe('multisig-channel');
    expect(r.items.find((i) => i.id === 'u:0')).toMatchObject({ status: 'unclassified', reason: 'unknown-channel-type' });
    expect(r.items.find((i) => i.id === 'v:0')?.reason).toBe('unknown-channel-type');
  });

  it('never counts a closing channel (its funds reappear as on-chain outputs)', () => {
    const r = classifyExposure({
      utxos: [],
      spentFromAddresses: [],
      channels: (['closing', 'closing-force', 'waiting-close'] as const).map((state, i) => channel('anchors', { channelPoint: `c:${i}`, state })),
    });
    expect(r.items.every((i) => i.reason === 'channel-closing' && i.amountSat === null)).toBe(true);
    expect(r.exposedSat + r.hiddenSat + r.unclassifiedSat).toBe(0);
    expect(r.byReason).toEqual([{ reason: 'channel-closing', status: 'unclassified', count: 3, amountSat: 0, uncountedItems: 3 }]);
  });
});

describe('classifyExposure — Taproot Assets', () => {
  const asset = { assetIdHex: 'aa'.repeat(32), name: 'Demo USD', amount: '1000000', isSpent: false };

  it('attaches assets to the wallet output that anchors them, counting its bitcoin once', () => {
    const r = classifyExposure({
      utxos: [utxo('ANCHOR:0', 'bcrt1panchor', P2TR, 1_000), utxo('t:1', 'bcrt1pchange', P2TR, 50_000)],
      spentFromAddresses: [],
      assets: [{ ...asset, anchorOutpoint: 'anchor:0' }],
    });
    expect(r.items).toHaveLength(2);
    const anchor = r.items.find((i) => i.reason === 'asset-anchor');
    expect(anchor).toMatchObject({ source: 'onchain', status: 'exposed', amountSat: 1_000, assets: [{ name: 'Demo USD', amount: '1000000' }] });
    expect(r.exposedSat).toBe(51_000);
    expect(r.byReason.map((g) => [g.reason, g.count, g.amountSat])).toEqual([
      ['taproot-output', 1, 50_000],
      ['asset-anchor', 1, 1_000],
    ]);
  });

  it('lists an anchor the wallet does not report as an output without inventing its bitcoin amount', () => {
    const r = classifyExposure({
      utxos: [],
      spentFromAddresses: [],
      assets: [
        { ...asset, anchorOutpoint: 'x:1' },
        { ...asset, assetIdHex: 'bb'.repeat(32), name: 'Other', anchorOutpoint: 'x:1' },
        { ...asset, name: 'Gone', anchorOutpoint: 'y:0', isSpent: true },
        { ...asset, name: 'No anchor', anchorOutpoint: '' },
      ],
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: 'x:1', source: 'asset', status: 'exposed', reason: 'asset-anchor', amountSat: null });
    expect(r.items[0]?.assets?.map((a) => a.name)).toEqual(['Demo USD', 'Other']);
    expect(r.exposedSat).toBe(0);
    expect(r.byReason[0]).toMatchObject({ reason: 'asset-anchor', count: 1, uncountedItems: 1 });
  });
});

describe('classifyExposure — report', () => {
  it('reproduces the regtest wallet: taproot change, reused-after-spend deposit, asset anchor, anchors channel', () => {
    const r = classifyExposure({
      utxos: [
        utxo('9491:1', 'bcrt1pchange', P2TR, 84_990_971, { addressType: 'p2tr' }),
        utxo('a87e:0', 'bcrt1qdeposit', P2WPKH, 25_000_000, { addressType: 'p2wkh' }),
        utxo('9491:0', 'bcrt1panchor', P2TR, 1_000, { addressType: 'p2tr' }),
      ],
      spentFromAddresses: ['bcrt1qdeposit', 'bcrt1pold'],
      channels: [channel('anchors', { channelPoint: 'dd1d:0', localBalanceSat: 12_839_530, capacitySat: 15_000_000 })],
      assets: [{ assetIdHex: 'aa'.repeat(32), name: 'Demo USD (regtest)', amount: '1000000', anchorOutpoint: '9491:0', isSpent: false }],
    });
    expect(r.exposedSat).toBe(84_990_971 + 25_000_000 + 1_000);
    expect(r.hiddenSat).toBe(12_839_530);
    expect(r.unclassifiedSat).toBe(0);
    expect(r.byReason.map((g) => g.reason)).toEqual(['taproot-output', 'reused-after-spend', 'asset-anchor', 'multisig-channel']);
    // Exposed first, largest first.
    expect(r.items.map((i) => i.id)).toEqual(['9491:1', 'a87e:0', '9491:0', 'dd1d:0']);
  });

  it('totals equal the sum of counted items, and every reason has a status', () => {
    const r = classifyExposure({
      utxos: [utxo('a:0', 'q', P2WPKH, 1), utxo('b:0', 'p', P2TR, 2), utxo('c:0', 'u', 'ff', 4)],
      spentFromAddresses: [],
      channels: [channel('taproot', { localBalanceSat: 8 }), channel('anchors', { channelPoint: 'd:0', localBalanceSat: 16 })],
    });
    expect(r.exposedSat + r.hiddenSat + r.unclassifiedSat).toBe(31);
    expect(r.byReason.reduce((s, g) => s + g.amountSat, 0)).toBe(31);
    for (const reason of REASON_ORDER) expect(REASON_STATUS[reason]).toBeDefined();
  });

  it('is empty for an empty wallet', () => {
    expect(classifyExposure({ utxos: [], spentFromAddresses: [] })).toEqual({ items: [], exposedSat: 0, hiddenSat: 0, unclassifiedSat: 0, byReason: [] });
  });
});
