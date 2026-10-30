# Regtest harness

Docker-based Bitcoin regtest environment for autonomous integration tests:
`bitcoind` (mined regtest coins, txindex) plus two LND nodes (`lnd-alice`,
`lnd-bob`) for channel/Loop flows.

## Status

Two layers today:

- **Docker regtest environment** (`docker-compose.yml`): `bitcoind` (mined
  regtest coins, txindex) plus two LND nodes (`lnd-alice`, `lnd-bob`) for
  Mode B channel/Loop flows. Wiring the full litd money-flow harness (seed
  funding, channel opens, invoice payment scripts) is a dedicated task.
- **Ark money-flow suite** (`src/ark-moneyflow.test.ts`): exercises the real
  `@sovereign/wavelength-adapter` provider, payment dispatcher, and the shared
  payment engine against `src/simulated-client.ts` — an in-memory
  implementation of the pinned `@lightninglabs/wavelength-core` client
  contract. It covers quote persistence and one-time dispatch with
  reconciliation, crash recovery without a duplicate dispatch, VTXO expiry
  and operator-loss alerts, balance buckets, and the unilateral-exit walk
  (infeasible → funded → started → swept → on-chain).

  The daemon itself is simulated, not a live Ark operator: no Wavelength
  `waved` container image was verifiable at the pinned SDK version, and this
  suite's contract is the SDK surface the adapter consumes — which the
  simulation implements exactly. Every SDK-shape assumption (required
  `EntryProgress` fields, exit-plan entries, quote lifecycle) is exercised
  against the SDK's own type declarations. Live-daemon wiring remains open
  and would extend, not replace, this suite.

Run: `corepack pnpm --filter @sovereign/harness-regtest test` (typecheck:
`... typecheck`).

## Rules (spec-locked)

- Regtest/signet only — **never mainnet** for autonomous financial testing.
- All harness credentials are local-only throwaways; never reuse real secrets.
