#!/usr/bin/env bash
# Local Loop on regtest: a real swap server for the desktop app on your machine.
# Regtest only — the coins are worthless and nothing touches Lightning Labs'
# hosted servers.
#
#   scripts/dev/loop-regtest.sh start     build + start the swap server, launch a bridge pointed at it
#   scripts/dev/loop-regtest.sh fund ADDR send 1 regtest BTC to ADDR and mine 6 blocks
#   scripts/dev/loop-regtest.sh mine [N]  mine N blocks (default 6)
#   scripts/dev/loop-regtest.sh info      swap server node pubkey/host, bridge URL for the app
#   scripts/dev/loop-regtest.sh stop      stop the bridge and remove the regtest containers
#
# Why from source: the lightninglabs/loopserver Docker image can no longer be
# pulled. lightninglabs/loop PR #1222 builds a regtest server from the loop
# repo; this uses the same pinned commit as .github/workflows/loop-wallet-path.yml
# (keep LOOP_REF in step with it).
#
# Differences from CI, for Docker Desktop on macOS (container IPs are not
# reachable from the host): bitcoind P2P and the server's Lightning port are
# published on loopback, on ports that don't collide with harness/regtest
# (127.0.0.1:18544 and 127.0.0.1:19835). This is a separate regtest chain from
# harness/regtest, so the bridge gets its own data dir and wallet.
#
# Needs: Docker (Desktop) running, jq, git, node, `pnpm build`, `pnpm sidecar:fetch`.
set -Eeuo pipefail

LOOP_PR=1222
LOOP_REF=3d10930491713c1ee2f9957316747da9a3813072
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="${SOVEREIGN_LOOP_REGTEST_DIR:-$HOME/.sovereign/loop-regtest}"
LOOP_DIR="$STATE/loop-upstream"
BRIDGE_PORT="${BRIDGE_PORT:-8792}"
BITCOIND_P2P=127.0.0.1:18544
LNDSERVER_P2P=127.0.0.1:19835
APERTURE=aperture:11018

fail() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }
compose() { docker compose -p regtest -f "$LOOP_DIR/regtest/docker-compose.yml" -f "$STATE/host-ports.yml" "$@"; }
# Upstream's regtest.sh with our port override added to each compose call.
rt() { "$LOOP_DIR/regtest/regtest-host.sh" "$@"; }

fetch_loop() {
  if [[ "$(git -C "$LOOP_DIR" rev-parse HEAD 2>/dev/null || true)" == "$LOOP_REF" ]]; then return; fi
  rm -rf "$LOOP_DIR"
  git init -q "$LOOP_DIR"
  git -C "$LOOP_DIR" remote add origin https://github.com/lightninglabs/loop.git
  git -C "$LOOP_DIR" fetch -q --depth 1 origin "refs/pull/$LOOP_PR/head"
  local actual
  actual="$(git -C "$LOOP_DIR" rev-parse FETCH_HEAD)"
  [[ "$actual" == "$LOOP_REF" ]] \
    || fail "loop PR #$LOOP_PR head is $actual, expected the pinned $LOOP_REF (update both this script and the CI workflows after reviewing it)"
  git -C "$LOOP_DIR" checkout -q "$LOOP_REF"
}

write_host_script() {
  # regtest.sh's `start` runs `down`/`up --build` with only its own compose
  # file, which would drop the published ports. Use a copy that adds ours.
  local src="$LOOP_DIR/regtest/regtest.sh" dst="$LOOP_DIR/regtest/regtest-host.sh"
  local n
  n="$(grep -c -- '-f "${COMPOSE_FILE}")' "$src" || true)"
  [[ "$n" == 2 ]] || fail "upstream regtest.sh changed shape (expected 2 compose calls, found $n); update this script"
  sed "s|-f \"\${COMPOSE_FILE}\")|-f \"\${COMPOSE_FILE}\" -f \"$STATE/host-ports.yml\")|" "$src" > "$dst"
  chmod +x "$dst"
}

write_override() {
  cat > "$STATE/host-ports.yml" <<EOF
# Written by scripts/dev/loop-regtest.sh: publish what a host-side wallet needs.
services:
  bitcoind:
    ports: ["$BITCOIND_P2P:18444"]
  lndserver:
    ports: ["$LNDSERVER_P2P:9735"]
EOF
}

