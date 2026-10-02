#!/usr/bin/env bash
#
# End-to-end test of the node AUTO-UPDATER (`install-validator.sh updater …`, installed on a node
# as /usr/local/bin/rougechain-update) in Docker.
#
#   scripts/release/test-updater.sh                      # ubuntu:24.04 + debian:12 + ubuntu:22.04
#   IMAGES="debian:12" scripts/release/test-updater.sh
#   scripts/release/test-updater.sh --mutations          # mutation check (see below)
#   REAL_BINARY=… REAL_CLI=… scripts/release/test-updater.sh   # + the real node against mainnet
#
# What it builds (all throw-away, in a temp dir):
#   * TEST release keys, and manifests signed with them by the real tooling (make-manifest /
#     sign-manifest): a base release 9.0.0 and a set of 9.1.0 / 9.2.0 / 8.9.0 releases — good,
#     unhealthy in every way the health check knows, forged, unsigned, wrongly signed, with bad
#     files, with an `installer` entry, …
#   * a FAKE node binary per release: it serves /api/health, /api/stats, /api/block/N and /metrics
#     with a fixed behaviour (healthy, wrong chain id, missing activation, wrong activation height,
#     stuck height, wrong state root, other fork, crash at start, not runnable);
#   * a stand-in for `systemctl` (containers have no systemd) that really starts, stops and
#     restarts the node from the unit's ExecStart as the unit's user — so restart, health check
#     and rollback are exercised for real;
#   * a fake reference node, started inside the test container.
# The scenario matrix is test/updater-scenarios.sh. Exit code: 0 only if every check passed.
#
# DEV_CLI: a `rougechain` CLI >= 1.2.0 (it has `release verify`, the ML-DSA-65 verifier the
#   updater uses). Default: core/target/release/rougechain, else core/target/debug/rougechain.
#   Build one with: (cd core && cargo build -p quantum-vault-cli)
#
# --mutations: runs the suite against deliberately BROKEN copies of the installer (signature
#   check off, sha256 check off, health check off, rollback off, …) on the first image and
#   requires the suite to FAIL for each — evidence that the tests can see those defects.
#   MUTATIONS="sig health" limits the set. A mutation run stops at its first failed check
#   (FAIL_FAST=0 runs the whole suite and counts them).
#
# REAL_BINARY + REAL_CLI (optional): installs the REAL node binary as a test-signed "1.6.0"
#   (REAL_CLI = the CLI shipped with it, which has no `release verify`), lets it sync from the
#   public mainnet node (read-only requests), then auto-updates it to a test-signed "1.6.1" —
#   the same binary with one byte appended, plus DEV_CLI — and runs the REAL health check
#   against https://api.rougechain.io.
#   ONLY_REAL=1 skips the scenario matrix and runs only this part.
# KEEP_IMAGES=1: do not remove images this run pulled.
# LOG_DIR=<dir>: keep the full log of every run there.
#
# Needs: docker, Node.js >= 20. Everything it creates is named rc-upd-test-* and removed on exit.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMAGES="${IMAGES:-ubuntu:24.04 debian:12 ubuntu:22.04}"
WEB_IMAGE="busybox:1.36"
BB_IMAGE="busybox:1.36-musl"     # a STATIC busybox: it is copied into the test containers (three different libcs)
NET="rc-upd-test-net"
WEB="rc-upd-test-web"
WEB_URL="http://$WEB:8080"
DOWN_URL="http://$WEB:8081"
PASSPHRASE="updater-test-passphrase"
ALL_MUTATIONS="sig mldsa sha health rollback downgrade newest failedskip lock window proposer"
TMP="$(mktemp -d)"
PULLED=()
MODE="suite"
if [ "${1:-}" = "--mutations" ]; then MODE="mutations"; fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
cleanup() {
  local rc=$?
  docker rm -f -v "$WEB" rc-upd-test-run rc-upd-test-real rc-upd-test-bb > /dev/null 2>&1 || true
  docker network rm "$NET" > /dev/null 2>&1 || true
  if [ "${KEEP_IMAGES:-0}" != 1 ] && [ ${#PULLED[@]} -gt 0 ]; then
    docker rmi "${PULLED[@]}" > /dev/null 2>&1 || true
  fi
  rm -rf -- "${TMP:?}" 2> /dev/null || true
  exit "$rc"
}
trap cleanup EXIT

ensure_image() {
  if ! docker image inspect "$1" > /dev/null 2>&1; then
    echo "pulling $1"
    docker pull -q "$1" > /dev/null
    PULLED+=("$1")
  fi
}

command -v docker > /dev/null || { echo "docker is required" >&2; exit 1; }
command -v node > /dev/null || { echo "Node.js >= 20 is required" >&2; exit 1; }
if [ ! -d "$HERE/node_modules/@noble/post-quantum" ]; then
  say "installing release tooling dependencies (npm ci)"
  (cd "$HERE" && npm ci --no-audit --no-fund > /dev/null)
fi
if [ -z "${DEV_CLI:-}" ]; then
  for c in "$REPO/core/target/release/rougechain" "$REPO/core/target/debug/rougechain"; do
    if [ -x "$c" ]; then DEV_CLI="$c"; break; fi
  done
fi
[ -n "${DEV_CLI:-}" ] && [ -x "$DEV_CLI" ] || { echo "DEV_CLI: need a rougechain CLI >= 1.2.0 — build it: (cd core && cargo build -p quantum-vault-cli), or set DEV_CLI=<path>" >&2; exit 1; }
"$DEV_CLI" release verify --help > /dev/null 2>&1 || { echo "DEV_CLI ($DEV_CLI) has no 'release verify' subcommand" >&2; exit 1; }

# ── mutations ────────────────────────────────────────────────────────────────
# mutate NAME FILE — break one safeguard in a copy of install-validator.sh.
mutate() {
  local f="$2"
  # shellcheck disable=SC2016  # the sed patterns match literal shell text
  case "$1" in
    sig)        sed -i '/^verify_ed25519() {$/a\  return 0' "$f" ;;                 # any Ed25519 signature is "valid"
    mldsa)      sed -i '/^verify_mldsa() {$/a\  return 0' "$f" ;;                   # any ML-DSA-65 signature is "valid"
    sha)        sed -i 's/^    if \[ "\$got" != "\$sha" \]; then$/    if false; then/' "$f" ;;   # sha256 of downloads not checked
    health)     sed -i '/^health_check() {$/a\  HEALTH_NOTE="mutated"; HEALTH_UNVERIFIED=0; HEALTH_MSG=""; return 0' "$f" ;;   # always healthy
    rollback)   sed -i '/^undo_swap() {$/a\  return 0' "$f" ;;                      # a failed update is left in place
    downgrade)  sed -i 's/^  if ! ver_lt "\$INSTALLED_VERSION" "\${CAND_VERSIONS\[\$pick\]}"; then$/  if false; then/' "$f" ;;   # older / equal releases are installed
    newest)     sed -i 's/^    if \[ "\$best" = -1 \] || ver_lt .*; then best="\$i"; fi$/    if [ "$best" = -1 ]; then best="$i"; fi/' "$f" ;;   # first source wins, not the newest
    failedskip) sed -i 's/^  if failed_before "\$REL_VERSION" && \[ "\$RETRY_FAILED" != 1 \]; then$/  if false; then/' "$f" ;;   # failed releases are retried forever
    lock)       sed -i '/^acquire_lock() {/,/^}/s/^  flock -n 9$/  true/' "$f" ;;   # no mutual exclusion
    window)     sed -i '/^wait_for_window() {$/a\  return 0' "$f" ;;                # no delay window
    proposer)   sed -i '/^wait_if_proposing() {$/a\  return 0' "$f" ;;              # restart a proposing validator
    *) echo "unknown mutation: $1" >&2; exit 1 ;;
  esac
  bash -n "$f" || { echo "mutation $1 produced a script that does not parse" >&2; exit 1; }
}

