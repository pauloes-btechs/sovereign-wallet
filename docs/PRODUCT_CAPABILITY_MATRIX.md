# Product capability matrix

Audit of what Sovereign Wallet actually does, as of 2026-11-05 (branch
`feat/product-platform`, base `4b5c563`). Evidence comes from reading the
code, the test suites, and running the apps against a real litd v0.17.8 on
regtest. A capability counts as **surfaced** only when a user can discover,
configure, execute, monitor and understand it in the UI. An RPC stub, an
import or a library function with no route to the UI does not count.

## Legend

| Mark | Classification |
| --- | --- |
| ✅ | Fully functional and surfaced in the UI |
| 🟦 | Fully functional, not surfaced in the UI (library code, tested against a real daemon, no route to any screen) |
| 🟨 | Partially implemented |
| 🧪 | Mocked or simulated only |
| ⬜ | Not implemented |
| ⛔ | Unsupported by the current backend, upstream version, or test environment |

Architecture recap: desktop **advanced mode** = React UI → bridge (HTTP,
`services/litd-adapter/src/bridge`) → litd gRPC. Desktop **everyday mode** =
React UI → `waved` REST gateway (Wavelength). Mobile everyday = Wavelength SDK
(simulated client today); mobile advanced = LNC to a remote node.

## LND (advanced mode)

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Create wallet (aezeed) | ✅ | `POST /wallet/seed`, `/wallet/init`; e2e "create" |
| Restore wallet (aezeed + recovery window) | 🟨 | Bridge route + UI exist; the bridge path is never tested (drill 1 uses raw clients) |
| Unlock | 🟨 | Route + UI; no e2e |
| On-chain balance, receive address, send, fee estimate | ✅ | e2e receive + send. Bug: the UI passes the fee-rate input as a confirmation target |
| Taproot (p2tr) receive addresses | ⬜ | Only p2wkh/np2wkh allowed (`session.ts:addressTypeToProto`) |
| UTXO list / coin control | ⬜ | No ListUnspent |
| Lightning pay (BOLT11) + decode | ✅ | e2e outbound. No intent persistence: Mode B bypasses `packages/payments` |
| Create invoice | ✅ | e2e inbound. No QR, no copy button |
| Invoice history / subscribe | ⬜ | Only payments are listed |
| Fee probing before pay (EstimateRouteFee) | ⬜ | User sets a fee cap blind |
| Keysend | ⬜ | |
| Open / list channels | ✅ | e2e |
| Close channel (coop / force) | 🟨 | Route + UI + job polling; no e2e |
| Channel fee policies (UpdateChannelPolicy, FeeReport) | ⬜ | |
| Peers list / connect / disconnect | ⬜ | Connect only inside channel open |
| Forwarding history | 🟨 | Last 7 days, max 100, read-only table |
| Network graph / node lookup | ⬜ | |
| SCB export / restore | 🟨 | Export in e2e; restore route + UI untested through the bridge |
| PSBT channel funding | ⬜ | |

## Chain backend

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Neutrino (BIP157) sync | 🟨 | Works (e2e, integration). UI shows "synced" badges but never names the backend or shows progress |
| bitcoind backend | 🟨 | Config path exists; never run against a real bitcoind backend in tests |
| Remote LND (litd proxy) | 🟨 | Integration test; UI is static instructions only |

## Lightning Loop

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Loop Out / Loop In quotes | 🟦 | `LitdLoopPort`, `LiquidityManager`; no bridge route |
| Execute Loop Out / Loop In | ⛔ on regtest, 🟦 code | Needs the Lightning Labs swap server; CI pins a dead server and asserts the classified failure |
| Swap list / live monitor | 🟦 | `listSwaps`, Monitor stream; no route |
| AutoLoop parameters | 🟨 | Get works; set refused without the swap server; budget guardrails in `packages/liquidity` |
| Static-address Loop In (deposits) | ⬜ | Only mapped as a swap type |
| Swap suggestions (SuggestSwaps) | ⬜ | |
| **Loop daemon running in the shipped app** | ⛔ (bug) | The bridge launches litd without `loop-mode=integrated`, so loopd never starts and every Loop RPC would answer "unknown service" |

