# Upstream Integrations

Every third-party component this wallet touches, what we pin, and what each
integration is trusted for. Versions below are re-pinned at implementation
time — upstream APIs in this ecosystem move (spec: research artifacts of
2026-10-30).

> **Stub.** Each row gets exact pins, license confirmation, and update policy
> as its integration task lands.

| Component | Role | Verified version (2026-10-30) | Pin policy | Trust boundary |
| --- | --- | --- | --- | --- |
| litd | Mode B engine — LND + tapd + Loop + Pool + Faraday in one binary | v0.17.8 (bundles LND v0.21.5-beta.rc1, tapd v0.8.6) — re-pinned 2026-10-30: release assets + signed SHA256 manifest verified via GitHub API; checksums locked in `sidecars.lock.json` | Exact tag; release binary + checksum lock (`scripts/fetch-sidecars.mjs`) | Self-hosted daemon; loopback RPC, least-privilege macaroons |
| LND | Node core inside litd | v0.21.x line | Protos vendored at the litd-pinned tag (`lightning.proto` + `walletunlocker.proto`, v0.21.5-beta.rc1); generated TS committed | Breaking-change cadence ~6–12 months |
| Neutrino (CDNSync) | Desktop light-client sync | LND v0.21 | Via litd pin | SPV trust model — disclosed in onboarding |
| Loop / AutoLoop | Liquidity swaps | v0.35.2-beta, production-ready | Via litd pin / go.mod revision at build | Quotes rendered live; budget-governed automation |
| Pool | Liquidity market (optional) | v0.7.0-beta | Feature-detected; behind availability check | Thin market is a first-class UI state |
| Taproot Assets (tapd) | Asset issuance/transfers | v0.8.x line | L1 core; asset channels experimental flag | Seed-only asset recovery impossible — proof backup mandatory |
| Wavelength SDK | Mode A engine | v0.2.0 (first public mainnet, unstable APIs) | Exact version; CI re-pin job | Ark operator + swap server dependencies disclosed verbatim |
| waved | Mode A desktop sidecar — Wavelength Ark client daemon | v0.2.0 (commit b82bd54; `waved --version` verified on Linux) | Exact release asset, per-binary SHA256 pinned in `scripts/fetch-waved.mjs` | Same trust boundary as the Wavelength SDK — Ark operator + swap server; local RPC loopback-only; health server loopback-only |
| Tauri 2 | Desktop shell, sidecars, updater | core 2.12.x | Exact minor | Signed/notarized bundle path; AV false-positive watch |
| React Native | Mobile shell | ≥0.76 New Architecture | Exact version at plan time | No LND-in-app; Mode B via LNC only |

## Rules

- No component ships without a license check (MIT expected; AGPL components
  are not linked, only protocol-compatible where applicable).
- Every network endpoint the wallet contacts is listed here and asserted by
  the egress test — no undisclosed egress, no telemetry.
- Version bumps require an updated golden test of the consumed surface.

## waved sidecar pin (Mode A desktop)

- **Pinned upstream:** `lightninglabs/wavelength` release `v0.2.0` — the
  daemon's first public mainnet release. Commit reported by the binary:
  `b82bd54`.
- **Distribution:** fetched at build time by `scripts/fetch-waved.mjs` from
  the upstream release assets; the binary is installed as the Tauri sidecar
  `apps/desktop/src-tauri/binaries/waved-<target-triple>` and is never
  committed to this repository.
- **Hash pinning:** per-binary SHA256 hashes (from the SIGNED release
  manifest `manifest-v0.2.0.txt`, signatures by bhandras + sputn1ck) are
  pinned in `scripts/fetch-waved.mjs`. A download whose hash does not match
  fails the build. The script also runs a `waved --version` smoke when the
  target matches the host.
- **Re-pin procedure:** new upstream release → review its manifest and
  changelog → update `WAVES_VERSION` + `WAVES_SHA256` in
  `scripts/fetch-waved.mjs` → update this row → golden tests of the
  consumed surface must still pass (Wavelength v0.2.0 APIs are explicitly
  unstable).
- **Health contract (verified against v0.2.0 on Linux, 2026-10-30):**
  `--health.listen` serves `/livez` (200 once the daemon is up) and
  `/readyz` (503 until the wallet is initialized). The lifecycle engine
  gates startup on `/livez` only; the UI reads `/readyz` separately —
  "daemon alive" and "wallet ready" are distinct states.
- **Startup flags (fresh install):** default `lwwallet` backend requires
  `--wallet.esploraurl`; an unreachable loopback placeholder still lets the
  daemon initialize and serve health until wallet setup replaces it. The
  `lnd` backend fails startup without an lnd TLS certificate — not used on
  desktop Mode A.
