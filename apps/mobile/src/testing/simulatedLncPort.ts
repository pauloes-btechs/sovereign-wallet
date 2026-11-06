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

export class SimulatedLncPort implements LncRpcPort {
  private connected = false;
  private invoiceSeq = 0;
  private readonly listeners = new Set<(event: LncConnectionEvent) => void>();
  private readonly activity: RemoteActivityRecord[] = [];
  /** Amounts of the invoices this port created, so paying one records its amount. */
  private readonly invoiceAmounts = new Map<string, bigint>();
  /** A fixed clock for deterministic tests; defaults to the wall clock. */
  constructor(private readonly now: () => Date = () => new Date()) {}

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
    return {
      lightningSpendableSat: 420_000n,
      onchainConfirmedSat: 1_250_000n,
      channels: [
        { chanId: 'sim-1', active: true, localSat: 420_000n, remoteSat: 580_000n, capacitySat: 1_000_000n },
      ],
    };
  }

  async addInvoice(request: { valueSat: bigint; memo?: string }): Promise<{ bolt11: string }> {
    this.invoiceSeq += 1;
    const bolt11 = `lnbcrt${request.valueSat}n1sim${this.invoiceSeq}`;
    this.invoiceAmounts.set(bolt11, request.valueSat);
    this.activity.unshift({
      paymentHash: sha256Hex(`sim-invoice-${this.invoiceSeq}`),
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

  async payInvoice(request: { bolt11: string; timeoutSeconds: number }): Promise<{
    outcome: DispatchOutcome;
  }> {
    this.activity.unshift({
      paymentHash: sha256Hex(request.bolt11),
      direction: 'out',
      amountSat: this.invoiceAmounts.get(request.bolt11) ?? hrpAmountSat(request.bolt11) ?? 0n,
      feeSat: 0n,
      status: 'settled',
      createdAt: this.now().toISOString(),
      memo:
        this.invoiceAmounts.has(request.bolt11) || hrpAmountSat(request.bolt11) !== null
          ? 'Simulated payment'
          : 'Simulated payment (amount not encoded in the invoice)',
      paymentRequest: request.bolt11,
    });
    return { outcome: { status: 'settled', backendRef: 'sim-preimage' } };
  }

  async lookupPayment(_paymentHashHex: string): Promise<ReconcileResult> {
    return { status: 'unknown' };
  }

  async listLightningActivity(request: { readonly maxItems: number }): Promise<readonly RemoteActivityRecord[]> {
    return this.activity.slice(0, request.maxItems);
  }
}

/**
 * The amount in a BOLT11 human-readable part (`ln<net><amount><multiplier>1…`),
 * in whole sats; null when the invoice carries no amount. Multipliers per
 * BOLT11: m = 10^-3, u = 10^-6, n = 10^-9, p = 10^-12 BTC.
 */
function hrpAmountSat(bolt11: string): bigint | null {
  const match = /^ln(?:bcrt|bc|tbs|tb)(\d+)([munp]?)1/i.exec(bolt11);
  if (match === null) return null;
  const amount = BigInt(match[1] ?? '0');
  const msatPerUnit: Record<string, bigint> = {
    '': 100_000_000_000n,
    m: 100_000_000n,
    u: 100_000n,
    n: 100n,
    p: 0n, // 0.1 msat per unit — handled below
  };
  const multiplier = (match[2] ?? '').toLowerCase();
  const msat = multiplier === 'p' ? amount / 10n : amount * (msatPerUnit[multiplier] ?? 0n);
  return msat / 1000n;
}