# ── fixtures ─────────────────────────────────────────────────────────────────
# build_fixtures SCRIPTS_DIR — everything under $TMP/www (served) and $TMP/ctx (mounted).
build_fixtures() {
  local scripts="$1"
  WWW="$TMP/www"; CTX="$TMP/ctx"; FILES="$WWW/files"
  rm -rf -- "${WWW:?}" "${CTX:?}"
  mkdir -p "$FILES" "$WWW/rel" "$CTX/shims" "$CTX/keys"
  export RELEASE_KEY_PASSPHRASE="$PASSPHRASE"
  tool() { node "$HERE/$1" "${@:2}" > "$TMP/tool.log" 2>&1 || { cat "$TMP/tool.log" >&2; echo "fixture step failed: $*" >&2; exit 1; }; }
  if [ ! -f "$TMP/test-keys.json" ]; then
    tool keygen.mjs --out "$TMP/test-keys.json" --pub-dir "$TMP/keys"
    tool keygen.mjs --out "$TMP/other-keys.json" --pub-dir "$TMP/other-keys"
  fi
  cp "$TMP/keys/"* "$CTX/keys/"

  # The fake node. TAG names the build; BEHAVIOUR is what is wrong with it (or "healthy").
  fake_node() { # fake_node TAG BEHAVIOUR DEST
    mkdir -p "$(dirname "$3")"
    sed -e "s/@TAG@/$1/g" -e "s/@BEHAVIOUR@/$2/g" > "$3" <<'FAKE'
#!/bin/bash
# fake quantum-vault-daemon (@TAG@, @BEHAVIOUR@) for the updater tests
TAG="@TAG@"; BEHAVIOUR="@BEHAVIOUR@"
dd=""; port=5100; host=127.0.0.1; chain=""; digest=0; mine=false
[ -r "/fake/behaviour-$TAG" ] && BEHAVIOUR="$(cat "/fake/behaviour-$TAG")"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) if [ "$BEHAVIOUR" = norun ]; then echo "error while loading shared libraries: libfake.so.1" >&2; exit 127; fi; echo "fake daemon $TAG"; exit 0 ;;
    --data-dir) dd="$2"; shift ;;
    --api-port) port="$2"; shift ;;
    --host) host="$2"; shift ;;
    --chain-id) chain="$2"; shift ;;
    --mine) mine=true ;;
    --print-state-digest) digest=1 ;;
  esac
  shift
