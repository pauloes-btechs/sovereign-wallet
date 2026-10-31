/**
 * @sovereign/privacy — deny-by-default egress policy, privacy transports
 * (direct + Tor/SOCKS5), loopback-only binding enforcement, and the egress
 * monitoring the CI privacy suite runs against real wallet flows.
 *
 * Spec basis: "No telemetry/account/network calls beyond disclosed endpoints
 * (verified by egress test); Tor option; SQLCipher-at-rest; loopback-only
 * local RPC" — Sovereign Wallet spec, Privacy & security deliverable.
 */

export { SecurityPolicyEngine, EgressPolicyViolation } from './policy.js';
export type { DisclosedEndpoint, EgressDecision, TransportKind } from './policy.js';
export { isLoopbackHost, parseHostPort, validateSidecarListenArgs, LoopbackViolationError, DEFAULT_LISTEN_FLAG_PATTERN } from './loopback.js';
export type { ListenArgsOptions } from './loopback.js';
export { DirectPrivacyTransport, createPolicyFetch } from './transport.js';
export type { PrivacyTransport } from './transport.js';
export { TorPrivacyTransport, TorTransportError, connectSocks5 } from './tor.js';
export type { TorTransportOptions } from './tor.js';
export { installEgressMonitor } from './egress-monitor.js';
export type { EgressEvent, EgressKind, EgressMonitor } from './egress-monitor.js';
export { DEFAULT_DISCLOSED_ENDPOINTS } from './disclosed.js';
