/**
 * Mode B (litd) adapter — scaffold stub.
 *
 * Scope locked for later tasks:
 * - litd v0.17.8 sidecar: LND + Loop + Pool + tapd + Faraday in one binary.
 * - Desktop RPC loopback-bound, least-privilege macaroons.
 * - gRPC via protobuf-ts with LND protos pinned per litd release
 *   (no grpc-web — lacks bidirectional streaming).
 * - Mobile Mode B is LNC-only; no LND-in-app, ever.
 * - Build litd from the pinned tag to resolve bundled Loop/Pool revisions.
 */
export {};
