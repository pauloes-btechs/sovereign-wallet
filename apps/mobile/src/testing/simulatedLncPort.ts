/**
 * SimulatedLncPort — preview/test-only stand-in for the `@lightninglabs/lnc-rn`
 * port, so the remote-node (Mode B) screens can be viewed in the web preview.
 * Everything it returns is labeled simulated (alias `sim-node`, `lnbcrt…sim`
 * invoices) and nothing leaves the page. It is never wired into a native build.
 *
 * Activity is only what happened through this port in this session: each
 * invoice it created (open — nothing in the simulation pays it) and each
 * payment it made. It starts empty; nothing is pre-seeded.
 */

import type { DispatchOutcome, ReconcileResult } from '@sovereign/payments';
import type {
  LncConnectionEvent,
  LncRpcPort,
  RemoteActivityRecord,
  RemoteBalances,
  RemoteNodeInfo,
} from '../flows/modeBRemoteController.js';
import { sha256Hex } from '../flows/modeBRemoteController.js';
import type { DecodedAssetAddress, RemoteAsset, RemoteAssetTransfer } from '../flows/assets.js';
import type { RemoteChannelDetail } from '../flows/liquidity.js';
import type {
  LoopDirection,
  LoopInRequest,
  LoopOutRequest,
  LoopSwapStarted,
  LoopTerms,
  RemoteLoopQuote,
  RemoteSwap,
} from '../flows/transfers.js';
import { SimulatedLiquidityNode } from './simulatedLiquidity.js';
import { decodeBolt11, invoiceAmountSat } from '../flows/destination.js';
import { encodeSimulatedBolt11 } from './simInvoice.js';


export class SimulatedLncPort implements LncRpcPort {
  private connected = false;
  private invoiceSeq = 0;
  private readonly listeners = new Set<(event: LncConnectionEvent) => void>();
  private readonly activity: RemoteActivityRecord[] = [];
  /** Amounts of the invoices this port created, so paying one records its amount. */
  private readonly invoiceAmounts = new Map<string, bigint>();
  /** Every payInvoice request as received (tests assert fee limit and timeout). */
  readonly payRequests: Array<{ bolt11: string; timeoutSeconds: number; feeLimitSat?: number }> = [];
  /** Every Loop, liquidity and asset result is labelled simulated in the UI. */
  readonly simulated = true;
  /** Channels, Loop swap server and tapd stand-in (see simulatedLiquidity.ts). */
  readonly liquidity: SimulatedLiquidityNode;
  /** A fixed clock for deterministic tests; defaults to the wall clock. */
  constructor(private readonly now: () => Date = () => new Date()) {
    this.liquidity = new SimulatedLiquidityNode(() => this.now().getTime());
  }

