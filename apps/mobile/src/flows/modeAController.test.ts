/**
 * Unit tests for the Mode A wallet controller — faked ports, precise
 * transition coverage. The REAL provider/engine stack is exercised end-to-end
 * by the harness money-flow integration suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentIntent } from '@sovereign/payments';
import type { BalanceBuckets, WalletEvent } from '@sovereign/wallet-core';
import { CrossProviderRestoreError } from '@sovereign/wallet-core';
import type {
  CreateWalletResult,
  LightningSendPayload,
  OnchainSendPayload,
  QuotedSend,
  VtxoWithState,
  WalletInfo,
} from '@sovereign/wavelength-adapter';
import { WavelengthError } from '@sovereign/wavelength-adapter';
import type {
  ModeAEnginePort,
  ModeAProviderPort,
} from './modeAController.js';
import { ModeAController, parseSats, summarizeVtxos } from './modeAController.js';

let idSeq = 0;
const nextId = (prefix: string): string => {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
};

const walletInfo = (serverConnected = true): WalletInfo => ({
  version: 'sim',
  commit: 'sim',
  network: 'regtest',
  blockHeight: 805_000,
  serverConnected,
  walletType: 'ark',
  walletState: 'ready',
  walletReady: true,
  identityPubKey: 'sim',
  serverInfo: { freeRefreshWindowBlocks: 25 },
});

const buckets = (lightningSpendableSat = 50_000n): BalanceBuckets => ({
  onchainConfirmedSat: 0n,
  onchainPendingSat: 0n,
  lightningSpendableSat,
  lightningPendingSat: 0n,
  lockedOrExpiringSat: 0n,
});

interface FakeProviderCalls {
  starts: number;
  createWallets: Array<{ mnemonic: string[]; recoverState: boolean; password: string }>;
  quoteLightningCalls: number;
  quoteOnchainCalls: number;
  classifyCalls: number;
}

class FakeProvider implements ModeAProviderPort {
  readonly id = 'wavelength' as const;
  readonly seedCompatibility = ['mnemonic-ark'];
  readonly capabilities = {
    lightningSend: true,
    lightningReceive: true,
    lightningMechanism: 'swaps' as const,
    onchainSend: true,
    onchainReceive: true,
    assets: 'none' as const,
    unilateralExit: 'async' as const,
    recoveryModel: 'mnemonic-ark' as const,
    operatorDependencies: [],
  };
  readonly calls: FakeProviderCalls = {
    starts: 0,
    createWallets: [],
    quoteLightningCalls: 0,
    quoteOnchainCalls: 0,
    classifyCalls: 0,
  };

  /** Driver-controlled VTXO classification returned by classifyVtxos(). */
  classified: VtxoWithState[] = [];
  serverConnected = true;
  balance = buckets();
  quoteFeeSat = 30;
  quoteAmountSat = 0;
  quoteThrows: Error | undefined;
  createWalletResult: CreateWalletResult = fullCreateWalletResult(['alpha', 'beta'], false, 3);
  createWalletThrows: Error | undefined;

  private listener: ((e: WalletEvent) => void) | undefined;

  async start(): Promise<void> {
    this.calls.starts += 1;
  }
  async stop(): Promise<void> {}
  onEvent(listener: (e: WalletEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  emit(event: WalletEvent): void {
    this.listener?.(event);
  }
  async createWallet(request: CreateWalletLike): Promise<CreateWalletResult> {
    this.calls.createWallets.push({
      mnemonic: request.mnemonic ?? [],
      recoverState: request.recoverState ?? false,
      password: request.password,
    });
    if (this.createWalletThrows) throw this.createWalletThrows;
    return this.createWalletResult;
  }
  async walletInfo(): Promise<WalletInfo> {
    return walletInfo(this.serverConnected);
  }
  async balanceBuckets(): Promise<BalanceBuckets> {
    return this.balance;
  }
  async receiveLightning(): Promise<string> {
    return nextId('invoice');
  }
  async depositOnchain(): Promise<string> {
    return nextId('bcrt1q');
  }
  async quoteLightning(): Promise<QuotedSend & { payload: LightningSendPayload }> {
    this.calls.quoteLightningCalls += 1;
    if (this.quoteThrows) throw this.quoteThrows;
    const quote = {
      sendIntentId: nextId('si'),
      amountSat: this.quoteAmountSat,
      expectedFeeSat: this.quoteFeeSat,
      paymentHash: nextId('ph'),
    };
    return {
      payload: { invoice: 'inv', quote: quote as QuotedSend['quote'] },
      quote: quote as QuotedSend['quote'],
    };
  }
  async quoteOnchain(): Promise<QuotedSend & { payload: OnchainSendPayload }> {
    this.calls.quoteOnchainCalls += 1;
    if (this.quoteThrows) throw this.quoteThrows;
    const quote = {
      sendIntentId: nextId('si'),
      amountSat: this.quoteAmountSat,
      expectedFeeSat: this.quoteFeeSat,
      paymentHash: '',
    };
    return {
      payload: { onchainAddress: 'bcrt1q', quote: quote as QuotedSend['quote'] },
      quote: quote as QuotedSend['quote'],
    };
  }
  async classifyVtxos(): Promise<readonly VtxoWithState[]> {
    this.calls.classifyCalls += 1;
    return this.classified;
  }
}

type CreateWalletLike = { password: string; mnemonic?: string[]; recoverState?: boolean };
const fullCreateWalletResult = (
  mnemonic: string[],
  recoveryRan: boolean,
  recoveredVTXOs: number,
): CreateWalletResult => ({
  mnemonic,
  encipheredSeed: 'enc-sim',
  identityPubKey: 'sim-identity',
  recoveryRan,
  recoveredBoardingAddresses: 0,
  recoveredBoardingUTXOs: 0,
  recoveredVTXOs,
  recoveredOORReceiveScripts: 0,
  recoveredOORRecipientEvents: 0,
});

class FakeEngine implements ModeAEnginePort {
  submitted: Array<{ kind: string; payload: unknown; maxFeeSat?: number }> = [];
  executed: string[] = [];
  /** Outcome the next execute() returns; driver-set. */
  executeOutcome: 'settled' | 'in-flight' = 'settled';
  recoverReport: { reconciled: string[]; needsRecovery: string[] } = {
    reconciled: [],
    needsRecovery: [],
  };

  async submit(kind: 'lightning-invoice' | 'onchain', payload: unknown): Promise<PaymentIntent> {
    this.submitted.push({ kind, payload });
    return { intentId: nextId('intent'), kind, payload, state: 'authorized', attempts: [] };
  }
  async execute(intentId: string): Promise<PaymentIntent> {
    this.executed.push(intentId);
    return {
      intentId,
      kind: 'lightning-invoice',
      payload: {},
      state: this.executeOutcome,
      backendRef: 'ph-1',
      attempts: [],
    };
  }
  async recoverInterrupted(): Promise<{ reconciled: string[]; needsRecovery: string[] }> {
    return this.recoverReport;
  }
}

/** A classified VTXO with the given state. */
function vtxo(state: VtxoWithState['state'], overrides?: Partial<VtxoWithState>): VtxoWithState {
  return {
    vtxo: {
      outpoint: nextId('op'),
      amountSat: 10_000,
      status: 'available',
      batchExpiry: 805_010,
      relativeExpiry: 20,
      commitmentTxid: 'tx',
    },
    state,
    blocksToExpiry: 10,
    ...overrides,
  };
}

describe('ModeAController — create wallet + backup', () => {
  let provider: FakeProvider;
  let controller: ModeAController;

  beforeEach(() => {
    provider = new FakeProvider();
    controller = new ModeAController({
      provider,
      engine: new FakeEngine(),
      network: 'regtest',
      dataDir: '/tmp/mode-a-unit',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the provider, subscribes to events, and refreshes balances', async () => {
    await controller.start();
    expect(provider.calls.starts).toBe(1);
    expect(controller.getState().balances).toEqual(buckets());
    expect(controller.getState().vtxo).not.toBeNull();
  });

  it('walks create → backup steps → done, dropping the words from memory', async () => {
    await controller.start();
    await controller.createWallet('passphrase-1');
    const afterCreate = controller.getState();
    expect(afterCreate.screen).toBe('backup');
    expect(afterCreate.backupStep).toBe('show');
    expect(afterCreate.words).toEqual(['alpha', 'beta']);
    expect(provider.calls.createWallets[0]?.recoverState).toBe(false);

    controller.acknowledgeWords();
    expect(controller.getState().backupStep).toBe('verify');
    controller.showWordsAgain();
    expect(controller.getState().backupStep).toBe('show');
    controller.acknowledgeWords();
    controller.confirmBackup();
    const done = controller.getState();
    expect(done.screen).toBe('home');
    // Words never persist beyond the backup flow.
    expect(done.words).toBeNull();
  });

  it('re-renders balances on provider balance-changed events', async () => {
    await controller.start();
    const before = controller.getState().balances;
    provider.balance = buckets(77_000n);
    provider.emit({ type: 'balance-changed' });
    // The event handler refreshes asynchronously — wait a microtask turn.
    await vi.waitFor(() => {
      expect(controller.getState().balances?.lightningSpendableSat).toBe(77_000n);
    });
    expect(before?.lightningSpendableSat).toBe(50_000n);
  });
});

describe('ModeAController — send', () => {
  let provider: FakeProvider;
  let engine: FakeEngine;
  let controller: ModeAController;

  beforeEach(() => {
    provider = new FakeProvider();
    engine = new FakeEngine();
    controller = new ModeAController({
      provider,
      engine,
      network: 'regtest',
      dataDir: '/tmp/mode-a-unit',
    });
    void controller.start();
  });

  it('quotes before review and shows the fee — nothing dispatches', async () => {
    controller.setSendDestination('lnbcrt1-invoice');
    await controller.reviewSend(100);
    const s = controller.getState();
    expect(s.sendStatus).toBe('review');
    expect(s.sendFeeSat).toBe(30n);
    expect(provider.calls.quoteLightningCalls).toBe(1);
    expect(engine.submitted).toHaveLength(0);
  });

  it('refuses to quote an empty destination and surfaces the error', async () => {
    await controller.reviewSend(100);
    expect(controller.getState().sendStatus).toBe('failed');
    expect(controller.getState().sendError).toContain('invoice');
    expect(provider.calls.quoteLightningCalls).toBe(0);
  });

  it('requires an amount for on-chain sends', async () => {
    controller.setSendKind('onchain');
    controller.setSendDestination('bcrt1q-dest');
    await controller.reviewSend();
    expect(controller.getState().sendError).toContain('amount');

    controller.setSendAmount('not-a-number');
    await controller.reviewSend();
    expect(controller.getState().sendError).toContain('amount');

    controller.setSendAmount('21000');
    await controller.reviewSend();
    expect(controller.getState().sendStatus).toBe('review');
    expect(provider.calls.quoteOnchainCalls).toBe(1);
  });

  it('surfaces a fee-budget rejection from the quote as a send error', async () => {
    provider.quoteThrows = new WavelengthError('fee above budget', 'wavelength_error');
    controller.setSendDestination('lnbcrt1-invoice');
    await controller.reviewSend(10);
    expect(controller.getState().sendStatus).toBe('failed');
    expect(controller.getState().sendError).toContain('budget');
  });

  it('settles a confirmed send and refreshes balances', async () => {
    controller.setSendDestination('lnbcrt1-invoice');
    await controller.reviewSend(100);
    await controller.confirmSend();
    expect(controller.getState().sendStatus).toBe('settled');
    expect(engine.submitted[0]?.kind).toBe('lightning-invoice');
    expect(engine.executed).toHaveLength(1);
    // The approved payload (with its stored quote) is what the engine got.
    expect(engine.submitted[0]?.payload).toHaveProperty('invoice', 'inv');
  });

  it('keeps an ambiguous outcome in-flight and reconciles — never re-dispatches', async () => {
    engine.executeOutcome = 'in-flight';
    controller.setSendDestination('lnbcrt1-invoice');
    await controller.reviewSend(100);
    await controller.confirmSend();
    expect(controller.getState().sendStatus).toBe('sending');
    expect(engine.executed).toHaveLength(1);

    // The swap settles off-thread; reconcile resolves it without a re-dispatch.
    engine.recoverReport = { reconciled: [engine.executed[0] ?? ''], needsRecovery: [] };
    await controller.reconcilePending();
    expect(controller.getState().sendStatus).toBe('settled');
    expect(engine.executed).toHaveLength(1);
  });

  it('routes a needs-recovery reconcile to an explicit double-pay warning', async () => {
    engine.executeOutcome = 'in-flight';
    controller.setSendDestination('lnbcrt1-invoice');
    await controller.reviewSend(100);
    await controller.confirmSend();
    engine.recoverReport = { reconciled: [], needsRecovery: [engine.executed[0] ?? ''] };
    await controller.reconcilePending();
    const s = controller.getState();
    expect(s.sendStatus).toBe('failed');
    expect(s.sendError).toContain('could pay twice');
  });

  it('sendAnother resets the draft and clears pending intent state', async () => {
    controller.setSendDestination('lnbcrt1-invoice');
    await controller.reviewSend(100);
    await controller.confirmSend();
    controller.sendAnother();
    const s = controller.getState();
    expect(s.sendStatus).toBe('idle');
    expect(s.sendDestination).toBe('');
    expect(s.screen).toBe('send');
  });
});

describe('ModeAController — receive', () => {
  let provider: FakeProvider;
  let controller: ModeAController;

  beforeEach(() => {
    provider = new FakeProvider();
    controller = new ModeAController({
      provider,
      engine: new FakeEngine(),
      network: 'regtest',
      dataDir: '/tmp/mode-a-unit',
    });
    void controller.start();
  });

  it('generates an on-chain boarding address', async () => {
    await controller.generateAddress();
    const s = controller.getState();
    expect(s.onchainAddress).toContain('bcrt1q');
    expect(s.invoice).toBeNull();
  });

  it('generates a swap-based Lightning invoice for a parsed amount', async () => {
    controller.setReceiveAmount('21000');
    await controller.generateInvoice();
    expect(controller.getState().invoice).toContain('invoice');
  });

  it('refuses invoice generation without a parseable amount', async () => {
    await expect(controller.generateInvoice()).rejects.toThrow('amount');
  });
});

describe('ModeAController — restore', () => {
  let provider: FakeProvider;
  let controller: ModeAController;

  beforeEach(() => {
    provider = new FakeProvider();
    controller = new ModeAController({
      provider,
      engine: new FakeEngine(),
      network: 'regtest',
      dataDir: '/tmp/mode-a-unit',
    });
  });

  it('refuses a phrase that is not 12 or 24 words before the daemon sees it', async () => {
    controller.setRestoreWords('alpha beta gamma');
    await controller.restore();
    const s = controller.getState();
    expect(s.restoreStatus).toBe('failed');
    expect(s.restoreRejection?.code).toBe('invalid-words');
    expect(provider.calls.createWallets).toHaveLength(0);
  });

  it('requires a device password', async () => {
    controller.setRestoreWords('w '.repeat(12).trim());
    await controller.restore();
    expect(controller.getState().restoreRejection?.code).toBe('invalid-words');
    expect(provider.calls.createWallets).toHaveLength(0);
  });

  it('restores with recoverState=true and reports the recovered counters', async () => {
    controller.setRestoreWords('w '.repeat(12).trim());
    controller.setRestorePassword('passphrase-1');
    await controller.restore();
    const s = controller.getState();
    expect(s.restoreStatus).toBe('restored');
    expect(s.restoreSummary).toEqual({ recoveredVTXOs: 3, recoveryRan: false });
    expect(provider.calls.createWallets[0]?.recoverState).toBe(true);
    expect(provider.calls.createWallets[0]?.mnemonic).toHaveLength(12);
  });

  it('maps a deadline miss to the batch-expired unilateral-exit fallback', async () => {
    provider.createWalletThrows = new WavelengthError(
      'restore missed the VTXO expiry deadline',
      'failed_precondition',
    );
    controller.setRestoreWords('w '.repeat(12).trim());
    controller.setRestorePassword('passphrase-1');
    await controller.restore();
    const s = controller.getState();
    expect(s.restoreStatus).toBe('failed');
    expect(s.restoreRejection?.code).toBe('batch-expired');
    expect(s.restoreRejection?.message).toContain('unilateral exit');
  });

  it('refuses a cross-provider phrase with an explicit explanation', async () => {
    provider.createWalletThrows = new CrossProviderRestoreError(
      'wavelength',
      'aezeed+scb',
      ['mnemonic-ark'],
    );
    controller.setRestoreWords('w '.repeat(24).trim());
    controller.setRestorePassword('passphrase-1');
    await controller.restore();
    const s = controller.getState();
    expect(s.restoreStatus).toBe('failed');
    expect(s.restoreRejection?.code).toBe('cross-provider-seed');
    expect(s.restoreRejection?.message).toContain('never shared');
  });
});

describe('ModeAController — VTXO summary derivation', () => {
  it('prioritizes at-risk over exiting over expiring over fresh', () => {
    expect(summarizeVtxos([vtxo('fresh'), vtxo('expiring')], true).state).toBe('expiring');
    expect(summarizeVtxos([vtxo('exiting'), vtxo('expiring')], true).state).toBe('exiting');
    expect(summarizeVtxos([vtxo('at-risk'), vtxo('exiting')], true).state).toBe('at-risk');
    expect(summarizeVtxos([vtxo('fresh')], true).state).toBe('fresh');
  });

  it('carries operator reachability and the earliest expiring deadline in hours', () => {
    const summary = summarizeVtxos([vtxo('expiring', { blocksToExpiry: 13 }), vtxo('fresh')], false);
    expect(summary.operatorReachable).toBe(false);
    expect(summary.hoursToExpiry).toBe(3); // ceil(13 / 6)
  });

  it('reports null hours when nothing is expiring', () => {
    expect(summarizeVtxos([vtxo('fresh')], true).hoursToExpiry).toBeNull();
  });
});

describe('parseSats', () => {
  it('accepts plain positive integers and trims whitespace', () => {
    expect(parseSats('21000')).toBe(21000);
    expect(parseSats(' 42 ')).toBe(42);
  });
  it('rejects empty, non-numeric, zero, and unsafe values', () => {
    expect(parseSats('')).toBeUndefined();
    expect(parseSats('1.5')).toBeUndefined();
    expect(parseSats('12abc')).toBeUndefined();
    expect(parseSats('0')).toBeUndefined();
    expect(parseSats('-5')).toBeUndefined();
    expect(parseSats('9'.repeat(16))).toBeUndefined();
  });
});
