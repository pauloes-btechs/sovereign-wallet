/**
 * Unit tests for the Mode B remote-node controller — faked LNC port, precise
 * transition coverage. The REAL LNC transport (10-word pairing, PAKE+Noise,
 * macaroon scoping, revocation, money flow) is proven by the regtest
 * integration suite in services/litd-adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchOutcome } from '@sovereign/payments';
import type { LncRpcPort, RemoteBalances, RemoteNodeInfo } from './modeBRemoteController.js';
import {
  DESKTOP_ONLY_DISCLOSURE,
  LIVENESS_REQUIRED_OPS,
  ModeBRemoteController,
  ModeBRemoteError,
  isDesktopOnly,
  parseSats,
  sha256Hex,
  validatePairingPhrase,
} from './modeBRemoteController.js';

const nodeInfo = (): RemoteNodeInfo => ({
  identityPubkey: '02' + 'a'.repeat(62),
  alias: 'home-node',
  version: '0.17.8-commit',
  network: 'regtest',
  blockHeight: 900,
});

const balances = (): RemoteBalances => ({
  lightningSpendableSat: 1_500_000n,
  onchainConfirmedSat: 21_000_000n,
  channels: [
    {
      chanId: '227:1:0',
      active: true,
      localSat: 1_500_000n,
      remoteSat: 500_000n,
      capacitySat: 2_000_000n,
    },
  ],
});

/** Minimal conforming fake of the LNC port. */
function makePort(): LncRpcPort & {
  listeners: Array<(event: { type: string }) => void>;
  payCalls: Array<{ bolt11: string; timeoutSeconds: number }>;
  emit: (event: { type: string }) => void;
  settledOutcome: DispatchOutcome;
} {
  const listeners: Array<(event: { type: string }) => void> = [];
  const payCalls: Array<{ bolt11: string; timeoutSeconds: number }> = [];
  let connected = false;
  const port = {
    listeners,
    payCalls,
    settledOutcome: { status: 'settled', backendRef: 'preimage-1' } as DispatchOutcome,
    emit: (event: { type: string }) => {
      for (const l of [...listeners]) l(event);
    },
    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    isConnected: () => connected,
    onConnectionEvent(listener: (event: { type: string }) => void) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async getInfo() {
      return nodeInfo();
    },
    async getBalances() {
      return balances();
    },
    async addInvoice({ valueSat }: { valueSat: bigint }) {
      return { bolt11: `lnbcrt${valueSat}test` };
    },
    async payInvoice(request: { bolt11: string; timeoutSeconds: number }) {
      payCalls.push(request);
      return { outcome: port.settledOutcome };
    },
    async lookupPayment() {
      return { status: 'unknown' as const };
    },
  };
  return port as unknown as LncRpcPort & typeof port;
}

const TEN_WORDS = 'abstract acid acrobat actor actual admit adopt adore advance adventure';

describe('pairing phrase validation', () => {
  it('accepts exactly 10 words', () => {
    expect(validatePairingPhrase(TEN_WORDS)).toBe('ok');
  });

  it('rejects 9 and 11 words', () => {
    expect(validatePairingPhrase(TEN_WORDS.split(' ').slice(0, 9).join(' '))).toBe(
      'wrong-word-count',
    );
    expect(validatePairingPhrase(`${TEN_WORDS} extra`)).toBe('wrong-word-count');
  });

  it('collapses extra whitespace before counting', () => {
    expect(validatePairingPhrase(`  ${TEN_WORDS.split(' ').join('   ')}  `)).toBe('ok');
  });
});

describe('liveness-required operations are desktop-only on mobile', () => {
  it('labels channel safety ops desktop-only', () => {
    for (const op of LIVENESS_REQUIRED_OPS) {
      expect(isDesktopOnly(op)).toBe(true);
    }
  });

  it('keeps payments and invoices mobile-allowed', () => {
    expect(isDesktopOnly('pay-invoice')).toBe(false);
    expect(isDesktopOnly('add-invoice')).toBe(false);
  });

  it('carries a disclosure string for the UI', () => {
    expect(DESKTOP_ONLY_DISCLOSURE.length).toBeGreaterThan(20);
  });
});

