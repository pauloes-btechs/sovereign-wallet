#!/usr/bin/env bash
# Wallet-path Loop test: real Loop Out and Loop In driven through Sovereign
# Wallet's own bridge (the same HTTP routes the desktop app calls), against
# the source-built regtest swap server. Regtest only — never real funds.
#
# Prerequisites (the workflow does these):
#   - `pnpm build` and `pnpm sidecar:fetch` (bridge + checksum-verified litd)
#   - upstream regtest topology running: `<loop>/regtest/regtest.sh start`
#
# What it proves, end to end:
#   bridge launches litd (Neutrino against the regtest bitcoind) with Loop
#   pointed at the regtest server -> wallet created through the bridge ->
#   funded, channel opened to the server's node -> POST /loop/quote and
#   POST /loop/out with an authorization the bridge re-checks -> swap
#   settles -> the same for POST /loop/in -> GET /loop/swaps lists both as
#   success (what the Loop history page shows).
set -Eeuo pipefail

REGTEST_DIR="${1:?usage: loop-wallet-path.sh /path/to/loop/regtest}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${WORK_DIR:-$RUNNER_TEMP/wallet-path}"
BRIDGE_PORT=8791
# Loop Out first: it moves channel balance to the server side, which then
# funds the Loop In (minus the server's 1% channel reserve).
LOOP_OUT_SAT="${LOOP_OUT_SAT:-1000000}"
LOOP_IN_SAT="${LOOP_IN_SAT:-500000}"
CHANNEL_SAT=3000000
PASSWORD='regtest only wallet password'

fail() { echo "::error::$*" >&2; exit 1; }
rt() { "$REGTEST_DIR/regtest.sh" "$@"; }
ip_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }

mkdir -p "$WORK"
TOKEN=''
api() {
  # api METHOD PATH [JSON] -> response body on stdout; non-2xx fails with the body.
  local out code
  out="$(mktemp)"
  if [[ $# -ge 3 ]]; then
    code="$(curl -sS -m 180 -o "$out" -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' -d "$3" "http://127.0.0.1:$BRIDGE_PORT$2")" || code=000
  else
    code="$(curl -sS -m 180 -o "$out" -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" \
      "http://127.0.0.1:$BRIDGE_PORT$2")" || code=000
  fi
  cat "$out"
  rm -f "$out"
  [[ "$code" == 2* ]]
}

wait_until() {
  # wait_until DESCRIPTION SECONDS COMMAND...
  local what="$1" secs="$2"; shift 2
  local deadline=$((SECONDS + secs))
  until "$@" >/dev/null 2>&1; do
    [[ $SECONDS -lt $deadline ]] || fail "Timed out waiting for $what"
    sleep 3
  done
}

node_synced() { api GET /state | jq -e '.phase == "ready" and .info.syncedToChain == true' >/dev/null; }
mine() { rt mine "${1:-1}"; wait_until "wallet node to sync" 120 node_synced; }

echo "::group::Locate the regtest topology"
BITCOIND_IP="$(ip_of bitcoind)"; LNDSERVER_IP="$(ip_of lndserver)"; APERTURE_IP="$(ip_of aperture)"
[[ -n "$BITCOIND_IP" && -n "$LNDSERVER_IP" && -n "$APERTURE_IP" ]] || fail "Regtest containers not found"
echo "bitcoind=$BITCOIND_IP lndserver=$LNDSERVER_IP aperture=$APERTURE_IP"
# loopd verifies aperture's TLS certificate by name, as upstream's loopclient does.
echo "$APERTURE_IP aperture" | sudo tee -a /etc/hosts >/dev/null
docker cp aperture:/root/.aperture/tls.cert "$WORK/aperture-tls.cert"
SERVER_PUBKEY="$(rt lndserver getinfo | jq -r '.identity_pubkey')"
echo "::endgroup::"

echo "::group::Launch the wallet's bridge (litd: Neutrino + Loop -> regtest server)"
LITD_BIN="$(ls "$REPO_ROOT"/apps/desktop/src-tauri/binaries/litd-x86_64-unknown-linux-gnu)"
node "$REPO_ROOT/services/litd-adapter/dist/bridge/main.js" --launch \
  --litdBinary="$LITD_BIN" --dataDir="$WORK/litd" --network=regtest \
  --backend=neutrino --peer="$BITCOIND_IP:18444" --port="$BRIDGE_PORT" \
  --bootstrap="$WORK/bridge.json" \
  --loopServer=aperture:11018 --subServerArg="loop.server.tlspath=$WORK/aperture-tls.cert" \
  > "$WORK/bridge.log" 2>&1 &
echo $! > "$WORK/bridge.pid"
wait_until "bridge bootstrap file" 120 test -s "$WORK/bridge.json"
TOKEN="$(jq -r '.token' "$WORK/bridge.json")"
wait_until "litd wallet service" 180 bash -c "curl -sf -H 'authorization: Bearer $TOKEN' http://127.0.0.1:$BRIDGE_PORT/state | jq -e '.phase == \"missing\"'"
echo "::endgroup::"

echo "::group::Create the wallet through the bridge"
SEED="$(api POST /wallet/seed '{}')" || fail "seed: $SEED"
api POST /wallet/init "$(jq -nc --argjson m "$(jq '.mnemonic' <<<"$SEED")" --arg p "$PASSWORD" '{mnemonic:$m,password:$p}')" >/dev/null \
  || fail "wallet init failed"
wait_until "wallet ready and synced" 300 node_synced
wait_until "litd sub-servers" 300 bash -c "curl -sf -H 'authorization: Bearer $TOKEN' http://127.0.0.1:$BRIDGE_PORT/services | jq -e '.ready == true and .subServers.loop.running == true'"
api GET /services | jq '{ready, loop: .subServers.loop, operators}'
echo "::endgroup::"

echo "::group::Fund the wallet and open a channel to the swap server's node"
ADDR="$(api POST /onchain/address '{"type":"p2wkh"}' | jq -r '.address')"
rt bitcoin sendtoaddress "$ADDR" 1 >/dev/null
mine 6
api GET /onchain/balance | jq .
api POST /channels "$(jq -nc --arg pk "$SERVER_PUBKEY" --arg host "$LNDSERVER_IP:9735" --arg amt "$CHANNEL_SAT" \
  '{nodePubkeyHex:$pk,host:$host,localFundingSat:$amt,satPerVbyte:2}')" | jq . || fail "channel open failed"
mine 6
wait_until "channel to lndserver active" 180 bash -c "curl -sf -H 'authorization: Bearer $TOKEN' http://127.0.0.1:$BRIDGE_PORT/channels | jq -e '[.open[] | select(.state == \"open\")] | length >= 1'"
api GET /channels | jq '.open'
echo "::endgroup::"

# Active is not routable yet: lnd registers the channel's HTLC link with its
# switch a moment after the channel turns active, and a payment in that window
# fails at once with INSUFFICIENT_BALANCE (also documented in
# lnc.integration.test.ts). Loop's first step is a payment (the L402 token),
# so prove the channel carries one before swapping: pay a small invoice from
# the server's node through the wallet, retrying until it settles.
echo "::group::Prove the channel can route a payment"
routable=false
for attempt in $(seq 1 20); do
  probe="$(rt lndserver addinvoice --amt 1000 --memo routability-probe | jq -r '.payment_request')"
  res="$(api POST /payments "$(jq -nc --arg pr "$probe" '{paymentRequest:$pr,feeLimitSat:"10"}')")" || true
  echo "probe attempt=$attempt: $(jq -c '{status, failureReason, feeSat}' <<<"$res" 2>/dev/null || echo "$res")"
  if [[ "$(jq -r '.status' <<<"$res" 2>/dev/null)" == succeeded ]]; then routable=true; break; fi
  sleep 3
done
[[ "$routable" == true ]] || fail "The channel never routed a 1,000-sat payment to the server's node"
echo "::endgroup::"

LND_INVOICE_OFFSET=0
note_server_invoices() { LND_INVOICE_OFFSET="$(rt lndserver listinvoices --max_invoices 1 | jq -r '.last_index_offset // 0')"; }

# Upstream's own regtest bootstrap notes that the first L402 fetch can leave
# aperture's invoice unpaid (an lndclient payment-timeout incompatibility),
# and pays that exact new invoice before retrying. Do the same through the
# wallet's own payment route, only for an invoice aperture just created.
pay_new_l402_invoice() {
  local latest invoice
  latest="$(rt lndserver listinvoices --max_invoices 1 | jq -r '.last_index_offset // 0')"
  [[ "$latest" -gt "$LND_INVOICE_OFFSET" ]] || return 1
  invoice="$(rt lndserver listinvoices --max_invoices 1 | jq -r '.invoices[-1] | select(.state == "OPEN") | .payment_request')"
  [[ -n "$invoice" ]] || return 1
  echo "Paying aperture's L402 invoice through the wallet (POST /payments)"
  api POST /payments "$(jq -nc --arg pr "$invoice" '{paymentRequest:$pr,feeLimitSat:"10"}')" | jq '{status, failureReason, feeSat}'
}

start_swap() {
  # start_swap DIRECTION AMOUNT -> swap id on stdout
  local dir="$1" amt="$2" quote total body res
  quote="$(api POST /loop/quote "$(jq -nc --arg d "$dir" --argjson a "$amt" '{direction:$d,amountSat:$a}')")" \
    || fail "$dir quote request failed: $quote"
  jq -e '.ok == true' <<<"$quote" >/dev/null || fail "$dir quote refused: $quote"
  jq '.quote' <<<"$quote" >&2
  total="$(jq -r '.quote.fees.totalSat' <<<"$quote")"
  body="$(jq -nc --argjson a "$amt" --argjson t "$total" '{amountSat:$a,authorization:{amountSat:$a,maxTotalFeeSat:$t}}')"
  local route="/loop/out"; [[ "$dir" == loop-in ]] && route="/loop/in"
  note_server_invoices
  if ! res="$(api POST "$route" "$body")"; then
    echo "$route failed once: $res" >&2
    pay_new_l402_invoice >&2 || fail "$route failed: $res"
    res="$(api POST "$route" "$body")" || fail "$route failed after paying the L402 invoice: $res"
  fi
  jq -r '.swapId' <<<"$res"
}

settle() {
  # settle SWAP_ID LABEL — mine until the bridge reports the swap done.
  local id="$1" label="$2" view state
  for i in $(seq 1 60); do
    view="$(api GET "/loop/swaps/$id")" || fail "GET /loop/swaps/$id failed: $view"
    state="$(jq -r '.state' <<<"$view")"
    echo "$label poll=$i state=$state"
    if [[ "$(jq -r '.done' <<<"$view")" == true ]]; then
      jq . <<<"$view"
      [[ "$state" == success ]] || fail "$label ended in state $state: $(jq -r '.failureReason' <<<"$view")"
      return 0
    fi
    mine 1
    sleep 4
  done
  fail "$label did not settle"
}

echo "::group::Loop Out through the wallet"
api GET /loop/terms | jq .
OUT_ID="$(start_swap loop-out "$LOOP_OUT_SAT")"
echo "Loop Out swap id: $OUT_ID"
settle "$OUT_ID" "Loop Out"
echo "::endgroup::"

echo "::group::Loop In through the wallet"
IN_ID="$(start_swap loop-in "$LOOP_IN_SAT")"
echo "Loop In swap id: $IN_ID"
settle "$IN_ID" "Loop In"
echo "::endgroup::"

echo "::group::Swap history as the app reads it"
SWAPS="$(api GET /loop/swaps)" || fail "GET /loop/swaps failed"
jq '.swaps | map({id, kind, state, amountSat, costServerSat, costOnchainSat, costOffchainSat})' <<<"$SWAPS"
jq -e --arg o "$OUT_ID" '.swaps[] | select(.id == $o and .kind == "loop-out" and .state == "success")' <<<"$SWAPS" >/dev/null \
  || fail "Loop Out missing from history as success"
jq -e --arg i "$IN_ID" '.swaps[] | select(.id == $i and .kind == "loop-in" and .state == "success")' <<<"$SWAPS" >/dev/null \
  || fail "Loop In missing from history as success"
echo "::endgroup::"

echo "Loop Out and Loop In settled through Sovereign Wallet's bridge on regtest."
