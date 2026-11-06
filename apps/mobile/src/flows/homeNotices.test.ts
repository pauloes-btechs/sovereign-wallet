import { describe, expect, it } from 'vitest';
import type { BalanceBuckets } from '@sovereign/wallet-core';
import { remoteActivityItems, wavelengthActivityItems } from './activity.js';
import { remoteBalanceView, wavelengthBalanceView } from './homeBalances.js';
import { remoteNotices, wavelengthNotices } from './notifications.js';
import type { WavelengthNoticeInput } from './notifications.js';
import type { RemoteBalances } from './modeBRemoteController.js';

const buckets = (overrides: Partial<BalanceBuckets> = {}): BalanceBuckets => ({
  onchainConfirmedSat: 0n,
  onchainPendingSat: 0n,
  lightningSpendableSat: 150_000n,
  lightningPendingSat: 0n,
  lockedOrExpiringSat: 50_000n,
  ...overrides,
});

const remoteBalances = (overrides: Partial<RemoteBalances> = {}): RemoteBalances => ({
  lightningSpendableSat: 420_000n,
  onchainConfirmedSat: 1_250_000n,
  channels: [{ chanId: 'c1', active: true, localSat: 420_000n, remoteSat: 580_000n, capacitySat: 1_000_000n }],
  ...overrides,
});

describe('wavelengthBalanceView', () => {
  it('sums disjoint buckets once and tags each line', () => {
    const view = wavelengthBalanceView(buckets({ onchainPendingSat: 5_000n }), true);
    expect(view.totalSat).toBe(205_000n);
    expect(view.lines.reduce((sum, l) => sum + l.sats, 0n)).toBe(view.totalSat);
    expect(view.lines.map((l) => [l.label, l.state])).toEqual([
      ['Lightning (spendable)', 'spendable'],
      ['On-chain (confirmed)', 'spendable'],
      ['On-chain (unconfirmed)', 'pending'],
      ['Locked / expiring', 'locked'],
    ]);
    expect(view.receiveCapacitySat).toBeNull();
  });

  it('marks off-chain funds unavailable while the operator is unreachable', () => {
    const view = wavelengthBalanceView(buckets(), false);
    expect(view.lines[0]?.state).toBe('unavailable');
    expect(view.lines[0]?.note).toMatch(/operator is unreachable/);
  });
});

describe('remoteBalanceView', () => {
  it('totals Lightning + on-chain and keeps receiving capacity apart', () => {
    const view = remoteBalanceView(remoteBalances());
    expect(view.totalSat).toBe(1_670_000n);
    expect(view.receiveCapacitySat).toBe(580_000n);
    expect(view.lines.map((l) => l.key)).toEqual(['lightning', 'onchain']);
  });

  it('splits inactive channel balance into unavailable only when the node figures reconcile', () => {
    const channels = [
      { chanId: 'a', active: true, localSat: 100_000n, remoteSat: 10n, capacitySat: 100_010n },
      { chanId: 'b', active: false, localSat: 40_000n, remoteSat: 900n, capacitySat: 40_900n },
    ];
    const view = remoteBalanceView(remoteBalances({ lightningSpendableSat: 140_000n, channels }));
    expect(view.lines.map((l) => [l.key, l.sats, l.state])).toEqual([
      ['lightning', 100_000n, 'spendable'],
      ['lightning-inactive', 40_000n, 'unavailable'],
      ['onchain', 1_250_000n, 'spendable'],
    ]);
    expect(view.receiveCapacitySat).toBe(10n); // active channels only
    // Figures that do not reconcile are shown as the node reported them.
    const unreconciled = remoteBalanceView(remoteBalances({ lightningSpendableSat: 150_000n, channels }));
    expect(unreconciled.lines.map((l) => l.key)).toEqual(['lightning', 'onchain']);
  });
});

const base: WavelengthNoticeInput = {
  vtxo: { state: 'fresh', operatorReachable: true, hoursToExpiry: null },
  balances: buckets(),
  balancesError: null,
  paymentInFlight: false,
  activity: [],
  unilateralExit: 'async',
};

