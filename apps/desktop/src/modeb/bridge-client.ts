/**
 * Typed client for the litd loopback bridge (Mode B).
 *
 * Wire contract mirrors `services/litd-adapter/src/bridge/session.ts` view
 * types, with every bigint sats field serialized as a decimal string by the
 * bridge's `sessionJsonReplacer`. Request amounts go out as strings so the
 * UI never loses precision on >2^53 values.
 */

export interface BridgeBootstrap {
  /** Loopback bridge base URL (absolute 127.0.0.1) or a same-origin proxy path. */
  bridgeUrl: string;
  /** Per-launch random session token (Authorization: Bearer). */
  bridgeToken: string;
}

/** Parse dev/e2e URL params. Null when absent or malformed — never throws.
 *  Accepts an absolute loopback URL or a same-origin proxy path (/modeb). */
export function devBridgeBootstrap(search: string): BridgeBootstrap | null {
  const params = new URLSearchParams(search);
  const bridgeUrl = params.get('devBridgeUrl');
  const bridgeToken = params.get('devBridgeToken');
  if (bridgeUrl === null || bridgeToken === null) return null;
  if (/^\/[^\s]*$/.test(bridgeUrl)) return { bridgeUrl, bridgeToken };
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(bridgeUrl)) return { bridgeUrl, bridgeToken };
  return null;
}

export class BridgeHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeHttpError';
  }
}

export type BridgePhase = 'ready' | 'locked' | 'missing' | 'undetermined';

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
  readonly chains: readonly { readonly chain: string; readonly network: string }[];
}

export interface BridgeStateView {
  readonly phase: BridgePhase;
  readonly info?: NodeHealthView;
  readonly error?: string;
}

export interface WalletBalanceView {
  readonly totalSat: string;
  readonly confirmedSat: string;
  readonly unconfirmedSat: string;
  readonly lockedSat: string;
  readonly reservedAnchorSat: string;
}

export interface ChannelBalanceView {
  readonly localSat: string;
  readonly remoteSat: string;
  readonly localUnsettledSat: string;
  readonly pendingOpenLocalSat: string;
  readonly pendingOpenRemoteSat: string;
}

/** Serialized ChannelRowView — open AND pending channels share this shape. */
export interface ChannelRowView {
  readonly channelPoint: string;
  readonly chanId: string;
  readonly remotePubkey: string;
  readonly capacitySat: string;
  readonly localBalanceSat: string;
  readonly remoteBalanceSat: string;
  readonly state: 'opening' | 'open' | 'open-inactive' | 'closing' | 'closing-force' | 'waiting-close';
  readonly initiatorLabel: string;
}

export interface ChannelsView {
  readonly open: readonly ChannelRowView[];
  readonly pending: readonly ChannelRowView[];
  readonly balance: ChannelBalanceView;
}

export interface CloseJobView {
  readonly id: string;
  readonly state: 'closing' | 'closed';
  readonly closingTxid?: string;
  readonly error?: string;
}

/** Serialized ListPayments row (see mapPaymentView). */
export interface PaymentView {
  readonly paymentHash: string;
  readonly status: string;
  readonly valueSat: string;
  readonly feeSat: string;
  readonly creationTimeNs: string;
  readonly failureReason?: string;
}

export interface PaymentOutcomeView {
  readonly status: 'succeeded' | 'failed' | 'no-result';
  readonly paymentHash: string;
  readonly preimage?: string;
  readonly failureReason?: string;
}

export interface DecodedInvoiceView {
  readonly paymentHashHex: string;
  readonly amountSat?: string;
  readonly memo: string;
  readonly destination: string;
  readonly cltvExpiry: string;
}

export interface FeeEstimateView {
  readonly satPerVbyte: string;
  readonly feeSat: string;
}

export interface ForwardingEventView {
  readonly timestampNs: string;
  readonly amtInSat: string;
  readonly amtOutSat: string;
  readonly feeSat: string;
}

export interface ChannelInsightView {
  readonly chanPoint: string;
  readonly monitoredSeconds: string;
  readonly uptimeSeconds: string;
  readonly uptimeRatio?: number;
  readonly volumeIncomingMsat: string;
  readonly volumeOutgoingMsat: string;
  readonly feesEarnedMsat: string;
  readonly isPrivate: boolean;
}

export interface RevenuePairView {
  readonly peerChannelPoint: string;
  readonly amountOutgoingMsat: string;
  readonly feesOutgoingMsat: string;
  readonly amountIncomingMsat: string;
  readonly feesIncomingMsat: string;
}

export interface RevenueReportView {
  readonly targetChannel: string;
  readonly pairs: readonly RevenuePairView[];
}

export interface FaradayView {
  readonly available: boolean;
  readonly error?: string;
  readonly insights?: readonly ChannelInsightView[];
  readonly revenue?: readonly RevenueReportView[];
}

export interface ClosedChannelView {
  readonly channelPoint: string;
  readonly chanId: string;
  readonly remotePubkey: string;
  readonly closingTxHash: string;
  readonly closeType: string;
  readonly closeHeight: number;
  readonly settledBalanceSat: string;
  readonly timeLockedBalanceSat: string;
}

export interface DiagnosticsView {
  readonly node: NodeHealthView;
  readonly closed: readonly ClosedChannelView[];
  readonly forwarding: readonly ForwardingEventView[];
  readonly faraday: FaradayView;
}

