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
function fakeClients(calls: { exportProof: number; newAddr: number }): {
  clients: TapdClients;
  balancesRequests: tapdAssets.ListBalancesRequest[];
} {
  const balancesRequests: tapdAssets.ListBalancesRequest[] = [];
  const clients = {
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
      listBalances: async (req: tapdAssets.ListBalancesRequest) => {
        balancesRequests.push(tapdAssets.ListBalancesRequest.clone(req));
        return { response: tapdAssets.ListBalancesResponse.create({}) };
      },
    } as unknown as TapdClients['assets'],
    mint: {
      listBatches: async () => ({ response: tapdMint.ListBatchResponse.create({}) }),
    } as unknown as TapdClients['mint'],
  } as unknown as TapdClients;
  return { clients, balancesRequests };
}

describe('listBalances — group_by selection', () => {
  it('selects the asset-id grouping; tapd rejects an unset group_by', async () => {
    const { clients, balancesRequests } = fakeClients({ exportProof: 0, newAddr: 0 });
    await new AssetManager(clients).listBalances();
    expect(balancesRequests).toHaveLength(1);
    expect(balancesRequests[0].groupBy).toEqual({ oneofKind: 'assetId', assetId: true });
  });
});

describe('batchIsConfirmed', () => {
  it('accepts CONFIRMED and the terminal FINALIZED state', () => {
    expect(
      batchIsConfirmed(
        tapdMint.MintingBatch.create({ state: tapdMint.BatchState.CONFIRMED }),
      ),
    ).toBe(true);
    expect(
      batchIsConfirmed(
        tapdMint.MintingBatch.create({ state: tapdMint.BatchState.FINALIZED }),
      ),
    ).toBe(true);
  });

  it('rejects in-flight and cancelled states', () => {
    for (const state of [
      tapdMint.BatchState.PENDING,
      tapdMint.BatchState.FROZEN,
      tapdMint.BatchState.COMMITTED,
      tapdMint.BatchState.BROADCAST,
      tapdMint.BatchState.SEEDLING_CANCELLED,
      tapdMint.BatchState.SPROUT_CANCELLED,
    ]) {
      expect(batchIsConfirmed(tapdMint.MintingBatch.create({ state }))).toBe(false);
    }
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
  const { clients } = fakeClients(calls);
  const manager = new AssetManager(clients);

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
