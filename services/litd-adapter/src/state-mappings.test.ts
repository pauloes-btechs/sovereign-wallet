import { describe, expect, it } from 'vitest';

import {
  buildCloseChannelRequest,
  buildOpenChannelRequest,
  buildRestoreChanBackupRequest,
  buildSendCoinsRequest,
  buildSendPaymentRequest,
  mapChannelBalance,
  mapClosedChannel,
  mapNodeInfo,
  mapOpenChannel,
  mapPayReq,
  mapPendingChannel,
  mapWalletBalance,
  multiChanBackupHex,
  openChannelDisplayState,
  parseChannelPoint,
  pendingChannelDisplayState,
  RequestValidationError,
  walletPhaseFromInfoError,
  walletPhaseFromMacaroonCallError,
  walletPhaseFromUnlockCanaryError,
} from './state-mappings.js';

const throwsValidation = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    // Only the validation error counts — any other throw is a bug.
    if (err instanceof RequestValidationError) {
      return err;
    }
    throw err;
  }
  throw new Error('expected RequestValidationError, but nothing was thrown');
};

describe('wallet phase classification', () => {
  it('locked from the info error when the service answers with the unlock refusal', () => {
    expect(walletPhaseFromInfoError('2 UNKNOWN: wallet locked, unlock it via `lncli unlock` or the UnlockWallet gRPC')).toBe('locked');
    expect(walletPhaseFromInfoError('wallet locked')).toBe('locked');
  });

  it('undetermined from transport/startup noise — never a guessed phase', () => {
    expect(walletPhaseFromInfoError('14 UNAVAILABLE: Connections dropping')).toBe('undetermined');
    expect(walletPhaseFromInfoError('waiting to start, RPC services not available')).toBe('undetermined');
    expect(walletPhaseFromInfoError('12 UNIMPLEMENTED: unknown service lnrpc.Lightning')).toBe('undetermined');
  });

  it('missing from the unlock canary wallet-not-initialized error', () => {
    expect(walletPhaseFromUnlockCanaryError('1 UNKNOWN: wallet not initialized')).toBe('missing');
    expect(walletPhaseFromUnlockCanaryError('unable to locate wallet')).toBe('missing');
  });

  it('locked from the unlock canary wrong-passphrase errors', () => {
    expect(walletPhaseFromUnlockCanaryError('invalid passphrase: checksum mismatch')).toBe('locked');
    expect(walletPhaseFromUnlockCanaryError('2 UNKNOWN: wrong password')).toBe('locked');
  });

  it('ready from the unlock canary already-unlocked error (wallet is up)', () => {
    expect(walletPhaseFromUnlockCanaryError('wallet already unlocked, UnlockWallet RPC no longer available')).toBe('ready');
    expect(walletPhaseFromUnlockCanaryError('12 UNIMPLEMENTED: unknown service lnrpc.WalletUnlocker')).toBe('ready');
  });

  it('undetermined from canary noise — unknown must not invent a phase', () => {
    expect(walletPhaseFromUnlockCanaryError('14 UNAVAILABLE: socket hang up')).toBe('undetermined');
  });

  it('macaroon-call errors reclassify only the locked phase', () => {
    expect(walletPhaseFromMacaroonCallError('wallet locked')).toBe('locked');
    expect(walletPhaseFromMacaroonCallError('14 UNAVAILABLE: transient')).toBe('undetermined');
  });
});

describe('node health mapping', () => {
  it('maps the GetInfo surface the dashboards render', () => {
    const view = mapNodeInfo({
      identityPubkey: 'pub-1',
      alias: 'my node',
      version: '0.21.5-beta.rc1',
      syncedToChain: true,
      syncedToGraph: false,
      blockHeight: 2641,
      numPeers: 2,
      numActiveChannels: 1,
      numPendingChannels: 2,
      numInactiveChannels: 3,
      uris: ['pub-1@127.0.0.1:9735'],
      chains: [{ chain: 'bitcoin', network: 'regtest' }],
    } as never);
    expect(view.alias).toBe('my node');
    expect(view.syncedToChain).toBe(true);
    expect(view.blockHeight).toBe(2641);
    expect(view.chains[0]?.network).toBe('regtest');
    expect(view.uris).toEqual(['pub-1@127.0.0.1:9735']);
  });
});

