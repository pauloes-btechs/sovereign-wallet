# Hosting & distribution

Where each surface of Sovereign Wallet runs, what it costs, and which
secrets (if any) it needs. The short version: **a noncustodial wallet has
no server to host.** Keys, seeds and node state live on the user's device,
so "hosting" here means three things: a public web demo, a place to ship
signed installers, and CI to build them.

## Surface map

| Surface | What it is | Where it runs | Cost | Secrets |
| --- | --- | --- | --- | --- |
| **Web demo** | Mode A mobile app over react-native-web, simulated Wavelength client, regtest | **Vercel** (Hobby) | Free | None |
| **Desktop app** | Tauri 2 shell + `waved`/`litd` sidecars | User's machine; installers on **GitHub Releases** | Free | Signing certs (later) |
| **Android** | React Native 0.88 | Device; APK on GitHub Releases or Firebase App Distribution → Play Store later | Free → $25 one-time (Play) | Release keystore (later) |
| **iOS** | React Native 0.88 | Simulator now; TestFlight → App Store later | $99/yr (Apple Developer) | Apple signing identity (later) |
| **CI / builds** | Lint, typecheck, tests, fuzz, regtest integration, recovery drills, installers | **GitHub Actions** | Free (public repo) | Signing secrets (later) |
| **Local Lightning dev** | bitcoind + LND + litd on regtest | Your Mac via Docker (`harness/regtest`), or **Polar** | Free | Throwaway local creds only |

The Apple Developer Program ($99/yr) is the one paid item, and it covers both
macOS notarization and iOS distribution. Everything else is free.

## Web demo: Vercel

### What gets deployed

`apps/mobile` contains a web preview entry (`src/preview.tsx`) that mounts the
**real** Mode A app (the provider, payment engine, controller and the same RN
screens the native shells use) over `react-native-web`, driven by the harness's
in-memory simulated Wavelength client on **regtest**. It makes no network
calls and handles no real funds. A banner at the top of the page says so.

It is a demo of the product, **not a web wallet**. A browser-hosted
key-holding wallet would be a different security model (supply chain,
extension injection, storage) and is out of scope.

### Configuration (already in the repo)

`vercel.json` at the repo root:

- `installCommand`: `pnpm install --frozen-lockfile` (Vercel reads the pnpm
  version from `packageManager`)
- `buildCommand`: `pnpm web:build`, which builds the workspace packages the
  mobile app depends on, then runs `vite build --config vite.preview.config.ts`
- `outputDirectory`: `apps/mobile/dist`
- Security headers on every response: a strict CSP (`default-src 'none'`,
  `connect-src 'self'`, `frame-ancestors 'none'`), `no-referrer`, `nosniff`,
  a locked-down `Permissions-Policy`, COOP, and `noindex`. The full
  onboarding → backup → verify → home flow was verified under this exact CSP
  with zero console errors.

### Environment variables

**None.** The demo has no backend, no API keys and no analytics. That's
deliberate and in line with the product's no-telemetry invariant
([PRIVACY](PRIVACY.md)). If a variable ever appears here, it should be
public-by-design (e.g. `VITE_NETWORK=regtest`), because anything in a
client bundle is readable by every visitor. Never put a secret in a Vercel
env var that a Vite build can read.

### One-time setup

1. Sign in at vercel.com with GitHub → **Add New… → Project** → import
   `pauloes-btechs/sovereign-wallet`.
2. Leave **Root Directory** as the repo root (`vercel.json` drives the rest).
   Framework preset: *Other*.
3. Deploy. Every push to `main` then updates production, and every PR gets a
   preview URL that Vercel comments on the PR.

The CI job **Web preview build (Vercel target)** runs the same build command,
so a red check means the deploy would fail too.

### Alternatives (also free)

- **Cloudflare Pages**: same build command and output dir; headers go in
  `apps/mobile/public/_headers`. Unlimited bandwidth on the free tier.
- **GitHub Pages**: works for a static demo via an Actions workflow, but
  custom response headers (CSP) are not supported, so it's a weaker fit.

Vercel's Hobby plan is for personal, non-commercial use. If the project
becomes a commercial product, move to Pro or to Cloudflare Pages.

## Desktop: GitHub Actions + GitHub Releases

CI already builds unsigned dev installers for macOS (Apple silicon + Intel),
Windows (NSIS + MSI) and Linux (best-effort), with install smoke tests
([RELEASE](RELEASE.md)). To ship:

1. On a version tag, upload those artifacts to a **GitHub Release** (or switch
   the desktop lanes to `tauri-apps/tauri-action`, which builds and attaches
   them to a draft release in one step).
2. Optional: enable the **Tauri updater** plugin pointed at the release's
   `latest.json`. That needs an updater keypair (`TAURI_SIGNING_PRIVATE_KEY`
   as a GitHub secret).
3. When credentials exist, add the GitHub secrets listed in
   [RELEASE §Signing](RELEASE.md#signing-the-path-pending-credentials):
   `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`,
   `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`, plus a Windows code-signing
   cert.

There is no Vercel role for the desktop app. Its UI is bundled into the
binary and talks only to loopback sidecars (see the Tauri CSP in
`apps/desktop/src-tauri/tauri.conf.json`).

## Mobile

- **Android now:** the CI debug APK (loads JS from Metro, so it's a dev build).
  For testers, produce a release APK with a bundled JS and share it through
  GitHub Releases or **Firebase App Distribution** (free). Play Store later
  ($25 one-time) with an `.aab` and a release keystore stored as a GitHub
  secret.
- **iOS now:** the CI simulator build. For real devices, you need the Apple
  Developer Program, then **TestFlight** (free with the program).

## Local Lightning development

- **`harness/regtest`** (in repo): Docker Compose with bitcoind 27, two LNDs and
  litd v0.17.8. It's what CI and the recovery drills use. Needs Docker Desktop.
- **Polar** (lightningpolar.com): a desktop GUI for spinning up regtest
  LND/litd networks with one click. Good for poking at Mode B by hand
  (channels, Loop, Taproot Assets) alongside the scripted harness.
- **Signet** is the next step for public testing with other people. Mainnet
  stays off until there's an explicit product sign-off (see the safety
  invariants in the README).

## Secrets inventory

| Secret | Lives in | Needed for | Status |
| --- | --- | --- | --- |
| *(none)* | Vercel | Web demo | n/a |
| `APPLE_*` (5) | GitHub Actions secrets | macOS sign + notarize | Pending Apple Developer account |
| Windows signing cert | GitHub Actions secrets | Signed installers | Pending |
| `TAURI_SIGNING_PRIVATE_KEY` | GitHub Actions secrets | Desktop auto-update | Optional |
| Android release keystore | GitHub Actions secrets | Play / release APK | Pending |
| Regtest macaroons/certs | `harness/regtest/data/` (gitignored) | Local + CI tests | Throwaway, never committed |

`.env` and `.env.*` are gitignored. Nothing in this repo needs a `.env` today.
