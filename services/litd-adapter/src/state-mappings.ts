/**
 * Pure mappings between the pinned litd/LND proto surface and Mode B view
 * state. No I/O, no clients — everything here is directly unit-testable, and
 * the integration suite pins the daemon-side error TEXTS these patterns
 * classify. Unknown inputs classify as `undetermined` and render as honest
 * diagnostic errors; nothing here guesses a phase the daemon did not state.
 */
import type {
  Channel,
  ChannelBalanceResponse,
  ChannelCloseSummary,
  ChanBackupSnapshot,
  ChannelInsightsResponse,
  ClosedChannelsResponse,
  CloseChannelRequest,
  ForwardingHistoryResponse,
  GetInfoResponse,
  OpenChannelRequest,
  PayReq,
  PendingChannelsResponse_PendingChannel,
  RestoreChanBackupRequest,
  RevenueReportResponse,
  SendCoinsRequest,
  SendPaymentRequest,
  WalletBalanceResponse,
} from '@sovereign/litd-proto';
// Enum members are used as values in the switch mappings below.
import { ChannelCloseSummary_ClosureType } from '@sovereign/litd-proto';

/** The lifecycle phase of the embedded LND wallet, as provable from RPCs. */
export type LitdWalletPhase = 'missing' | 'locked' | 'ready';

/** Unresolved classification — the UI renders the raw error verbatim. */
export type PhaseProbeOutcome = LitdWalletPhase | 'undetermined';

/**
 * Classify a GetInfo failure. The only provable phase from the info error
 * alone is 'locked': the registered Lightning service answers every call
 * with the unlock refusal. Transport/startup noise is undetermined.
 */
export function walletPhaseFromInfoError(message: string): PhaseProbeOutcome {
  if (WALLET_LOCKED_PATTERN.test(message)) {
    return 'locked';
  }
  return 'undetermined';
}

/**
 * Classify a failed unlock canary (UnlockWallet with a random throwaway
 * password that can never be correct — so no real wallet is touched).
 *
 * - "wallet not initialized" → the daemon has no wallet: `missing`.
 * - Wrong-passphrase/checksum errors → a wallet exists and stays locked.
 * - "already unlocked"/retired Unlocker → the wallet is actually up.
 */
export function walletPhaseFromUnlockCanaryError(message: string): PhaseProbeOutcome {
  if (WALLET_NOT_INITIALIZED_PATTERN.test(message)) {
    return 'missing';
  }
  if (ALREADY_UNLOCKED_PATTERN.test(message)) {
    return 'ready';
  }
  // lnd refuses the canary with "wallet locked, unlock it via …" when a wallet
  // exists and is locked — same observable state as a wrong passphrase.
  if (WRONG_PASSPHRASE_PATTERN.test(message) || WALLET_LOCKED_PATTERN.test(message)) {
    return 'locked';
  }
  return 'undetermined';
}

/**
 * Classify a failed macaroon-authed call while the wallet is unlocked —
 * distinguishes "wallet locked again (restart)" from transient errors.
 */
export function walletPhaseFromMacaroonCallError(message: string): PhaseProbeOutcome {
  return walletPhaseFromInfoError(message);
}

const WALLET_LOCKED_PATTERN = /wallet locked/i;
const WALLET_NOT_INITIALIZED_PATTERN = /wallet not initialized|no wallet found|unable to locate wallet/i;
const ALREADY_UNLOCKED_PATTERN = /already unlocked|no longer available|unknown service.*unlocker/i;
const WRONG_PASSPHRASE_PATTERN = /wrong|invalid|checksum|password|passphrase/i;

// ---------------------------------------------------------------------------
// View mappings
// ---------------------------------------------------------------------------

export interface ChainView {
  readonly chain: string;
  readonly network: string;
}

export interface NodeHealthView {
  readonly identityPubkey: string;
  readonly alias: string;
  readonly version: string;
  readonly syncedToChain: boolean;
  readonly syncedToGraph: boolean;
  readonly blockHeight: number;
  readonly numPeers: number;
  readonly numActiveChannels: number;
  readonly numPendingChannels: number;
  readonly numInactiveChannels: number;
  readonly uris: readonly string[];
  readonly chains: readonly ChainView[];
}

