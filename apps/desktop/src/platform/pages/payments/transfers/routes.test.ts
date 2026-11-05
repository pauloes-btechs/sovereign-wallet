import { describe, expect, it } from 'vitest';
import {
  bip21,
  DESTINATIONS,
  hasRail,
  preferredCandidate,
  resolveRoutes,
  SOURCES,
  type DestinationId,
  type RailId,
  type RouteAdapter,
  type RouteEnv,
  type SourceId,
} from './routes.js';

/** A node like the regtest stack, but with the swap server reachable. */
const ready: RouteEnv = {
  onchainSpendableSat: 100_000_000,
  lightningSpendableSat: 12_000_000,
  lightningReceivableSat: 2_000_000,
  openChannels: 1,
  loopRunning: true,
  loopOperator: 'configured',
  loopOperatorHost: 'localhost:11009',
  tapdRunning: true,
  assetCount: 1,
};

describe('resolveRoutes: which pairs map to which rail', () => {
  it.each<[SourceId, DestinationId, RailId[]]>([
    ['onchain', 'lightning', ['loop-in', 'channel-open']],
    ['onchain', 'external-address', ['onchain-send']],
    ['lightning', 'onchain', ['loop-out']],
    ['lightning', 'external-address', ['loop-out']],
    ['lightning', 'invoice', ['lightning-payment']],
    ['external-btc', 'onchain', ['funding-address']],
    ['external-btc', 'lightning', ['static-loop-in', 'funding-invoice']],
    ['taproot-asset', 'asset-address', ['asset-send']],
  ])('%s to %s resolves to %j', (s, d, expected) => {
    const r = resolveRoutes(s, d, ready);
    expect(r.candidates.map((c) => c.adapter.rail)).toEqual(expected);
    expect(r.noRoute).toBeUndefined();
    expect(r.candidates.every((c) => c.blocker === null)).toBe(true);
  });

  it('every other pair is unavailable with a reason, never a fabricated rail', () => {
    const routed = new Set([
      'onchain>lightning',
      'onchain>external-address',
      'lightning>onchain',
      'lightning>external-address',
      'lightning>invoice',
      'external-btc>onchain',
      'external-btc>lightning',
      'taproot-asset>asset-address',
    ]);
    for (const s of SOURCES) {
      for (const d of DESTINATIONS) {
        const r = resolveRoutes(s.id, d.id, ready);
        if (routed.has(`${s.id}>${d.id}`)) continue;
        expect(r.candidates, `${s.id}>${d.id}`).toHaveLength(0);
        expect(r.noRoute?.reason.length, `${s.id}>${d.id}`).toBeGreaterThan(10);
        expect(hasRail(s.id, d.id)).toBe(false);
      }
    }
  });

  it('never routes to another blockchain, and says why', () => {
    for (const s of SOURCES) {
      const r = resolveRoutes(s.id, 'other-chain', ready);
      expect(r.candidates).toHaveLength(0);
      expect(r.noRoute?.reason).toMatch(/no cross-chain route/i);
      expect(r.noRoute?.reason).toMatch(/ERC-20/);
    }
  });

  it('explains asset and same-account pairs specifically', () => {
    expect(resolveRoutes('taproot-asset', 'onchain', ready).noRoute?.reason).toMatch(/only to Taproot Assets addresses/);
    expect(resolveRoutes('onchain', 'asset-address', ready).noRoute?.reason).toMatch(/specific asset, not bitcoin/);
    expect(resolveRoutes('onchain', 'onchain', ready).noRoute?.reason).toMatch(/already on-chain/);
    expect(resolveRoutes('lightning', 'lightning', ready).noRoute?.reason).toMatch(/already Lightning/);
    expect(resolveRoutes('onchain', 'invoice', ready).noRoute?.fix).toMatch(/Loop In/);
    expect(resolveRoutes('external-btc', 'invoice', ready).noRoute?.reason).toMatch(/not part of that transfer/);
  });
});