done
if [ "$digest" = 1 ]; then
  [ -d "$dd" ] || exit 3
  if [ ! -e "$dd/node-keys.json" ]; then
    pk="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf '{"algorithm":"ML-DSA-65","public_key_hex":"%s","secret_key_hex":"TEST-ONLY-%s"}\n' "$pk" "$pk" > "$dd/node-keys.json"
  fi
  mkdir -p "$dd/chain-db"; echo "{\"fake\":\"$TAG\"}"; exit 0
fi
if [ "$BEHAVIOUR" = crash ]; then echo "fake daemon $TAG: crashing at start" >&2; exit 1; fi
height="$(cat /fake/height 2> /dev/null || echo 100)"
lag="$(cat "/fake/lag-$TAG" 2> /dev/null || echo 0)"
fork=main; rootfork=main
sched='{"network":"mainnet","tx_uniqueness":90,"token_minting":235,"validator_retirement":{"height":1240,"validators":[]}}'
case "$BEHAVIOUR" in
  stuck) lag=5 ;;
  wrongroot) rootfork=bad ;;
  fork) fork=bad; rootfork=bad; lag=1 ;;
  wrongchain) chain="rougechain-evil-1" ;;
  noactivation) sched='{"network":"mainnet","tx_uniqueness":90,"validator_retirement":{"height":1240,"validators":[]}}' ;;
  wrongheight) sched='{"network":"mainnet","tx_uniqueness":90,"token_minting":240,"validator_retirement":{"height":1240,"validators":[]}}' ;;
esac
h=$((height - lag))
hash_of() { printf 'block-%s-%s' "$1" "$fork" | sha256sum | cut -d ' ' -f 1; }
root_of() { printf 'root-%s-%s' "$1" "$rootfork" | sha256sum | cut -d ' ' -f 1; }
www="${dd:?}/fake-www"
rm -rf "$www"; mkdir -p "$www/api/block"
dp=null; if [ -s /fake/proposer ]; then dp="\"$(cat /fake/proposer)\""; fi
printf '{"status":"ok","chain_id":"%s","height":%s}\n' "$chain" "$h" > "$www/api/health"
printf '{"connected_peers":1,"network_height":%s,"is_mining":%s,"chain_id":"%s","finalized_height":%s,"state_root":"%s","upgrade_schedule":%s,"designated_proposer_next_height":%s,"designated_proposer_next":%s,"fake_tag":"%s"}\n' \
  "$h" "$mine" "$chain" "$h" "$(root_of "$h")" "$sched" "$((h + 1))" "$dp" "$TAG" > "$www/api/stats"
printf '# TYPE rougechain_mempool_size gauge\nrougechain_mempool_size %s\n' "$(cat /fake/mempool 2> /dev/null || echo 0)" > "$www/metrics"
n=$((h > 25 ? h - 25 : 1))
while [ "$n" -le "$h" ]; do
  printf '{"success":true,"block":{"height":%s,"hash":"%s","stateRoot":"%s"}}\n' "$n" "$(hash_of "$n")" "$(root_of "$n")" > "$www/api/block/$n"
  n=$((n + 1))
done
exec /ctx/busybox httpd -f -p "$host:$port" -h "$www"
FAKE
    chmod 0755 "$3"
  }
  # A CLI without `release verify` (as shipped with node 1.6.0).
  fake_cli() { # fake_cli TAG DEST
    mkdir -p "$(dirname "$2")"
    cat > "$2" <<FAKE
#!/bin/bash
# fake rougechain CLI ($1) for the updater tests — no 'release verify'
case "\${1:-}" in --version) echo "rougechain fake-$1"; exit 0 ;; esac
echo "error: unrecognized subcommand" >&2; exit 2
FAKE
    chmod 0755 "$2"
  }
  # The stand-in for systemctl: starts/stops the node from its unit, records every call.
  cat > "$CTX/shims/systemctl" <<'SYSTEMCTL'
