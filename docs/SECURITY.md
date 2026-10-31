# Security

The security model: what the wallet defends, where the trust boundaries are,
and how each defense is tested. Findings from the adversarial review pass are
tracked in [SECURITY_REVIEW](SECURITY_REVIEW.md).

## Trust boundaries

| Boundary | Untrusted side | Defense |
| --- | --- | --- |
| Destination strings (pasted addresses, invoices, asset IDs) | User input, clipboard | Wallet-owned parsers (no third-party parse), strict BIP-173/BIP-350/BOLT-11 validation, deterministic fuzzing in CI |
| Third-party dependency band (Ark operator, swap server, relay) | The network | Disclosed verbatim via the provider contract; fail-closed egress policy; nothing auto-executes |
| Sidecar processes | Local machine boundary | Hash-pinned from signed upstream manifests (`sidecars.lock.json`, `scripts/fetch-waved.mjs`); loopback-only listeners (listen-args fuzzed); least-privilege macaroons for litd RPC |
| WebView → system | Renderer compromise | Tauri CSP `default-src 'self'; connect-src 'self' http://127.0.0.1:*` — the renderer can only reach itself and loopback daemons |
| Data at rest | Device theft, other local processes | SQLCipher (bundled, vendored OpenSSL) for every database; DB key in platform secure storage (Keychain / Credential Manager / Secret Service) via per-platform keyring backends |
| Payment dispatch | Crashes, replays | Intent persisted pre-dispatch; restart reconciles against the backend — blind re-dispatch is a test-failing defect |
| Seed material | Everything | Seeds never leave the wallet process; never logged; never transmitted — recovery is always user-initiated file/phrase entry |

## Supply chain

- **Sidecar binaries** (litd, waved) are never committed. They are fetched at
  build time from upstream releases and verified against SHA256 hashes copied
  from upstream *signed* manifests; a hash mismatch fails the build.
- **Protos** are vendored at the litd-pinned tag — no codegen drift.
- **Dependency audit** (`pnpm audit --prod`, high threshold) and **secret
  scan** (gitleaks, full history) gate every PR in CI.

## Cryptographic choices

- SQLCipher with vendored OpenSSL — no system-LIB crypto variance.
- LNC pairing: PAKE + Noise — the pairing phrase never crosses the wire.
- Macaroons scope litd permissions per session; sessions are revocable.

## Hardening details already in the build

- Loopback-only sidecar listeners, enforced and fuzzed
  (`packages/daemon-lifecycle`, listen-args parser fuzz).
- Fail-closed egress policy engine + disclosed endpoint registry
  (`packages/privacy` — see [PRIVACY](PRIVACY.md)).
- Encrypted durable payment-intent store (`packages/payments` SQLite store).
- Identity guard refusing duplicate live registration of the same seed
  (`packages/wallet-core`).

## Verification layers

1. Unit tests for every payment-state transition, including
   reconcile-not-redispatch.
2. Deterministic fuzzing (destination, invoice, asset-id, listen-args
   parsers) — 100k iterations per seed in CI, seeds fixed so failures are
   reproducible locally.
3. Regtest integration suite against real bitcoind + LND + litd.
4. Recovery drill suite (release-blocking) — see
   [WALLET_RECOVERY](WALLET_RECOVERY.md).
5. Adversarial review pass — findings and triage in
   [SECURITY_REVIEW](SECURITY_REVIEW.md).

## Reporting a vulnerability

This is an open-source (MIT) project. Report vulnerabilities privately to
**pauloes@btechs.io** rather than in a public issue; include reproduction
steps and affected components. Regtest-only reproduction instructions are
appreciated — never test against mainnet funds.