  async connect(_pairingPhraseWords: readonly string[]): Promise<void> {
    this.connected = true;
    for (const listener of this.listeners) listener({ type: 'connected' });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onConnectionEvent(listener: (event: LncConnectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getInfo(): Promise<RemoteNodeInfo> {
    return {
      identityPubkey: `02${'5e'.repeat(31)}`,
      alias: 'sim-node',
      version: 'simulated',
      network: 'regtest',
      blockHeight: 805_000,
    };
  }

  async getBalances(): Promise<RemoteBalances> {
    return this.liquidity.balances();
  }

  // ——— channels, Loop and Taproot Assets (simulated; see simulatedLiquidity.ts) ———

  async listChannels(): Promise<readonly RemoteChannelDetail[]> {
    return this.liquidity.listChannels();
  }

  async loopTerms(): Promise<LoopTerms> {
    return this.liquidity.loopTerms();
  }

  async loopQuote(request: { readonly direction: LoopDirection; readonly amountSat: bigint }): Promise<RemoteLoopQuote> {
    return this.liquidity.quote(request.direction, request.amountSat);
  }

  async loopOut(request: LoopOutRequest): Promise<LoopSwapStarted> {
    return this.liquidity.loopOut(request);
  }

  async loopIn(request: LoopInRequest): Promise<LoopSwapStarted> {
    return this.liquidity.loopIn(request);
  }

  async listSwaps(): Promise<readonly RemoteSwap[]> {
    return this.liquidity.listSwaps();
  }

  async swapStatus(swapId: string): Promise<RemoteSwap> {
    return this.liquidity.swapStatus(swapId);
  }

  async listAssets(): Promise<readonly RemoteAsset[]> {
    return this.liquidity.listAssets();
  }

  async assetTransfers(): Promise<readonly RemoteAssetTransfer[]> {
    return this.liquidity.assetTransfers();
  }

  async newAssetAddress(request: { readonly assetIdHex: string; readonly amount: bigint }): Promise<{ readonly address: string }> {
    return { address: this.liquidity.newAssetAddress(request.assetIdHex, request.amount) };
  }

  async decodeAssetAddress(address: string): Promise<DecodedAssetAddress> {
    return this.liquidity.decodeAssetAddress(address);
  }

  async sendAsset(request: { readonly address: string }): Promise<{ readonly txid: string; readonly chainFeeSat: bigint | null }> {
    return this.liquidity.sendAsset(request.address);
  }

  async addInvoice(request: { valueSat: bigint; memo?: string; expirySeconds?: number }): Promise<{ bolt11: string }> {
    this.invoiceSeq += 1;
    const paymentHash = sha256Hex(`sim-invoice-${this.invoiceSeq}`);
    // A well-formed (unsigned) BOLT11 so the Send parser reads it like a real one.
    const bolt11 = encodeSimulatedBolt11({
      network: 'regtest',
      amountMsat: request.valueSat === 0n ? null : request.valueSat * 1000n,
      paymentHashHex: paymentHash,
      description: request.memo,
      expirySeconds: request.expirySeconds,
      timestamp: Math.floor(this.now().getTime() / 1000),
    });
    this.invoiceAmounts.set(bolt11, request.valueSat);
    this.activity.unshift({
      paymentHash,
      direction: 'in',
      amountSat: request.valueSat,
      feeSat: null,
      status: 'open',
      createdAt: this.now().toISOString(),
      memo: request.memo ?? null,
      paymentRequest: bolt11,
    });
    return { bolt11 };
  }

  /**
   * Simulated routing: fee = max(1 sat, 0.1% of the amount). Refuses like
   * LND does: unreadable or expired invoices, an invoice already paid, a fee
   * above `feeLimitSat` (no route within the limit) and amounts above the
   * simulated Lightning balance. Paying an invoice this port created marks
   * that invoice settled (a simulated self-payment).
   */
  async payInvoice(request: { bolt11: string; timeoutSeconds: number; feeLimitSat?: number }): Promise<{
    outcome: DispatchOutcome;
  }> {
    this.payRequests.push(request);
    const decoded = decodeBolt11(request.bolt11);
    if (!decoded.ok) {
      return { outcome: { status: 'definitive-failure', reason: 'invalid payment request: checksum failed' } };
    }
    const invoice = decoded.invoice;
    if (Math.floor(this.now().getTime() / 1000) >= invoice.expiresAt) {
      return { outcome: { status: 'definitive-failure', reason: 'invoice expired' } };
    }
    if (this.activity.some((r) => r.direction === 'out' && r.paymentHash === invoice.paymentHash && r.status === 'settled')) {
      return { outcome: { status: 'definitive-failure', reason: 'invoice is already paid' } };
    }
    const amountSat = invoiceAmountSat(invoice) ?? 0n;
    const feeSat = amountSat / 1000n > 1n ? amountSat / 1000n : 1n;
    const spendable = (await this.getBalances()).lightningSpendableSat;
    const failure =
      request.feeLimitSat !== undefined && feeSat > BigInt(request.feeLimitSat)
        ? 'FAILURE_REASON_NO_ROUTE'
        : amountSat + feeSat > spendable
          ? 'FAILURE_REASON_INSUFFICIENT_BALANCE'
          : null;
    this.activity.unshift({
      paymentHash: invoice.paymentHash,
      direction: 'out',
      amountSat,
      feeSat: failure === null ? feeSat : null,
      status: failure === null ? 'settled' : 'failed',
      createdAt: this.now().toISOString(),
      memo: invoice.description ?? 'Simulated payment',
      paymentRequest: invoice.invoice,
    });
    if (failure !== null) return { outcome: { status: 'definitive-failure', reason: failure } };
    const own = this.activity.findIndex((r) => r.direction === 'in' && r.paymentHash === invoice.paymentHash);
    const ownRecord = this.activity[own];
    if (ownRecord !== undefined) this.activity[own] = { ...ownRecord, status: 'settled' };
    return { outcome: { status: 'settled', backendRef: 'sim-preimage' } };
  }

  async lookupPayment(_paymentHashHex: string): Promise<ReconcileResult> {
    return { status: 'unknown' };
  }

  async listLightningActivity(request: { readonly maxItems: number }): Promise<readonly RemoteActivityRecord[]> {
    return this.activity.slice(0, request.maxItems);
  }
}
