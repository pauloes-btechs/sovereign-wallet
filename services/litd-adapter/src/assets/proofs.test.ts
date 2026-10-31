/**
 * Proof backup/restore unit tests — the release-blocking recovery drill's
 * logic layer. Integration (regtest litd) exercises the same flows over the
 * real tapd; here the ProofClient is a fake so every branch is reachable.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { ProofClient } from './proofs.js';
import { backupAssetProofs, JsonFileProofBackupStore, restoreAssetProofs, restoreAssetProofsStrict } from './proofs.js';

const ASSET_A = {
  assetIdHex: 'a'.repeat(64),
  scriptKeyHex: 'b'.repeat(66),
};
const ASSET_B = {
  assetIdHex: 'c'.repeat(64),
  scriptKeyHex: 'd'.repeat(66),
};

/** Deterministic fake verifier: proofs are tagged bytes; verify round-trips. */
function fakeVerifier(opts?: { invalid: string[] }): ProofClient & { exported: string[] } {
  const exported: string[] = [];
  return {
    exported,
    exportProof: async (input) => {
      const tag = `proof:${input.assetIdHex.slice(0, 8)}:${input.scriptKeyHex.slice(0, 8)}`;
      exported.push(tag);
      return new TextEncoder().encode(tag);
    },
    verifyProofFile: async (raw) => {
      const tag = new TextDecoder().decode(raw);
      return { valid: !opts?.invalid.some((prefix) => tag.startsWith(prefix)) };
    },
  };
}

describe('asset proof backup and restore', () => {
  let dir: string;
  const cleanup: (() => Promise<void>)[] = [];
  const makeStore = async (): Promise<JsonFileProofBackupStore> => {
    dir = await mkdtemp(join(tmpdir(), 'sov-proofs-'));
    cleanup.push(async () => rm(dir, { recursive: true, force: true }));
    return new JsonFileProofBackupStore(dir);
  };

  afterAll(async () => {
    for (const fn of cleanup) await fn();
  });

  it('backups every asset, persists records, and survives a store reload', async () => {
    const store = await makeStore();
    const verifier = fakeVerifier();
    const outcome = await backupAssetProofs(verifier, [ASSET_A, ASSET_B], store);
    expect(outcome.failed).toEqual([]);
    expect(outcome.backed.length).toBe(2);
    expect(outcome.backed[0]).toMatchObject({
      assetIdHex: ASSET_A.assetIdHex,
      scriptKeyHex: ASSET_A.scriptKeyHex,
      verifiedAtExport: true,
    });
    expect(outcome.backed[0]?.proofHex).toBeTruthy();

    // Fresh store instance over the same dir — the index reloads from disk.
    const reloaded = new JsonFileProofBackupStore(dir);
    expect((await reloaded.get(ASSET_A.assetIdHex, ASSET_A.scriptKeyHex))?.proofHex).toBeTruthy();
    expect((await reloaded.list()).length).toBe(2);
  });

  it('reports (never stores) an asset whose proof fails pre-verification', async () => {
    const store = await makeStore();
    const outcome = await backupAssetProofs(fakeVerifier({ invalid: ['proof:'] }), [ASSET_A], store);
    expect(outcome.backed).toEqual([]);
    expect(outcome.failed.length).toBe(1);
    expect(outcome.failed[0]?.reason).toContain('valid=false');
    expect(await store.list()).toEqual([]); // nothing persisted
  });

  it('restore re-uploads only valid proofs and reports invalid entries', async () => {
    const store = await makeStore();
    await backupAssetProofs(fakeVerifier(), [ASSET_A, ASSET_B], store);

    // Verifier accepts A, rejects B.
    const verifier = fakeVerifier({ invalid: [`proof:${ASSET_B.assetIdHex.slice(0, 8)}`] });
    const outcome = await restoreAssetProofs(verifier, store);
    expect(outcome.restored.length).toBe(1);
    expect(outcome.restored[0]?.assetIdHex).toBe(ASSET_A.assetIdHex);
    expect(outcome.invalid.length).toBe(1);
    expect(outcome.invalid[0]?.reason).toContain('VerifyProof');
  });

  it('restoreAssetProofsStrict throws when any proof is invalid (release-blocking drill semantics)', async () => {
    const store = await makeStore();
    await backupAssetProofs(fakeVerifier(), [ASSET_A, ASSET_B], store);
    const verifier = fakeVerifier({ invalid: [`proof:${ASSET_B.assetIdHex.slice(0, 8)}`] });
    await expect(restoreAssetProofsStrict(verifier, store)).rejects.toThrow(/proof restore FAILED/);
  });

  it('restore with an empty store restores nothing and throws nothing', async () => {
    const store = await makeStore();
    const outcome = await restoreAssetProofs(fakeVerifier(), store);
    expect(outcome).toEqual({ restored: [], invalid: [] });
  });
});