## Lightning Pool

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Market snapshot (batch history) | 🟦 | `LitdPoolPort.marketRaw` + `classifyPoolMarket`; unreachable auctioneer → "unavailable" |
| Accounts, orders (bid/ask), leases | ⬜ | |
| Sidecar tickets | ⬜ | |
| **Pool daemon running in the shipped app** | ⛔ (bug) | Same as Loop: no `pool-mode=integrated` |

## Lightning Terminal (litd)

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Sub-server status (litrpc Status) | ⬜ | Readiness inferred from error strings |
| Super macaroon for sub-servers | ⛔ (bug) | The bridge never bakes it, so every sub-server call authenticates with LND's admin macaroon and fails ("signature mismatch after caveat verification") |
| LNC sessions create / list / revoke | 🟦 | `LncSessionManager`, real pairing in integration test; desktop has no UI |

## Taproot Assets

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| List assets / balances | 🟦 | `AssetManager.listAssets/listBalances`; integration-tested |
| Receive address (new / decode) | 🟦 | integration-tested |
| Send + transfer history | 🟦 | Self-transfer integration-tested; external transfers need a proof courier |
| Proof export / verify / backup / restore | 🟦 | Integration + recovery drill 3 |
| Mint (issuance) | 🟦 | Integration-tested |
| Universe sync | ⬜ | |
| Asset channels / RFQ | ⬜ | Deliberately gated off (`assets/experimental.ts`) |
| Any asset UI | ⬜ | One yes/no row in the capability disclosure |

## Faraday

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Channel insights, revenue report | 🟨 | Wired into Node health, but **always fails** (wrong macaroon, see litd row). The e2e accepts "unavailable", which masked it |
| Node audit | ⬜ | |

## Wavelength (everyday mode)

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Create wallet | ✅ | Real waved in CI (persistence test) |
| Unlock | ✅ | Real waved in CI |
| Restore from mnemonic | 🧪 | Mobile UI over the simulated client only; no desktop UI |
| Balances | 🟨 | On-chain buckets hard-zeroed; confirmed boarding + on-chain funds shown as "Lightning spendable" (mislabel). Full breakdown (`getWireBalance`) unused |
| VTXO state / expiry | 🟨 | Real code; desktop hard-codes "fresh", operator reachable, no expiry |
| On-chain receive (boarding) | 🟨 | Real code + UI; only ever exercised as "operator unavailable" |
| On-chain send | 🟨 | Real code + UI; gateway path unverified on the wire |
| Lightning receive / send (swaps) | 🟨 | Real code + UI; unexercised without a swap server |
| Collaborative exit (offboard) | ⬜ | Gateway route exists, unused |
| Unilateral exit + progress | 🟦 | Real code; `onStartExit={null}` on desktop; copy only on mobile |
| Payment history | 🟦 | `list({view:'activity'})`, not surfaced anywhere |
| Fees / quotes in review | 🟨 | Enforced, but desktop review shows no amount or fee |
| Operator / swap-server availability | ⛔ on regtest | No arkd or swap server in the harness; SDK presets cover testnet/testnet4/signet only |
| Mobile everyday mode against a real client | 🧪 | Web preview and tests use `MobileFlowSimulatedClient`; no native client injected |

## LNC (mobile advanced mode)

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Pair with a remote node | 🟨 | Screens + controller; native resolver not wired |
| Pay / create invoice | 🟨 | Pay has no decode/review step before sending |
| Revoke session | 🟨 | Controller method exists, no button |