export function mapNodeInfo(info: GetInfoResponse): NodeHealthView {
  return {
    identityPubkey: info.identityPubkey,
    alias: info.alias,
    version: info.version,
    syncedToChain: info.syncedToChain,
    syncedToGraph: info.syncedToGraph,
    blockHeight: info.blockHeight,
    numPeers: info.numPeers,
    numActiveChannels: info.numActiveChannels,
    numPendingChannels: info.numPendingChannels,
    numInactiveChannels: info.numInactiveChannels,
    uris: [...info.uris],
    chains: info.chains.map((c) => ({ chain: c.chain, network: c.network })),
  };
}

export interface WalletBalanceView {
  readonly totalSat: bigint;
  readonly confirmedSat: bigint;
  readonly unconfirmedSat: bigint;
  readonly lockedSat: bigint;
  readonly reservedAnchorSat: bigint;
}

export function mapWalletBalance(balance: WalletBalanceResponse): WalletBalanceView {
  return {
    totalSat: balance.totalBalance,
    confirmedSat: balance.confirmedBalance,
    unconfirmedSat: balance.unconfirmedBalance,
    lockedSat: balance.lockedBalance,
    reservedAnchorSat: balance.reservedBalanceAnchorChan,
  };
}

export interface ChannelBalanceView {
  readonly localSat: bigint;
  readonly remoteSat: bigint;
  /** Unsettled local balance (pending HTLCs) when the daemon reports it. */
  readonly localUnsettledSat: bigint;
  readonly pendingOpenLocalSat: bigint;
  readonly pendingOpenRemoteSat: bigint;
}

export function mapChannelBalance(balance: ChannelBalanceResponse): ChannelBalanceView {
  return {
    localSat: balance.localBalance?.sat ?? 0n,
    remoteSat: balance.remoteBalance?.sat ?? 0n,
    localUnsettledSat: balance.unsettledLocalBalance?.sat ?? 0n,
    pendingOpenLocalSat: balance.pendingOpenLocalBalance?.sat ?? 0n,
    pendingOpenRemoteSat: balance.pendingOpenRemoteBalance?.sat ?? 0n,
  };
}

// ---------------------------------------------------------------------------
// Channel state model — the visual states the dashboards render
// ---------------------------------------------------------------------------

/** Coarse visual state of one channel; each value renders a distinct badge. */
export type ChannelDisplayState =
  | 'opening'
  | 'open'
  | 'open-inactive'
  | 'closing'
  | 'closing-force'
  | 'waiting-close';

export function openChannelDisplayState(channel: Channel): ChannelDisplayState {
  return channel.active ? 'open' : 'open-inactive';
}

/** Which list of PendingChannelsResponse an entry came from. */
export type PendingChannelKind =
  | 'pending-open'
  | 'pending-closing'
  | 'pending-force-closing'
  | 'waiting-close';

export function pendingChannelDisplayState(kind: PendingChannelKind): ChannelDisplayState {
  switch (kind) {
    case 'pending-open':
      return 'opening';
    case 'pending-closing':
      return 'closing';
    case 'pending-force-closing':
      return 'closing-force';
    case 'waiting-close':
      return 'waiting-close';
  }
}

export interface ChannelRowView {
  readonly channelPoint: string;
  readonly chanId: string;
  readonly remotePubkey: string;
  readonly capacitySat: bigint;
  readonly localBalanceSat: bigint;
  readonly remoteBalanceSat: bigint;
  readonly state: ChannelDisplayState;
  readonly initiatorLabel: string;
}

export function mapOpenChannel(channel: Channel): ChannelRowView {
  return {
    channelPoint: channel.channelPoint,
    chanId: channel.chanId,
    remotePubkey: channel.remotePubkey,
    capacitySat: channel.capacity,
    localBalanceSat: channel.localBalance,
    remoteBalanceSat: channel.remoteBalance,
    state: openChannelDisplayState(channel),
    initiatorLabel: channel.initiator ? 'opened by you' : 'opened by peer',
  };
}

export function mapPendingChannel(
  kind: PendingChannelKind,
  pending: {
    readonly channel?: PendingChannelsResponse_PendingChannel;
    readonly limboBalance?: bigint;
  },
): ChannelRowView {
  const channel = pending.channel;
  return {
    channelPoint: channel?.channelPoint ?? '',
    chanId: '',
    remotePubkey: channel?.remoteNodePub ?? '',
    capacitySat: channel?.capacity ?? 0n,
    localBalanceSat: channel?.localBalance ?? 0n,
    remoteBalanceSat: channel?.remoteBalance ?? 0n,
    state: pendingChannelDisplayState(kind),
    // Limbo balance is the funds locked in the closing/settling flow — the
    // single number a user needs while a channel is leaving.
    initiatorLabel:
      kind === 'pending-open'
        ? 'confirming funding transaction'
        : `funds in limbo: ${pending.limboBalance ?? 0n} sat`,
  };
}

