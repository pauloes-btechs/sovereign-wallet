import { describe, expect, it } from 'vitest';
import { computeAccounts, fundSegments } from './balances.js';

const wallet = (o: Partial<Record<'totalSat' | 'confirmedSat' | 'unconfirmedSat' | 'lockedSat' | 'reservedAnchorSat', string>> = {}) => ({
  totalSat: '0',
  confirmedSat: '0',
  unconfirmedSat: '0',
  lockedSat: '0',
  reservedAnchorSat: '0',
  ...o,
});
const channels = (b: Partial<Record<'localSat' | 'remoteSat' | 'localUnsettledSat' | 'pendingOpenLocalSat' | 'pendingOpenRemoteSat', string>> = {}) => ({
  open: [],
  pending: [],
  balance: { localSat: '0', remoteSat: '0', localUnsettledSat: '0', pendingOpenLocalSat: '0', pendingOpenRemoteSat: '0', ...b },
});

describe('computeAccounts', () => {
  it('never counts receivable capacity as owned funds', () => {
    const a = computeAccounts(wallet({ confirmedSat: '1000' }), channels({ localSat: '500', remoteSat: '9000' }));
    expect(a.totalSat).toBe(1500);
    expect(a.lightningReceivableSat).toBe(9000);
  });

  it('treats locked UTXOs and the anchor reserve as part of confirmed, not extra', () => {
    const a = computeAccounts(wallet({ confirmedSat: '1000', lockedSat: '200', reservedAnchorSat: '100' }), channels());
    expect(a.onchainSpendableSat).toBe(700);
    expect(a.onchainLockedSat).toBe(300);
    expect(a.totalSat).toBe(1000);
  });

  it('adds unconfirmed, opening channels, in-flight HTLCs and Pool accounts exactly once', () => {
    const a = computeAccounts(
      wallet({ confirmedSat: '1000', unconfirmedSat: '50' }),
      channels({ localSat: '400', localUnsettledSat: '20', pendingOpenLocalSat: '300' }),
      [
        { valueSat: 250, state: 'open' },
        { valueSat: 999, state: 'closed' },
      ],
    );
    expect(a.totalSat).toBe(1000 + 50 + 400 + 20 + 300 + 250);
    expect(a.poolAccountsSat).toBe(250);
  });

  it('degrades to zeros while data is loading', () => {
    expect(computeAccounts(undefined, undefined).totalSat).toBe(0);
  });

  it('liquidity bar owned segments sum to the total', () => {
    const a = computeAccounts(
      wallet({ confirmedSat: '1000', unconfirmedSat: '50', lockedSat: '10' }),
      channels({ localSat: '400', remoteSat: '700', pendingOpenLocalSat: '30' }),
      [{ valueSat: 5, state: 'open' }],
    );
    const owned = fundSegments(a).filter((s) => s.kind !== 'inbound').reduce((s, x) => s + x.sats, 0);
    expect(owned).toBe(a.totalSat);
  });
});