describe('balance mappings', () => {
  it('treats absent amount sub-messages as zero, never undefined math', () => {
    const view = mapChannelBalance({
      balance: 0n,
      pendingOpenBalance: 0n,
      localBalance: { sat: 12n, msat: 12_000n },
      remoteBalance: undefined,
      unsettledLocalBalance: undefined,
      unsettledRemoteBalance: undefined,
      pendingOpenLocalBalance: { sat: 5n, msat: 5_000n },
      pendingOpenRemoteBalance: undefined,
      customChannelData: new Uint8Array(),
    } as never);
    expect(view.localSat).toBe(12n);
    expect(view.remoteSat).toBe(0n);
    expect(view.pendingOpenLocalSat).toBe(5n);
    expect(view.pendingOpenRemoteSat).toBe(0n);
  });

  it('wallet balance maps every lock/limbo bucket the UI shows', () => {
    const view = mapWalletBalance({
      totalBalance: 100n,
      confirmedBalance: 90n,
      unconfirmedBalance: 10n,
      lockedBalance: 3n,
      reservedBalanceAnchorChan: 1n,
      accountBalance: {},
    } as never);
    expect(view.totalSat).toBe(100n);
    expect(view.lockedSat).toBe(3n);
    expect(view.reservedAnchorSat).toBe(1n);
  });
});

describe('channel display states', () => {
  it('open channels split into active and inactive by the daemon flag', () => {
    expect(openChannelDisplayState({ active: true } as never)).toBe('open');
    expect(openChannelDisplayState({ active: false } as never)).toBe('open-inactive');
  });

  it('every pending list maps to its own visual state — none collapse together', () => {
    expect(pendingChannelDisplayState('pending-open')).toBe('opening');
    expect(pendingChannelDisplayState('pending-closing')).toBe('closing');
    expect(pendingChannelDisplayState('pending-force-closing')).toBe('closing-force');
    expect(pendingChannelDisplayState('waiting-close')).toBe('waiting-close');
  });

  it('open channel row exposes balances and initiator', () => {
    const row = mapOpenChannel({
      active: true,
      remotePubkey: 'peer',
      channelPoint: 'aa:1',
      chanId: '777:1:1',
      capacity: 100_000n,
      localBalance: 60_000n,
      remoteBalance: 40_000n,
      initiator: true,
    } as never);
    expect(row.state).toBe('open');
    expect(row.initiatorLabel).toBe('opened by you');
    expect(row.capacitySat).toBe(100_000n);
  });

  it('pending rows carry limbo/funding context in the initiator label', () => {
    const opening = mapPendingChannel('pending-open', {
      channel: {
        channelPoint: 'bb:0',
        remoteNodePub: 'peer',
        capacity: 500n,
        localBalance: 500n,
      } as never,
    });
    expect(opening.state).toBe('opening');
    expect(opening.initiatorLabel).toBe('confirming funding transaction');

    const waiting = mapPendingChannel('waiting-close', { limboBalance: 420n });
    expect(waiting.state).toBe('waiting-close');
    expect(waiting.initiatorLabel).toContain('420');
  });
});

describe('closed channel mapping', () => {
  it('labels each closure type distinctly', () => {
    expect(mapClosedChannel({ closeType: 0 } as never).closeType).toBe('cooperative close');
    expect(mapClosedChannel({ closeType: 1 } as never).closeType).toBe('force close (you)');
    expect(mapClosedChannel({ closeType: 2 } as never).closeType).toBe('force close (peer)');
    expect(mapClosedChannel({ closeType: 3 } as never).closeType).toBe('breach close');
  });

  it('carries settled and time-locked balances', () => {
    const view = mapClosedChannel({
      channelPoint: 'cc:0',
      chanId: '9:1:1',
      remotePubkey: 'peer',
      closingTxHash: 'deadbeef',
      closeHeight: 3000,
      settledBalance: 11n,
      timeLockedBalance: 22n,
      closeType: 0,
    } as never);
    expect(view.settledBalanceSat).toBe(11n);
    expect(view.timeLockedBalanceSat).toBe(22n);
    expect(view.closingTxHash).toBe('deadbeef');
  });
});

