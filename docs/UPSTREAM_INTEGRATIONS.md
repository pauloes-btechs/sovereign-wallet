# Upstream Integrations

Every third-party component this wallet touches: what is pinned, what it is
trusted for, how it is integrated, and its status in this build.

**Pin policy.** Exact versions for wallet engines and sidecars (hash-locked in
`sidecars.lock.json` and `scripts/fetch-waved.mjs`); range pins for shell/UI
tooling resolved to an exact version in `pnpm-lock.yaml`. Version bumps
require a green golden test of the consumed surface. Upstream APIs in this
ecosystem move — re-pin deliberately, never by accident.

**License policy.** MIT or permissively dual-licensed components only; AGPL
components are not linked. Licenses below were verified from the npm
registry, crates.io, and the upstream signed release manifests (retrieval
dates in §Verification).

**Egress policy.** Every network endpoint the wallet contacts appears in the
`packages/privacy` disclosed registry and is asserted by the egress test —
no undisclosed egress, no telemetry.

## Wallet engines & daemons

| Component | Upstream repo | Version (verified) | Capability | Integration method | License | Dependencies | Platforms | Limitations | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| litd (Lightning Terminal) | `lightninglabs/lightning-terminal` | v0.17.8 — bundles LND v0.21.5-beta.rc1, tapd v0.8.6, Loop/Pool/Faraday; release asset + signed SHA256 manifest verified; hashes locked in `sidecars.lock.json` | Mode B engine: LND node, channels, Loop/Pool liquidity, Taproot Assets, node analytics | Tauri sidecar (`litd-<triple>`), managed by `packages/daemon-lifecycle`; gRPC via protobuf-ts on vendored protos | MIT (full LICENSE read) | Neutrino needs a compact-filter source (our regtest harness uses btcd); full-node mode needs bitcoind | Windows, macOS, Linux (x64/arm64 per lock file) | Remote mode needs external LND ≥ v0.19.0 with `rpcmiddleware.enable`; breaking-change cadence ~6–12 months | Implemented (desktop) |
| LND (inside litd) | `lightninglabs/lnd` | v0.21.5-beta.rc1 (via litd pin) | Node core: on-chain, channels, invoices, SCB backup | Vendored `lightning.proto` + `walletunlocker.proto` at the litd tag → generated TS in `packages/litd-proto` | MIT | gRPC runtime `@grpc/grpc-js` | As litd | `rpc.proto` must be re-pinned per litd release | Implemented |
| Neutrino (CDNSync) | part of LND | v0.21 line | Desktop SPV light-client sync; minutes-scale fresh sync | Via litd pin | MIT | Compact block filters | As litd | SPV trust model — disclosed in onboarding; needs a filter source | Implemented (default backend) |
| Loop / AutoLoop | `lightninglabs/loop` | v0.35.2-beta (bundled in litd; go.mod revision resolved when litd is built) | Loop In/Out swaps + built-in automation | litd gRPC surface, wrapped by `packages/liquidity` | MIT | litd | As litd | Swap costs displayed live; AutoLoop is opt-in, budget-governed | Implemented |
| Pool | `lightninglabs/pool` | v0.7.0-beta (bundled) | Leased inbound liquidity market | litd gRPC surface behind market-availability detection | MIT | litd | As litd | Live market depth unverifiable from docs; thin market is a first-class UI state | Implemented (optional behind availability detection) |
| Taproot Assets (tapd) | `lightninglabs/taproot-assets` | v0.8.6 (bundled in litd v0.17.8; v0.8.8 line verified upstream) | Asset issuance, transfer, proofs | litd gRPC surface (`services/litd-adapter`) | MIT | litd | As litd | Asset channels are experimental (peer lockstep, RFQ oracle, seed-only recovery impossible) — behind a flag, off by default; proof backup mandatory | L1 implemented; asset channels experimental/off |
| Faraday | `lightninglabs/faraday` | v0.2.14-alpha (bundled) | Node/channel analytics | litd gRPC surface | MIT | litd | As litd | Analytics only | Implemented (feeds Mode B health views) |
| Wavelength SDK | `lightninglabs/wavelength` | v0.2.0 (first public mainnet release; APIs explicitly unstable) | Mode A engine: Ark VTXOs, on-chain Bitcoin, swap-based Lightning | `@lightninglabs/wavelength-core` npm package; ALL contact isolated in `services/wavelength-adapter` | MIT | Ark operator + swap server (disclosed verbatim via capability contract) | Browser WASM (documented), React Native; **no documented desktop runtime** | Unstable APIs — CI re-pin job + golden tests of the consumed surface; seed restore must complete before VTXO batch expiry | Implemented (adapter + Mode A flows) |
| waved (Wavelength daemon) | `lightninglabs/wavelength` (same release) | v0.2.0, commit `b82bd54` (`waved --version` verified on Linux 2026-10-30) | Mode A desktop daemon | Tauri sidecar, hash-pinned from the signed upstream release manifest | MIT | Same operator dependencies as the SDK; local RPC + health server loopback-only | Per-triple release assets (linux/mac/win) | No documented desktop runtime upstream — sidecar behavior validated during implementation (AV false positives watched); `lwwallet` backend needs `--wallet.esploraurl` | Implemented (desktop Mode A) |
| LNC (`@lightninglabs/lnc-web`) | `lightninglabs/lnc-web` | 0.3.6-alpha | Mode B mobile: pairing to the user's own litd | npm package in `services/litd-adapter` (dev dep of the mobile stack) | MIT | 10-word pairing phrase, PAKE+Noise relay | Web/Node runtime; used by mobile Mode B | Alpha line; sessions are macaroon-scoped and revocable | Implemented (mobile Mode B) |