## Cross-cutting

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Crash-safe payment intents | 🟨 | Engine is real and drill-tested; only Wavelength sends use it |
| Design system | 🟨 | `@sovereign/ui` tokens exist, but the desktop never imports them (shared components render unstyled); three diverging palettes |
| Navigation | ⬜ | No router, no sidebar, no search, no breadcrumbs; one tab bar in Mode B |
| Activity / transaction history | ⬜ | Payments only, last 10 or 20, no search or filters |
| Transfers between rails | ⬜ | |
| Settings | ⬜ | None in any app |
| QR codes, copy buttons, payment URIs | ⬜ | |
| Privacy controls | 🟨 | Egress policy, Tor, SQLCipher exist in packages; no UI |

## What this means for the backlog

Ordered by what unblocks the most product. Each item is implementable now.

1. **Unblock the sub-servers** in the bridge-launched litd: bake the super
   macaroon, start Loop and Pool (`loop-mode`/`pool-mode=integrated`), keep
   their data inside the wallet's data dir, and authenticate Loop, Pool,
   tapd and Faraday with the super macaroon. Fixes Faraday too.
2. **Expose what already works** through the bridge: Loop quotes / swaps /
   monitor / AutoLoop, Pool market, Taproot Assets (list, receive, send,
   proofs, mint), litd sub-server status, LNC sessions, invoice history,
   peers, channel policies, UTXOs, p2tr addresses.
3. **New desktop shell and design system** on one token source shared with
   mobile and Storybook.
4. **Dashboard** with non-double-counted balances, liquidity health and
   insights computed from real state.
5. **Transfers & Swaps** router that only offers routes the backend
   declares, with a full preview and status timeline; **Loop In / Loop Out**
   wizards and swap history.
6. Pool marketplace, channel manager (policies, peers), assets section,
   settings center, then Wavelength fixes (balance mislabel, real VTXO state,
   exits, history, desktop restore) and mobile.

Upstream and environment blockers are listed in
[UPSTREAM_BLOCKERS](#upstream-and-environment-blockers) below.

## Upstream and environment blockers

Researched 2026-11-05 against Lightning Labs docs and source (links in
[UPSTREAM_INTEGRATIONS](UPSTREAM_INTEGRATIONS.md)).

| Area | Fact | Consequence |
| --- | --- | --- |
| Loop on regtest | Lightning Labs publishes `lightninglabs/loopserver`, a regtest-only swap server (binary only), wired with aperture (L402) in `loop/regtest/docker-compose.yml` | Real Loop In / Loop Out / static-address journeys **can** be verified on regtest, but only where Docker Hub is reachable (GitHub Actions). This dev environment cannot pull it |
| Loop on signet / testnet | loopd has built-in `signet.swap.lightning.today` and `test.swap.lightning.today` endpoints | Unverified whether they are online |
| Static-address Loop In | Standard since Loop v0.29; MuSig2 taproot address, 250k sat minimum; static-address *autoloop* is `--experimental` | Implement deposits → Loop In; keep static autoloop off |
| AutoLoop | One direction at a time (`--type in|out`); `SuggestSwaps` is the dry run | UI enforces a single direction and offers a dry run |
| Pool | No public regtest auctioneer; poold has no signet; testnet auctioneer status unverified; no official deprecation, but low activity | Pool journeys can only be verified to "market unavailable" in this environment. Marked **unverified** |
| Taproot Assets | Works fully on regtest with a local universe / proof courier; asset channels need integrated litd, protocol flags and a (mock) price oracle | Single-node mint / send / receive / proofs verifiable; asset channels stay gated |
| Faraday via litd | Sub-servers accept their own macaroon or a litd **super macaroon**; LND's admin macaroon fails with "signature mismatch" | Root cause of the Faraday bug; fixed by baking the super macaroon |
| litd sub-server status | `litrpc.Status/SubServerStatus` (since v0.11) returns running / disabled / error per sub-server | Replace error-string readiness guessing with this RPC |
| Wavelength | No public regtest Ark operator or swap server; SDK presets cover testnet, testnet4 and signet | Everyday-mode money movement can't be verified on regtest; needs signet with Lightning Labs' operator (unverified availability) |
| Polar | Supports litd up to 0.16 and disables Loop/Pool | Not useful for Loop/Pool testing |