describe('on-chain request builders', () => {
  it('send-coins accepts a fixed amount and fee, defaulting to confirmed inputs', () => {
    const req = buildSendCoinsRequest({ address: 'bcrt1qxyz', amountSat: 5000n, satPerVbyte: 4 });
    expect(req.addr).toBe('bcrt1qxyz');
    expect(req.amount).toBe(5000n);
    expect(req.satPerVbyte).toBe(4n);
    expect(req.sendAll).toBe(false);
    expect(req.spendUnconfirmed).toBe(false);
  });

  it('send-all requires the explicit amount to be absent', () => {
    expect(() => buildSendCoinsRequest({ address: 'a', sendAll: true, amountSat: 1n, satPerVbyte: 1 })).toThrow(RequestValidationError);
    const req = buildSendCoinsRequest({ address: 'a', sendAll: true, satPerVbyte: 2 });
    expect(req.sendAll).toBe(true);
    expect(req.amount).toBe(0n);
  });

  it('send-coins rejects zero amounts and non-integer fees', () => {
    expect(throwsValidation(() => buildSendCoinsRequest({ address: 'a', amountSat: 0n, satPerVbyte: 1 })).message).toMatch(/positive whole/);
    expect(throwsValidation(() => buildSendCoinsRequest({ address: 'a', amountSat: 5n, satPerVbyte: 0 })).message).toMatch(/whole number/);
    expect(throwsValidation(() => buildSendCoinsRequest({ address: '  ', amountSat: 5n, satPerVbyte: 1 })).message).toMatch(/address/);
  });

  it('open-channel validates the 33-byte pubkey and funding amount', () => {
    expect(() => buildOpenChannelRequest({ nodePubkeyHex: 'aabb', localFundingSat: 1n, satPerVbyte: 1 })).toThrow(RequestValidationError);
    expect(() => buildOpenChannelRequest({ nodePubkeyHex: 'a'.repeat(66), localFundingSat: 0n, satPerVbyte: 1 })).toThrow(RequestValidationError);
    const req = buildOpenChannelRequest({ nodePubkeyHex: 'AB'.repeat(33), localFundingSat: 500_000n, satPerVbyte: 3 });
    expect(Array.from(req.nodePubkey)).toEqual(Array.from(Buffer.from('AB'.repeat(33), 'hex')));
    expect(req.localFundingAmount).toBe(500_000n);
    expect(req.satPerVbyte).toBe(3n);
    expect(req.minConfs).toBe(1);
  });

  it('channel points parse strictly and close requests carry the fundingTxidStr oneof', () => {
    const parsed = parseChannelPoint('0123456789abcdef'.repeat(8).slice(0, 64) + ':3');
    expect(parsed.outputIndex).toBe(3);
    expect(throwsValidation(() => parseChannelPoint('not-a-point')).message).toMatch(/channel point/);
    expect(throwsValidation(() => parseChannelPoint(`${'a'.repeat(63)}:0`)).message).toMatch(/channel point/);

    const req = buildCloseChannelRequest({ channelPoint: `${'ab'.repeat(32)}:0`, force: false });
    expect(req.channelPoint).toMatchObject({ fundingTxid: { oneofKind: 'fundingTxidStr' }, outputIndex: 0 });
    expect(req.force).toBe(false);
    expect(() => buildCloseChannelRequest({ channelPoint: 'x:0', satPerVbyte: 0 })).toThrow(RequestValidationError);
  });
});

