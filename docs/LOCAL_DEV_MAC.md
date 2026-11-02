# Local development on macOS (external SSD)

Running the repo from `/Volumes/Extreme SSD/sovereign-wallet` and
pushing changes to GitHub (and from there to Vercel).

## 0. Check the drive's file system first

pnpm relies on symlinks and hard links. **exFAT supports neither**, and many
external SSDs ship formatted as exFAT. On exFAT, `pnpm install` will fail or
produce a broken `node_modules`.

```sh
diskutil info "/Volumes/Extreme SSD" | grep "File System Personality"
```

- **APFS** (or Mac OS Extended): you're fine.
- **ExFAT**: either reformat the drive to APFS in Disk Utility (this
  **erases the drive**, so copy everything off first), or keep the code on
  the SSD and put a separate APFS volume/partition on it for dev work.
  exFAT also sprinkles `._*` AppleDouble files everywhere; `.gitignore`
  already ignores them.

## 1. Toolchain (once per Mac)

```sh
# Homebrew: https://brew.sh
xcode-select --install                 # Apple command-line tools (git, clang)
brew install node@22                   # Node ≥ 20 (CI uses 22)
corepack enable                        # gives you the pinned pnpm (10.28.0)
```

For the **desktop app** (Tauri):

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust toolchain
```

For **integration tests / regtest harness**: Docker Desktop, and Go 1.24 for
the btcd filter server (`brew install go`).

For **mobile**: Xcode + CocoaPods (`brew install cocoapods`) for iOS;
Android Studio + JDK 17 for Android.

## 2. Clone (already done) and install

```sh
cd "/Volumes/Extreme SSD/sovereign-wallet"
git pull
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test   # all should be green
```

## 3. Run things

| What | Command | Opens |
| --- | --- | --- |
| Web demo (Mode A, simulated, regtest) | `pnpm web:dev` | http://localhost:5174 |
| Web demo, production build | `pnpm web:build` then `pnpm --filter @sovereign/mobile exec vite preview --config vite.preview.config.ts` | http://localhost:4173 |
| Component catalog (Storybook) | `pnpm --filter @sovereign/ui storybook` | http://localhost:6006 |
| Both Vercel services together | `npx vercel dev -L` (Storybook answers at its own root in dev; see HOSTING) | http://localhost:3000 |
| Desktop app (real sidecars) | `pnpm sidecar:fetch && node scripts/fetch-waved.mjs` (hash-verified litd + waved), then `pnpm --filter @sovereign/desktop tauri dev` | Native window |
| Desktop UI only, in a browser | `pnpm --filter @sovereign/desktop dev` | http://localhost:5173 (shows "Desktop runtime required" without a daemon) |
| Desktop Mode B in a browser | same, then open `/?mode=b` | Node-mode UI |
| Regtest harness | see [harness/regtest/README.md](../harness/regtest/README.md) | Docker |
| Mobile Metro | `pnpm --filter @sovereign/mobile exec react-native start` | Metro bundler |

## 4. The change → ship loop

```sh
git checkout -b feat/my-change
# …edit…
pnpm lint && pnpm typecheck && pnpm test && pnpm web:build
git add -A && git commit -m "feat: …"
git push -u origin feat/my-change
gh pr create --fill          # or open the PR on github.com
```

- CI runs every check on the PR, including the web-preview build.
- Vercel (once connected, see [HOSTING](HOSTING.md)) posts a preview URL on
  the PR.
- Merge to `main` → Vercel updates the production demo URL automatically.

There are no environment variables to set locally or on Vercel.
