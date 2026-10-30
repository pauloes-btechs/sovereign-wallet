# Regtest harness

Docker-based Bitcoin regtest environment for autonomous integration tests.
**Regtest/signet only — never mainnet** (spec-locked). All harness credentials
are local-only throwaways.

## Topology

| Service   | Image                                      | Host ports (loopback)  | Role |
| --------- | ------------------------------------------ | ---------------------- | ---- |
| bitcoind  | `bitcoin/bitcoin:27.0`                     | RPC 18443, P2P 18444   | Chain of record; mining via RPC |
| lnd-alice | `lightninglabs/lnd:v0.21.5-beta.rc1`       | RPC 10009, P2P 19735   | Full-node LND; remote-LND test target (`rpcmiddleware.enable`) |
| lnd-bob   | `lightninglabs/lnd:v0.21.5-beta.rc1`       | RPC 10010              | Second full-node LND; channel/Loop peer |
| litd      | `lightninglabs/lightning-terminal:v0.17.8` | embedded-LND RPC 10011 | litd integrated mode, bitcoind backend (full-node option) |

The host-side Neutrino filter server (built in CI) follows bitcoind's chain and
serves BIP157 compact filters on **127.0.0.1:18555**. It exists because
bitcoind does not implement BIP157 serving and a bitcoind-backed LND handles no
filter messages (verified against lnd v0.21.5-beta.rc1 sources).

## What runs today

Two layers:

- **Mode B — Docker environment + real-binary integration suite**
  (`docker-compose.yml`, `src/harness.ts`, `src/cli.ts`): bootstrap initializes
  the bitcoind wallet, seeds 110+ matured blocks, and initializes/unlocks the
  wallets on both LNDs and litd's embedded LND. The gated integration tests
  (`pnpm test:integration`) then drive a fetched litd sidecar against the
  harness: wallet init, Neutrino regtest sync, on-chain receive/send, and
  channel open/close.
- **Mode A — Ark money-flow suite** (`src/ark-moneyflow.test.ts`): exercises
  the real `@sovereign/wavelength-adapter` provider, payment dispatcher, and
  the shared payment engine against `src/simulated-client.ts` — an in-memory
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

## Usage

```sh
# 1. Start the containers (from repo root)
docker compose -f harness/regtest/docker-compose.yml up -d --wait

# 2. Build the harness package (protobuf-ts based bootstrap + helpers)
pnpm --filter @sovereign/harness-regtest build

# 3. Run the host-side filter server (btcd, pinned) — CI does this; see ci.yml
btcd --regtest --connect=127.0.0.1:18444 --listen=127.0.0.1:18555 \
     --datadir=harness/regtest/data/btcd --logdir=harness/regtest/data/btcd-log

# 4. Bootstrap: init/unlock wallets, seed the chain (110 matured blocks)
pnpm harness:bootstrap

# 5. Run the integration suite (needs a fetched sidecar: pnpm sidecar:fetch)
pnpm test:integration

# Mode A suite (no Docker needed)
pnpm --filter @sovereign/harness-regtest test

# Teardown
docker compose -f harness/regtest/docker-compose.yml down -v
```

## Seed data

`pnpm harness:bootstrap` (harness/regtest/src/cli.ts) brings the harness to a
known state: bitcoind wallet "harness", 110+ matured blocks, and an initialized
aezeed wallet on lnd-alice, lnd-bob, and litd's embedded LND (password
`harness-regtest-password`, local-only). Wallet init is idempotent — existing
wallets are unlocked instead.

## Files

- `docker-compose.yml` — the four services above
- `lnd-alice/lnd.conf`, `lnd-bob/lnd.conf`, `litd/litd.conf` — daemon configs
- `src/` — `@sovereign/harness-regtest`: RPC/gRPC helpers, bootstrap,
  constants, plus the Mode A simulated-client suite
- `data/` — runtime state (gitignored): TLS certs, macaroons, chain data

## Rules (spec-locked)

- Regtest/signet only — **never mainnet** for autonomous financial testing.
- All harness credentials are local-only throwaways; never reuse real secrets.