describe('resolveRoutes: live blockers', () => {
  it('keeps Loop routes but blocks them when the swap server is offline', () => {
    const offline: RouteEnv = { ...ready, loopOperator: 'offline', loopOperatorHost: '127.0.0.1:1' };
    for (const [s, d] of [
      ['lightning', 'onchain'],
      ['lightning', 'external-address'],
      ['onchain', 'lightning'],
      ['external-btc', 'lightning'],
    ] as const) {
      const loop = resolveRoutes(s, d, offline).candidates.find((c) => c.adapter.rail.includes('loop'));
      expect(loop?.blocker?.kind).toBe('provider');
      expect(loop?.blocker?.reason).toContain('127.0.0.1:1');
      expect(loop?.blocker?.fix).toMatch(/--loopServer/);
    }
    // Non-Loop rails are unaffected.
    expect(resolveRoutes('lightning', 'invoice', offline).candidates[0]?.blocker).toBeNull();
    expect(resolveRoutes('onchain', 'external-address', offline).candidates[0]?.blocker).toBeNull();
  });

  it('prefers the first runnable alternative when the preferred rail is blocked', () => {
    const offline: RouteEnv = { ...ready, loopOperator: 'offline' };
    expect(preferredCandidate(resolveRoutes('onchain', 'lightning', offline))?.adapter.rail).toBe('channel-open');
    expect(preferredCandidate(resolveRoutes('external-btc', 'lightning', offline))?.adapter.rail).toBe('funding-invoice');
    expect(preferredCandidate(resolveRoutes('onchain', 'lightning', ready))?.adapter.rail).toBe('loop-in');
  });

  it('blocks when loopd itself is down, as a service problem', () => {
    const r = resolveRoutes('lightning', 'onchain', { ...ready, loopRunning: false });
    expect(r.candidates[0]?.blocker?.kind).toBe('service');
  });

  it('blocks on missing funds or capacity with the reason', () => {
    const empty: RouteEnv = { ...ready, onchainSpendableSat: 0, lightningSpendableSat: 0, lightningReceivableSat: 0, openChannels: 0, assetCount: 0 };
    expect(resolveRoutes('onchain', 'external-address', empty).candidates[0]?.blocker?.kind).toBe('funds');
    expect(resolveRoutes('lightning', 'invoice', empty).candidates[0]?.blocker?.reason).toMatch(/no open Lightning channel/);
    expect(resolveRoutes('taproot-asset', 'asset-address', empty).candidates[0]?.blocker?.reason).toMatch(/no Taproot Assets/);
    expect(resolveRoutes('onchain', 'lightning', { ...ready, lightningReceivableSat: 0 }).candidates[0]?.blocker?.reason).toMatch(/inbound room/);
    // Depositing from outside never depends on this wallet's balances.
    expect(resolveRoutes('external-btc', 'onchain', empty).candidates[0]?.blocker).toBeNull();
  });

  it('accepts new providers without changing the resolver', () => {
    const extra: RouteAdapter = {
      rail: 'onchain-send',
      label: 'Test provider',
      provider: 'test',
      summary: '',
      timing: '',
      dependencies: [],
      risks: [],
      inline: true,
      matches: (s, d) => s === 'onchain' && d === 'onchain',
      check: () => null,
    };
    const r = resolveRoutes('onchain', 'onchain', ready, [extra]);
    expect(r.candidates.map((c) => c.adapter.label)).toEqual(['Test provider']);
    expect(r.noRoute).toBeUndefined();
  });
});

describe('bip21', () => {
  it('formats amounts in BTC without float drift', () => {
    expect(bip21('bcrt1qxyz', 1)).toBe('bitcoin:bcrt1qxyz?amount=0.00000001');
    expect(bip21('bcrt1qxyz', 150_000_000)).toBe('bitcoin:bcrt1qxyz?amount=1.5');
    expect(bip21('bcrt1qxyz', 100_000_000)).toBe('bitcoin:bcrt1qxyz?amount=1');
    expect(bip21('bcrt1qxyz', 12_345)).toBe('bitcoin:bcrt1qxyz?amount=0.00012345');
    expect(bip21('bcrt1qxyz')).toBe('bitcoin:bcrt1qxyz');
    expect(bip21('bcrt1qxyz', 0)).toBe('bitcoin:bcrt1qxyz');
  });
});
