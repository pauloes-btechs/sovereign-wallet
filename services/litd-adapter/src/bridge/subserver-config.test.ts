import { describe, expect, it } from 'vitest';
import { buildLitdConfig } from '../config.js';
import { OFFLINE_OPERATOR, planSubServers } from './subserver-config.js';

describe('planSubServers', () => {
  it('starts loopd and poold and keeps their data inside the wallet data dir', () => {
    const plan = planSubServers('signet', '/w');
    expect(plan.extraSubServerArgs).toEqual(
      expect.arrayContaining([
        'loop-mode=integrated',
        'pool-mode=integrated',
        'loop.datadir=/w/loop',
        'pool.basedir=/w/pool',
        'faraday.faradaydir=/w/faraday',
      ]),
    );
  });

  it('never points regtest at a real operator unless one is configured', () => {
    const plan = planSubServers('regtest', '/w');
    expect(plan.extraSubServerArgs).toContain(`loop.server.host=${OFFLINE_OPERATOR}`);
    expect(plan.extraSubServerArgs).toContain(`pool.auctionserver=${OFFLINE_OPERATOR}`);
    expect(plan.operators.loop.mode).toBe('offline');
  });

  it('uses an explicitly configured local swap server', () => {
    const plan = planSubServers('regtest', '/w', { loopServer: '127.0.0.1:11009' });
    expect(plan.extraSubServerArgs).toContain('loop.server.host=127.0.0.1:11009');
    expect(plan.operators.loop).toEqual({ mode: 'configured', host: '127.0.0.1:11009' });
    expect(plan.operators.pool.mode).toBe('offline');
  });

  it('leaves upstream defaults alone off regtest', () => {
    const plan = planSubServers('mainnet', '/w');
    expect(plan.extraSubServerArgs.some((l) => l.startsWith('loop.server.host='))).toBe(false);
    expect(plan.operators.pool.mode).toBe('upstream-default');
  });

  it('produces lines buildLitdConfig accepts', () => {
    const plan = planSubServers('regtest', '/w', { extra: ['loop.server.notls=true'] });
    const config = buildLitdConfig({
      network: 'regtest',
      dataDir: '/w',
      backend: { kind: 'neutrino', peers: ['127.0.0.1:18555'] },
      superMacaroon: { bake: 'read-write' },
      extraSubServerArgs: plan.extraSubServerArgs,
    });
    expect(config.superMacaroonPath).toBe('/w/super.macaroon');
    const all = [...config.args, ...config.confLines].join('\n');
    expect(all).toContain('loop-mode=integrated');
    expect(all).toContain('loop.server.notls=true');
  });
});
