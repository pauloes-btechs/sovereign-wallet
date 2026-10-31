/**
 * Per-call deadline (ms) for unary RPCs against the litd sub-servers.
 *
 * loopd/poold retry their upstream operator (swap server / auctioneer)
 * internally while holding the client call open — without a gRPC deadline,
 * a call against an unreachable operator never resolves, hangs the caller
 * indefinitely, and (in the integration suite) burns vitest's whole
 * per-test budget before the test fails. The deadline bounds every unary
 * call deterministically; DEADLINE_EXCEEDED classifies as 'unavailable'.
 */
export const RPC_UNARY_TIMEOUT_MS = 15_000;
