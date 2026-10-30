/**
 * Mode A (Wavelength) adapter — public surface.
 *
 * All Wavelength SDK contact is isolated in this package per the spec
 * (risk mitigation: v0.2.0 APIs are explicitly unstable; adapter tests
 * golden the surface we consume; CI re-pins versions against release tags).
 *
 * Exports here are the ONLY imports other packages may take from this
 * adapter. They speak the shared vocabulary (wallet-core types) plus the
 * adapter's own error/diagnostic types — never raw SDK shapes, except the
 * type-only re-exports hosts need to build transports.
 */

// Provider (the WalletProvider implementation) and its error surface.
export { WavelengthProvider, WavelengthProviderError } from './provider.js';
export type {
  WavelengthAdapterOptions,
  StartOptions,
} from './provider.js';

// Payment dispatch (implements the shared PaymentDispatcher port).
export {
  WavelengthPaymentDispatcher,
  PayloadValidationError,
  UnsupportedPaymentKindError,
  DEFAULT_DISPATCH_TIMEOUT_MS,
} from './dispatcher.js';
export type { WavelengthDispatcherOptions } from './dispatcher.js';
export {
  isLightningSendPayload,
  isOnchainSendPayload,
} from './dispatcher.js';
export type { LightningSendPayload, OnchainSendPayload } from './payloads.js';

// Authorization-time quoting (the fee-policy point; never dispatches).
export { quoteLightningSend, quoteOnchainSend } from './submit.js';
export type { LightningSendInput, OnchainSendInput, QuotedSend } from './submit.js';

// VTXO lifecycle (pure classification + user-visible copy).
export {
  classifyVtxo,
  classifyVtxoInventory,
  blocksToExpiryOf,
  isExitingJobStatus,
  hasExpiring,
  hasAtRisk,
  lockedOrExpiringSat,
  describeVtxoState,
  EXITING_JOB_STATUSES,
} from './vtxo-lifecycle.js';
export type { VtxoState, VtxoContext, VtxoWithState } from './vtxo-lifecycle.js';

// Unilateral exit (readiness, planning, batch start, phase copy).
export {
  planUnilateralExit,
  startUnilateralExit,
  summarizeExitReadiness,
  describeExitJobStatus,
  MissingUnrollAckError,
} from './exit.js';
export type { ExitReadiness, UnilateralExitOptions } from './exit.js';

// Entry mapping (payments vocabulary; pure).
export {
  dispatchOutcomeFromEntry,
  reconcileFromEntry,
  backendRefOf,
  entryMatchesBackendRef,
  entryMatchesOnchainPayload,
  paymentKindOfEntry,
  mapEntryToRecord,
  isInboundSettled,
  describeEntryFailure,
} from './entry-mapping.js';

// Version pins (the golden test asserts package.json matches these).
export { SDK_PACKAGE, SDK_PIN, WAVELENGTH_DAEMON_PIN } from './sdk-pin.js';
// Value re-exports of the SDK's string-enum constants and pairing manifest.
// The facade is the only runtime contact with the SDK; hosts and the test
// harness import these through THIS package, never `@lightninglabs/*`.
export {
  SendRailUnspecified,
  SendRailOffchainUnknown,
  SendRailInArk,
  SendRailLightning,
  SendRailOnchain,
  SendRailCredit,
  SendRailMixed,
  SendQuoteStatusUnspecified,
  SendQuoteStatusComplete,
  SendQuoteStatusLocalOnly,
  ListViewActivity,
  ListViewVTXOs,
  ListViewOnchain,
  ExitPathCooperative,
  ExitPathUnilateral,
  ExitPathUnilateralFallback,
  ExitJobStatusUnspecified,
  ExitJobStatusPending,
  ExitJobStatusMaterializing,
  ExitJobStatusCSVPending,
  ExitJobStatusSweeping,
  ExitJobStatusCompleted,
  ExitJobStatusFailed,
  ExitInfeasibilityReasonUnspecified,
  ExitInfeasibilityReasonSweepBelowDust,
  ExitInfeasibilityReasonUneconomical,
  ExitInfeasibilityReasonWalletUnderfunded,
  ExitInfeasibilityReasonWalletTooFewInputs,
  EntryKindSend,
  EntryKindReceive,
  EntryKindDeposit,
  EntryKindExit,
  EntryStatusPending,
  EntryStatusComplete,
  EntryStatusFailed,
  EntryPhaseUnspecified,
  EntryPhaseRequestCreated,
  EntryPhaseWaitingForPayment,
  EntryPhasePaymentDetected,
  EntryPhaseSettling,
  EntryPhaseConfirmed,
  EntryPhaseRefunding,
  EntryPhaseRefunded,
  EntryPhaseFailed,
  EntryPhaseWaitingForConfirmation,
  EntryRequestTypeLightning,
  EntryRequestTypeOnchain,
  EntryRequestTypeArk,
  EntryFailureCodeTimedOut,
  EntryFailureCodeExpired,
  EntryFailureCodeRefunded,
  EntryFailureCodeNeedsIntervention,
  EntryFailureCodeFailed,
  RUNTIME_MANIFEST_VERSION,
  // WalletState is a value (a const object of string literals), not just a type.
  WalletState,
} from './sdk/index.js';

// Type-only re-exports of the pinned SDK surface hosts may reference
// (transports build the client; nothing here may RUNTIME-import the SDK).
export type {
  WavelengthClient,
  WavelengthEvent,
  WavelengthListener,
  RuntimeConfig,
  Network,
  OpenWalletFromPasskeyRequest,
  OpenWalletFromPasskeyResult,
  WalletInfo,
  Balance,
  CreateWalletRequest,
  CreateWalletResult,
  UnlockWalletResult,
  DepositResult,
  ReceiveResult,
  SendRequest,
  SendResult,
  PrepareSendResult,
  ListRequest,
  ListResult,
  ListView,
  Entry,
  EntryKind,
  EntryStatus,
  EntryProgress,
  EntryFailureCode,
  ExitRequest,
  ExitStatusRequest,
  ExitResult,
  ExitStatusResult,
  ExitPlanEntry,
  ExitSummaryEntry,
  ExitSummaryRequest,
  ExitSummaryResult,
  GetExitPlanRequest,
  GetExitPlanResult,
  ExitBatchOptions,
  ExitBatchResult,
  ExitBatchEvent,
  ExitJobStatus,
  ExitPath,
  ExitInfeasibilityReason,
  VTXOInventory,
  WalletVTXO,
  OnchainHistory,
  OnchainTx,
  WalletStatus,
  ServerInfo,
  ActivityStreamOptions,
  UnlockWalletRequest,
  DepositRequest,
  ReceiveRequest,
  SweepWalletRequest,
  SweepWalletResult,
} from './sdk/index.js';
export { FORCE_UNROLL_ACK, WavelengthError, errorMessage } from './sdk/index.js';

// Local-daemon gateway transport: the browser/webview WavelengthClient that
// talks to the waved daemon's HTTP/JSON gateway over loopback. The Tauri
// sidecar owns the waved process; this is the in-app transport for it.
export {
  WavedGatewayClient,
  createWavedGatewayClient,
  mapWireBalance,
  parseWireBalance,
  normalizeGatewayInfo,
  DEFAULT_ACTIVITY_POLL_MS,
} from './sdk/gateway-client.js';
export type { WavedGatewayClientOptions, WireBalance } from './sdk/gateway-client.js';
