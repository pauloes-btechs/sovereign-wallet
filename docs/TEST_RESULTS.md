# TEST_RESULTS — Recovery drills (release-blocking)

Every wallet release requires a green run of the dedicated recovery drill suite
(`harness/recovery`) in CI. The five drills exercise the recovery paths the spec
marks release-blocking, each in a disposable regtest environment, and render
their evidence into this file.

Run locally with Docker + a fetched litd sidecar (`pnpm sidecar:fetch`):

```sh
pnpm --filter @sovereign/harness-recovery test:integration
```

The suite renders the results table below on every run. Regtest/signet only —
the drills are destructive by design (they wipe node data dirs) and guarded by
an on-node chain assertion.

Drills:

1. **LND aezeed + SCB restore** — capture a wallet's seed and static channel
   backup, wipe the node, restore from seed + SCB, force-close the restored
   channel with the peer down, and watch the funds return on-chain.
2. **Wavelength seed restore before VTXO batch expiry** — restore the seed on a
   fresh daemon before expiry; then the operator-unreachable fallback: the
   operator-side scan fails, the wallet's own encrypted backup rebuilds VTXO
   state, and the unilateral exit carries the funds on-chain.
3. **Taproot asset backup restore** — the LND seed alone restores no asset
   state; the exported tapd wallet backup must import and the proofs must
   re-verify on-chain.
4. **Interrupted-payment recovery** — payment intents persisted in-flight
   before dispatch are reconciled against the real LND on restart. A settled
   payment is recognized and never re-dispatched; a payment that never reached
   the backend returns to authorized for one safe, re-signed retry.
5. **Two LND nodes, one seed** — initializing two live nodes from the same
   seed yields identical identity keys, and the wallet-core identity guard
   refuses the second registration before funds can be double-spent.

## Release engineering evidence (2026-10-31)

Beyond the drills, the CI run attached to each PR verifies the build
deliverables. Evidence lives as run artifacts (7-day retention) —
see [RELEASE](RELEASE.md) for the artifact table.

| Deliverable | CI job | Evidence |
| --- | --- | --- |
| Windows installer (NSIS + MSI, debug, unsigned) | Desktop dev artifacts (windows-latest) | Uploaded bundle + install smoke test: NSIS `/S` and MSI `/qn` installs succeed; `Sovereign Wallet.exe` + `litd.exe` + `waved.exe` present |
| macOS bundle (dmg, debug, unsigned — Apple silicon + Intel) | Desktop dev artifacts (macos-latest / macos-15-intel) | Uploaded bundle + install smoke test: dmg mounts, app copies to /Applications, main binary + `litd` + `waved` present, codesign state recorded (unsigned) |
| Linux bundle (best-effort tier) | Desktop dev artifacts (ubuntu-24.04, `continue-on-error`) | Bundle inventory; never a release blocker |
| Android dev build | Android dev build (debug APK) | APK with dex + manifest + arm64 Hermes runtime, uploaded |
| iOS dev build | iOS dev build (simulator, unsigned) | Simulator .app with main binary; `CODE_SIGNING_ALLOWED=NO` |
| Parser robustness | Fuzz job | 100k iterations/seed on destination, invoice, asset-id, listen-args parsers |
| Egress discipline | Build & unit tests (egress scan) + integration suite | Source-scan test (no undisclosed host literals) + runtime egress-detection test |
| Supply chain | Dependency audit + Secret scan + sidecar hash checks | `pnpm audit --prod` (high threshold); gitleaks full history; sidecar SHA256 vs signed manifests |

Signing/notarization: **not verifiable — no credentials exist** (documented
external blocker, owner: Pauloes; see [RELEASE](RELEASE.md)). Smoke tests
therefore assert install correctness and sidecar presence, not signatures.

<!-- recovery-results:start -->

Rendered: 2026-10-31T05:26:58.423Z · drills recorded: 3

| Drill | Title | Result | Environment | Duration | Steps |
| --- | --- | --- | --- | --- | --- |
| `drill-2-wavelength-seed-restore-before-expiry` | Wavelength seed restore before VTXO batch expiry (fresh daemon) | ✅ pass | simulated waved daemon + shared operator indexer (regtest-only) | 0.0s | 6 |
| `drill-2-negative-expired-restore` | Seed restore AFTER batch expiry recovers nothing off-chain (negative leg) | ✅ pass | simulated waved daemon + shared operator indexer (regtest-only) | 0.0s | 4 |
| `drill-2-operator-unreachable-fallback` | Operator-unreachable restore → local encrypted backup → unilateral exit | ✅ pass | simulated waved daemon + shared operator indexer (regtest-only) | 0.0s | 7 |

### drill-2-wavelength-seed-restore-before-expiry — Wavelength seed restore before VTXO batch expiry (fresh daemon)

Result: **pass** (environment: simulated waved daemon + shared operator indexer (regtest-only))

1. started daemon A on regtest
2. created fresh wallet A (identity sim-69eb6d76f44594b7…)
3. deposited a 100k-sat VTXO batch (expires in 40 blocks); operator holds it in a live batch
4. restored the seed on daemon B with recoverState=true (pre-expiry)
5. operator-side scan rebuilt 1 VTXO; identity matches daemon A (sim-69eb6d76f44594b7…)
6. restored VTXO classifies fresh — spendable well inside the free-refresh window

### drill-2-negative-expired-restore — Seed restore AFTER batch expiry recovers nothing off-chain (negative leg)

Result: **pass** (environment: simulated waved daemon + shared operator indexer (regtest-only))

1. wallet funded with a 60k-sat VTXO expiring in 2 blocks
2. 3 blocks mined — the VTXO batch expired
3. operator-side scan found 0 live batches — the seed alone rebuilt no VTXO state
4. the off-chain path is unrecoverable after expiry — only a unilateral exit remains (exercised in the next drill)

### drill-2-operator-unreachable-fallback — Operator-unreachable restore → local encrypted backup → unilateral exit

Result: **pass** (environment: simulated waved daemon + shared operator indexer (regtest-only))

1. wallet funded (80k-sat VTXO) and the local encrypted backup captured
2. operator-unreachable restore scan FAILED as designed — the seed alone cannot rebuild VTXO state
3. the wallet exists (keys work) but holds zero VTXOs — no operator, no state
4. local encrypted backup rebuilt the 80k-sat VTXO — inventory restored without the operator
5. exit readiness gates on a funded fee source — 900 sats backing makes the exit feasible
6. unilateral exit STARTED (operator still unreachable — wallet-side operation)
7. exit completed on-chain — sweep tx sweep-tx-2, funds out of the operator's hands
