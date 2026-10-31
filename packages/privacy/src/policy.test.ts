import { describe, expect, it } from 'vitest';
import { EgressPolicyViolation, SecurityPolicyEngine, isLoopbackHost } from './index.js';

describe('SecurityPolicyEngine', () => {
  it('allows loopback as a class (local daemon RPC is the trust anchor)', () => {
    const engine = new SecurityPolicyEngine();
    expect(engine.decide('http://127.0.0.1:10031/v1/daemon/get-info')).toEqual({
      allowed: true,
      rule: 'loopback-daemon-rpc',
    });
    expect(engine.decide('http://localhost:8080')).toEqual({ allowed: true, rule: 'loopback-daemon-rpc' });
    expect(engine.decide('http://[::1]:9090')).toEqual({ allowed: true, rule: 'loopback-daemon-rpc' });
  });

  it('denies any non-loopback host that is not disclosed — telemetry and account services included', () => {
    const engine = new SecurityPolicyEngine();
    for (const url of [
      'https://sentry.io/api/123/envelope',
      'https://www.google-analytics.com/mp/collect',
      'https://api.mixpanel.com/track',
      'https://accounts.example.com/register',
      'https://wallet-telemetry.example.net/v1/events',
      'http://192.0.2.1/exfil',
    ]) {
      expect(engine.decide(url).allowed, url).toBe(false);
      expect(() => engine.assertEgressAllowed(url)).toThrow(EgressPolicyViolation);
    }
  });

  it('allows a registered endpoint on the disclosed host and port only', () => {
    const engine = new SecurityPolicyEngine().register({
      id: 'ark-operator',
      scheme: 'https',
      host: 'operator.example.org',
      port: 8443,
      pathPrefix: '/v1',
      purpose: 'Ark operator for VTXO management (Mode A).',
      allowTor: true,
    });
    expect(engine.decide('https://operator.example.org:8443/v1/wallets')).toEqual({
      allowed: true,
      rule: 'disclosed:ark-operator',
    });
    expect(engine.decide('https://operator.example.org:8443/other').allowed).toBe(false); // path prefix
    expect(engine.decide('https://operator.example.org:9999/v1/wallets').allowed).toBe(false); // port
    expect(engine.decide('https://other.example.org:8443/v1/wallets').allowed).toBe(false); // host
  });

  it('refuses Tor routing for endpoints that did not disclose allowTor', () => {
    const engine = new SecurityPolicyEngine().register({
      id: 'esplora',
      scheme: 'https',
      host: 'esplora.example.org',
      purpose: 'Block data (Mode A on-chain view).',
      allowTor: false,
    });
    expect(engine.decide('https://esplora.example.org/blocks/tip', { transport: 'tor' }).allowed).toBe(false);
    expect(engine.decide('https://esplora.example.org/blocks/tip', { transport: 'direct' }).allowed).toBe(true);
  });

  it('refuses loopback over Tor — a proxy cannot serve the local machine', () => {
    const engine = new SecurityPolicyEngine();
    expect(engine.decide('http://127.0.0.1:10031/v1/x', { transport: 'tor' })).toEqual({
      allowed: false,
      reason: 'loopback-over-tor',
    });
  });

  it('refuses non-http(s) schemes outright', () => {
    const engine = new SecurityPolicyEngine();
    expect(engine.decide('file:///etc/passwd').allowed).toBe(false);
    expect(engine.decide('ftp://example.org/file').allowed).toBe(false);
    expect(engine.decide('data:text/html,hello').allowed).toBe(false);
  });

  it('registers runtime endpoints from a URL with implicit default ports', () => {
    const engine = new SecurityPolicyEngine();
    engine.registerUrl('https://swap.example.org/v1/swap', {
      id: 'swap-server',
      purpose: 'Swap server for Lightning over Ark (Mode A).',
      allowTor: true,
    });
    // Default port (443 implicit) matches the registration.
    expect(engine.decide('https://swap.example.org/v1/swap/invoice').allowed).toBe(true);
    expect(engine.decide('https://swap.example.org/other').allowed).toBe(false);
    expect(engine.disclosed().map((e) => e.id)).toEqual(['swap-server']);
  });

  it('refuses unparseable URLs (fail closed)', () => {
    const engine = new SecurityPolicyEngine();
    expect(engine.decide('not a url').allowed).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('recognizes loopback forms and rejects lookalikes', () => {
    for (const host of ['127.0.0.1', '127.9.9.9', 'localhost', 'LOCALHOST', '::1', '[::1]', 'tauri.localhost']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', '127.0.0.1.evil.com', '192.168.1.1', '::2', '[::2]', 'example.org']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});
