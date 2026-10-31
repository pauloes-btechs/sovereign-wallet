/**
 * CI-enforced egress suite — the executable form of the spec's privacy
 * claims: "No telemetry/account/network calls beyond disclosed endpoints
 * (verified by egress test)".
 *
 * Three layers of proof:
 *  1. Instrumented flow — a real WavedGatewayClient runs against a loopback
 *     stub with the egress monitor installed; every observed outbound
 *     attempt must be loopback or disclosed, and the flow must have made
 *     network calls (the monitor saw them — no vacuous pass).
 *  2. Refusal — undisclosed destinations (telemetry, account registration)
 *     are refused IN-PROCESS by the SecurityPolicyEngine before dispatch.
 *  3. Source scan — the runtime source tree contains no hardcoded remote
 *     endpoint literal, so new remote dependencies must flow through the
 *     disclosed registry (a conscious, reviewed change).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WavedGatewayClient } from '@sovereign/wavelength-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DISCLOSED_ENDPOINTS } from './disclosed.js';
import { installEgressMonitor, type EgressMonitor } from './egress-monitor.js';
import { isLoopbackHost } from './loopback.js';
import { SecurityPolicyEngine } from './policy.js';
import { createPolicyFetch } from './transport.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function startStub(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    // Minimal envelope; the gateway client's parsing of an empty get-info
    // body is irrelevant here — the egress test observes ATTEMPTS.
    void req;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

let monitor: EgressMonitor | undefined;

afterEach(() => {
  monitor?.restore();
  monitor = undefined;
});

describe('egress: instrumented real wallet flow', () => {
  it('gateway-client flow attempts loopback only, with zero undisclosed attempts', async () => {
    const stub = await startStub();
    const engine = new SecurityPolicyEngine();
    monitor = installEgressMonitor(engine);
    try {
      // Real client, real fetch (instrumented), policy-consulting transport.
      const client = new WavedGatewayClient({
        gatewayUrl: stub.url,
        fetchImpl: createPolicyFetch(engine),
      });
      // The stub returns `{}` — a mapping error is fine; the network attempt
      // is what the egress suite observes. Swallowing here is the TEST's
      // contract, not production error handling.
      await client.getInfo().catch(() => undefined);

      const events = monitor.events();
      expect(events.length, 'flow must have made network attempts').toBeGreaterThan(0);
      expect(monitor.violations()).toEqual([]);
      for (const event of events) {
        expect(
          ['127.0.0.1', '::1', 'localhost'].includes(event.host),
          `non-loopback attempt: ${JSON.stringify(event)}`,
        ).toBe(true);
      }
    } finally {
      stub.close();
    }
  });

  it('detects an undisclosed attempt made with RAW fetch (monitor catches policy bypasses)', async () => {
    const engine = new SecurityPolicyEngine();
    monitor = installEgressMonitor(engine);
    // TEST-NET-1 (RFC 5737) — reserved, never routable. Attempt recorded
    // even though the connection cannot succeed.
    const probe = fetch('https://192.0.2.1/collect', { signal: AbortSignal.timeout(250) });
    await probe.catch(() => undefined);
    const violations = monitor.violations();
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.host === '192.0.2.1')).toBe(true);
  });
});

describe('egress: in-process refusal of telemetry and account endpoints', () => {
  it('policy fetch refuses telemetry/account destinations before dispatch', async () => {
    const engine = new SecurityPolicyEngine();
    monitor = installEgressMonitor(engine);
    const policyFetch = createPolicyFetch(engine);
    const blocked = [
      'https://sentry.io/api/123/envelope',
      'https://www.google-analytics.com/mp/collect',
      'https://accounts.example.com/register',
    ];
    for (const url of blocked) {
      await expect(policyFetch(url)).rejects.toMatchObject({ name: 'EgressPolicyViolation' });
    }
    // Refusal happened in-process: nothing reached the wire, so the monitor
    // must have observed NO attempts from these calls.
    expect(monitor.events()).toEqual([]);
  });

  it('ships with zero pre-disclosed remote endpoints (no hidden services)', () => {
    expect(DEFAULT_DISCLOSED_ENDPOINTS).toEqual([]);
    const engine = new SecurityPolicyEngine();
    expect(engine.disclosed()).toEqual([]);
  });
});

describe('egress: runtime source scan — no hardcoded remote endpoints', () => {
  const SRC_DIRS = ['apps', 'packages', 'services'].map((d) => path.join(REPO_ROOT, d));
  const SKIP = new Set(['node_modules', 'dist', 'generated', '.storybook', 'coverage']);
  const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

  function isTestFile(file: string): boolean {
    return /\.(test|spec)\.[jt]sx?$/.test(file);
  }

  function collectSources(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) collectSources(full, acc);
      else if (EXT.has(path.extname(entry))) acc.push(full);
    }
    return acc;
  }

  it('every http(s) host literal in runtime source is loopback', () => {
    const offenders: { file: string; host: string }[] = [];
    for (const srcDir of SRC_DIRS) {
      for (const file of collectSources(srcDir)) {
        // Test files deliberately reference fixture hosts (telemetry examples,
        // RFC 5737 addresses) to prove refusal — they are not runtime egress.
        if (isTestFile(file)) continue;
        const content = readFileSync(file, 'utf8');
        const matches = content.matchAll(
          /https?:\/\/(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+)(?::\d+)?/g,
        );
        for (const match of matches) {
          const host = (match[1] ?? '').replace(/^\[|\]$/g, '');
          if (isLoopbackHost(host)) continue;
          offenders.push({ file: path.relative(REPO_ROOT, file), host });
        }
      }
    }
    expect(
      offenders,
      'remote endpoint literals must flow through the disclosed registry, not source code',
    ).toEqual([]);
  });
});
