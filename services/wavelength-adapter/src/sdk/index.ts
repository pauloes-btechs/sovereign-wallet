/**
 * THE single point of Wavelength SDK contact in this codebase.
 *
 * Spec (Mode A backend isolation): all `@lightninglabs/wavelength-*` imports
 * live in this directory — enforced by the root eslint.config.js
 * `no-restricted-imports` guard and by isolation.test.ts, which scans every
 * source file in the repo. Everything this adapter (and, through its
 * re-exports, the rest of the monorepo) knows about the SDK is declared here.
 *
 * Re-exported types are the SDK's own: re-declaring them would create a
 * second surface that drifts silently. Re-exported runtime values are the
 * handful of constants the adapter's logic depends on.
 */

export type {
  // Client contract (the port this adapter drives).
  WavelengthClient,
  ExternalSeedWalletClient,
  // Requests.
  CreateWalletRequest,
  UnlockWalletRequest,
  DepositRequest,
  ReceiveRequest,
  SendRequest,
  ListRequest,
  ListView,
  ExitRequest,
  ExitStatusRequest,
  ExitSummaryRequest,
  GetExitPlanRequest,
  SweepWalletRequest,
  // Results and lifecycle shapes.
  Balance,
  CreateWalletResult,
  UnlockWalletResult,
  DepositResult,
  ReceiveResult,
  PrepareSendResult,
  SendResult,
  ListResult,
  ActivityList,
  VTXOInventory,
  WalletVTXO,
  OnchainHistory,
  OnchainTx,
  Entry,
  EntryProgress,
  EntryRequest,
  EntryStatus,
  EntryPhase,
  EntryKind,
  EntryRequestType,
  EntryFailureCode,
  ExitResult,
  ExitStatusResult,
  ExitProgress,
  ExitCSV,
  ExitFees,
  ExitPlanEntry,
  GetExitPlanResult,
  ExitInfeasibilityReason,
  ExitJobStatus,
  ExitPath,
  ExitBatchOptions,
  ExitBatchResult,
  ExitBatchEvent,
  ExitBatchStop,
  ExitSummaryEntry,
  ExitSummaryResult,
  ActivityStreamOptions,
  WalletSweepInput,
  SweepWalletResult,
  // Runtime/config/events.
  RuntimeConfig,
  Network,
  PresetNetwork,
  OpenWalletFromPasskeyRequest,
  OpenWalletFromPasskeyResult,
  DebugLevel,
  WalletInfo,
  WalletStatus,
  ServerInfo,
  RuntimePhase,
  WavelengthEvent,
  WavelengthEventType,
  WavelengthListener,
  WavelengthErrorCode,
  WavelengthError as WavelengthErrorType,
  Destination,
  InvoiceAmount,
} from '@lightninglabs/wavelength-core';

export {
  // Exact acknowledgement string required to start a unilateral unroll
  // (requests.d.ts: "must be exactly \"I_KNOW_WHAT_I_AM_DOING\"").
  FORCE_UNROLL_ACK,
  // The paired daemon build of the pinned SDK release.
  RUNTIME_MANIFEST_VERSION,
  // SDK-blessed batch-exit helper: previews funding, skips outpoints already
  // running an exit, re-plans between starts.
  exitBatch,
  // Structural-vs-fundable classification for exit infeasibilities.
  isExitInfeasibilityFundable,
  // Error type thrown by the SDK, with its machine-readable `code`.
  WavelengthError,
  errorMessage,
  // String-enum constants asserted by the golden test (wire-string alignment).
  SendRailUnspecified,
  SendRailOffchainUnknown,
  SendRailLightning,
  SendRailOnchain,
  SendRailInArk,
  SendRailCredit,
  SendRailMixed,
  SendQuoteStatusUnspecified,
  SendQuoteStatusComplete,
  SendQuoteStatusLocalOnly,
  ExitJobStatusPending,
  ExitJobStatusMaterializing,
  ExitJobStatusCSVPending,
  ExitJobStatusSweeping,
  ExitJobStatusCompleted,
  ExitJobStatusFailed,
  ExitJobStatusUnspecified,
  ExitPathCooperative,
  ExitPathUnilateral,
  ExitPathUnilateralFallback,
  EntryKindSend,
  EntryKindReceive,
  EntryKindDeposit,
  EntryKindExit,
  EntryStatusPending,
  EntryStatusComplete,
  EntryStatusFailed,
  EntryRequestTypeLightning,
  EntryRequestTypeOnchain,
  EntryRequestTypeArk,
  ListViewActivity,
  ListViewVTXOs,
  ListViewOnchain,
  ExitInfeasibilityReasonUnspecified,
  ExitInfeasibilityReasonSweepBelowDust,
  ExitInfeasibilityReasonUneconomical,
  ExitInfeasibilityReasonWalletUnderfunded,
  ExitInfeasibilityReasonWalletTooFewInputs,
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
  // WalletState is a value (a const object of string literals), not just a type.
  WalletState,
  // Maps raw daemon walletState (proto number) to the SDK string union; used
  // by the gateway transport as the numeric fallback of its name mapping.
  walletStateFromProto,
  EntryFailureCodeTimedOut,
  EntryFailureCodeExpired,
  EntryFailureCodeRefunded,
  EntryFailureCodeNeedsIntervention,
  EntryFailureCodeFailed,
} from '@lightninglabs/wavelength-core';

/** Unsubscribe function returned by `client.subscribe` / `provider.onEvent`. */
export type Unsubscribe = () => void;
