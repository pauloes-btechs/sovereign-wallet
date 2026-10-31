/**
 * SecurityPolicyEngine — deny-by-default egress policy.
 *
 * Every outbound network request the wallet makes flows through this engine
 * (via a PrivacyTransport). Loopback destinations are allowed as a class —
 * local daemon RPC is the architecture's trust anchor and is documented in
 * UPSTREAM_INTEGRATIONS.md. Everything else must match a registered
 * DisclosedEndpoint, or the request is refused before any bytes leave the
 * process. There is no telemetry, no account registration, and no
 * undisclosed endpoint: refusal is the default, disclosure is the mechanism.
 */

import { isLoopbackHost } from './loopback.js';

/** A remote endpoint the wallet is allowed to contact, with the reason. */
export interface DisclosedEndpoint {
  /** Stable identifier — appears in audit logs and the disclosure UI. */
  readonly id: string;
  readonly scheme: 'http' | 'https';
  readonly host: string;
  /** Exact port when specified; when omitted any port on this host matches. */
  readonly port?: number;
  /** URL path prefix that must match (e.g. '/v1'). */
  readonly pathPrefix?: string;
  /** Why the wallet contacts this endpoint — shown verbatim in onboarding/help. */
  readonly purpose: string;
  /** Whether this endpoint may be routed through Tor (the privacy transport). */
  readonly allowTor: boolean;
}

export type TransportKind = 'direct' | 'tor';

export type EgressDecision =
  | { readonly allowed: true; readonly rule: string }
  | { readonly allowed: false; readonly reason: string };

export class EgressPolicyViolation extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(`Egress policy violation (${reason}): ${url}`);
    this.name = 'EgressPolicyViolation';
  }
}

export class SecurityPolicyEngine {
  private readonly endpoints = new Map<string, DisclosedEndpoint>();

  /** Register a disclosed endpoint. Duplicate ids are programming errors. */
  register(endpoint: DisclosedEndpoint): this {
    if (this.endpoints.has(endpoint.id)) {
      throw new Error(`Disclosed endpoint id already registered: ${endpoint.id}`);
    }
    this.endpoints.set(endpoint.id, { ...endpoint, host: endpoint.host.toLowerCase() });
    return this;
  }

  /** Register from a runtime URL (e.g. a user-configured Ark operator). */
  registerUrl(url: string | URL, meta: { id: string; purpose: string; allowTor: boolean }): this {
    const parsed = new URL(url instanceof URL ? url.href : url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Only http(s) endpoints can be disclosed, got: ${parsed.protocol}`);
    }
    const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
    const port = parsed.port === '' ? undefined : Number(parsed.port);
    return this.register({
      id: meta.id,
      scheme,
      host: parsed.hostname,
      ...(port !== undefined ? { port } : {}),
      pathPrefix: parsed.pathname === '/' ? undefined : parsed.pathname,
      purpose: meta.purpose,
      allowTor: meta.allowTor,
    });
  }

  /** The registry, for disclosure surfaces (onboarding, help, audit). */
  disclosed(): readonly DisclosedEndpoint[] {
    return [...this.endpoints.values()];
  }

  /** Host-only decision for transports that observe raw sockets/DNS. */
  decideHost(host: string): EgressDecision {
    if (isLoopbackHost(host)) return { allowed: true, rule: 'loopback' };
    const match = [...this.endpoints.values()].find((ep) => ep.host === host.toLowerCase());
    return match === undefined
      ? { allowed: false, reason: 'host-not-disclosed' }
      : { allowed: true, rule: `disclosed:${match.id}` };
  }

  decide(url: string | URL, opts: { transport?: TransportKind } = {}): EgressDecision {
    const transport = opts.transport ?? 'direct';
    let parsed: URL;
    try {
      parsed = typeof url === 'string' ? new URL(url) : url;
    } catch {
      return { allowed: false, reason: 'unparseable-url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: `scheme-not-allowed:${parsed.protocol}` };
    }
    if (isLoopbackHost(parsed.hostname)) {
      // Local daemon RPC is the trust anchor. Routing loopback through a
      // Tor SOCKS proxy is meaningless (and leaks the destination to a
      // proxy for no benefit) — refuse it.
      return transport === 'tor'
        ? { allowed: false, reason: 'loopback-over-tor' }
        : { allowed: true, rule: 'loopback-daemon-rpc' };
    }
    const match = [...this.endpoints.values()].find((ep) => this.matches(ep, parsed, transport));
    if (match === undefined) {
      return {
        allowed: false,
        reason: this.endpoints.size === 0 ? 'no-endpoints-disclosed' : 'endpoint-not-disclosed',
      };
    }
    return { allowed: true, rule: `disclosed:${match.id}` };
  }

  /** Decide, then throw on denial. The only entry point transports use. */
  assertEgressAllowed(url: string | URL, opts: { transport?: TransportKind } = {}): void {
    const decision = this.decide(url, opts);
    if (!decision.allowed) throw new EgressPolicyViolation(String(url), decision.reason);
  }

  private matches(ep: DisclosedEndpoint, url: URL, transport: TransportKind): boolean {
    const scheme = url.protocol === 'https:' ? 'https' : 'http';
    if (ep.scheme !== scheme || ep.host !== url.hostname.toLowerCase()) return false;
    if (ep.port !== undefined && url.port !== '' && Number(url.port) !== ep.port) return false;
    if (ep.port !== undefined && url.port === '') return scheme === 'https' ? ep.port === 443 : ep.port === 80;
    if (ep.pathPrefix !== undefined && !url.pathname.startsWith(ep.pathPrefix)) return false;
    if (transport === 'tor' && !ep.allowTor) return false;
    return true;
  }
}