check_aperture_name() {
  # loopd checks aperture's TLS certificate against the name "aperture",
  # exactly as upstream's own loop client does, so that name must point here.
  local resolved
  resolved="$(node -e "require('dns').lookup('aperture',4,(e,a)=>console.log(e?'':a))")"
  [[ "$resolved" == 127.0.0.1 ]] && return
  fail "the name 'aperture' must resolve to 127.0.0.1. Add it once with:
  echo '127.0.0.1 aperture' | sudo tee -a /etc/hosts"
}

litd_binary() {
  local triple
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) triple=aarch64-apple-darwin ;;
    Darwin-x86_64) triple=x86_64-apple-darwin ;;
    Linux-x86_64) triple=x86_64-unknown-linux-gnu ;;
    Linux-aarch64) triple=aarch64-unknown-linux-gnu ;;
    *) fail "unsupported platform $(uname -sm)" ;;
  esac
  local bin="$REPO_ROOT/apps/desktop/src-tauri/binaries/litd-$triple"
  [[ -x "$bin" ]] || fail "litd sidecar missing at $bin — run: pnpm sidecar:fetch"
  echo "$bin"
}

stop_bridge() {
  if [[ -f "$STATE/bridge.pid" ]]; then
    kill "$(cat "$STATE/bridge.pid")" 2>/dev/null || true
    rm -f "$STATE/bridge.pid"
  fi
}

start_bridge() {
  local bridge="$REPO_ROOT/services/litd-adapter/dist/bridge/main.js"
  [[ -f "$bridge" ]] || fail "bridge not built — run: pnpm build"
  stop_bridge
  # The swap server keeps its state in memory and `regtest.sh start` recreates
  # the chain, so a wallet from an earlier run would point at blocks that no
  # longer exist. Start the wallet fresh with the chain.
  rm -rf "$STATE/litd" "$STATE/bridge.json"
  docker cp aperture:/root/.aperture/tls.cert "$STATE/aperture-tls.cert"
  node "$bridge" --launch \
    --litdBinary="$(litd_binary)" --dataDir="$STATE/litd" --network=regtest \
    --backend=neutrino --peer="$BITCOIND_P2P" --port="$BRIDGE_PORT" \
    --bootstrap="$STATE/bridge.json" \
    --loopServer="$APERTURE" --subServerArg="loop.server.tlspath=$STATE/aperture-tls.cert" \
    > "$STATE/bridge.log" 2>&1 &
  echo $! > "$STATE/bridge.pid"
  local deadline=$((SECONDS + 120))
  until [[ -s "$STATE/bridge.json" ]]; do
    [[ $SECONDS -lt $deadline ]] || fail "bridge did not start; see $STATE/bridge.log"
    sleep 2
  done
}

info() {
  local pubkey token
  pubkey="$(rt lndserver getinfo | jq -r '.identity_pubkey')"
  echo
  echo "Swap server's Lightning node (open your channel to it):"
  echo "  pubkey: $pubkey"
  echo "  host:   $LNDSERVER_P2P"
  if [[ -s "$STATE/bridge.json" ]]; then
    token="$(jq -r '.token' "$STATE/bridge.json")"
    echo
    echo "Bridge (Loop -> $APERTURE): http://127.0.0.1:$BRIDGE_PORT  log: $STATE/bridge.log"
    echo "Open the desktop dev app with:"
    echo "  ?devBridgeUrl=http://127.0.0.1:$BRIDGE_PORT&devBridgeToken=$token"
  fi
}

case "${1:-}" in
  start)
    need docker; need jq; need git; need node
    docker info >/dev/null 2>&1 || fail "Docker is not running"
    mkdir -p "$STATE"
    check_aperture_name
    fetch_loop
    write_override
    write_host_script
    rt start
    start_bridge
    info
    cat <<EOF

Next, in the app: create a wallet, copy a receive address, then
  scripts/dev/loop-regtest.sh fund <address>
open a channel of ~3,000,000 sats to the node above, then
  scripts/dev/loop-regtest.sh mine 6
Loop terms and quotes should now load. Mine a block at a time while a swap runs.
EOF
    ;;
  fund)
    [[ -n "${2:-}" ]] || fail "usage: $0 fund <regtest address>"
    rt bitcoin sendtoaddress "$2" 1 >/dev/null
    rt mine 6
    echo "Sent 1 regtest BTC to $2 and mined 6 blocks."
    ;;
  mine) rt mine "${2:-6}"; echo "Mined ${2:-6} block(s)." ;;
  info) info ;;
  stop)
    stop_bridge
    [[ -f "$LOOP_DIR/regtest/docker-compose.yml" ]] && compose down -v --remove-orphans
    echo "Stopped."
    ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