#!/bin/bash
# stand-in for systemctl in the updater tests
S=/run/fake-systemd; mkdir -p "$S/enabled"
echo "$*" >> "$S/calls.log"
cmd=""; now=0; units=()
for a in "$@"; do
  case "$a" in
    --now) now=1 ;;
    -*) ;;
    *) if [ -z "$cmd" ]; then cmd="$a"; else units+=("$a"); fi ;;
  esac
done
u="${units[0]:-}"; case "$u" in ""|*.service|*.timer) ;; *) u="$u.service" ;; esac
alive() { [ -s "$S/$u.pid" ] && kill -0 "$(cat "$S/$u.pid")" 2> /dev/null; }
stop_unit() {
  case "$u" in *.timer) rm -f "$S/active-$u"; return 0 ;; esac
  if alive; then
    kill "$(cat "$S/$u.pid")" 2> /dev/null
    for _ in $(seq 1 100); do alive || break; sleep 0.05; done
  fi
  rm -f "$S/$u.pid"
}
start_unit() {
  local f="/etc/systemd/system/$u" user wd cmdline
  case "$u" in *.timer) touch "$S/active-$u"; return 0 ;; esac
  [ -f "$f" ] || { echo "Unit $u not found." >&2; return 5; }
  user="$(sed -n 's/^User=//p' "$f")"; wd="$(sed -n 's/^WorkingDirectory=//p' "$f")"
  cmdline="$(awk '/^ExecStart=/{f=1; sub(/^ExecStart=/,"")} f{l=$0; c=sub(/\\$/,"",l); printf "%s ", l; if(!c) exit}' "$f")"
  # shellcheck disable=SC2086
  ( cd "${wd:-/}" && umask 077 && exec setpriv --reuid "${user:-root}" --regid "${user:-root}" --clear-groups env HOME="${wd:-/}" $cmdline >> /var/log/fake-node.log 2>&1 < /dev/null ) &
  echo $! > "$S/$u.pid"
}
case "$cmd" in
  is-active) case "$u" in *.timer) [ -e "$S/active-$u" ] ;; *) alive ;; esac || exit 3 ;;
  start) alive || start_unit ;;
  restart) stop_unit; start_unit ;;
  stop) stop_unit ;;
  enable) touch "$S/enabled/$u"; if [ "$now" = 1 ]; then start_unit; fi ;;
  disable) rm -f "$S/enabled/$u"; if [ "$now" = 1 ]; then stop_unit; fi ;;
  is-enabled) if [ -e "$S/enabled/$u" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  show) echo "Fri 2026-10-02 12:17:00 UTC" ;;
  *) : ;;
