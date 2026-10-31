/**
 * Default disclosed endpoints — the registry the egress test asserts against.
 *
 * Loopback daemon RPC needs no registration (allowed as a class — see
 * SecurityPolicyEngine). Remote endpoints are registered at RUNTIME when the
 * user configures them (Ark operator, Esplora server, swap server), with the
 * disclosure text from the provider contract's operatorDependencies.
 *
 * The runtime source tree must not hardcode any remote endpoint literal —
 * that invariant is CI-enforced (see egress.test.ts, source host scan), so
 * every future remote dependency must flow through this registry.
 */

import type { DisclosedEndpoint } from './policy.js';

/**
 * As of this task the wallet ships with ZERO pre-disclosed remote endpoints:
 * Mode A's operator/swap-server and Mode B's Esplora/Neutrino peers are
 * runtime-configured per wallet setup and disclosed on registration.
 * Telemetry/account endpoints are not merely undisclosed — they are refused
 * by the deny-by-default engine and asserted against in the egress suite.
 */
export const DEFAULT_DISCLOSED_ENDPOINTS: readonly DisclosedEndpoint[] = [];
