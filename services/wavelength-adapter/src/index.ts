/**
 * Mode A (Wavelength) adapter — scaffold stub.
 *
 * All Wavelength SDK contact is isolated in this package per the spec
 * (risk mitigation: v0.2.0 APIs are explicitly unstable; adapter tests
 * golden the surface we consume; CI re-pins versions against release tags).
 *
 * Scope locked for later tasks:
 * - Static WalletCapabilities declaration (lightningMechanism: 'swaps').
 * - VTXO lifecycle state machine surface (fresh/expiring/at-risk/exiting).
 * - Seed restore BEFORE VTXO batch expiry; operator-unreachable fallback
 *   routes to unilateral exit.
 * - Desktop runtime: `waved` sidecar (Tauri sidecar mechanism) — WASM is the
 *   documented fallback only if sidecar packaging fails (reversal condition).
 */
export {};
