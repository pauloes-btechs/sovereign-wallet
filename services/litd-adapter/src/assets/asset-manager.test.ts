/**
 * AssetManager unit tests — pure mapping + validate-before-call ordering.
 * The full RPC surface (issue/send/receive end-to-end) is covered by the
 * regtest integration suite over a real tapd; these tests pin the logic
 * that must hold regardless of network: batch state mapping, registry
 * metadata anchoring, and identifier validation happening BEFORE tapd.
 */
import { describe, expect, it } from 'vitest';

import type { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { tapdAssets, tapdMint } from '@sovereign/litd-proto';

import { AssetManager, batchIsConfirmed, toRegistryEntry } from './asset-manager.js';
import type { TapdClients } from './tapd-clients.js';

/** Test double over the generated clients: records calls; full RPC surface
 * is exercised by the regtest integration suite, not here. */
function fakeClients(calls: { exportProof: number; newAddr: number }): TapdClients {
  return {
    transport: { close: () => undefined } as unknown as GrpcTransport,
    assets: {
      exportProof: async () => {
        calls.exportProof += 1;
        return { response: tapdAssets.ProofFile.create({ rawProofFile: new Uint8Array([1]) }) };
      },
      newAddr: async () => {
        calls.newAddr += 1;
        return { response: tapdAssets.Addr.create({ encoded: 'taprt1fake' }) };
      },
    } as unknown as TapdClients['assets'],
    mint: {
      listBatches: async () => ({ response: tapdMint.ListBatchResponse.create({}) }),
    } as unknown as TapdClients['mint'],
  };
}

describe('batchIsConfirmed', () => {
  it('maps only BATCH_STATE_CONFIRMED', () => {
    expect(
      batchIsConfirmed(
        tapdMint.MintingBatch.create({ state: tapdMint.BatchState.CONFIRMED }),
      ),
    ).toBe(true);
    expect(
      batchIsConfirmed(
        tapdMint.MintingBatch.create({ state: tapdMint.BatchState.FROZEN }),
      ),
    ).toBe(false);
  });
});

describe('toRegistryEntry', () => {
  const GENESIS_META_HASH = new Uint8Array(32).fill(7);

  function assetWithGenesis(): tapdAssets.Asset {
    return tapdAssets.Asset.create({
      assetGenesis: tapdAssets.GenesisInfo.create({
        assetId: new Uint8Array(32).fill(1),
        metaHash: GENESIS_META_HASH,
      }),
      assetGroup: tapdAssets.AssetGroup.create({ tweakedGroupKey: new Uint8Array(33).fill(9) }),
    });
  }

  it('anchors metadata when FetchAssetMeta hash equals the genesis meta hash', () => {
    const entry = toRegistryEntry(assetWithGenesis(), {
      metaHashHex: Buffer.from(GENESIS_META_HASH).toString('hex'),
      metaJson: { name: 'USDX', issuer: 'unknown' },
    });
    expect(entry.metaHashAnchored).toBe(true);
    expect(entry.groupKeyHex).toBe('09'.repeat(33));
    expect(entry.meta?.json).toEqual({ name: 'USDX', issuer: 'unknown' });
  });

  it('marks metadata unanchored when the served hash differs from genesis', () => {
    const entry = toRegistryEntry(assetWithGenesis(), {
      metaHashHex: 'ff'.repeat(32),
      metaJson: { name: 'USDX' },
    });
    expect(entry.metaHashAnchored).toBe(false);
  });

  it('throws on an asset without genesis info — no entry can be keyed', () => {
    expect(() => toRegistryEntry(tapdAssets.Asset.create({}))).toThrow(/genesis/);
  });
});

describe('AssetManager — validate before any tapd call', () => {
  const calls = { exportProof: 0, newAddr: 0 };
  const manager = new AssetManager(fakeClients(calls));

  it('rejects a malformed asset id without calling the proof RPC', async () => {
    await expect(
      manager.exportProof({ assetIdHex: 'nothex', scriptKeyHex: '02'.repeat(33) }),
    ).rejects.toThrow(/asset id/i);
    expect(calls.exportProof).toBe(0);
  });

  it('rejects a malformed script key without calling the proof RPC', async () => {
    await expect(
      manager.exportProof({ assetIdHex: 'ab'.repeat(32), scriptKeyHex: 'zz' }),
    ).rejects.toThrow(/script key/i);
    expect(calls.exportProof).toBe(0);
  });

  it('rejects a malformed asset id on newAssetAddress without an RPC', async () => {
    await expect(manager.newAssetAddress({ assetIdHex: 'nothex', amount: 1n })).rejects.toThrow(/asset id/i);
    expect(calls.newAddr).toBe(0);
  });
});
