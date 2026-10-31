# Architecture

How Sovereign Wallet is put together: two swappable wallet engines behind one
interface, a capability-declaring contract that keeps them honest, and the
process/security model that makes it safe to run real funds.

The authoritative product/scope decisions live in the approved spec
(Obvious Blueprint `art_c8VM79Nw`). This document describes what is actually
built in this repository as of the docs set landing (2026-10-31).

## The one-line model

```
┌────────────────────────────────────────────────────────────────────┐
│  UI (React) — renders ONLY what the active provider declares       │
├────────────────────────────────────────────────────────────────────┤
│  Domain layer (TypeScript)                                         │
│    wallet-core   provider contract, capabilities, identity guard   │
│    payments      payment-intent state machine (reconcile-first)    │
│    secure-store  SQLCipher at rest, platform keyring               │
│    privacy       egress policy, Tor transport, endpoint registry   │
│    liquidity     Loop/Pool quotes, AutoLoop budgets, thin market   │
├────────────────────────────────────────────────────────────────────┤
│  Adapters — the ONLY code that touches a backend SDK/API           │
│    wavelength-adapter (@lightninglabs/wavelength-core)             │
│    litd-adapter       (gRPC via protobuf-ts, pinned protos)        │
├────────────────────────────────────────────────────────────────────┤
│  Engine boundary — third-party / operator dependency band          │
│    Mode A: waved sidecar → Ark operator + swap server              │
│    Mode B: litd sidecar → Bitcoin network (+ optional services)    │
└────────────────────────────────────────────────────────────────────┘
```

The boundary invariant: **no code path creates a wallet, balance, or history
under one provider and reads or restores it under another.** Seeds, identities,
balances, and recovery paths are disjoint per provider, enforced by the
contract below and tested (two-nodes-one-seed drill).

## Provider contract (`packages/wallet-core`)

Every backend adapter implements `WalletProvider` and exposes a static,
versioned `WalletCapabilities` declaration:

- what Lightning is here (`lightningMechanism: 'channels' | 'swaps'`) — the UI
  labels Mode A Lightning as "via swap service", never as channels;
- unilateral-exit support, recovery model, asset support;
- `operatorDependencies[]` — every third party required for send/receive/exit/
  recovery, each with a `disclosure` string shown verbatim in onboarding and
  help.

The UI reads the declaration; it never infers parity between backends. When a
provider cannot do something, the corresponding surface is hidden or disabled
at render time, not stubbed.

## Two engines

### Mode A — Wavelength (everyday)

- On-device keys, Ark VTXOs, on-chain Bitcoin; Lightning send/receive via
  atomic swaps with a swap server (never channel-based).
- VTXO lifecycle is a first-class user-visible state machine:
  `fresh → expiring → at-risk → exiting`, with background refresh while the
  operator is reachable and a fee-funded unilateral exit as the fallback.
- Desktop runs `waved` (Wavelength's Go daemon, v0.2.0) as a Tauri sidecar;
  mobile uses the native SDK bindings (`@lightninglabs/wavelength-core`).
- All Wavelength contact is isolated in `services/wavelength-adapter` (a
  spec-locked edge, enforced by lint ignore + golden tests of the consumed
  surface).

### Mode B — litd (advanced)

- Desktop: `litd` v0.17.8 sidecar — LND + tapd + Loop + Pool + Faraday in one
  binary. Neutrino (CDNSync) by default; full-node backend or an existing
  user-controlled remote LND optional.
- Mobile: **LNC-only** to the user's own litd — 10-word pairing phrase,
  PAKE+Noise, macaroon-scoped revocable sessions. No LND-in-app, ever.
  Payments are foreground-only; channel-safety operations that require node
  liveness are labeled desktop-only.
- LND RPC protos are vendored at the litd-pinned tag (`packages/litd-proto`)
  and compiled with protobuf-ts. No grpc-web.

## Process model

Both desktop daemons are sidecars managed by `packages/daemon-lifecycle`:

- fetched at build time by hash-pinned scripts (`scripts/fetch-sidecars.mjs`,
  `scripts/fetch-waved.mjs`) against `sidecars.lock.json` and the signed
  upstream manifests; hashes are committed, binaries never are;
- health-gated startup (`/livez` gates boot; `/readyz` gates "wallet ready");
- local RPC is loopback-only with least-privilege macaroons (litd);
- the Tauri WebView may only `connect-src` to `self` and `127.0.0.1:*`
  (CSP in `apps/desktop/src-tauri/tauri.conf.json`).

## Payments

`packages/payments` owns one state machine shared by both modes:

```
draft → authorized → signing → in-flight → settled
                                  ↘ failed / needs-recovery
```

- The intent (UUIDv4) is persisted in `authorized` **before** dispatch;
  `maxFeeSat` is enforced at authorization.
- On restart, anything found in `signing`/`in-flight` is reconciled against
  the backend (invoice lookup / txid / swap status) before any retry. A
  settled backend result becomes `settled`; an unknown result becomes
  `needs-recovery` with a user-facing explanation.
- **Blind re-dispatch is a test-failing defect** (drill 4 in
  `harness/recovery`).

## Storage & keys

- SQLCipher (bundled, vendored OpenSSL via `rusqlite`) for all local
  databases; the database key lives in the platform secure storage (macOS
  Keychain / Windows Credential Manager / Secret Service) via the `keyring`
  crate, per-platform feature-gated.
- Payment-intent state persists in the same encrypted store
  (`packages/payments` SQLite store).

## Privacy & egress

`packages/privacy` owns the disclosed-endpoint registry and a fail-closed
egress policy engine (Tor transport optional). Two test layers enforce "no
undisclosed network calls":

- a runtime source scan that fails CI if an http(s) host literal appears in
  runtime source outside the registry (this is why even a docs URL in a
  config comment gets removed rather than allow-listed);
- an egress-detection test around the running components.

Details and threat model: [PRIVACY](PRIVACY.md), [SECURITY](SECURITY.md).

## Testing & release gate

- Unit: vitest, every payment-state transition incl. reconcile-not-redispatch.
- Fuzz: deterministic fuzzing of wallet-owned parsers (destination, invoice,
  asset id, listen args) at 100k iterations/seed in CI.
- Integration: Docker Compose regtest harness (`harness/regtest`) with real
  bitcoind + 2×LND + litd; the desktop Mode B e2e boots a real litd sidecar.
- Recovery: `harness/recovery` five-drill suite is the release-blocking gate;
  evidence renders into [TEST_RESULTS](TEST_RESULTS.md).
- Builds: unsigned dev artifacts per platform with install smoke tests —
  see [RELEASE](RELEASE.md).

## Directory map

```
apps/
  desktop/        Tauri 2 + React + Vite; src-tauri holds the Rust shell
  mobile/         React Native 0.88 (New Architecture) + android/ + ios/
packages/
  wallet-core/    provider contract, capabilities, identity guard
  payments/       intent state machine + encrypted intent store
  secure-store/   SQLCipher factory + keyring round-trip
  privacy/        egress policy, endpoint registry, Tor transport
  liquidity/      Loop/Pool quote handling, AutoLoop budget policy
  litd-proto/     pinned LND protos → generated TS
  ui/             presentational components + Storybook
  daemon-lifecycle/ sidecar boot/health/stop engine (waved + litd)
services/
  wavelength-adapter/  ALL Wavelength SDK contact (spec-locked edge)
  litd-adapter/        LND/litd gRPC + Loop/Pool/tapd clients
harness/
  regtest/   Docker Compose regtest environment + bootstrap CLI
  recovery/  five release-blocking recovery drills
scripts/    hash-pinned sidecar fetchers
```
