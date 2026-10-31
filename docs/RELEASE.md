# Release

How a Sovereign Wallet release is produced, verified, and shipped — and the
external blockers that currently keep it at unsigned dev artifacts.

## Status: unsigned development artifacts

**Every artifact this repository produces today is unsigned and is a
development build** (desktop `--debug` bundles, Android debug APK, iOS
simulator app). This is deliberate, not a shortcut: signing and notarization
credentials do not exist yet, and the build brief's safety boundary forbids
handling credentials we do not have. Nothing about the pipeline is blocked —
the moment credentials exist, the signing steps in §Signing slot in without
process changes.

### External blockers (owner: Pauloes)

| Blocker | Blocks | Consequence while absent |
| --- | --- | --- |
| Apple Developer certificate + notarization credentials | Signed macOS bundles, notarization, App Store | macOS artifacts unsigned — users must right-click → Open on first launch (Gatekeeper); no auto-update trust chain |
| Windows code-signing certificate (EV or OV) | Signed Windows installers | SmartScreen warns on first install; installers unsigned |
| Apple App Store / Google Play accounts | Store distribution, store-tier release builds | Dev builds only; mobile release builds (bundled JS) not produced |

These are recorded in [UPSTREAM_INTEGRATIONS](UPSTREAM_INTEGRATIONS.md) under
"Unavailable".

## What CI produces (every run, attached to the run, 7-day retention)

| Artifact | Job | Content |
| --- | --- | --- |
| `sovereign-wallet-dev-x86_64-pc-windows-msvc` | Desktop dev artifacts (windows-latest) | NSIS setup exe + MSI, debug, unsigned |
| `sovereign-wallet-dev-aarch64-apple-darwin` | Desktop dev artifacts (macos-latest) | dmg + .app, debug, unsigned (Apple silicon) |
| `sovereign-wallet-dev-x86_64-apple-darwin` | Desktop dev artifacts (macos-15-intel) | dmg + .app, debug, unsigned (Intel) |
| `sovereign-wallet-dev-x86_64-unknown-linux-gnu` | Desktop dev artifacts (ubuntu-24.04, best-effort) | deb/AppImage — **never a release blocker** |
| `sovereign-wallet-dev-android` | Android dev build | Debug APK (loads JS from Metro — dev build) |
| `sovereign-wallet-dev-ios-simulator` | iOS dev build | Unsigned simulator .app |
| `modeb-e2e-evidence` | Mode B desktop e2e | Screenshots/recording for UI PRs |
| `recovery-drill-results` | Recovery drills | Drill results JSONL + rendered TEST_RESULTS |

## Install smoke tests

Each desktop lane installs its artifact the way a user would, then asserts
the app and both sidecars landed:

- **Windows:** NSIS silent install (`/S`) **and** MSI silent install
  (`msiexec /qn`); then asserts `Sovereign Wallet.exe`, `litd.exe`, and
  `waved.exe` exist in the install directory.
- **macOS:** mounts the dmg read-only, copies `Sovereign Wallet.app` to
  `/Applications`; then asserts the main executable and `litd`/`waved`
  sidecars are present, and records the codesign state (expected: unsigned).
- **Linux (best-effort):** bundle inventory listing.
- **Android:** APK exists with dex + manifest + arm64 Hermes runtime.
- **iOS:** simulator .app exists with its main binary; bundle id printed.

## Release checklist

1. `main` is green on every required check — including the recovery drill
   suite (the release-blocking gate).
2. Re-pin check: sidecar versions in `sidecars.lock.json` /
   `scripts/fetch-waved.mjs` are the intended tags; golden tests of the
   consumed surface green.
3. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json`, workspace
   `package.json`s, and the desktop Rust crate together.
4. Tag the release; CI attaches the artifact set above to the tag run.
5. Desktop install smoke tests green on Windows and macOS (both
   architectures).
6. Docs accurate for the release: this file's artifact table,
   [TEST_RESULTS](TEST_RESULTS.md) drill table,
   [UPSTREAM_INTEGRATIONS](UPSTREAM_INTEGRATIONS.md) version rows.
7. If any credential blocker was resolved, complete §Signing before shipping.

## Signing (the path, pending credentials)

When credentials exist, add — do not change:

- **macOS:** import the Developer ID Application certificate; set
  `APPLE_CERTIFICATE` + `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` as
  GitHub secrets; Tauri's bundler signs and notarizes the dmg automatically
  when those are present.
- **Windows:** set the certificate as a GitHub secret; pass it to Tauri's
  NSIS/MSI signing configuration.
- **Android:** generate a release keystore; configure `signingConfig`
  release; produce an `.aab` for Play.
- **iOS:** developer identity + provisioning profile; switch the artifact
  job from the simulator SDK to device builds with a bundled JS.

## Known risks to watch at each release

- **Antivirus false positives on sidecar-bearing installers** — flagged
  unverified in stack research; if a major AV engine flags the signed (or
  unsigned) bundle, document the vendor and resolution here.
- **Wavelength API instability** — v0.2.0 APIs are explicitly unstable; any
  Wavelength re-pin re-runs the full Mode A golden + drill set.

## Linux

Best-effort tier per the spec: built if cheap, never a release blocker. The
lane is pinned to `ubuntu-24.04` (`ubuntu-latest` currently resolves to
26.04, where the Tauri GTK/appindicator dev deps are uninstallable) and runs
under `continue-on-error` — a failed Linux lane is reported but cannot block
a release.