export interface ClosedChannelView {
  readonly channelPoint: string;
  readonly chanId: string;
  readonly remotePubkey: string;
  readonly closingTxHash: string;
  readonly closeType: string;
  readonly closeHeight: number;
  readonly settledBalanceSat: bigint;
  readonly timeLockedBalanceSat: bigint;
}

function closureTypeLabel(closeType: ChannelCloseSummary_ClosureType): string {
  switch (closeType) {
    case ChannelCloseSummary_ClosureType.COOPERATIVE_CLOSE:
      return 'cooperative close';
    case ChannelCloseSummary_ClosureType.LOCAL_FORCE_CLOSE:
      return 'force close (you)';
    case ChannelCloseSummary_ClosureType.REMOTE_FORCE_CLOSE:
      return 'force close (peer)';
    case ChannelCloseSummary_ClosureType.BREACH_CLOSE:
      return 'breach close';
    case ChannelCloseSummary_ClosureType.FUNDING_CANCELED:
      return 'funding canceled';
    case ChannelCloseSummary_ClosureType.ABANDONED:
      return 'abandoned';
    default:
      return `closure type ${closeType}`;
  }
}

export function mapClosedChannel(channel: ChannelCloseSummary): ClosedChannelView {
  return {
    channelPoint: channel.channelPoint,
    chanId: channel.chanId,
    remotePubkey: channel.remotePubkey,
    closingTxHash: channel.closingTxHash,
    closeType: closureTypeLabel(channel.closeType),
    closeHeight: channel.closeHeight,
    settledBalanceSat: channel.settledBalance,
    timeLockedBalanceSat: channel.timeLockedBalance,
  };
}

export function mapClosedChannels(response: ClosedChannelsResponse): ClosedChannelView[] {
  return response.channels.map(mapClosedChannel);
}

export interface ForwardingEventView {
  readonly timestampNs: bigint;
  readonly amtInSat: bigint;
  readonly amtOutSat: bigint;
  readonly feeSat: bigint;
}

export function mapForwardingEvents(response: ForwardingHistoryResponse): ForwardingEventView[] {
  return response.forwardingEvents.map((event) => ({
    timestampNs: event.timestampNs !== 0n ? event.timestampNs : event.timestamp,
    amtInSat: event.amtIn,
    amtOutSat: event.amtOut,
    feeSat: event.fee,
  }));
}

export interface ChannelInsightView {
  readonly chanPoint: string;
  readonly monitoredSeconds: bigint;
  readonly uptimeSeconds: bigint;
  /** Uptime ratio 0–1 over the monitored window; undefined when unmonitored. */
  readonly uptimeRatio: number | undefined;
  readonly volumeIncomingMsat: bigint;
  readonly volumeOutgoingMsat: bigint;
  readonly feesEarnedMsat: bigint;
  readonly isPrivate: boolean;
}

export function mapChannelInsights(response: ChannelInsightsResponse): ChannelInsightView[] {
  return response.channelInsights.map((insight) => {
    const monitored = insight.monitoredSeconds;
    return {
      chanPoint: insight.chanPoint,
      monitoredSeconds: monitored,
      uptimeSeconds: insight.uptimeSeconds,
      uptimeRatio: monitored > 0n ? Number(insight.uptimeSeconds) / Number(monitored) : undefined,
      volumeIncomingMsat: insight.volumeIncomingMsat,
      volumeOutgoingMsat: insight.volumeOutgoingMsat,
      feesEarnedMsat: insight.feesEarnedMsat,
      isPrivate: insight.private,
    };
  });
}

export interface RevenuePairView {
  readonly peerChannelPoint: string;
  readonly amountOutgoingMsat: bigint;
  readonly feesOutgoingMsat: bigint;
  readonly amountIncomingMsat: bigint;
  readonly feesIncomingMsat: bigint;
}

export interface RevenueReportView {
  readonly targetChannel: string;
  readonly pairs: readonly RevenuePairView[];
}

