/**
 * AssetManager — the single tapd boundary for L1 Taproot Assets: issuance,
 * balances, transfer history, addresses, sends, metadata, and proofs.
 *
 * Every identifier crossing this boundary is validated (wallet-core
 * parsers) before it reaches tapd or a store, and responses stay typed —
 * this module never reshapes tapd facts into wishes. Asset-channel
 * operations are intentionally ABSENT from this surface: they are gated
 * behind the experimental flag (experimental.ts) and land only when that
 * gate opens.
 */
import { tapdAssets, tapdMint } from '@sovereign/litd-proto';
import {
  type AssetIdHex,
  type AssetRegistryEntryInput,
  type ScriptKeyHex,
  parseAssetId,
  parseScriptKey,
} from '@sovereign/wallet-core';

import type { TapdClients } from './tapd-clients.js';

/**
 * The Taproot Asset address version we create. On tapd v0.8.x the proto's
 * `AddrVersion.V1` (=2) is the current V1 address using V2 Tapscript
 * leaves — never invent a numeric literal where the enum names the intent.
 */
const DEFAULT_ADDR_VERSION = tapdAssets.AddrVersion.V1;

export interface AssetIssueSpec {
  readonly name: string;
  readonly amount: bigint;
  /** Issuer JSON claims — hashed into the genesis meta reveal. */
  readonly metaJson?: Record<string, unknown>;
  /** Group this issuance into a re-issuance group (grouped asset). */
  readonly enableEmission?: boolean;
}

export interface AssetSendRequest {
  /** Taproot Asset address strings as produced by the receiving wallet.
   * Full address validation is tapd's (DecodeAddr) — a local bech32m
   * parser would be a second opinion pretending to be an authority. */
  readonly tapAddresses: readonly string[];
  readonly label?: string;
}

/**
 * A batch is done when tapd marks it FINALIZED (the mint tx confirmed AND
 * the issuance applied) — the terminal success state in tapd v0.8.6.
 * CONFIRMED is the on-chain-confirmed intermediate before sprout; accepting
 * it too is safe (FINALIZED implies the tx confirmed), and the poll can
 * legitimately observe either between tapd's state transitions.
 */
