# Upstream Integrations

Every third-party component this wallet touches, what we pin, and what each
integration is trusted for. Versions below are re-pinned at implementation
time — upstream APIs in this ecosystem move (spec: research artifacts of
2026-10-30).

> **Stub.** Each row gets exact pins, license confirmation, and update policy
> as its integration task lands.

| Component | Role | Verified version (2026-10-30) | Pin policy | Trust boundary |
| --- | --- | --- | --- | --- |
| litd | Mode B engine — LND + tapd + Loop + Pool + Faraday in one binary | v0.17.8 (bundles LND v0.21.5-beta.rc1, tapd v0.8.6) | Exact tag; built from source | Self-hosted daemon; loopback RPC, least-privilege macaroons |
| LND | Node core inside litd | v0.21.x line | Pinned `rpc.proto` per litd release | Breaking-change cadence ~6–12 months |
| Neutrino (CDNSync) | Desktop light-client sync | LND v0.21 | Via litd pin | SPV trust model — disclosed in onboarding |
| Loop / AutoLoop | Liquidity swaps | v0.35.2-beta, production-ready | Via litd pin / go.mod revision at build | Quotes rendered live; budget-governed automation |
| Pool | Liquidity market (optional) | v0.7.0-beta | Feature-detected; behind availability check | Thin market is a first-class UI state |
| Taproot Assets (tapd) | Asset issuance/transfers | v0.8.x line | L1 core; asset channels experimental flag | Seed-only asset recovery impossible — proof backup mandatory |
| Wavelength SDK | Mode A engine | v0.2.0 (first public mainnet, unstable APIs) | Exact version; CI re-pin job | Ark operator + swap server dependencies disclosed verbatim |
| Tauri 2 | Desktop shell, sidecars, updater | core 2.12.x | Exact minor | Signed/notarized bundle path; AV false-positive watch |
| React Native | Mobile shell | ≥0.76 New Architecture | Exact version at plan time | No LND-in-app; Mode B via LNC only |

## Rules

- No component ships without a license check (MIT expected; AGPL components
  are not linked, only protocol-compatible where applicable).
- Every network endpoint the wallet contacts is listed here and asserted by
  the egress test — no undisclosed egress, no telemetry.
- Version bumps require an updated golden test of the consumed surface.