describe('sha256Hex', () => {
  it('matches the known empty-string vector', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the known "abc" vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('parseSats', () => {
  it('parses positive integers and rejects junk and zero', () => {
    expect(parseSats('1200')).toBe(1200n);
    expect(parseSats(' 42 ')).toBe(42n);
    expect(parseSats('')).toBeNull();
    expect(parseSats('0')).toBeNull();
    expect(parseSats('abc')).toBeNull();
    expect(parseSats('-5')).toBeNull();
  });
});

describe('ModeBRemoteController pairing', () => {
  let port: ReturnType<typeof makePort>;
  let controller: ModeBRemoteController;

  beforeEach(() => {
    port = makePort();
    controller = new ModeBRemoteController({ port, network: 'regtest' });
  });

  afterEach(() => {
    controller.stop();
  });

  it('refuses to pair without a valid 10-word phrase', async () => {
    controller.enterPairingPhrase('only three words');
    await expect(controller.pair()).rejects.toBeInstanceOf(ModeBRemoteError);
    expect(port.isConnected()).toBe(false);
    expect(controller.getState().screen).toBe('pairing');
  });

  it('pairs with 10 words, clears the phrase, and renders live node data', async () => {
    controller.enterPairingPhrase(TEN_WORDS);
    await controller.pair();
    const state = controller.getState();
    expect(state.screen).toBe('home');
    expect(state.phraseText).toBe('');
    expect(state.node?.alias).toBe('home-node');
    expect(state.balances?.lightningSpendableSat).toBe(1_500_000n);
  });

  it('returns to the pairing screen with the error on a failed handshake', async () => {
    controller.enterPairingPhrase(TEN_WORDS);
    vi.spyOn(port, 'connect').mockRejectedValueOnce(new Error('mailbox unreachable'));
    await expect(controller.pair()).rejects.toThrow('mailbox unreachable');
    const state = controller.getState();
    expect(state.screen).toBe('pairing');
    expect(state.connectError).toBe('mailbox unreachable');
  });
});

describe('ModeBRemoteController payments', () => {
  let port: ReturnType<typeof makePort>;
  let controller: ModeBRemoteController;

  beforeEach(async () => {
    port = makePort();
    controller = new ModeBRemoteController({ port, network: 'regtest' });
    controller.enterPairingPhrase(TEN_WORDS);
    await controller.pair();
    controller.setForegrounded(true);
  });

  afterEach(() => {
    controller.stop();
  });

  it('refuses background payments BEFORE authorizing or dispatching anything', async () => {
    controller.setForegrounded(false);
    controller.editSendDestination('lnbcrt1m1abc');
    await expect(controller.send()).rejects.toMatchObject({ code: 'backgrounded' });
    expect(port.payCalls).toHaveLength(0);
    expect(controller.getState().sendStatus).toBe('failed');
  });

  it('dispatches exactly once and settles on a successful payment', async () => {
    controller.editSendDestination('lnbcrt1m1abc');
    await controller.send();
    expect(port.payCalls).toHaveLength(1);
    expect(port.payCalls[0]?.bolt11).toBe('lnbcrt1m1abc');
    const state = controller.getState();
    expect(state.sendStatus).toBe('settled');
    expect(state.sendBolt11Text).toBe('');
  });

  it('reports failure without a retry when the backend fails definitively', async () => {
    port.settledOutcome = { status: 'definitive-failure', reason: 'invoice already paid' };
    controller.editSendDestination('lnbcrt1m1abc');
    await controller.send();
    expect(port.payCalls).toHaveLength(1);
    expect(controller.getState().sendStatus).toBe('failed');
    // The engine's intent carries no reason; the dispatcher keeps the node's
    // reason per intent so the screen can explain it.
    expect(controller.getState().sendError).toBe('Payment failed: invoice already paid');
  });

  it('surfaces needs-recovery instead of re-dispatching on an ambiguous outcome', async () => {
    port.settledOutcome = { status: 'timeout' };
    controller.editSendDestination('lnbcrt1m1abc');
    await controller.send();
    expect(port.payCalls).toHaveLength(1); // never blind-retried
    // Not "failed": the node may still complete it. The state says so and
    // offers a status check, never a resend.
    expect(controller.getState().sendStatus).toBe('in-flight');
    expect(controller.getState().sendError).toContain('could pay twice');

    // Checking status looks the payment up (the port answers unknown) and
    // still never dispatches again.
    await controller.checkPaymentStatus();
    expect(port.payCalls).toHaveLength(1);
    expect(controller.getState().sendStatus).toBe('in-flight');
  });
});

describe('ModeBRemoteController receive + revocation', () => {
  let port: ReturnType<typeof makePort>;
  let controller: ModeBRemoteController;

  beforeEach(async () => {
    port = makePort();
    controller = new ModeBRemoteController({ port, network: 'regtest' });
    controller.enterPairingPhrase(TEN_WORDS);
    await controller.pair();
  });

  afterEach(() => {
    controller.stop();
  });

  it('creates a receive invoice from the amount draft', async () => {
    controller.editInvoiceAmount('1200');
    await controller.createInvoice();
    expect(controller.getState().invoice).toBe('lnbcrt1200test');
  });

  it('ignores empty or invalid invoice amounts without calling the port', async () => {
    const addSpy = vi.spyOn(port, 'addInvoice');
    controller.editInvoiceAmount('');
    await controller.createInvoice();
    controller.editInvoiceAmount('abc');
    await controller.createInvoice();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('says what is missing for an invalid amount and surfaces a node error', async () => {
    controller.editInvoiceAmount('abc');
    await controller.createInvoice();
    expect(controller.getState().invoiceError).toMatch(/whole number of sats/);
    controller.editInvoiceAmount('1200');
    expect(controller.getState().invoiceError).toBeNull();

    vi.spyOn(port, 'addInvoice').mockRejectedValueOnce(new Error('permission denied: invoices:write'));
    await expect(controller.createInvoice()).rejects.toThrow('permission denied');
    expect(controller.getState().invoiceError).toBe('permission denied: invoices:write');
  });

  it('moves to the revoked screen when the port reports a revoked session', async () => {
    const disconnectSpy = vi.spyOn(port, 'disconnect');
    port.emit({ type: 'revoked' });
    // handleRevoked is async — let the microtasks settle
    await vi.waitFor(() => {
      expect(controller.getState().screen).toBe('revoked');
    });
    expect(disconnectSpy).toHaveBeenCalled();
    expect(controller.getState().node).toBeNull();
  });

  it('refuses session revocation when the port cannot revoke', async () => {
    await expect(controller.revokeCurrentSession('03abc')).rejects.toMatchObject({
      code: 'session-permission-denied',
    });
  });

  it('revokes the current session and lands on the revoked screen', async () => {
    port.revokeSession = vi.fn(async () => undefined);
    await controller.revokeCurrentSession('03abc');
    expect(port.revokeSession).toHaveBeenCalledWith('03abc');
    expect(controller.getState().screen).toBe('revoked');
  });
});

describe('ModeBRemoteController tabs, activity and capabilities', () => {
  let port: ReturnType<typeof makePort>;
  let controller: ModeBRemoteController;

  beforeEach(async () => {
    port = makePort();
    controller = new ModeBRemoteController({ port, network: 'regtest', pollIntervalMs: 600_000 });
    controller.enterPairingPhrase(TEN_WORDS);
    await controller.pair();
  });

  afterEach(() => {
    controller.stop();
  });

  it('pairing opens the five-tab navigation on Home; revocation leaves it', async () => {
    expect(controller.getState().nav?.tab).toBe('home');
    controller.selectTab('wallet');
    expect(controller.getState().screen).toBe('wallet');
    controller.selectTab('send');
    expect(controller.getState().screen).toBe('send');
    expect(controller.goBack()).toBe(true); // tab root → Home
    expect(controller.getState().screen).toBe('home');
    expect(controller.goBack()).toBe(false);

    port.emit({ type: 'revoked' });
    await vi.waitFor(() => expect(controller.getState().screen).toBe('revoked'));
    expect(controller.getState().nav).toBeNull();
  });

  it('a port without listLightningActivity reports activity as unavailable, not empty', async () => {
    controller.selectTab('activity');
    await vi.waitFor(() => expect(controller.getState().activityStatus).toBe('unavailable'));
    expect(controller.getState().activity).toBeNull();
    const caps = controller.walletCapabilities();
    expect(caps.features.activity.available).toBe(false);
  });

  it('reads Lightning activity from the port when it implements the method', async () => {
    const records = [
      {
        paymentHash: 'ab'.repeat(32),
        direction: 'out' as const,
        amountSat: 1_000n,
        feeSat: 1n,
        status: 'settled' as const,
        createdAt: '2026-11-05T10:00:00.000Z',
        memo: null,
        paymentRequest: 'lnbcrt10u1x',
      },
    ];
    const requests: number[] = [];
    const withActivity = Object.assign(port, {
      async listLightningActivity(request: { maxItems: number }) {
        requests.push(request.maxItems);
        return records;
      },
    });
    const c = new ModeBRemoteController({ port: withActivity, network: 'regtest', pollIntervalMs: 600_000 });
    c.enterPairingPhrase(TEN_WORDS);
    await c.pair();
    expect(c.walletCapabilities().features.activity.available).toBe(true);
    c.selectTab('activity');
    await vi.waitFor(() => expect(c.getState().activityStatus).toBe('loaded'));
    expect(c.getState().activity).toEqual(records);
    expect(requests).toEqual([100]);
    c.stop();
  });

  it('an activity read failure is shown as a failure', async () => {
    const failing = Object.assign(port, {
      async listLightningActivity(): Promise<never> {
        throw new Error('permission denied: offchain read');
      },
    });
    const c = new ModeBRemoteController({ port: failing, network: 'regtest', pollIntervalMs: 600_000 });
    c.enterPairingPhrase(TEN_WORDS);
    await c.pair();
    await c.loadActivity();
    expect(c.getState().activityStatus).toBe('failed');
    expect(c.getState().activityError).toMatch(/permission denied/);
    c.stop();
  });

  it('capabilities never claim on-chain or fee quotes over LNC, and track the foreground rule', () => {
    const caps = controller.walletCapabilities();
    expect(caps.backend).toBe('remote-lnd');
    expect(caps.features.onchainSend.available).toBe(false);
    expect(caps.features.sendFeeQuote.available).toBe(false);
    expect(caps.features.lightningSend.available).toBe(true);
    expect(caps.features.sessionRevoke.available).toBe(false); // fake port has no revokeSession
    controller.setForegrounded(false);
    expect(controller.walletCapabilities().features.lightningSend.available).toBe(false);
  });
});