export function batchIsConfirmed(batch: tapdMint.MintingBatch): boolean {
  return (
    batch.state === tapdMint.BatchState.CONFIRMED ||
    batch.state === tapdMint.BatchState.FINALIZED
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Maps a tapd asset to a wallet-core registry entry. `metaHashAnchored` is
 * true when the asset's genesis meta hash equals the meta hash served by
 * FetchAssetMeta — metadata bound to the asset's own witness data (binding,
 * not issuer honesty; the registry adds the trust allowlist on top).
 */
export function toRegistryEntry(
  asset: tapdAssets.Asset,
  meta?: Readonly<{ metaHashHex: string; metaJson?: Record<string, unknown> }>,
): AssetRegistryEntryInput {
  if (asset.assetGenesis === undefined) {
    throw new Error('tapd asset is missing genesis info — cannot key a registry entry');
  }
  const assetIdHex = bytesToHex(asset.assetGenesis.assetId);
  const genesisMetaHashHex = bytesToHex(asset.assetGenesis.metaHash);
  const metaHashAnchored = meta !== undefined && meta.metaHashHex === genesisMetaHashHex;
  return {
    assetId: parseAssetId(assetIdHex),
    groupKeyHex: asset.assetGroup !== undefined ? bytesToHex(asset.assetGroup.tweakedGroupKey) : undefined,
    metaHashHex: genesisMetaHashHex,
    meta: meta?.metaJson
      ? {
          rawHex: Buffer.from(JSON.stringify(meta.metaJson), 'utf8').toString('hex'),
          metaType: 'json',
          json: meta.metaJson,
        }
      : undefined,
    metaHashAnchored,
  };
}

export class AssetManager {
  constructor(private readonly clients: TapdClients) {}

  /** Node + universe sanity probe (also the readiness canary). */
  async getInfo(): Promise<tapdAssets.GetInfoResponse> {
    return this.clients.assets.getInfo(tapdAssets.GetInfoRequest.create({})).response;
  }

  async listAssets(): Promise<tapdAssets.ListAssetResponse> {
    return this.clients.assets.listAssets(tapdAssets.ListAssetRequest.create({})).response;
  }

  async listBalances(): Promise<tapdAssets.ListBalancesResponse> {
    // tapd v0.8.6 requires the caller to select the group_by oneof — an unset
    // oneof is rejected server-side with "invalid group_by". Group by asset
    // id, which is the view balances UIs and consumers key off.
    return this.clients.assets
      .listBalances(
        tapdAssets.ListBalancesRequest.create({
          groupBy: { oneofKind: 'assetId', assetId: true },
        }),
      )
      .response;
  }

  async listTransfers(): Promise<tapdAssets.ListTransfersResponse> {
    return this.clients.assets.listTransfers(tapdAssets.ListTransfersRequest.create({})).response;
  }

  async listBatches(): Promise<tapdMint.ListBatchResponse> {
    return this.clients.mint.listBatches(tapdMint.ListBatchRequest.create({})).response;
  }

  /**
   * Issues an asset: stage it in a mint batch, then finalize the batch —
   * tapd auto-funds and seals when no custom witness is needed (per the
   * mintrpc proto). The batch anchors on-chain once funded; confirm it via
   * `waitForBatchConfirmation` after the harness mines.
   */
  async issueAsset(spec: AssetIssueSpec): Promise<tapdMint.MintingBatch | undefined> {
    await this.clients.mint
      .mintAsset(
        tapdMint.MintAssetRequest.create({
          asset: tapdMint.MintAsset.create({
            assetType: tapdAssets.AssetType.NORMAL,
            name: spec.name,
            amount: spec.amount,
            assetMeta: tapdAssets.AssetMeta.create({
              type: tapdAssets.AssetMetaType.META_TYPE_JSON,
              data: Buffer.from(JSON.stringify(spec.metaJson ?? { name: spec.name }), 'utf8'),
            }),
            newGroupedAsset: spec.enableEmission ?? false,
          }),
        }),
      )
      .response;
    const finalized = await this.clients.mint.finalizeBatch(tapdMint.FinalizeBatchRequest.create({})).response;
    return finalized.batch;
  }

  /** Polls until every non-cancelled batch is confirmed on-chain. */
  async waitForBatchConfirmation(timeoutMs: number): Promise<tapdMint.MintingBatch[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const batches = await this.listBatches();
      // ListBatchResponse carries VerboseBatch wrappers; cancelled batches
      // are dropped from consideration entirely.
      const relevant = batches.batches
        .map((verbose) => verbose.batch)
        .filter((b): b is tapdMint.MintingBatch => b !== undefined && b.state !== tapdMint.BatchState.SEEDLING_CANCELLED);
      if (relevant.length > 0 && relevant.every(batchIsConfirmed)) {
        return relevant;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `mint batches not confirmed within ${timeoutMs}ms — states: ${relevant
            .map((b) => tapdMint.BatchState[b.state] ?? `unknown(${b.state})`)
            .join(', ')}`,
        );
      }
      await sleep(400);
    }
  }

  /**
   * Creates an address receiving `amount` units of the asset. The courier
   * connection check is skipped: a V1 self-transfer needs no proof-courier
   * delivery, and blocking address creation on a courier's reachability
   * would make offline receive impossible (the upstream request field
   * exists for exactly this reason).
   */
  async newAssetAddress(input: Readonly<{ assetIdHex: AssetIdHex; amount: bigint }>): Promise<tapdAssets.Addr> {
    return this.clients.assets
      .newAddr(
        tapdAssets.NewAddrRequest.create({
          assetId: Buffer.from(parseAssetId(input.assetIdHex), 'hex'),
          amt: input.amount,
          addressVersion: DEFAULT_ADDR_VERSION,
          skipProofCourierConnCheck: true,
        }),
      )
      .response;
  }

  /** Decodes a Taproot Asset address with tapd's real validator. */
  async decodeTapAddress(encoded: string): Promise<tapdAssets.Addr> {
    return this.clients.assets.decodeAddr(tapdAssets.DecodeAddrRequest.create({ addr: encoded })).response;
  }

  async listAddrReceives(): Promise<tapdAssets.AddrReceivesResponse> {
    return this.clients.assets.addrReceives(tapdAssets.AddrReceivesRequest.create({})).response;
  }

  /**
   * Sends assets to the given Taproot Asset address(es). Self-transfers
   * (an address of the SAME wallet) need no proof courier on v0.8.x — the
   * freighter delivers locally; external V2 transfers use the configured
   * courier. Returns the resulting transfer (anchor tx hash inside).
   */
  async sendAsset(request: AssetSendRequest): Promise<tapdAssets.SendAssetResponse> {
    if (request.tapAddresses.length === 0) {
      throw new Error('sendAsset requires at least one Taproot Asset address');
    }
    return this.clients.assets
      .sendAsset(tapdAssets.SendAssetRequest.create({ tapAddrs: [...request.tapAddresses], label: request.label ?? '' }))
      .response;
  }

  /** Fetches the asset meta served by the daemon, keyed by asset id. */
  async fetchAssetMeta(assetIdHex: AssetIdHex): Promise<tapdAssets.FetchAssetMetaResponse> {
    return this.clients.assets
      .fetchAssetMeta(
        tapdAssets.FetchAssetMetaRequest.create({
          asset: { oneofKind: 'assetIdStr', assetIdStr: parseAssetId(assetIdHex) },
        }),
      )
      .response;
  }

  // -- proofs ---------------------------------------------------------------

  /** Verifies a raw proof file against the chain — tapd validates the full
   * inclusion/exclusion proof chain, not just the shape. */
  async verifyProofFile(rawProofFile: Uint8Array): Promise<tapdAssets.VerifyProofResponse> {
    return this.clients.assets.verifyProof(tapdAssets.ProofFile.create({ rawProofFile })).response;
  }

  async decodeProof(rawProofFile: Uint8Array): Promise<tapdAssets.DecodeProofResponse> {
    return this.clients.assets.decodeProof(tapdAssets.DecodeProofRequest.create({ rawProof: rawProofFile })).response;
  }

  /** Exports the canonical proof file bytes for an asset's script key. */
  async exportProof(input: Readonly<{ assetIdHex: AssetIdHex; scriptKeyHex: ScriptKeyHex }>): Promise<Uint8Array> {
    const proof = await this.clients.assets
      .exportProof(
        tapdAssets.ExportProofRequest.create({
          assetId: Buffer.from(parseAssetId(input.assetIdHex), 'hex'),
          scriptKey: Buffer.from(parseScriptKey(input.scriptKeyHex), 'hex'),
        }),
      )
      .response;
    return proof.rawProofFile;
  }

  async unpackProofFile(rawProofFile: Uint8Array): Promise<tapdAssets.UnpackProofFileResponse> {
    return this.clients.assets.unpackProofFile(tapdAssets.UnpackProofFileRequest.create({ rawProofFile })).response;
  }

  close(): void {
    this.clients.transport.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
