# Regtest harness

Docker-based Bitcoin regtest environment for autonomous integration tests:
`bitcoind` (mined regtest coins, txindex) plus two LND nodes (`lnd-alice`,
`lnd-bob`) for channel/Loop flows.

## Status

Stub. Wiring the full money-flow harness (seed funding, channel opens,
invoice payment scripts) is a dedicated task. Integration tests in CI run
against this compose file once wired.

## Rules (spec-locked)

- Regtest/signet only — **never mainnet** for autonomous financial testing.
- All harness credentials are local-only throwaways; never reuse real secrets.
