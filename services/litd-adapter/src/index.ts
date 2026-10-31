/**
 * @sovereign/litd-adapter — Mode B backend adapter.
 *
 * litd v0.17.8 sidecar (integrated LND v0.21.5-beta.rc1 + Loop + Pool + tapd
 * + Faraday), loopback-bound RPC, least-privilege macaroons, protobuf-ts
 * clients against the pinned LND protos. No grpc-web.
 */
export {
  DEFAULT_RPC_PORT,
  DEFAULT_UI_PORT,
  assertLoopbackOnly,
  buildLitdConfig,
  generateUiPassword,
} from './config.js';
export type { LitdBackendOptions, LitdNetwork, LitdSidecarOptions, ResolvedLitdConfig } from './config.js';

export { LND_PERMISSIONS, MACAROON_PROFILES, permissionListForProfiles } from './macaroons.js';
export type { MacaroonPermissionSpec, MacaroonProfile } from './macaroons.js';

export {
  connectionOptionsFromConfig,
  createLightningClient,
  createLitdTransport,
  createWalletUnlockerClient,
  probeRpcReady,
  readMacaroonHex,
  waitForServices,
} from './client.js';
export type { LitdConnectionOptions } from './client.js';

export { launchLitdSidecar } from './launcher.js';
export type { LaunchedLitd, LaunchLitdOptions } from './launcher.js';

export {
  LITD_LOCAL_CAPABILITIES,
  LITD_LOCAL_SEED_COMPATIBILITY,
  LitdLocalProvider,
  REMOTE_LND_REQUIREMENTS,
} from './provider.js';
export type {
  LightningClientFactory,
  LightningStreamClient,
  LitdLocalProviderOptions,
  LaunchFn,
} from './provider.js';

export {
  BridgeRequestError,
  LitdBridgeSession,
  sessionJsonReplacer,
  type LitdBridgeDeps,
  type LightningOps,
  type UnlockerOps,
  type FaradayOps,
} from './bridge/session.js';
export { createLitdBridgeServer } from './bridge/server.js';
export type { BridgeServerOptions } from './bridge/server.js';

export {
  LncSessionManager,
  assertFutureExpiry,
  assertTenWordPhrase,
  litSessionType,
} from './lnc-sessions.js';
export type { CreateLncSessionOptions, LncSessionHandle, LncSessionType } from './lnc-sessions.js';

export { bytesToHex, hexToBytes } from './bytes.js';

// -- Taproot Assets (L1 core) ----------------------------------------------
export { AssetManager, batchIsConfirmed, toRegistryEntry } from './assets/asset-manager.js';
export type { AssetIssueSpec, AssetSendRequest } from './assets/asset-manager.js';
export { createTapdClients, tapdConnectionOptions, waitForTapdServices } from './assets/tapd-clients.js';
export type { TapdClients } from './assets/tapd-clients.js';
export {
  AssetChannelsDisabledError,
  DEFAULT_ASSET_CHANNELS_CONFIG,
  assertAssetChannelsEnabled,
  assetSupportForConfig,
  resolveAssetChannelGate,
} from './assets/experimental.js';
export type { AssetChannelGate, AssetChannelGateReason, AssetChannelsConfig, ProofBackupPlan } from './assets/experimental.js';
export {
  JsonFileProofBackupStore,
  backupAssetProofs,
  backupSourcesFromAssets,
  restoreAssetProofs,
  restoreAssetProofsStrict,
} from './assets/proofs.js';
export type {
  AssetProofBackupStore,
  AssetProofRecord,
  BackupOutcome,
  BackupSourceAsset,
  ProofClient,
  RestoreOutcome,
} from './assets/proofs.js';