esac
SYSTEMCTL
  chmod 0755 "$CTX/shims/systemctl"
  # busybox (static): the fake node and the fake reference node serve their API with its httpd.
  if [ ! -x "$TMP/busybox" ]; then
    ensure_image "$BB_IMAGE"
    docker rm -f rc-upd-test-bb > /dev/null 2>&1 || true
    docker create --name rc-upd-test-bb "$BB_IMAGE" > /dev/null
    docker cp rc-upd-test-bb:/bin/busybox "$TMP/busybox" > /dev/null
    docker rm -f rc-upd-test-bb > /dev/null
  fi
  cp "$TMP/busybox" "$CTX/busybox"; chmod 0755 "$CTX/busybox"

  NAME="quantum-vault-daemon-test"; CLI_NAME="rougechain-test"; MF="manifest-mainnet.json"
  fake_node v0 healthy "$FILES/v0/$NAME"
  fake_node v1 healthy "$FILES/v1/$NAME"
  fake_node v2 healthy "$FILES/v2/$NAME"
  fake_node v3 healthy "$FILES/v3/$NAME"
  local b
  for b in wrongchain noactivation wrongheight stuck wrongroot fork crash norun; do fake_node "v2-$b" "$b" "$FILES/bad-$b/$NAME"; done
  fake_node vX healthy "$FILES/tampered/$NAME"            # same size as v2, different bytes
  [ "$(stat -c %s "$FILES/v2/$NAME")" = "$(stat -c %s "$FILES/tampered/$NAME")" ] || { echo "fixture error: tampered binary size differs" >&2; exit 1; }
  mkdir -p "$FILES/dev" "$FILES/old"
  cp "$DEV_CLI" "$FILES/dev/$CLI_NAME"; chmod 0755 "$FILES/dev/$CLI_NAME"
  fake_cli old "$FILES/old/$CLI_NAME"
  fake_cli new "$FILES/new/$CLI_NAME"
  printf '{"chain_id":"rougechain-mainnet-1","genesis_time":1}\n' > "$FILES/genesis-mainnet.json"
  mkdir -p "$FILES/othergenesis"
  printf '{"chain_id":"rougechain-mainnet-1","genesis_time":2}\n' > "$FILES/othergenesis/genesis-mainnet.json"
  # updater scripts for the `installer` manifest entry: this installer as v2.9.0 and as v1.0.0,
  # a tampered v2.9.0 of the same size, and one that is not a valid script
  mkdir -p "$FILES/ins" "$FILES/insbad"
  sed 's/^INSTALLER_VERSION=.*/INSTALLER_VERSION="2.9.0"/' "$scripts/install-validator.sh" > "$FILES/ins/install-validator-290.sh"
  sed 's/^INSTALLER_VERSION=.*/INSTALLER_VERSION="1.0.0"/' "$scripts/install-validator.sh" > "$FILES/ins/install-validator-100.sh"
  sed 's/^# RougeChain node \/ validator installer/# RougeChain node \/ validator installeR/' "$FILES/ins/install-validator-290.sh" > "$FILES/insbad/install-validator-290.sh"
  { cat "$FILES/ins/install-validator-290.sh"; printf 'if then fi (\n'; } > "$FILES/ins/install-validator-broken.sh"
  [ "$(stat -c %s "$FILES/ins/install-validator-290.sh")" = "$(stat -c %s "$FILES/insbad/install-validator-290.sh")" ] || { echo "fixture error: tampered updater size differs" >&2; exit 1; }

  # release DIR VERSION NODE_DIR [make-manifest args…] — make + sign into www/rel/DIR
  # (BIN_URL=… overrides the primary URL of the node binary)
  release() {
    local dir="$WWW/rel/$1" ver="$2" bin="$FILES/$3/$NAME" url="${BIN_URL:-$WEB_URL/files/$3/$NAME}"
    shift 3
    mkdir -p "$dir"
    tool make-manifest.mjs --allow-http --network mainnet --version "$ver" --released 2026-10-01 \
      --binary "$bin" --binary-url "$url" --source-commit 0000000 \
      --genesis "$FILES/genesis-mainnet.json" --genesis-url "$WEB_URL/files/genesis-mainnet.json" \
      --activation canonical_ledger_fork=49 --activation tx_uniqueness=90 --activation token_minting=235 \
      --activation validator_retirement=1240 --out "$dir/$MF" "$@"
    tool sign-manifest.mjs --allow-http --yes --key "$TMP/test-keys.json" "$dir/$MF"
  }
  DEVCLI=(--cli "$FILES/dev/$CLI_NAME" --cli-name "$CLI_NAME" --cli-url "$WEB_URL/files/dev/$CLI_NAME")
  OLDCLI=(--cli "$FILES/old/$CLI_NAME" --cli-name "$CLI_NAME" --cli-url "$WEB_URL/files/old/$CLI_NAME")
  release base    9.0.0 v1 "${DEVCLI[@]}"
  release baseold 9.0.0 v1 "${OLDCLI[@]}"
  release old     8.9.0 v0 "${DEVCLI[@]}"
  release opt     9.1.0 v2 "${DEVCLI[@]}"
  release mand    9.1.0 v2 "${DEVCLI[@]}" --mandatory --upgrade-before-height 235
  release newer   9.2.0 v3 "${DEVCLI[@]}"
  release chain   9.1.0 bad-wrongchain "${DEVCLI[@]}"
  release act     9.1.0 bad-noactivation "${DEVCLI[@]}"
  release height  9.1.0 bad-wrongheight "${DEVCLI[@]}"
  release stuck   9.1.0 bad-stuck "${DEVCLI[@]}"
  release root    9.1.0 bad-wrongroot "${DEVCLI[@]}"
  release fork    9.1.0 bad-fork "${DEVCLI[@]}"
  release crash   9.1.0 bad-crash "${DEVCLI[@]}"
  release norun   9.1.0 bad-norun "${DEVCLI[@]}"
  release samebin 9.1.0 v1 --cli "$FILES/new/$CLI_NAME" --cli-name "$CLI_NAME" --cli-url "$WEB_URL/files/new/$CLI_NAME"
  release mininst 9.1.0 v2 "${DEVCLI[@]}" --min-installer-version 99.0.0
  # the binary served does not match the signed manifest (same size, other bytes; no good mirror)
  BIN_URL="$WEB_URL/files/tampered/$NAME" release badsha 9.1.0 v2 "${DEVCLI[@]}" --binary-mirror "$WEB_URL/files/tampered/$NAME"
  # primary down, a tampered mirror, then a good one
  BIN_URL="$DOWN_URL/files/v2/$NAME" release mirror 9.1.0 v2 "${DEVCLI[@]}" --binary-mirror "$WEB_URL/files/tampered/$NAME" --binary-mirror "$WEB_URL/files/v2/$NAME"
  # a release with a different genesis file
  mkdir -p "$WWW/rel/genesis"
  tool make-manifest.mjs --allow-http --network mainnet --version 9.1.0 --released 2026-10-01 \
    --binary "$FILES/v2/$NAME" --binary-url "$WEB_URL/files/v2/$NAME" --source-commit 0000000 "${DEVCLI[@]}" \
    --genesis "$FILES/othergenesis/genesis-mainnet.json" --genesis-url "$WEB_URL/files/othergenesis/genesis-mainnet.json" \
    --activation tx_uniqueness=90 --activation token_minting=235 --out "$WWW/rel/genesis/$MF"
  tool sign-manifest.mjs --allow-http --yes --key "$TMP/test-keys.json" "$WWW/rel/genesis/$MF"
  # releases that carry the optional `installer` entry
  INS290=(--installer "$FILES/ins/install-validator-290.sh" --installer-name install-validator-290.sh --installer-url "$WEB_URL/files/ins/install-validator-290.sh")
  release ins        9.1.0 v2 "${DEVCLI[@]}" "${INS290[@]}"
  release insmin     9.1.0 v2 "${DEVCLI[@]}" "${INS290[@]}" --min-installer-version 2.9.0
  release insold     9.1.0 v2 "${DEVCLI[@]}" --min-installer-version 1.0.0 \
    --installer "$FILES/ins/install-validator-100.sh" --installer-name install-validator-100.sh --installer-url "$WEB_URL/files/ins/install-validator-100.sh"
  release insbad     9.1.0 v2 "${DEVCLI[@]}" --installer "$FILES/ins/install-validator-290.sh" --installer-name install-validator-290.sh \
    --installer-url "$WEB_URL/files/insbad/install-validator-290.sh"
  release insgarbage 9.1.0 v2 "${DEVCLI[@]}" --installer "$FILES/ins/install-validator-broken.sh" --installer-name install-validator-broken.sh \
    --installer-url "$WEB_URL/files/ins/install-validator-broken.sh"

  # forged: edited after signing (still schema-valid), both signatures of the original
  mkdir -p "$WWW/rel/forged"
  cp "$WWW/rel/opt/$MF.ed25519.sig" "$WWW/rel/opt/$MF.mldsa65.sig" "$WWW/rel/forged/"
  sed 's#/files/v2/#/files/tampered/#' "$WWW/rel/opt/$MF" > "$WWW/rel/forged/$MF"
  cmp -s "$WWW/rel/opt/$MF" "$WWW/rel/forged/$MF" && { echo "fixture error: forged manifest is identical" >&2; exit 1; }
  # wrongkey: properly signed (both signatures) by keys the node does not trust
  mkdir -p "$WWW/rel/wrongkey"; cp "$WWW/rel/opt/$MF" "$WWW/rel/wrongkey/"
  tool sign-manifest.mjs --allow-http --yes --key "$TMP/other-keys.json" "$WWW/rel/wrongkey/$MF"
  # unsigned: no signature files at all
  mkdir -p "$WWW/rel/unsigned"; cp "$WWW/rel/opt/$MF" "$WWW/rel/unsigned/"
  # badpq: valid Ed25519 signature; the ML-DSA-65 signature is a real one — of ANOTHER manifest
  mkdir -p "$WWW/rel/badpq" "$WWW/rel/badpqfresh" "$WWW/rel/pqgarbage"
  cp "$WWW/rel/opt/$MF" "$WWW/rel/opt/$MF.ed25519.sig" "$WWW/rel/badpq/"
  cp "$WWW/rel/newer/$MF.mldsa65.sig" "$WWW/rel/badpq/$MF.mldsa65.sig"
  cp "$WWW/rel/base/$MF" "$WWW/rel/base/$MF.ed25519.sig" "$WWW/rel/badpqfresh/"
  cp "$WWW/rel/newer/$MF.mldsa65.sig" "$WWW/rel/badpqfresh/$MF.mldsa65.sig"
  # pqgarbage: valid Ed25519 signature; the ML-DSA-65 signature file is not a signature
  cp "$WWW/rel/opt/$MF" "$WWW/rel/opt/$MF.ed25519.sig" "$WWW/rel/pqgarbage/"
  echo "this is not a signature" > "$WWW/rel/pqgarbage/$MF.mldsa65.sig"

  # Every fixture meant to be validly signed must pass the real verifier — with BOTH signatures —
  # and with the Rust verifier the node uses; the bad ones must not.
  local d
  for d in base baseold old opt mand newer chain act height stuck root fork crash norun samebin mininst badsha mirror genesis ins insmin insold insbad insgarbage; do
    tool verify-manifest.mjs --allow-http --keys-dir "$CTX/keys" "$WWW/rel/$d/$MF"
    "$DEV_CLI" release verify --manifest "$WWW/rel/$d/$MF" --sig "$WWW/rel/$d/$MF.mldsa65.sig" --pubkey "$CTX/keys/release-mldsa65.pub" > /dev/null \
      || { echo "fixture error: $d does not verify with the CLI" >&2; exit 1; }
  done
  for d in forged wrongkey badpq badpqfresh pqgarbage; do
    if node "$HERE/verify-manifest.mjs" --allow-http --keys-dir "$CTX/keys" "$WWW/rel/$d/$MF" > /dev/null 2>&1; then
      echo "fixture error: $d verifies" >&2; exit 1
    fi
  done
  chmod -R a+rX "$TMP"
}

