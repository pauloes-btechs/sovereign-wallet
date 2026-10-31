/**
 * PrivacyTransport — the single doorway for outbound HTTP.
 *
 * Adapters and apps MUST NOT call bare `fetch` for non-loopback traffic;
 * they take a `fetchImpl` (see the WavedGatewayClient) and apps hand them
 * `createPolicyFetch(...)`. The transport consults the SecurityPolicyEngine
 * BEFORE dispatch, so an undisclosed destination fails in-process — never
 * on the wire.
 */

import type { SecurityPolicyEngine, TransportKind } from './policy.js';

function inputToUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

export interface PrivacyTransport {
  readonly kind: TransportKind;
  /** fetch-compatible call: policy-checked, then dispatched. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class DirectPrivacyTransport implements PrivacyTransport {
  readonly kind: TransportKind = 'direct';

  constructor(
    private readonly engine: SecurityPolicyEngine,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = inputToUrl(input);
    this.engine.assertEgressAllowed(url, { transport: this.kind });
    return this.fetchImpl(input, init);
  }
}

/**
 * Drop-in `fetchImpl` for adapters that take a standard fetch (gateway
 * client, bridge client). Policy is consulted on every call.
 */
export function createPolicyFetch(
  engine: SecurityPolicyEngine,
  fetchImpl?: typeof fetch,
): typeof fetch {
  const transport = new DirectPrivacyTransport(engine, fetchImpl);
  return (input, init) => transport.fetch(input, init);
}
