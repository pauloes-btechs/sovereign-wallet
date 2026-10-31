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
  mobile/         React Native 0.88, New Architecture + android/ + ios/ shells
packages/
  wallet-core/    Capability-declaring provider contract + domain types
  payments/       Payment intent state machine (reconcile, never re-dispatch)
services/
  wavelength-adapter/  ALL Wavelength SDK contact, isolated
  litd-adapter/        litd/LND gRPC (protobuf-ts, pinned protos)
harness/regtest/ Docker regtest harness (autonomous testing: regtest ONLY)
harness/recovery/ Five release-blocking recovery drills
docs/            Architecture, docs set, release engineering
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

### Mobile native shells

`apps/mobile/android` and `apps/mobile/ios` are committed React Native 0.88
projects wired to the `SovereignWallet` AppRegistry entry in `index.js`:

```sh
pnpm --filter @sovereign/mobile start            # Metro (JS for dev builds)
cd apps/mobile/android && ./gradlew assembleDebug  # debug APK (no signing)
cd apps/mobile/ios && pod install && open SovereignWallet.xcworkspace
```

Debug builds load JS from Metro — they are dev artifacts, not releases.
CI builds both (Android debug APK; unsigned iOS simulator app) and desktop
installers for Windows/macOS with install smoke tests — see
[docs/RELEASE.md](docs/RELEASE.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — two engines, one contract, process model
- [Upstream integrations](docs/UPSTREAM_INTEGRATIONS.md) — full dependency inventory with pins and licenses
- [Wallet recovery](docs/WALLET_RECOVERY.md) — what restores from what, per mode
- [Privacy](docs/PRIVACY.md) — egress disclosure and enforcement
- [Security](docs/SECURITY.md) — trust boundaries and defenses ([review pass](docs/SECURITY_REVIEW.md))
- [Test results](docs/TEST_RESULTS.md) — recovery drill evidence + build verification
- [Release](docs/RELEASE.md) — artifacts, smoke tests, signing status and blockers

## Safety invariants

- Payment intents are persisted **before** dispatch; recovery reconciles,
  never blind re-dispatches.
- No telemetry, no account registration, no undisclosed network egress.
- Recovery drills (incl. Wavelength restore before VTXO batch expiry) are
  release-blocking.
- Autonomous financial testing on regtest/signet only — never mainnet.

## License

MIT — see [LICENSE](LICENSE).