## Shell & platform

| Component | Upstream repo | Version (verified) | Capability | Integration method | License | Dependencies | Platforms | Limitations | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tauri 2 | `tauri-apps/tauri` | core 2.x (stable 2.12.x line) | Desktop shell: sidecar bundling, updater, CSP | Rust crate + `@tauri-apps/api` / `cli` npm | Apache-2.0 OR MIT (crates.io) | Rust toolchain; platform WebView | Windows, macOS, Linux | No litd-specific sidecar precedent — Zap Desktop (archived) proved the pattern | Implemented |
| tauri-plugin-shell | `tauri-apps/plugins-workspace` | 2.x (2.6.0 line) | Sidecar process spawn from the shell | Tauri plugin | Apache-2.0 OR MIT (crates.io) | Tauri 2 | As Tauri | Sidecar args are listen-arg fuzzed | Implemented |
| rusqlite + SQLCipher | `rusqlite` crate | 0.39.x, `bundled-sqlcipher-vendored-openssl` feature | Encrypted-at-rest local databases | Rust crate (vendored SQLCipher + OpenSSL build) | MIT (crates.io); SQLCipher BSD-style license upstream | OpenSSL (vendored) | As Tauri | Bundled build adds compile time | Implemented |
| keyring | `open-source-cooperative/keyring-rs` (crate `keyring`) | 3.x (3.6.3 line) | DB key custody in platform secure storage | Per-platform feature gates: `apple-native`, `windows-native`, `linux-native` | MIT OR Apache-2.0 (crates.io) | macOS Keychain / Windows Credential Manager / Secret Service | Per-platform backends | Linux Secret Service requires a keyring daemon | Implemented |
| React Native | `facebook/react-native` | 0.88.1 (New Architecture) | Mobile shell | npm + native projects (`apps/mobile/android`, `apps/mobile/ios`) | MIT | Hermes, JDK 21 (Android), Xcode + CocoaPods (iOS) | Android, iOS | Mode B is LNC-only — no LND-in-app; debug dev builds load JS from Metro | Implemented (dev builds) |
| React | `facebook/react` | 18.3.x (desktop) / 19.3.x (mobile) | UI runtime | npm | MIT | — | — | — | Implemented |

## Domain dependencies

| Component | Upstream repo | Version (verified) | Capability | Integration method | License | Dependencies | Platforms | Limitations | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| protobuf-ts | `timostamm/protobuf-ts` | 2.11.x | gRPC TS client for LND protos | `@protobuf-ts/runtime`, `runtime-rpc`, `grpc-transport` | Apache-2.0 AND BSD-3-Clause (npm) | protoc at generate time | — | grpc-web rejected (no bidi streaming) — desktop uses local gRPC | Implemented |

## Development / test tooling (not shipped)

| Component | Upstream repo | Version | Capability | License | Status |
| --- | --- | --- | --- | --- | --- |
| Vite | `vitejs/vite` | 6.x (desktop) / 7.x (mobile preview) | Frontend bundler | MIT | Implemented |
| Vitest | `vitest-dev/vitest` | 3.2.x | Unit/integration test runner | MIT | Implemented |
| Playwright | `microsoft/playwright` | 1.50.x | Desktop e2e + visual evidence | Apache-2.0 | Implemented |
| Storybook | `storybookjs/storybook` | 10.6.x | UI component workshop | MIT | Implemented |
| btcd (regtest filter source) | `btcsuite/btcd` | v0.26.2 (pinned in CI) | BIP157 compact-filter source for Neutrino tests | MIT | Implemented (test harness only) |

## Unavailable / not integrated

| Component | Reason | Status |
| --- | --- | --- |
| Apple Developer signing / notarization credentials | No certificate exists (external blocker — owner: Pauloes); macOS artifacts ship unsigned with Gatekeeper guidance in [RELEASE](RELEASE.md) | Unavailable — documented blocker |
| Android Play Store / Apple App Store accounts | Same external blocker; dev builds only | Unavailable — documented blocker |
| Store-tier mobile release builds (bundled JS) | Blocked by the same signing/store credentials; debug dev builds are the current artifact | Unavailable — documented blocker |
| grpc-web | Rejected by design — no bidirectional streaming for LND RPC | Not integrated (by design) |
| Telemetry / analytics / account services | Violates the no-telemetry, no-registration invariant | Not integrated (by design) |

## Verification

- litd v0.17.8: GitHub release assets + signed SHA256 manifest checked at
  re-pin time (2026-10-30); hashes committed in `sidecars.lock.json`.
- waved v0.2.0: signed release manifest (`manifest-v0.2.0.txt`, signatures by
  bhandras + sputn1ck) — hashes in `scripts/fetch-waved.mjs`; `--version`
  smoke verified on Linux 2026-10-30; health contract verified against
  v0.2.0 on Linux 2026-10-30.
- npm licenses: `npm view <pkg>@<version> license` (retrieved 2026-10-31).
- Rust crate licenses: crates.io API (retrieved 2026-10-31).
- Lightning Labs component versions/licenses: verified research artifacts
  of 2026-10-30 (litd/LND/Neutrino, Loop/Pool/Taproot Assets, Wavelength).
