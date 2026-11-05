/**
 * SimulatedLncPort — preview/test-only stand-in for the `@lightninglabs/lnc-rn`
 * port, so the remote-node (Mode B) screens can be viewed in the web preview.
 * Everything it returns is labeled simulated (alias `sim-node`, `lnbcrt…sim`
 * invoices) and nothing leaves the page. It is never wired into a native build.
 */

import type { DispatchOutcome, ReconcileResult } from '@sovereign/payments';
import type {
  LncConnectionEvent,
  LncRpcPort,
  RemoteBalances,
  RemoteNodeInfo,
} from '../flows/modeBRemoteController.js';

export class SimulatedLncPort implements LncRpcPort {
  private connected = false;
  private invoiceSeq = 0;
  private readonly listeners = new Set<(event: LncConnectionEvent) => void>();

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
    return { bolt11: `lnbcrt${request.valueSat}n1sim${this.invoiceSeq}` };
  }

  async payInvoice(_request: { bolt11: string; timeoutSeconds: number }): Promise<{
    outcome: DispatchOutcome;
  }> {
    return { outcome: { status: 'settled', backendRef: 'sim-preimage' } };
  }

  async lookupPayment(_paymentHashHex: string): Promise<ReconcileResult> {
    return { status: 'unknown' };
  }
}