export class BridgeClient {
  constructor(private readonly options: BridgeBootstrap) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.options.bridgeUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.bridgeToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure (daemon or bridge down) — keep the message.
      throw new BridgeHttpError(0, err instanceof Error ? err.message : String(err));
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new BridgeHttpError(response.status, payload.error ?? `bridge request failed (${response.status})`);
    }
    return (await response.json()) as T;
  }

  state(): Promise<BridgeStateView> {
    return this.call<BridgeStateView>('GET', '/state');
  }

  generateSeed(): Promise<{ readonly mnemonic: readonly string[] }> {
    return this.call<{ mnemonic: string[] }>('POST', '/wallet/seed');
  }

  initWallet(input: { mnemonic: readonly string[]; password: string; aezeedPassphrase?: string; recoveryWindow?: number }): Promise<BridgeStateView> {
    return this.call<BridgeStateView>('POST', '/wallet/init', {
      mnemonic: input.mnemonic,
      password: input.password,
      ...(input.aezeedPassphrase === undefined ? {} : { aezeedPassphrase: input.aezeedPassphrase }),
      ...(input.recoveryWindow === undefined ? {} : { recoveryWindow: input.recoveryWindow }),
    });
  }

  unlockWallet(password: string): Promise<BridgeStateView> {
    return this.call<BridgeStateView>('POST', '/wallet/unlock', { password });
  }

  walletBalance(): Promise<WalletBalanceView> {
    return this.call<WalletBalanceView>('GET', '/onchain/balance');
  }

  newAddress(type: 'p2wkh' | 'np2wkh' = 'p2wkh'): Promise<{ readonly address: string }> {
    return this.call<{ address: string }>('POST', '/onchain/address', { type });
  }

  estimateFee(targetConf: number): Promise<FeeEstimateView> {
    return this.call<FeeEstimateView>('POST', '/onchain/estimate-fee', { targetConf });
  }

  sendCoins(input: { address: string; amountSat?: string; sendAll?: boolean; satPerVbyte?: number; label?: string }): Promise<{ readonly txid: string }> {
    return this.call<{ txid: string }>('POST', '/onchain/send', {
      address: input.address,
      ...(input.amountSat === undefined ? {} : { amountSat: input.amountSat }),
      ...(input.sendAll === undefined ? {} : { sendAll: input.sendAll }),
      ...(input.satPerVbyte === undefined ? {} : { satPerVbyte: input.satPerVbyte }),
      ...(input.label === undefined ? {} : { label: input.label }),
    });
  }

  channels(): Promise<ChannelsView> {
    return this.call<ChannelsView>('GET', '/channels');
  }

  openChannel(input: {
    nodePubkeyHex: string;
    host?: string;
    localFundingSat: string;
    satPerVbyte?: number;
    isPrivate?: boolean;
  }): Promise<{ readonly channelPoint: string }> {
    return this.call('POST', '/channels', {
      nodePubkeyHex: input.nodePubkeyHex,
      ...(input.host === undefined ? {} : { host: input.host }),
      localFundingSat: input.localFundingSat,
      ...(input.satPerVbyte === undefined ? {} : { satPerVbyte: input.satPerVbyte }),
      ...(input.isPrivate === undefined ? {} : { isPrivate: input.isPrivate }),
    });
  }

  closeChannel(input: { channelPoint: string; force?: boolean; satPerVbyte?: number }): Promise<CloseJobView> {
    return this.call<CloseJobView>('POST', '/channels/close', {
      channelPoint: input.channelPoint,
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(input.satPerVbyte === undefined ? {} : { satPerVbyte: input.satPerVbyte }),
    });
  }

  closeJob(id: string): Promise<CloseJobView> {
    return this.call<CloseJobView>('GET', `/channels/close/${id}`);
  }

  createInvoice(input: { amountSat?: string; memo?: string }): Promise<{ readonly paymentRequest: string; readonly rHashHex: string }> {
    return this.call('POST', '/invoices', {
      ...(input.amountSat === undefined ? {} : { amountSat: input.amountSat }),
      ...(input.memo === undefined ? {} : { memo: input.memo }),
    });
  }

  decodeInvoice(paymentRequest: string): Promise<DecodedInvoiceView> {
    return this.call<DecodedInvoiceView>('POST', '/invoices/decode', { paymentRequest });
  }

  payInvoice(input: {
    paymentRequest: string;
    amountSat?: string;
    invoiceAmountSat?: string;
    feeLimitSat?: string;
    feeLimitPercent?: number;
    cltvLimit?: number;
    allowSelfPayment?: boolean;
  }): Promise<PaymentOutcomeView> {
    return this.call<PaymentOutcomeView>('POST', '/payments', {
      paymentRequest: input.paymentRequest,
      ...(input.amountSat === undefined ? {} : { amountSat: input.amountSat }),
      ...(input.invoiceAmountSat === undefined ? {} : { invoiceAmountSat: input.invoiceAmountSat }),
      ...(input.feeLimitSat === undefined ? {} : { feeLimitSat: input.feeLimitSat }),
      ...(input.feeLimitPercent === undefined ? {} : { feeLimitPercent: input.feeLimitPercent }),
      ...(input.cltvLimit === undefined ? {} : { cltvLimit: input.cltvLimit }),
      ...(input.allowSelfPayment === undefined ? {} : { allowSelfPayment: input.allowSelfPayment }),
    });
  }

  payments(max = 20): Promise<{ readonly payments: readonly PaymentView[] }> {
    return this.call<{ payments: PaymentView[] }>('GET', `/payments?max=${max}`);
  }

  diagnostics(): Promise<DiagnosticsView> {
    return this.call<DiagnosticsView>('GET', '/diagnostics');
  }

  exportChannelBackups(): Promise<{ readonly multiChanBackupHex: string }> {
    return this.call<{ multiChanBackupHex: string }>('GET', '/channel-backups');
  }

  restoreChannelBackups(backupHex: string): Promise<{ readonly ok: true }> {
    return this.call<{ ok: true }>('POST', '/channel-backups/restore', { backupHex });
  }
}
