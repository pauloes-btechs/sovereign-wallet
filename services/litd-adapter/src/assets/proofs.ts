/**
 * Proof verification, storage, and restoration for L1 asset state.
 *
 * Why this exists: seed-only recovery is IMPOSSIBLE for Taproot asset
 * state (tapd v0.8.x — asset ownership proves through chain-anchored
 * proof files). Any wallet feature that puts asset state at risk must
 * back up the proofs, and a restore must RE-VERIFY every proof against
 * the chain — a stored-but-invalid proof is worthless and must never
 * pass silently as recovered.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AssetIdHex, ScriptKeyHex } from '@sovereign/wallet-core';

export interface AssetProofRecord {
  readonly assetIdHex: string;
  readonly scriptKeyHex: string;
  readonly outpointHex: string;
  /** Canonical proof file bytes, hex-encoded. */
  readonly proofHex: string;
  /** Epoch ms when the proof was exported from tapd. */
  readonly exportedAt: number;
  /** Verification result AT EXPORT TIME (tapd VerifyProof.valid). */
  readonly verifiedAtExport: boolean;
}

/** Storage boundary for proof backups — JSON-file impl below; test fakes implement this. */
export interface AssetProofBackupStore {
  put(record: AssetProofRecord): Promise<void>;
  get(assetIdHex: string, scriptKeyHex: string): Promise<AssetProofRecord | undefined>;
  list(): Promise<AssetProofRecord[]>;
}

/** Structural slice the backup/restore flows need — AssetManager satisfies
 * it; tests satisfy it with fakes (no casts, no subclassing). */
export interface ProofClient {
  exportProof(input: Readonly<{ assetIdHex: AssetIdHex; scriptKeyHex: ScriptKeyHex }>): Promise<Uint8Array>;
  verifyProofFile(rawProofFile: Uint8Array): Promise<{ valid: boolean }>;
}

/** JSON-file proof store: one index file, proofs as hex, written via
 * tmp-file + rename so a crash never leaves a torn index behind. */
export class JsonFileProofBackupStore implements AssetProofBackupStore {
  private readonly indexPath: string;

  constructor(private readonly dirPath: string) {
    this.indexPath = join(dirPath, 'proof-backup.json');
  }

