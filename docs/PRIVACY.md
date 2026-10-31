# Privacy

What leaves the device, where it goes, and what never does. Enforced by
`packages/privacy` (egress policy engine, endpoint registry, Tor transport)
and verified by tests, not promises.

## The invariants

- **No telemetry.** No analytics, no crash reporting, no usage metrics.
- **No account registration.** No email, no identity service, no sync account.
- **No undisclosed egress.** Every network endpoint the wallet can contact is
  declared in the disclosed-endpoint registry in `packages/privacy`; any
  endpoint not in the registry is blocked (fail-closed).

## How enforcement works

1. **Disclosed registry.** Remote endpoints live in one registry module.
   Application code cannot hard-code a remote host — a CI test scans runtime
   source for http(s) host literals and fails the build if any appears
   outside the registry. (A documentation URL in a config comment is enough
   to fail this scan — the rule is deliberately mechanical.)
2. **Fail-closed policy engine.** Network requests flow through the policy
   engine; unknown destinations are denied, not warned about.
3. **Egress-detection test.** Integration tests run wallet components against
   an instrumented environment and assert no connection attempt reaches an
   undisclosed host.
4. **Tor transport (optional).** Users who need network-level privacy can
   route supported connections over Tor.

## What the wallet talks to, by mode

The provider contract's `operatorDependencies[]` is the runtime source of
truth — the UI renders it verbatim in onboarding and help.

### Mode A (Wavelength/Ark)

| Dependency | Needed for | Consequence if down |
| --- | --- | --- |
| Ark operator | VTXO batching/refresh, operator-side restore scan | Background refresh pauses; funds move to at-risk state; unilateral exit (wallet-side) still available |
| Swap server | Lightning send/receive via atomic swaps | Lightning swaps unavailable; on-chain Bitcoin unaffected |
| Esplora endpoint (waved `lwwallet` backend) | Chain data for the waved daemon | Configurable at setup |

### Mode B (litd)

| Dependency | Needed for | Consequence if down |
| --- | --- | --- |
| Bitcoin network (Neutrino filters by default; optional bitcoind full node) | Sync, broadcast | Wallet cannot sync or broadcast |
| User's own litd (mobile, via LNC relay) | Mobile Mode B access | Mobile access down; desktop unaffected |
| LNC relay (Lightning Labs-documented transport) | Mobile pairing transport | E2E-encrypted relay only — sees no wallet data; pairing fails offline |
| Loop/Pool services (optional liquidity) | Swaps, leases | Liquidity features degrade; nothing executes without explicit user action |

## Data at rest

All local databases are SQLCipher-encrypted (see
[SECURITY](SECURITY.md)); the database key is held in the platform secure
storage (Keychain / Credential Manager / Secret Service). Payment-intent
state — including destination strings — lives in the same encrypted store.

## What this document does not claim

Wallet privacy against the parties listed above (the Ark operator, swap
server, and Bitcoin peers) is bounded by their role — a wallet using an Ark
operator reveals what any Ark client must. The invariant here is narrower
and absolute: nothing is collected, nothing is transmitted beyond the
disclosed endpoints, and the user can verify both claims in the registry and
the egress test.

Related: [SECURITY](SECURITY.md) · [UPSTREAM_INTEGRATIONS](UPSTREAM_INTEGRATIONS.md)
