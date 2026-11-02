# Upstream watch & the replayed desktop demo

Lightning Labs ships often (litd, LND, Loop, Pool, Taproot Assets, Faraday,
Wavelength). This repo answers two questions about every release, without
anyone having to remember to check:

1. **Does Sovereign Wallet still work on it?** The weekly workflow
   `.github/workflows/upstream-watch.yml` checks, and reports in a GitHub issue.
2. **What does the product look like on it?** The hosted `/desktop/` demo
   replays real responses recorded from the real stack, refreshed from that
   same run.

Lightning Labs does not host public APIs. Their APIs are the gRPC/REST
surfaces of software you run (litd bundles LND + Loop + Pool + tapd +
Faraday; Wavelength ships `waved` and the `@lightninglabs/wavelength-core`
SDK). So "testing against their APIs" means running those binaries on
**regtest** (fake coins by design) and driving our real code against them.

## The weekly run

Mondays 14:17 UTC, or on demand: **Actions → Upstream watch → Run workflow**
(optionally with a specific litd tag).

| Job | What it does | Catches |
| --- | --- | --- |
| `api` | Lists release tags (public git), reads the newest litd's `go.mod` to learn which LND / tapd / Loop / Pool / Faraday it bundles, fetches all 13 vendored `.proto` files at those revisions, and diffs them **semantically** (RPCs, messages, fields, enums) against `packages/litd-proto/protos`. Then vendors them, regenerates the gRPC clients, runs `pnpm typecheck` and `pnpm test`. | Removed / renamed / retyped fields and RPCs, with the places our litd-facing code references the field; compile errors in our code. |
| `integration` | Boots the docker regtest harness on the **new** litd + LND images and fetches the new litd sidecar (hashes from its release manifest), then runs `pnpm test:integration`. | Runtime breakage in the adapter: wallet, channels, Loop, Pool, tapd, Neutrino. |
| `e2e` | Same harness; runs the real desktop node-mode e2e (UI → bridge → litd) with the recorder on, rebuilds the demo fixture and diffs it against the committed one. | UI flows that break; any change in the shape, status or state of what the UI receives. |
| `waved` | Fetches the newest `waved` (hash from its manifest) and runs the real-daemon lifecycle tests. | Wavelength daemon boot / health / wallet-persistence regressions. |
| `report` | Opens one issue per release set (label `upstream-watch`), or updates it on re-runs. | — |

The issue starts with a verdict: **compatible** (safe to bump), **api-breaking**
(upstream broke API, but nothing we exercise fails) or **broken** (something
we run fails), followed by the pins vs. latest table, what the new litd
bundles, the per-proto change list, and the desktop-response diff.

Nothing is pushed or bumped automatically. The canary binaries are verified
against the hashes in their release manifests but **not** the manifest
signatures; shipping pins (`sidecars.lock.json`, `scripts/fetch-waved.mjs`)
are still moved by hand against the signed manifests.

### Run the checks locally

```sh
node scripts/upstream-watch/check.mjs --out=upstream-watch-out      # API surface report (≈1 min)
node scripts/upstream-watch/check.mjs --litd=v0.17.10 --write-protos # vendor a release's protos
pnpm --filter @sovereign/litd-proto generate && pnpm typecheck        # …and see what stops compiling
```

## The replayed `/desktop/` demo

- **Recording:** `apps/desktop/e2e/modeb/recorder.ts` hooks the Mode B e2e.
  With `SOVEREIGN_RECORD_DIR` set, every bridge response the UI receives is
  appended to `modeb-traffic.jsonl`. Wallet setup routes (seed words,
  passwords), request bodies and the bearer token are never recorded.
- **Fixture:** `node scripts/demo/build-fixtures.mjs --in=…jsonl` keeps the last
  successful response per route (the end state: funded wallet, open channel,
  payments, diagnostics, backup) in `apps/desktop/src/demo/fixtures/modeb.json`,
  with the litd and LND versions it came from.
- **Replay:** the demo build (`VITE_SOVEREIGN_DEMO=replay`, set only by the
  Vercel `desktop` service) runs the unmodified `BridgeClient` and screens over
  an in-page transport that answers from the fixture. Calls the recording
  never made return an explicit 501. The Tauri app and every other build
  compile the replay code out (verified: no demo code in the normal bundle).
- **Refresh:** every CI run of the Mode B e2e on `main` uploads a
  `demo-fixture` artifact, and the weekly watch uploads
  `upstream-watch-demo-fixture` for the new release. Replace the committed
  fixture with it to update the hosted demo.

The committed fixture was first recorded on 2026-11-02 from real litd v0.17.8
(LND 0.21.5-beta.rc1) on a local stand-in chain (btcd regtest + a
standalone LND peer). CI recordings use the docker harness (bitcoind).

## First findings (2026-11-02)

- **litd v0.17.10** (bundles LND v0.21.6-beta, tapd v0.8.8, Loop v0.35.2,
  Pool v0.7.2, Faraday v0.2.20): all 13 vendored protos unchanged; the full
  desktop node-mode scenario passed and every UI response kept its shape.
  Compatible.
- **waved v0.2.1**: all 13 real-daemon lifecycle tests pass. Compatible.
- **Faraday is unavailable in the bridge on both versions**: on v0.17.8 calls
  fail with `invalid macaroon: verification failed: signature mismatch after
  caveat verification`; on v0.17.10 with `faraday is not yet ready for
  requests…`. The diagnostics pane shows its honest "unavailable" state, and
  the e2e accepts that, so this was invisible until now. Worth fixing in
  `services/litd-adapter/src/bridge/session.ts` (macaroon used for frdrpc,
  and readiness wait).