  async put(record: AssetProofRecord): Promise<void> {
    await mkdir(this.dirPath, { recursive: true });
    const records = await this.list();
    const next = [...records.filter((r) => !(r.assetIdHex === record.assetIdHex && r.scriptKeyHex === record.scriptKeyHex)), record];
    const tmp = `${this.indexPath}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(tmp, this.indexPath);
  }

  async get(assetIdHex: string, scriptKeyHex: string): Promise<AssetProofRecord | undefined> {
    return (await this.list()).find((r) => r.assetIdHex === assetIdHex && r.scriptKeyHex === scriptKeyHex);
  }

  async list(): Promise<AssetProofRecord[]> {
    try {
      return JSON.parse(await readFile(this.indexPath, 'utf8')) as AssetProofRecord[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err; // never swallow — a corrupt index must surface, not masquerade as empty
    }
  }
}

/** One backed-up asset: the local asset's script key + outpoint. */
export interface BackupSourceAsset {
  readonly assetIdHex: string;
  readonly scriptKeyHex: string;
  readonly outpointHex?: string;
}

export interface BackupOutcome {
  readonly backed: AssetProofRecord[];
  readonly failed: Array<{ assetIdHex: string; scriptKeyHex: string; reason: string }>;
}

/**
 * Exports and verifies proofs for the given assets, storing only proofs
 * that tapd verified at export time. An export that fails verification is
 * REPORTED, not stored — silently persisting an invalid proof would turn
 * the backup into a time bomb.
 */
export async function backupAssetProofs(
  manager: ProofClient,
  assets: readonly BackupSourceAsset[],
  store: AssetProofBackupStore,
): Promise<BackupOutcome> {
  const backed: AssetProofRecord[] = [];
  const failed: BackupOutcome['failed'] = [];
  for (const asset of assets) {
    try {
      const proofBytes = await manager.exportProof({ assetIdHex: asset.assetIdHex, scriptKeyHex: asset.scriptKeyHex });
      const verified = await manager.verifyProofFile(proofBytes);
      if (!verified.valid) {
        failed.push({ assetIdHex: asset.assetIdHex, scriptKeyHex: asset.scriptKeyHex, reason: 'tapd VerifyProof returned valid=false' });
        continue;
      }
      const record: AssetProofRecord = {
        assetIdHex: asset.assetIdHex,
        scriptKeyHex: asset.scriptKeyHex,
        outpointHex: asset.outpointHex ?? '',
        proofHex: Buffer.from(proofBytes).toString('hex'),
        exportedAt: Date.now(),
        verifiedAtExport: true,
      };
      await store.put(record);
      backed.push(record);
    } catch (err) {
      failed.push({
        assetIdHex: asset.assetIdHex,
        scriptKeyHex: asset.scriptKeyHex,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { backed, failed };
}

export interface RestoreOutcome {
  readonly restored: AssetProofRecord[];
  readonly invalid: Array<{ assetIdHex: string; scriptKeyHex: string; reason: string }>;
}

/** Restores proofs from the store, re-verifying EVERY proof against the
 * chain before counting it as recovered. Returns the invalid entries so
 * callers surface them — restoring must never be silent about a proof
 * that no longer verifies. */
export async function restoreAssetProofs(
  manager: ProofClient,
  store: AssetProofBackupStore,
): Promise<RestoreOutcome> {
  const restored: AssetProofRecord[] = [];
  const invalid: RestoreOutcome['invalid'] = [];
  for (const record of await store.list()) {
    try {
      const proofBytes = Buffer.from(record.proofHex, 'hex');
      const verified = await manager.verifyProofFile(proofBytes);
      if (verified.valid) {
        restored.push(record);
      } else {
        invalid.push({ assetIdHex: record.assetIdHex, scriptKeyHex: record.scriptKeyHex, reason: 'stored proof failed tapd VerifyProof' });
      }
    } catch (err) {
      invalid.push({
        assetIdHex: record.assetIdHex,
        scriptKeyHex: record.scriptKeyHex,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { restored, invalid };
}

/** Strict restore for release-blocking drills: any invalid proof throws. */
export async function restoreAssetProofsStrict(manager: ProofClient, store: AssetProofBackupStore): Promise<RestoreOutcome> {
  const outcome = await restoreAssetProofs(manager, store);
  if (outcome.invalid.length > 0) {
    const details = outcome.invalid.map((i) => `${i.assetIdHex.slice(0, 8)}…: ${i.reason}`).join('; ');
    throw new Error(`proof restore FAILED for ${outcome.invalid.length} asset(s): ${details}`);
  }
  return outcome;
}

/** Collects backup sources for every unspent local asset from a live
 * ListAssets response — spent assets' proofs describe consumed states. */
export function backupSourcesFromAssets(assetsResponse: {
  assets?: Array<{ isSpent: boolean; assetGenesis?: { assetId?: Uint8Array }; scriptKey?: Uint8Array; chainAnchor?: { anchorOutpoint?: string } }>;
}): BackupSourceAsset[] {
  const sources: BackupSourceAsset[] = [];
  for (const asset of assetsResponse.assets ?? []) {
    const genesis = asset.assetGenesis;
    if (asset.isSpent || genesis?.assetId === undefined || asset.scriptKey === undefined) {
      continue;
    }
    sources.push({
      assetIdHex: Buffer.from(genesis.assetId).toString('hex'),
      scriptKeyHex: Buffer.from(asset.scriptKey).toString('hex'),
      outpointHex: asset.chainAnchor?.anchorOutpoint ?? '',
    });
  }
  return sources;
}