describe('lightning payment builders', () => {
  it('builds the SendPaymentV2 request with fee-limit settings', () => {
    const fixed = buildSendPaymentRequest({ paymentRequest: 'lnbcrt1xyz', feeLimitSat: 30n, cltvLimit: 100 });
    expect(fixed.paymentRequest).toBe('lnbcrt1xyz');
    expect(fixed.feeLimitSat).toBe(30n);
    expect(fixed.feeLimitMsat).toBe(0n);
    expect(fixed.cltvLimit).toBe(100);
    const pct = buildSendPaymentRequest({ paymentRequest: 'lnbcrt1xyz', feeLimitPercent: 5, invoiceAmountSat: 1000n });
    expect(pct.feeLimitSat).toBe(50n); // 5% of the decoded 1 000-sat invoice
    const pctCeil = buildSendPaymentRequest({ paymentRequest: 'lnbcrt1xyz', feeLimitPercent: 5, invoiceAmountSat: 10n });
    expect(pctCeil.feeLimitSat).toBe(1n); // ceilinged to ≥1 sat
  });

  it('rejects mixed fee-limit forms and bad inputs', () => {
    expect(() => buildSendPaymentRequest({ paymentRequest: 'x', feeLimitSat: 1n, feeLimitPercent: 2 })).toThrow(RequestValidationError);
    expect(() => buildSendPaymentRequest({ paymentRequest: 'not-bolt11' })).toThrow(RequestValidationError);
    expect(() => buildSendPaymentRequest({ paymentRequest: 'lnbcrt1x', amountSat: -1n })).toThrow(RequestValidationError);
    expect(() => buildSendPaymentRequest({ paymentRequest: 'lnbcrt1x', feeLimitPercent: 0 })).toThrow(RequestValidationError);
    // A percentage limit without a decoded amount cannot be enforced — refuse it.
    expect(() => buildSendPaymentRequest({ paymentRequest: 'lnbcrt1x', feeLimitPercent: 2 })).toThrow(RequestValidationError);
  });

  it('trims the bolt11 string', () => {
    const req = buildSendPaymentRequest({ paymentRequest: '  lnbcrt1x  ' });
    expect(req.paymentRequest).toBe('lnbcrt1x');
  });
});

describe('invoice decode mapping', () => {
  it('surfaces the review fields the pay screen shows', () => {
    const view = mapPayReq({
      destination: 'pubkey-1',
      paymentHash: 'hash-1',
      numSatoshis: 210n,
      description: 'coffee',
      cltvExpiry: 80n,
    } as never);
    expect(view).toEqual({
      paymentHashHex: 'hash-1',
      amountSat: 210n,
      memo: 'coffee',
      destination: 'pubkey-1',
      cltvExpiry: 80n,
    });
  });
});

describe('SCB round-trip', () => {
  it('extracts the multi-channel blob as hex and refuses empty backups', () => {
    const blob = multiChanBackupHex({ multiChanBackup: { chanPoints: [], multiChanBackup: new Uint8Array([1, 2, 3]) } } as never);
    expect(blob).toBe(Buffer.from([1, 2, 3]).toString('hex'));
    expect(() => multiChanBackupHex({} as never)).toThrow(RequestValidationError);
    expect(() => multiChanBackupHex({ multiChanBackup: { chanPoints: [], multiChanBackup: new Uint8Array() } } as never)).toThrow(RequestValidationError);
  });

  it('rebuilds a restore request from saved hex', () => {
    const hexBlob = 'deadbeef'.repeat(8); // 64 chars — a realistic SCB blob length
    const req = buildRestoreChanBackupRequest(hexBlob);
    expect(req.backup.oneofKind).toBe('multiChanBackup');
    expect(Array.from((req.backup as { multiChanBackup: Uint8Array }).multiChanBackup)).toEqual(
      Array.from(Buffer.from(hexBlob, 'hex')),
    );
    expect(() => buildRestoreChanBackupRequest('zzzz')).toThrow(RequestValidationError);
    expect(() => buildRestoreChanBackupRequest('ab')).toThrow(RequestValidationError); // too short
  });
});