describe('wavelengthNotices', () => {
  it('is quiet for a healthy funded wallet', () => {
    expect(wavelengthNotices(base)).toEqual([]);
  });

  it('raises lifecycle, operator and in-flight notices from state, most severe first', () => {
    const notices = wavelengthNotices({
      ...base,
      vtxo: { state: 'expiring', operatorReachable: false, hoursToExpiry: 3 },
      paymentInFlight: true,
    });
    expect(notices.map((n) => [n.id, n.action.target.kind])).toEqual([
      ['operator-unreachable', 'refresh'],
      ['vtxo-expiring', 'exit-information'],
      ['payment-in-flight', 'tab'],
    ]);
    expect(notices[1]?.body).toMatch(/about 3 hours/);
  });

  it('links the newest failed item and pending items into Activity', () => {
    const activity = wavelengthActivityItems(
      [
        { txId: 'f', providerId: 'wavelength', direction: 'out', kind: 'lightning-invoice', amountSat: 1n, status: 'failed', at: '2026-11-05T10:00:00Z' },
        { txId: 'p', providerId: 'wavelength', direction: 'in', kind: 'onchain', amountSat: 1n, status: 'pending', at: '2026-11-04T10:00:00Z' },
      ],
      null,
    );
    const notices = wavelengthNotices({ ...base, activity });
    expect(notices.map((n) => n.action.target)).toEqual([
      { kind: 'transaction', id: 'wl:f' },
      { kind: 'activity', status: 'pending' },
    ]);
  });

  it('offers Receive for an empty wallet, and says nothing is spendable when funds are locked', () => {
    expect(wavelengthNotices({ ...base, balances: buckets({ lightningSpendableSat: 0n, lockedOrExpiringSat: 0n }) })[0]?.id).toBe('no-funds');
    expect(wavelengthNotices({ ...base, balances: buckets({ lightningSpendableSat: 0n }) })[0]?.id).toBe('nothing-spendable');
    // Unknown activity (read failed) → no funding advice that might be wrong.
    expect(wavelengthNotices({ ...base, activity: null, balances: buckets({ lightningSpendableSat: 0n, lockedOrExpiringSat: 0n }) })).toEqual([]);
  });

  it('shows an unreadable-balances notice only when there is nothing to show instead', () => {
    expect(wavelengthNotices({ ...base, balances: null, balancesError: 'daemon down' })[0]).toMatchObject({
      id: 'balances-unreadable',
      body: 'daemon down',
    });
  });
});

describe('remoteNotices', () => {
  const remoteBase = { connected: true, balances: remoteBalances(), paymentInFlight: false, activity: [] };

  it('is quiet for a connected node with balance both ways', () => {
    expect(remoteNotices(remoteBase)).toEqual([]);
  });

  it('asks to pair again when disconnected', () => {
    expect(remoteNotices({ ...remoteBase, connected: false })[0]?.action.target).toEqual({ kind: 'pair-again' });
  });

  it('explains missing channels, offline channels and one-sided liquidity', () => {
    expect(remoteNotices({ ...remoteBase, balances: remoteBalances({ channels: [] }) })[0]?.id).toBe('no-channels');
    const offline = remoteBalances({
      channels: [{ chanId: 'c', active: false, localSat: 1n, remoteSat: 1n, capacitySat: 2n }],
    });
    expect(remoteNotices({ ...remoteBase, balances: offline })[0]?.id).toBe('channels-offline');
    const noInbound = remoteBalances({
      channels: [{ chanId: 'c', active: true, localSat: 10n, remoteSat: 0n, capacitySat: 10n }],
    });
    const notice = remoteNotices({ ...remoteBase, balances: noInbound })[0];
    expect(notice?.id).toBe('no-inbound');
    expect(notice?.body).toBe('Your wallet currently has insufficient receiving capacity for Lightning payments.');
  });

  it('counts pending payments but not open invoices', () => {
    const activity = remoteActivityItems([
      { paymentHash: 'a', direction: 'in', amountSat: 1n, feeSat: null, status: 'open', createdAt: '2026-11-05T00:00:00Z', memo: null, paymentRequest: null },
      { paymentHash: 'b', direction: 'out', amountSat: 1n, feeSat: null, status: 'pending', createdAt: '2026-11-04T00:00:00Z', memo: null, paymentRequest: null },
    ]);
    expect(remoteNotices({ ...remoteBase, activity }).map((n) => n.title)).toEqual(['1 payment pending']);
  });
});
