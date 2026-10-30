# Sovereign Wallet

A noncustodial Bitcoin & Lightning wallet with two isolated engines behind one
dark, minimalist interface:

- **Everyday mode (Mode A)** — Wavelength/Ark: on-device keys, Ark VTXOs,
  on-chain Bitcoin, swap-based Lightning. Built for people who should never
  need to learn what a channel is.
- **Advanced mode (Mode B)** — self-operated `litd` (LND + Loop + Pool +
  Taproot Assets + Faraday in one binary): full channel infrastructure,
  graphical everywhere; the terminal is never required.

The two engines are **not equivalent and never merged**: separate wallets,
balances, seeds, and recovery paths, enforced by a capability-declaring
provider contract (`packages/wallet-core`). The UI renders only what the
active provider declares.

## Layout

```
apps/
  desktop/        Tauri 2 + React + Vite (daemons as signed sidecars)
  mobile/         React Native ≥0.76, New Architecture (Mode B is LNC-only)
packages/
  wallet-core/    Capability-declaring provider contract + domain types
  payments/       Payment intent state machine (reconcile, never re-dispatch)
services/
  wavelength-adapter/  ALL Wavelength SDK contact, isolated
  litd-adapter/        litd/LND gRPC (protobuf-ts, pinned protos)
harness/regtest/ Docker regtest harness (autonomous testing: regtest ONLY)
docs/            UPSTREAM_INTEGRATIONS.md and friends
```

## Development

```sh
pnpm install
pnpm build        # typecheck + compile every workspace package
pnpm lint
pnpm typecheck
pnpm test
```

Requires Node ≥20 and pnpm (version pinned via `packageManager`).

## Safety invariants

- Payment intents are persisted **before** dispatch; recovery reconciles,
  never blind re-dispatches.
- No telemetry, no account registration, no undisclosed network egress.
- Recovery drills (incl. Wavelength restore before VTXO batch expiry) are
  release-blocking.
- Autonomous financial testing on regtest/signet only — never mainnet.

## License

MIT — see [LICENSE](LICENSE).