start_web() {
  ensure_image "$WEB_IMAGE"
  docker rm -f "$WEB" > /dev/null 2>&1 || true
  docker network rm "$NET" > /dev/null 2>&1 || true
  docker network create "$NET" > /dev/null
  docker run -d --name "$WEB" --network "$NET" -v "$TMP/www:/www:ro" "$WEB_IMAGE" httpd -f -p 8080 -h /www > /dev/null
}

# run_suite IMAGE SCRIPTS_DIR LOG — true if every check passed
run_suite() {
  docker run --rm --name rc-upd-test-run --network "$NET" -e WEB="$WEB_URL" -e DOWN="$DOWN_URL" -e FAIL_FAST="${FAIL_FAST:-0}" \
    -v "$2:/src:ro" -v "$TMP/ctx:/ctx:ro" "$1" bash /src/release/test/updater-scenarios.sh > "$3" 2>&1
}

FAILED=()
SUMMARY=()
ensure_image "$WEB_IMAGE"

if [ "$MODE" = "mutations" ]; then
  image="${IMAGES%% *}"
  ensure_image "$image"
  # The fixtures are the normal ones (the updater scripts inside the self-update releases are
  # the unmodified installer); what is mutated is the installer that gets installed and run.
  say "building fixtures (TEST keys, fake nodes, signed manifests)"
  build_fixtures "$REPO/scripts"
  start_web
  for m in ${MUTATIONS:-$ALL_MUTATIONS}; do
    say "mutation '$m' on $image — the suite must FAIL"
    src="$TMP/src-$m"
    mkdir -p "$src/release/test"
    cp "$REPO/scripts/install-validator.sh" "$src/"
    cp "$REPO/scripts/release/test/"*.sh "$src/release/test/"
    mutate "$m" "$src/install-validator.sh"
    cmp -s "$src/install-validator.sh" "$REPO/scripts/install-validator.sh" && { echo "mutation '$m' did not change the installer — the mutation is stale" >&2; exit 1; }
    log="$TMP/mut-$m.log"
    if [ -n "${LOG_DIR:-}" ]; then mkdir -p "$LOG_DIR"; fi
    if FAIL_FAST="${FAIL_FAST:-1}" run_suite "$image" "$src" "$log"; then
      FAILED+=("mutation:$m")
      SUMMARY+=("FAIL  mutation $m SURVIVED — the suite passed with this safeguard removed")
    else
      n="$(grep -c '^  FAIL' "$log" || true)"
      if [ "$n" -ge 1 ]; then
        SUMMARY+=("PASS  mutation $m killed after $(grep -c '^  ok' "$log" || true) passing checks by: $(grep -m 1 '^  FAIL' "$log" | sed 's/^  FAIL  //' | cut -c 1-120)")
      else
        FAILED+=("mutation:$m"); SUMMARY+=("FAIL  mutation $m: the suite did not run to a verdict"); tail -n 20 "$log"
      fi
    fi
    if [ "${VERBOSE:-0}" = 1 ]; then grep -E '^  FAIL' "$log" || true; fi
    if [ -n "${LOG_DIR:-}" ]; then cp "$log" "$LOG_DIR/"; fi
  done
  say "summary"
  printf '  %s\n' "${SUMMARY[@]}"
  if [ ${#FAILED[@]} -gt 0 ]; then echo "FAILED: ${FAILED[*]}"; exit 1; fi
  echo "ALL MUTATIONS KILLED"
  exit 0
fi

say "building fixtures (TEST keys, fake nodes, signed manifests)"
build_fixtures "$REPO/scripts"
say "starting the fixture server"
start_web

for image in $IMAGES; do
  if [ "${ONLY_REAL:-0}" = 1 ]; then ensure_image "$image"; break; fi
  say "updater scenarios on $image"
  ensure_image "$image"
  log="$TMP/run-${image//[:\/]/-}.log"
  t0=$SECONDS
  if run_suite "$image" "$REPO/scripts" "$log"; then result="PASS"; else result="FAIL"; FAILED+=("$image"); fi
  if [ "$result" = "FAIL" ] || [ "${VERBOSE:-0}" = 1 ]; then cat "$log"; else grep -E "^\[|FAIL" "$log" | tr '\n' ' '; echo; fi
  SUMMARY+=("$result  $image  — $(tail -n 1 "$log") ($((SECONDS - t0))s)")
  if [ -n "${LOG_DIR:-}" ]; then mkdir -p "$LOG_DIR"; cp "$log" "$LOG_DIR/"; fi
done

# ── optional: the real node, updated for real, health-checked against mainnet ─
if [ -n "${REAL_BINARY:-}" ]; then
  [ -f "$REAL_BINARY" ] || { echo "REAL_BINARY: $REAL_BINARY not found" >&2; exit 1; }
  [ -n "${REAL_CLI:-}" ] && [ -f "$REAL_CLI" ] || { echo "REAL_CLI: the rougechain CLI shipped with REAL_BINARY is needed too" >&2; exit 1; }
  image="${IMAGES%% *}"
  say "real node on $image: install 1.6.0 (test-signed), sync from mainnet, auto-update to 1.6.1, real health check"
  R="$TMP/www/files/real"; mkdir -p "$R/a" "$R/b"
  cp "$REAL_BINARY" "$R/a/quantum-vault-daemon-real"
  # "1.6.1": the same program with one byte appended (a different sha256, identical behaviour),
  # so that the update really replaces the binary, restarts the node and health-checks it.
  { cat "$REAL_BINARY"; printf '\n'; } > "$R/b/quantum-vault-daemon-real"
  cp "$REAL_CLI" "$R/a/rougechain-real"; cp "$DEV_CLI" "$R/b/rougechain-real"
  cp "$REPO/core/daemon/genesis-mainnet.json" "$R/genesis-mainnet.json"
  chmod 0755 "$R"/a/* "$R"/b/*
  # shellcheck disable=SC2016
  mapfile -t ACTS < <(node -e 'for (const a of JSON.parse(require("fs").readFileSync(process.argv[1])).activations) console.log(`--activation\n${a.name}=${a.height}`)' "$REPO/releases/manifest-mainnet.json")
  UBH="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).upgrade_before_height)' "$REPO/releases/manifest-mainnet.json")"
  for v in "1.6.0 a" "1.6.1 b"; do
    ver="${v% *}"; d="${v#* }"
    mkdir -p "$TMP/www/rel/real-$ver"
    tool make-manifest.mjs --allow-http --network mainnet --version "$ver" --released 2026-10-02 \
      --binary "$R/$d/quantum-vault-daemon-real" --binary-url "$WEB_URL/files/real/$d/quantum-vault-daemon-real" --source-commit 03613ef \
      --cli "$R/$d/rougechain-real" --cli-name rougechain-real --cli-url "$WEB_URL/files/real/$d/rougechain-real" \
      --genesis "$R/genesis-mainnet.json" --genesis-url "$WEB_URL/files/real/genesis-mainnet.json" \
      --mandatory --upgrade-before-height "$UBH" "${ACTS[@]}" --out "$TMP/www/rel/real-$ver/manifest-mainnet.json"
    tool sign-manifest.mjs --allow-http --yes --key "$TMP/test-keys.json" "$TMP/www/rel/real-$ver/manifest-mainnet.json"
  done
  chmod -R a+rX "$TMP"
  log="$TMP/real.log"
  if docker run --rm --name rc-upd-test-real --network "$NET" -e WEB="$WEB_URL" \
      -v "$REPO/scripts:/src:ro" -v "$TMP/ctx:/ctx:ro" "$image" bash /src/release/test/updater-real.sh > "$log" 2>&1; then
    SUMMARY+=("PASS  real node: $(grep -m 1 'UPDATE OK' "$log" | sed 's/^.*UPDATE OK: //' | cut -c 1-220)")
    grep -E '^(  ok|  FAIL|real:)' "$log" || true
  else
    cat "$log"; FAILED+=("real"); SUMMARY+=("FAIL  real node scenario")
  fi
  if [ -n "${LOG_DIR:-}" ]; then cp "$log" "$LOG_DIR/"; fi
fi

say "summary"
printf '  %s\n' "${SUMMARY[@]}"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "FAILED: ${FAILED[*]}"
  exit 1
fi
echo "ALL UPDATER TESTS PASSED"