export function mapRevenueReport(response: RevenueReportResponse): RevenueReportView[] {
  return response.reports.map((report) => ({
    targetChannel: report.targetChannel,
    pairs: Object.entries(report.pairReports).map(([peerChannelPoint, pair]) => ({
      peerChannelPoint,
      amountOutgoingMsat: pair.amountOutgoingMsat,
      feesOutgoingMsat: pair.feesOutgoingMsat,
      amountIncomingMsat: pair.amountIncomingMsat,
      feesIncomingMsat: pair.feesIncomingMsat,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Request builders — validation happens here so the bridge never dispatches
// a malformed request to a node holding real funds.
// ---------------------------------------------------------------------------

export class RequestValidationError extends Error {}

/** Parse an lnrpc channel point ("txid:index") into its two halves. */
export function parseChannelPoint(channelPoint: string): { txid: string; outputIndex: number } {
  const match = /^([0-9a-fA-F]{64}):(\d+)$/.exec(channelPoint.trim());
  if (!match) {
    throw new RequestValidationError(`invalid channel point "${channelPoint}" — expected "<64-char txid>:<output index>"`);
  }
  return { txid: match[1]!, outputIndex: Number(match[2]) };
}

export interface SendCoinsInput {
  readonly address: string;
  /** Required unless sendAll. Whole satoshis. */
  readonly amountSat?: bigint;
  readonly sendAll?: boolean;
  /** Explicit fee rate; the UI passes a live estimate or a manual value. */
  readonly satPerVbyte: number;
  readonly label?: string;
}

export function buildSendCoinsRequest(input: SendCoinsInput): SendCoinsRequest {
  if (!input.address.trim()) {
    throw new RequestValidationError('destination address is required');
  }
  if (!Number.isInteger(input.satPerVbyte) || input.satPerVbyte < 1) {
    throw new RequestValidationError('fee must be a whole number of satoshis per vbyte (≥ 1)');
  }
  if (input.sendAll === true) {
    if (input.amountSat !== undefined) {
      throw new RequestValidationError('cannot combine an explicit amount with send-all');
    }
  } else if (input.amountSat === undefined || input.amountSat <= 0n) {
    throw new RequestValidationError('amount must be a positive whole number of satoshis (or send-all)');
  }
  return {
    addr: input.address.trim(),
    amount: input.amountSat ?? 0n,
    sendAll: input.sendAll === true,
    satPerVbyte: BigInt(input.satPerVbyte),
    label: input.label ?? '',
    targetConf: 0,
    satPerByte: 0n,
    minConfs: 1,
    spendUnconfirmed: false,
    coinSelectionStrategy: 0 as SendCoinsRequest['coinSelectionStrategy'],
    outpoints: [],
  };
}

export interface OpenChannelInput {
  readonly nodePubkeyHex: string;
  readonly localFundingSat: bigint;
  readonly satPerVbyte: number;
  readonly isPrivate?: boolean;
  /** Satoshis pushed to the remote side at open (0 = none). */
  readonly pushSat?: bigint;
}

const PUBKEY_HEX_PATTERN = /^([0-9a-fA-F]{66})$/;

export function buildOpenChannelRequest(input: OpenChannelInput): OpenChannelRequest {
  if (!PUBKEY_HEX_PATTERN.test(input.nodePubkeyHex.trim())) {
    throw new RequestValidationError('node pubkey must be 33 bytes of hex (66 characters)');
  }
  if (input.localFundingSat <= 0n) {
    throw new RequestValidationError('channel funding amount must be a positive whole number of satoshis');
  }
  if (!Number.isInteger(input.satPerVbyte) || input.satPerVbyte < 1) {
    throw new RequestValidationError('fee must be a whole number of satoshis per vbyte (≥ 1)');
  }
  return {
    nodePubkey: Buffer.from(input.nodePubkeyHex.trim(), 'hex'),
    nodePubkeyString: '',
    localFundingAmount: input.localFundingSat,
    pushSat: input.pushSat ?? 0n,
    satPerVbyte: BigInt(input.satPerVbyte),
    targetConf: 0,
    satPerByte: 0n,
    private: input.isPrivate === true,
    minHtlcMsat: 0n,
    remoteCsvDelay: 0,
    minConfs: 1,
    spendUnconfirmed: false,
    closeAddress: '',
    commitmentType: 0 as OpenChannelRequest['commitmentType'],
    zeroConf: false,
    scidAlias: false,
    baseFee: 0n,
    feeRate: 0n,
    useBaseFee: false,
    useFeeRate: false,
    remoteChanReserveSat: 0n,
    fundMax: false,
    memo: '',
    outpoints: [],
    remoteMaxValueInFlightMsat: 0n,
    remoteMaxHtlcs: 0,
    maxLocalCsv: 0,
    fundingShim: undefined,
  };
}

export interface CloseChannelInput {
  readonly channelPoint: string;
  readonly force?: boolean;
  readonly satPerVbyte?: number;
}

export function buildCloseChannelRequest(input: CloseChannelInput): CloseChannelRequest {
  const { txid, outputIndex } = parseChannelPoint(input.channelPoint);
  if (input.satPerVbyte !== undefined && (!Number.isInteger(input.satPerVbyte) || input.satPerVbyte < 1)) {
    throw new RequestValidationError('fee must be a whole number of satoshis per vbyte (≥ 1)');
  }
  return {
    channelPoint: {
      fundingTxid: {
        oneofKind: 'fundingTxidStr',
        fundingTxidStr: txid,
      },
      outputIndex,
    },
    force: input.force === true,
    satPerVbyte: input.satPerVbyte !== undefined ? BigInt(input.satPerVbyte) : 0n,
    targetConf: 0,
    satPerByte: 0n,
    deliveryAddress: '',
    maxFeePerVbyte: 0n,
    noWait: false,
  };
}

export interface SendPaymentInput {
  readonly paymentRequest: string;
  /** Amount override for zero-amount invoices, in satoshis. */
  readonly amountSat?: bigint;
  /** Decoded invoice amount — the percentage fee base. Required for feeLimitPercent. */
  readonly invoiceAmountSat?: bigint;
  /** Exactly one of these two fee-limit forms when provided. */
  readonly feeLimitSat?: bigint;
  readonly feeLimitPercent?: number;
  readonly cltvLimit?: number;
  readonly allowSelfPayment?: boolean;
}

/**
 * Build the routerrpc SendPaymentRequest for SendPaymentV2. The stream's
 * terminal Payment.status (SUCCEEDED/FAILED) is the payment's verdict —
 * mapped by mapPaymentOutcome.
 */
export function buildSendPaymentRequest(input: SendPaymentInput): SendPaymentRequest {
  const bolt11 = input.paymentRequest.trim();
  if (!bolt11.toLowerCase().startsWith('ln')) {
    throw new RequestValidationError('a Lightning payment request (BOLT-11 string) is required');
  }
  if (input.amountSat !== undefined && input.amountSat < 0n) {
    throw new RequestValidationError('amount cannot be negative');
  }
  if (input.feeLimitSat !== undefined && input.feeLimitPercent !== undefined) {
    throw new RequestValidationError('choose either a fixed fee limit or a percentage, not both');
  }
  if (input.feeLimitSat !== undefined && input.feeLimitSat <= 0n) {
    throw new RequestValidationError('fixed fee limit must be positive');
  }
  if (input.feeLimitPercent !== undefined && (input.feeLimitPercent < 1 || input.feeLimitPercent > 100)) {
    throw new RequestValidationError('percentage fee limit must be between 1 and 100');
  }
  // routerrpc expresses its fee limit as plain sat/mSat integers (no FeeLimit
  // oneof), so a percentage limit is translated here, ceilinged to ≥1 sat.
  let feeLimitSat = input.feeLimitSat ?? 0n;
  if (input.feeLimitPercent !== undefined) {
    const base =
      input.invoiceAmountSat !== undefined && input.invoiceAmountSat > 0n
        ? input.invoiceAmountSat
        : (input.amountSat ?? 0n);
    if (base <= 0n) {
      throw new RequestValidationError('percentage fee limit requires the invoice amount');
    }
    feeLimitSat = (base * BigInt(input.feeLimitPercent) + 99n) / 100n;
  }
  return {
    paymentRequest: bolt11,
    amt: input.amountSat ?? 0n,
    amtMsat: 0n,
    feeLimitSat,
    feeLimitMsat: 0n,
    cltvLimit: input.cltvLimit ?? 0,
    outgoingChanIds: [],
    lastHopPubkey: new Uint8Array(),
    allowSelfPayment: input.allowSelfPayment === true,
    dest: new Uint8Array(),
    destFeatures: [],
    destCustomRecords: {},
    finalCltvDelta: 0,
    paymentHash: new Uint8Array(),
    routeHints: [],
    timeoutSeconds: 60,
    maxParts: 0,
    noInflightUpdates: false,
    paymentAddr: new Uint8Array(),
    maxShardSizeMsat: 0n,
    amp: false,
    timePref: 0,
    cancelable: false,
    firstHopCustomRecords: {},
  };
}

export type PaymentOutcomeStatus = 'succeeded' | 'failed' | 'no-result';

export interface PaymentOutcomeView {
  readonly status: PaymentOutcomeStatus;
  readonly paymentHash: string;
  readonly preimage?: string;
  readonly failureReason?: string;
}

const TERMINAL_PAYMENT_STATUSES = new Set([2, 3]); // SUCCEEDED, FAILED (see Payment_PaymentStatus)

const PAYMENT_STATUS_LABELS: Record<number, string> = {
  0: 'unknown',
  1: 'in-flight',
  2: 'succeeded',
  3: 'failed',
};

/** Serialized ListPayments row (sats as decimal strings). */
export interface PaymentView {
  readonly paymentHash: string;
  readonly status: string;
  readonly valueSat: string;
  readonly feeSat: string;
  readonly creationTimeNs: string;
  readonly failureReason?: string;
}

/** Serialize a ListPayments row for the bridge (sats as decimal strings). */
export function mapPaymentView(payment: {
  readonly paymentHash: string;
  readonly status: number;
  readonly valueSat: bigint;
  readonly fee: bigint;
  readonly creationTimeNs: bigint;
  readonly failureReason: number;
}): PaymentView {
  return {
    paymentHash: payment.paymentHash,
    status: PAYMENT_STATUS_LABELS[payment.status] ?? `unknown (${payment.status})`,
    valueSat: payment.valueSat.toString(),
    feeSat: payment.fee.toString(),
    creationTimeNs: payment.creationTimeNs.toString(),
    failureReason:
      payment.status === 3 && payment.failureReason !== 0
        ? PAYMENT_FAILURE_REASONS[payment.failureReason] ?? `unknown (${payment.failureReason})`
        : undefined,
  };
}

/** Map the terminal state of a SendPaymentV2 stream to a view. */
export function mapPaymentOutcome(finalPayment?: {
  readonly status: number;
  readonly paymentHash?: string;
  readonly paymentPreimage?: string;
  readonly failureReason?: number;
}): PaymentOutcomeView {
  if (finalPayment === undefined || !TERMINAL_PAYMENT_STATUSES.has(finalPayment.status)) {
    return { status: 'no-result', paymentHash: '' };
  }
  const succeeded = finalPayment.status === 2;
  const failureReason =
    !succeeded && finalPayment.failureReason !== undefined
      ? PAYMENT_FAILURE_REASONS[finalPayment.failureReason] ?? `unknown (${finalPayment.failureReason})`
      : undefined;
  return {
    status: succeeded ? 'succeeded' : 'failed',
    paymentHash: finalPayment.paymentHash ?? '',
    preimage: succeeded ? finalPayment.paymentPreimage : undefined,
    failureReason,
  };
}

const PAYMENT_FAILURE_REASONS: Record<number, string> = {
  0: 'no error',
  1: 'payment timeout',
  2: 'no route found',
  3: 'non-recoverable error',
  4: 'incorrect payment details',
  5: 'insufficient liquidity',
};

export interface DecodedInvoiceView {
  readonly paymentHashHex: string;
  readonly amountSat?: bigint;
  readonly memo: string;
  readonly destination: string;
  readonly cltvExpiry: bigint;
}

/** Map a DecodePayReq response for the payment review step. */
export function mapPayReq(decoded: PayReq): DecodedInvoiceView {
  return {
    paymentHashHex: decoded.paymentHash,
    amountSat: decoded.numSatoshis,
    memo: decoded.description,
    destination: decoded.destination,
    cltvExpiry: decoded.cltvExpiry,
  };
}

// ---------------------------------------------------------------------------
// SCB (channel backup) round-trip
// ---------------------------------------------------------------------------

/**
 * Extract the multi-channel SCB blob as hex from a backup snapshot. The
 * single blob covers ALL open channels — the format the recovery UI saves
 * as a file and uploads during restore.
 */
export function multiChanBackupHex(snapshot: ChanBackupSnapshot): string {
  const multi = snapshot.multiChanBackup;
  if (multi === undefined || multi.multiChanBackup.length === 0) {
    throw new RequestValidationError('the node returned no multi-channel backup — nothing to save');
  }
  return Buffer.from(multi.multiChanBackup).toString('hex');
}

/** Rebuild the restore request from a hex SCB blob (one file → one blob). */
export function buildRestoreChanBackupRequest(backupHex: string): RestoreChanBackupRequest {
  const trimmed = backupHex.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length < 16) {
    throw new RequestValidationError('this does not look like a channel backup file (expected hex content)');
  }
  return {
    backup: {
      oneofKind: 'multiChanBackup',
      multiChanBackup: new Uint8Array(Buffer.from(trimmed, 'hex')),
    },
  };
}
