/**
 * Egress monitor — test instrumentation that observes EVERY outbound network
 * attempt the process makes (fetch + raw sockets) and classifies each against
 * the SecurityPolicyEngine.
 *
 * This is the mechanism the CI egress test uses to prove the wallet's
 * privacy claims: run real flows with the monitor installed, then assert
 * (a) the flows actually made network calls (the monitor saw them), and
 * (b) every attempt is either loopback or a disclosed endpoint. Detection
 * counts ATTEMPTS, not successes — a refused connection is still an egress
 * attempt and is still reported.
 *
 * Mechanism notes:
 * - `globalThis.fetch` is patched for the URL-level view of fetch calls.
 * - `net.Socket.prototype.connect` is the funnel every outbound TCP
 *   connection shares (net.connect, http/https agents, undici, tls.connect).
 *   Patching the `node:http`/`node:https` module namespaces instead does not
 *   work: ESM built-in namespace properties are not writable.
 * - Hostnames are captured at connect time, so DNS lookups that fail are
 *   still recorded — attempts, not successes.
 */

import * as netMod from 'node:net';
import type { SecurityPolicyEngine } from './policy.js';

export type EgressKind = 'fetch' | 'net';

export interface EgressEvent {
  readonly kind: EgressKind;
  /** Host the process attempted to reach. */
  readonly host: string;
  readonly port?: number;
  /** Full URL for fetch attempts, when available. */
  readonly url?: string;
}

export interface EgressMonitor {
  /** Every observed outbound attempt, in observation order. */
  events(): readonly EgressEvent[];
  /** Attempts the policy engine refuses (neither loopback nor disclosed). */
  violations(): readonly EgressEvent[];
  restore(): void;
}

export function installEgressMonitor(engine: SecurityPolicyEngine): EgressMonitor {
  const events: EgressEvent[] = [];

  const record = (event: EgressEvent): void => {
    events.push(event);
  };

  // --- fetch: URL-level view ---------------------------------------------
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = url;
    }
    record({ kind: 'fetch', host, url });
    return originalFetch.call(globalThis, input, init);
  }) as typeof fetch;

  // --- raw sockets: the funnel for every outbound TCP connect --------------
  const originalConnect = netMod.Socket.prototype.connect;
  type ConnectArgs = Parameters<typeof netMod.Socket.prototype.connect>;
  netMod.Socket.prototype.connect = function patchedConnect(this: netMod.Socket, ...args: unknown[]) {
    const options = args[0] as { host?: string; hostname?: string; port?: number; path?: string };
    if (!options?.path && (options?.host ?? options?.hostname)) {
      record({
        kind: 'net',
        host: (options.hostname ?? options.host ?? '').toLowerCase(),
        port: options.port,
      });
    }
    return originalConnect.apply(this, args as ConnectArgs);
  } as typeof netMod.Socket.prototype.connect;

  return {
    events: () => [...events],
    violations: () =>
      events.filter((e) => {
        const decision = engine.decideHost(e.host);
        return !decision.allowed;
      }),
    restore: () => {
      globalThis.fetch = originalFetch;
      netMod.Socket.prototype.connect = originalConnect;
    },
  };
}
