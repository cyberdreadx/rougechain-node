#!/usr/bin/env bash
# Runs INSIDE a throw-away container (started by ../test-updater.sh). Exercises the auto-updater
# (`install-validator.sh updater …`, installed as /usr/local/bin/rougechain-update) end to end:
#   /src   the repo's scripts/ directory (read-only) — or a MUTATED copy of it (mutation runs)
#   /ctx   fixtures: keys/ (TEST public keys), shims/systemctl (stand-in: there is no systemd in
#          a container), busybox (static; the fake node and the fake reference node serve their
#          API with its httpd)
#   WEB    base URL of the fixture server (signed TEST releases), DOWN a URL nothing listens on
# The node is a FAKE quantum-vault-daemon that serves /api/health, /api/stats, /api/block/N and
# /metrics; each release ships one with a fixed behaviour (healthy, wrong chain id, missing
# activation, stuck height, wrong state root, other fork, crash at start, not runnable).
# The updater's clock is set by the tests (TEST MODE): sleeps are 50× shorter and advance it.
# Prints one line per check and exits non-zero if any check failed.
set -uo pipefail

WEB="${WEB:?}"
DOWN="${DOWN:?}"
INSTALLER=/src/install-validator.sh
LOG=/tmp/updater.log
PASS=0
FAIL=0
RC=0
TEST_ENV=(ROUGECHAIN_INSTALLER_TEST=1 ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=/ctx/keys/release-ed25519.pub.pem
  ROUGECHAIN_INSTALLER_TEST_MLDSA_PUBKEY_FILE=/ctx/keys/release-mldsa65.pub)
RUN_PATH=/ctx/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BIN=/usr/local/bin/quantum-vault-daemon
CLI=/usr/local/bin/rougechain
UNIT=/etc/systemd/system/rougechain-validator.service
UPDATER=/usr/local/lib/rougechain/install-validator.sh
UPD=/usr/local/bin/rougechain-update
DATA=/var/lib/rougechain/mainnet
CONF=/etc/rougechain/mainnet
UCONF=$CONF/update.conf
STATE=/var/lib/rougechain-updater/mainnet/state
CALLS=/run/fake-systemd/calls.log
LOCAL=http://127.0.0.1:5100
REF=http://127.0.0.1:6100
REF2=http://127.0.0.1:6200
T0=1790000000          # the updater's clock at the start of a run, unless a test sets NOW
NOW=$T0
JITTER=0               # per-host delay fraction (0…9999); 0 = no delay

ok()   { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad()  {
  FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; if [ -s "$LOG" ]; then sed 's/^/        | /' "$LOG" | tail -n 30; fi
  # FAIL_FAST=1 (mutation runs): one failed check is the verdict.
  if [ "${FAIL_FAST:-0}" = 1 ]; then printf '\nstopped at the first failure: %d passed, %d failed\n' "$PASS" "$FAIL"; exit 1; fi
}
check() { local d="$1"; shift; if "$@" > /dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
section() { printf '\n[%s]\n' "$1"; }
logged() { grep -qE -- "$1" "$LOG"; }
not_logged() { ! grep -qE -- "$1" "$LOG"; }
sha() { sha256sum "$1" | cut -d ' ' -f 1; }
rel_sha() { curl -fsS "$WEB/rel/$1/manifest-mainnet.json" | jq -r ".${2:-binary}.sha256"; }
expect_rc() { if [ "$RC" -eq "$2" ]; then ok "$1"; else bad "$1 (exit $RC, wanted $2)"; fi; }
st() { sed -n "s/^$1=//p" "$STATE" 2> /dev/null; }
restarts() { grep -c '^restart rougechain-validator' "$CALLS" 2> /dev/null || true; }
# restart_node — restart the (fake) node outside an update, and wait until it answers again.
restart_node() {
  sysd restart rougechain-validator
  for _ in $(seq 1 100); do if curl -fsS --max-time 1 "$LOCAL/api/health" > /dev/null 2>&1; then return 0; fi; sleep 0.1; done
  bad "fixture: the fake node did not come back after a restart"
}
node_tag() { curl -fsS --max-time 3 "$LOCAL/api/stats" 2> /dev/null | jq -r '.fake_tag // "?"' 2> /dev/null || echo down; }
node_up() { [ "$(node_tag)" != "down" ] && [ -n "$(node_tag)" ]; }
installed() { jq -r .version "$CONF/manifest.json" 2> /dev/null; }

# ── the fake world ───────────────────────────────────────────────────────────
block_hash() { printf 'block-%s-main' "$1" | sha256sum | cut -d ' ' -f 1; }
state_root() { printf 'root-%s-main' "$1" | sha256sum | cut -d ' ' -f 1; }

# ref_write DIR HEIGHT [CHAIN_ID] — the files a reference node at HEIGHT serves.
ref_write() {
  local d="$1" h="$2" chain="${3:-rougechain-mainnet-1}" n
  rm -rf "${d:?}/api"; mkdir -p "$d/api/block"
  printf '{"status":"ok","chain_id":"%s","height":%s}\n' "$chain" "$h" > "$d/api/health"
  printf '{"network_height":%s,"chain_id":"%s","state_root":"%s","is_mining":true}\n' "$h" "$chain" "$(state_root "$h")" > "$d/api/stats"
  for n in $(seq $((h > 25 ? h - 25 : 1)) "$h"); do
    printf '{"success":true,"block":{"height":%s,"hash":"%s","stateRoot":"%s"}}\n' "$n" "$(block_hash "$n")" "$(state_root "$n")" > "$d/api/block/$n"
  done
}
# chain HEIGHT — the network (and with it the reference node) is at HEIGHT. A fake node reads
# /fake/height when it starts.
chain() { echo "$1" > /fake/height; ref_write /ref-www "$1"; }
ref_up() {
  ref_down
  /ctx/busybox httpd -f -p 127.0.0.1:6100 -h /ref-www > /dev/null 2>&1 &
  echo $! > /run/ref.pid
  for _ in $(seq 1 50); do curl -fsS --max-time 1 "$REF/api/health" > /dev/null 2>&1 && return 0; sleep 0.1; done
  echo "fixture error: fake reference node did not start" >&2; exit 1
}
ref_down() { if [ -s /run/ref.pid ]; then kill "$(cat /run/ref.pid)" 2> /dev/null; rm -f /run/ref.pid; sleep 0.1; fi; }
ref2_up() { # a second reference node (REFERENCE_URLS) at HEIGHT $1 [chain id $2]
  ref2_down; mkdir -p /ref2-www; ref_write /ref2-www "$1" "${2:-rougechain-mainnet-1}"
  /ctx/busybox httpd -f -p 127.0.0.1:6200 -h /ref2-www > /dev/null 2>&1 &
  echo $! > /run/ref2.pid
  for _ in $(seq 1 50); do curl -fsS --max-time 1 "$REF2/api/health" > /dev/null 2>&1 && return 0; sleep 0.1; done
}
ref2_down() { if [ -s /run/ref2.pid ]; then kill "$(cat /run/ref2.pid)" 2> /dev/null; rm -f /run/ref2.pid; sleep 0.1; fi; }

sysd() { PATH="$RUN_PATH" systemctl "$@"; }

reset_all() {
  sysd stop rougechain-validator > /dev/null 2>&1 || true
  rm -rf /usr/local/bin/quantum-vault-daemon* /usr/local/bin/rougechain* /etc/rougechain /var/lib/rougechain /etc/systemd/system/rougechain-validator*
  rm -rf /usr/local/lib/rougechain /var/lib/rougechain-updater /etc/systemd/system/rougechain-update* /run/fake-systemd
  rm -f /fake/lag-* /fake/behaviour-* /fake/proposer /fake/mempool /var/log/fake-node.log
  userdel rougechain > /dev/null 2>&1 || true
  groupdel rougechain > /dev/null 2>&1 || true
  NOW=$T0; JITTER=0
}

# install REL [VAR=value…] — a fresh node on release REL via the installer (it starts the node).
install() {
  local rel="$1"; shift
  env -i PATH="$RUN_PATH" HOME=/root "${TEST_ENV[@]}" RELEASE_BASE_URLS="$WEB/rel/$rel" PEERS="$REF/api" NODE_NAME=upd-test "$@" \
    bash "$INSTALLER" > "$LOG" 2>&1
  RC=$?
}
fresh() { # fresh [REL] [VAR=value…] — reset, install REL (default: base), must succeed
  local rel="${1:-base}"; [ $# -gt 0 ] && shift
  reset_all
  install "$rel" "$@"
  if [ "$RC" -ne 0 ] || ! node_up; then bad "fixture: fresh install of '$rel' failed (exit $RC)"; fi
}
# upd ARGS… — run the installed updater as the timer would, with the test clock.
upd() {
  env -i PATH="$RUN_PATH" HOME=/root "${TEST_ENV[@]}" ROUGECHAIN_UPDATER_TEST_NOW="$NOW" ROUGECHAIN_UPDATER_TEST_SLEEP_DIV=50 \
    ROUGECHAIN_UPDATER_TEST_JITTER="$JITTER" "$UPD" "$@" > "$LOG" 2>&1
  RC=$?
}
conf() { # conf KEY VALUE — set one line of update.conf
  if grep -q "^$1=" "$UCONF"; then sed -i "s|^$1=.*|$1=$2|" "$UCONF"; else echo "$1=$2" >> "$UCONF"; fi
}
sources() { # sources REL… — where the updater looks for manifests
  local list="" r
  for r in "$@"; do case "$r" in http*) list="$list $r" ;; *) list="$list $WEB/rel/$r" ;; esac; done
  conf RELEASE_BASE_URLS "${list# }"
}
clear_state() { rm -f "$STATE"; NOW=$T0; JITTER=0; }
snapshot() { # everything an update may touch — not the updater's state, its settings (the tests edit them) or logs
  {
    find /usr/local/bin /usr/local/lib/rougechain /etc/rougechain /etc/systemd/system -type f ! -name update.conf -exec sha256sum {} + 2> /dev/null | sort -k 2
    find "$DATA" -maxdepth 1 -name node-keys.json -exec sha256sum {} + 2> /dev/null
  } | sha256sum | cut -d ' ' -f 1
}

# expect_rollback WHAT REASON_REGEX — after `upd run` of a bad 9.1.0 on a 9.0.0 node.
expect_rollback() {
  local what="$1" re="$2"
  expect_rc "$what: exit code $ROLLED_BACK (rolled back)" "$ROLLED_BACK"
  check "$what: the reason is logged loudly" logged "UPDATE FAILED: release 9\.1\.0 — .*$re"
  check "$what: says it rolled back and that the node answers again" bash -c "grep -q 'ROLLING BACK to release 9.0.0' $LOG && grep -q 'ROLLBACK: rolled back to 9.0.0; the node is answering again' $LOG"
  check "$what: the previous binary is back, the bad one kept as .failed" test "$(sha $BIN)" = "$V1_SHA" -a "$(sha $BIN.failed)" != "$V1_SHA"
  check "$what: install record is 9.0.0 again (manifest + both signatures)" bash -c "test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0 && cmp -s $CONF/manifest.json /tmp/base-manifest.json && test -s $CONF/manifest.json.ed25519.sig -a -s $CONF/manifest.json.mldsa65.sig"
  check "$what: the node runs the previous release again" test "$(node_tag)" = "v1"
  check "$what: release 9.1.0 is recorded as failed" bash -c "test \"\$(sed -n 's/^FAILED_VERSIONS=//p' $STATE)\" = 9.1.0 && grep -q '^LAST_RESULT=release 9.1.0 failed and was rolled back' $STATE"
}

# ── setup ────────────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
if ! command -v jq > /dev/null 2>&1 || ! command -v curl > /dev/null 2>&1; then
  { apt-get update -qq || { sleep 10; apt-get update -qq; }; } > /tmp/apt.log 2>&1
  apt-get install -y -qq --no-install-recommends curl ca-certificates openssl jq > /tmp/apt.log 2>&1 || { cat /tmp/apt.log; echo "could not install test prerequisites"; exit 1; }
fi
mkdir -p /fake /ref-www /run/systemd/system        # /run/systemd/system: "systemd is running" for the installer
chmod 0755 /fake
# shellcheck disable=SC1091
echo "=== $(. /etc/os-release && echo "$PRETTY_NAME") / $(openssl version) / $(bash --version | head -n 1) ==="
ROLLED_BACK=3
V1_SHA="$(rel_sha base)"; V2_SHA="$(rel_sha opt)"; V3_SHA="$(rel_sha newer)"
chain 100
ref_up
curl -fsS "$WEB/rel/base/manifest-mainnet.json" -o /tmp/base-manifest.json

section "installer sets up auto-update (with a service manager)"
fresh base
check "node installed, running release 9.0.0 (fake node v1), answering" test "$(installed)" = "9.0.0" -a "$(node_tag)" = "v1"
check "the installed CLI is one with 'release verify'" bash -c "$CLI release verify --help"
check "updater + command installed" test -s "$UPDATER" -a -x "$UPD"
check "timer enabled and started via systemctl" bash -c "grep -qx 'enable --now rougechain-update.timer' $CALLS && grep -q 'auto-update timer enabled: rougechain-update.timer (MODE=auto)' $LOG"
check "state dir + lock are root-only" bash -c "test \"\$(stat -c '%a %U' /var/lib/rougechain-updater/mainnet)\" = '755 root' && test \"\$(stat -c '%U' /run/rougechain-update-mainnet.lock)\" = root"
install base AUTO_UPDATE=0
check "re-run with AUTO_UPDATE=0: MODE=off, timer disabled and stopped" bash -c "grep -qx 'MODE=off' $UCONF && grep -qx 'disable --now rougechain-update.timer' $CALLS && grep -q 'auto-update is off: rougechain-update.timer is disabled' $LOG"
install base
check "re-run without AUTO_UPDATE: stays off (update.conf decides), timer stays disabled" bash -c "grep -qx 'MODE=off' $UCONF && test \"\$(grep -c '^enable --now rougechain-update.timer' $CALLS)\" = 1"
sources opt
upd run
expect_rc "timer-style run with MODE=off does nothing, exit 0" 0
check "…says so, and installed nothing" bash -c "grep -q 'auto-update is off (MODE=off' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
install base AUTO_UPDATE=1
check "re-run with AUTO_UPDATE=1: MODE=auto, timer enabled again; RELEASE_BASE_URLS setting kept" bash -c "grep -qx 'MODE=auto' $UCONF && test \"\$(grep -c '^enable --now rougechain-update.timer' $CALLS)\" = 2 && grep -q '^RELEASE_BASE_URLS=$WEB/rel/opt' $UCONF"
conf MODE notify
install base
check "MODE=notify in update.conf: kept by a re-run, timer enabled, next steps say notify only" bash -c "grep -qx 'MODE=notify' $UCONF && grep -q 'NOTIFY ONLY' $LOG"
check "the update unit's ExecStart is the installed command" bash -c "grep -qx 'ExecStart=$UPD run --network mainnet' /etc/systemd/system/rougechain-update.service"

section "status"
fresh base
upd status
expect_rc "status exits 0" 0
check "status: mode, pin, installed, nothing seen yet, timer, next check, updater" bash -c "grep -qE '^  mode +auto ' $LOG && grep -qE '^  pinned version +none' $LOG && grep -qE '^  installed release +9\.0\.0' $LOG && grep -qE '^  latest seen +nothing yet' $LOG && grep -qE '^  last check +never' $LOG && grep -qE '^  failed releases +none' $LOG && grep -qE '^  timer +rougechain-update.timer: enabled' $LOG && grep -qE '^  next check +Fri 2026-10-02' $LOG && grep -qE '^  updater +v[0-9]+\.[0-9]+\.[0-9]+ ' $LOG"

section "nothing newer: up to date; older and equal manifests are ignored"
BEFORE="$(snapshot)"; R0="$(restarts)"
sources base
upd run
expect_rc "the same release offered again (equal version): exit 0" 0
check "…reported as up to date" logged "up to date: release 9\.0\.0 is installed"
sources old
upd run
expect_rc "an OLDER validly signed manifest (8.9.0): exit 0" 0
check "…reported as older and ignored (stale mirror / replay), not installed" bash -c "grep -q 'serves release 8.9.0, OLDER than the installed 9.0.0' $LOG && grep -q 'up to date' $LOG"
sources old base
upd run
check "older + equal together: still nothing to do" logged "up to date"
check "nothing on disk changed, the node was not restarted" test "$(snapshot)" = "$BEFORE" -a "$(restarts)" = "$R0"
check "every line of a run carries the journal prefix" bash -c "! grep -qv '^rougechain-update\[mainnet\]: ' $LOG"
upd status
check "status after a check: last check time, result, latest seen" bash -c "grep -qE '^  last check +20[0-9]{2}-' $LOG && grep -qE '^  last result +up to date \(9\.0\.0\)' $LOG && grep -qE '^  latest seen +9\.0\.0' $LOG"

section "forged, unsigned and wrongly signed manifests are refused"
for src in forged wrongkey unsigned pqgarbage; do
  sources "$src"
  upd run
  expect_rc "$src: exit 1" 1
  case "$src" in
    unsigned) check "unsigned: no signature file → not used" logged "could not fetch the signature .*ed25519\.sig" ;;
    pqgarbage) check "pqgarbage: valid Ed25519 but a malformed ML-DSA-65 signature file → refused" logged "SIGNATURE CHECK FAILED for .*ML-DSA-65 signature file is not a 3309-byte signature" ;;
    *) check "$src: the Ed25519 signature check failed, said loudly" logged "\[!\] SIGNATURE CHECK FAILED for $WEB/rel/$src/manifest-mainnet.json — this manifest was NOT signed by the release key" ;;
  esac
done
check "…nothing changed, no restart" test "$(snapshot)" = "$BEFORE" -a "$(restarts)" = "$R0"
upd status
check "status shows the error of the last run" logged "last result +error: (NO source served a validly signed|no release source could be reached)"
sources forged opt
JITTER=0 upd run
expect_rc "a forged source next to a good one: the good one is installed" 0
check "…the forgery was reported, release 9.1.0 installed" bash -c "grep -q 'SIGNATURE CHECK FAILED for $WEB/rel/forged' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"

section "a new release installs, the node restarts, the health check passes"
fresh base
KEY_SHA="$(sha $DATA/node-keys.json)"
sources opt
upd run
expect_rc "run: exit 0" 0
check "release 9.1.0 installed: binary matches the signed sha256, .prev is the old one" test "$(sha $BIN)" = "$V2_SHA" -a "$(sha $BIN.prev)" = "$V1_SHA"
check "install record: manifest 9.1.0 + both signatures" bash -c "test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0 && test -s $CONF/manifest.json.ed25519.sig -a -s $CONF/manifest.json.mldsa65.sig"
check "the node was restarted exactly once and now runs the new release" test "$(restarts)" = 1 -a "$(node_tag)" = "v2"
check "both signatures were verified before anything was installed" bash -c "grep -q 'signature OK (Ed25519 release key' $LOG && grep -q 'signature OK (ML-DSA-65 release key .*checked with $CLI)' $LOG"
check "health check passed against the reference node" logged "UPDATE OK: release 9\.1\.0 is installed \(was 9\.0\.0\) — healthy: agrees with $REF/api \(local height 100, reference 100, same block and state\)"
check "node key and unit untouched" bash -c "test \"\$(sha256sum $DATA/node-keys.json | cut -d ' ' -f 1)\" = $KEY_SHA && grep -q -- '--node-name upd-test' $UNIT"
check "state: result, no failed release, nothing pending" bash -c "grep -qx 'LAST_RESULT=updated to 9.1.0' $STATE && grep -q '^LAST_UPDATE_RESULT=9.0.0 -> 9.1.0: healthy' $STATE && test -z \"\$(sed -n 's/^FAILED_VERSIONS=//p' $STATE)\" && test -z \"\$(sed -n 's/^PENDING_VERSION=//p' $STATE)\""
check "no temp dir left behind" bash -c '! ls -d /tmp/tmp.* 2>/dev/null | grep -q .'
check "every line of the update run carries the journal prefix" bash -c "! grep -qv '^rougechain-update\[mainnet\]: ' $LOG"
upd run
expect_rc "next run: exit 0" 0
check "…up to date, no second restart" bash -c "grep -q 'up to date: release 9.1.0' $LOG && test \"\$(grep -c '^restart rougechain-validator' $CALLS)\" = 1"
upd status
check "status: installed 9.1.0, last update result" bash -c "grep -qE 'installed release +9\.1\.0' $LOG && grep -qE 'last update +20.* — 9\.0\.0 -> 9\.1\.0: healthy' $LOG"

section "sources: the newest validly signed release wins"
fresh base; sources base opt
upd run
check "stale primary (9.0.0) + newer mirror (9.1.0) → 9.1.0 installed" test "$(installed)" = "9.1.0" -a "$(node_tag)" = "v2"
fresh base; sources opt base
upd run
check "newer primary (9.1.0) + stale mirror (9.0.0) → 9.1.0 installed" test "$(installed)" = "9.1.0"
fresh base; sources old opt newer base
upd run
check "four sources (8.9.0, 9.1.0, 9.2.0, 9.0.0) → the highest, 9.2.0" test "$(installed)" = "9.2.0" -a "$(sha $BIN)" = "$V3_SHA"
fresh base; sources "$DOWN/rel/opt" opt
upd run
expect_rc "primary down (connection refused) → mirror used, exit 0" 0
check "…the failure was reported and 9.1.0 installed from the mirror" bash -c "grep -q 'could not fetch $DOWN/rel/opt/manifest-mainnet.json' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
fresh base; sources "$DOWN/a" "$WEB/rel/missing"
BEFORE="$(snapshot)"
upd run
expect_rc "every source unreachable: exit 1" 1
check "…said so, nothing changed, not marked as a failed release" bash -c "grep -q 'no release source could be reached' $LOG && test -z \"\$(sed -n 's/^FAILED_VERSIONS=//p' $STATE)\""
check "…nothing changed" test "$(snapshot)" = "$BEFORE" -a "$(restarts)" = 0
sources mirror
upd run
expect_rc "binary: primary down, a tampered mirror, then a good mirror → installed" 0
check "…tampered mirror rejected by sha256, good one installed" bash -c "grep -q 'binary: sha256 .* does not match the signed manifest' $LOG && test \"\$(sha256sum $BIN | cut -d ' ' -f 1)\" = $V2_SHA"

section "a file that does not match the signed manifest is never installed"
fresh base; sources badsha
BEFORE="$(snapshot)"
upd run
expect_rc "binary with the right size but wrong sha256 from every URL: exit 1" 1
check "…refused by sha256, nothing changed, no restart" bash -c "grep -q 'binary: sha256 .* does not match the signed manifest' $LOG && grep -q 'could not obtain a binary matching the signed manifest' $LOG"
check "…nothing changed, no restart, node still on v1" test "$(snapshot)" = "$BEFORE" -a "$(restarts)" = 0 -a "$(node_tag)" = "v1"
check "…a download problem is not a 'failed release': it is tried again next time" bash -c "test -z \"\$(sed -n 's/^FAILED_VERSIONS=//p' $STATE)\""
sources opt
upd run
check "…and the next run (good source) installs it" test "$(installed)" = "9.1.0"

section "unhealthy release → rollback, recorded as failed, no retry loop, a newer release is tried"
fresh base
for pair in "chain|the node reports chain id 'rougechain-evil-1'" "act|upgrade schedule mismatch: the node reports token_minting = missing, the release manifest says 235" \
    "height|upgrade schedule mismatch: the node reports token_minting = 240, the release manifest says 235" \
    "stuck|not keeping up with the network after 300s: local height 95, $REF/api is at 100" \
    "root|this node DIVERGED from $REF/api: state root at height 100 is" "fork|this node DIVERGED from $REF/api: block 99 is" \
    "crash|the node API did not answer within 120s of the restart"; do
  rel="${pair%%|*}"; re="${pair#*|}"
  clear_state; sources "$rel"
  R0="$(restarts)"
  upd run
  expect_rollback "$rel" "$re"
  check "$rel: two restarts (new release, then the previous one)" test "$(($(restarts) - R0))" = 2
done
check "the fake node really took each bad start (crash at start was exercised)" grep -q "crashing at start" /var/log/fake-node.log

clear_state; sources norun
R0="$(restarts)"
upd run
expect_rc "a binary that does not run here: exit $ROLLED_BACK" "$ROLLED_BACK"
check "…caught before any restart, rolled back, recorded as failed" bash -c "grep -q 'UPDATE FAILED: release 9.1.0 — the installed binary does not run on this system' $LOG && test \"\$(sed -n 's/^FAILED_VERSIONS=//p' $STATE)\" = 9.1.0"
check "…binary is v1 again, the node was never restarted and still answers" test "$(sha $BIN)" = "$V1_SHA" -a "$(restarts)" = "$R0" -a "$(node_tag)" = "v1"

clear_state; sources opt
mkdir "$BIN.new"                         # the new binary cannot be written (stands in for a full disk)
R0="$(restarts)"
upd run
expect_rc "the new binary cannot be written: exit $ROLLED_BACK" "$ROLLED_BACK"
check "…reported, the binary in place is still the previous one, install record still 9.0.0" bash -c "grep -q 'UPDATE FAILED: release 9.1.0 — could not write the new binary' $LOG && grep -q 'ROLLBACK: rolled back to 9.0.0' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
check "…binary is v1, the node was never restarted and still answers" test "$(sha $BIN)" = "$V1_SHA" -a "$(restarts)" = "$R0" -a "$(node_tag)" = "v1"
rmdir "$BIN.new" 2> /dev/null || rm -rf "${BIN:?}.new"

# no retry loop
clear_state; sources norun; upd run      # (9.1.0 is recorded as failed again, with the 'does not run' reason)
sources crash
R0="$(restarts)"; BEFORE="$(snapshot)"
for i in 1 2 3; do
  upd run
  check "failed release, later run #$i: exit 0, not tried again, no restart" bash -c "test $RC = 0 && grep -q 'release 9.1.0 FAILED on this node before and was rolled back' $LOG && test \"\$(grep -c '^restart rougechain-validator' $CALLS)\" = $R0"
done
check "…nothing on disk changed in those runs" test "$(snapshot)" = "$BEFORE"
upd status
check "status names the failed release and why (the first failure is the one recorded), nothing pending" bash -c "grep -qE 'failed releases +9\.1\.0 \(not retried; last: 9\.1\.0 at .*the installed binary does not run on this system' $LOG && ! grep -q '^  pending' $LOG"
upd check
check "check reports the failed release too, changes nothing" bash -c "grep -q 'FAILED on this node before' $LOG && test \"\$(sha256sum $BIN | cut -d ' ' -f 1)\" = $V1_SHA"
# a newer release is tried
sources crash newer
upd run
expect_rc "a NEWER release (9.2.0) is tried although 9.1.0 failed: exit 0" 0
check "…installed and healthy" bash -c "test \"\$(jq -r .version $CONF/manifest.json)\" = 9.2.0 && grep -q 'UPDATE OK: release 9.2.0' $LOG"
check "…node runs v3" test "$(node_tag)" = "v3"
# --retry-failed
fresh base; sources crash
upd run
expect_rc "(setup) 9.1.0 crashes and is rolled back" "$ROLLED_BACK"
sources opt          # the same version, now a good build of it (the operator fixed the cause)
upd run
check "without --retry-failed the failed version is still skipped" bash -c "test $RC = 0 && grep -q 'FAILED on this node before' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
upd run --retry-failed
expect_rc "run --retry-failed tries it again: exit 0" 0
check "…installed, and no longer listed as failed" bash -c "test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0 && test -z \"\$(sed -n 's/^FAILED_VERSIONS=//p' $STATE)\""

section "rollback when the previous release does not come back either"
fresh base; sources crash
echo crash > /fake/behaviour-v1          # from now on v1 crashes at start too (it is still running)
upd run
expect_rc "new release crashes AND the old one does not come back: exit 4" 4
check "…files are rolled back and it says the node needs attention" bash -c "test \"\$(sha256sum $BIN | cut -d ' ' -f 1)\" = $V1_SHA && grep -q 'BUT THE NODE IS NOT ANSWERING' $LOG && grep -q '^LAST_UPDATE_RESULT=9.0.0 -> 9.1.0 FAILED' $STATE"
rm -f /fake/behaviour-v1

section "reference node unreachable is not a reason to roll back"
fresh base PEERS=http://127.0.0.1:6999/api      # nothing listens there
sources opt
upd run
expect_rc "healthy release, reference unreachable: exit 0 (NOT rolled back)" 0
check "…installed, running, and reported as UNVERIFIED against a reference" bash -c "test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0 && grep -q 'UPDATE OK: release 9.1.0 .*UNVERIFIED against a reference node (none could be reached for 300s' $LOG && grep -q '\[!\] health check: UNVERIFIED' $LOG"
check "…node runs v2, one restart" test "$(node_tag)" = "v2" -a "$(restarts)" = 1
fresh base PEERS=http://127.0.0.1:6999/api
sources chain
upd run
expect_rc "unreachable reference + a release with the wrong chain id: still rolled back (local checks)" "$ROLLED_BACK"
fresh base PEERS=http://127.0.0.1:6999/api
sources stuck
upd run
expect_rc "unreachable reference + a node 5 blocks lower than before the update: rolled back" "$ROLLED_BACK"
check "…because its height went backwards" logged "height went backwards \(100 before the update, 95 now\) and no reference node was reachable"
fresh base PEERS=http://127.0.0.1:6999/api
conf REFERENCE_URLS "$REF"
sources opt
upd run
check "peer unreachable, an extra REFERENCE_URLS node reachable → verified against it" logged "UPDATE OK: release 9\.1\.0 .*healthy: agrees with $REF/api"
fresh base PEERS=http://127.0.0.1:6999/api
ref2_up 100 rougechain-other-9
conf REFERENCE_URLS "$REF2/api"
sources opt
upd run
check "a reference node on ANOTHER chain is not used for comparison (→ unverified, not rolled back)" bash -c "test $RC = 0 && grep -q 'UNVERIFIED against a reference node' $LOG"
ref2_up 100
ref_write /ref2-www 100; printf '{"network_height":100,"chain_id":"rougechain-mainnet-1","state_root":"%s"}\n' "$(printf x | sha256sum | cut -d ' ' -f 1)" > /ref2-www/api/stats
fresh base
conf REFERENCE_URLS "$REF2/api"
sources opt
upd run
check "two references that disagree with each other: agreeing with one is enough, the disagreement is logged" bash -c "test $RC = 0 && grep -q 'reference nodes disagree with each other' $LOG && grep -q 'UPDATE OK' $LOG"
ref2_down

section "keeping up: lag, syncing nodes, idle chain"
fresh base
chain 102                                # the network moved on 2 blocks; v2 starts at 102 too
echo 2 > /fake/lag-v2
sources opt
upd run
check "2 blocks behind the reference (allowed lag 2), same block at the common height → healthy" bash -c "test $RC = 0 && grep -q 'agrees with $REF/api (local height 100, reference 102' $LOG"
fresh base
chain 103; echo 3 > /fake/lag-v2
sources opt
upd run
expect_rc "3 blocks behind and not advancing → rolled back" "$ROLLED_BACK"
check "…reason: not keeping up" logged "not keeping up with the network after 300s: local height 100, $REF/api is at 103"
chain 100
fresh base
echo 12 > /fake/lag-v1                   # a node that is still syncing before the update: 12 behind
restart_node
check "(setup) node is at 88, reference at 100" test "$(curl -fsS $LOCAL/api/stats | jq -r .network_height)" = 88
echo 7 > /fake/lag-v2                    # …and after the update's restart it is at 93: advancing, still behind
sources opt
upd run
check "a node that was already syncing and advances after the update is healthy (not rolled back)" bash -c "test $RC = 0 && grep -q 'is syncing (it was 12 blocks behind before the update, 7 now)' $LOG"
fresh base
echo 12 > /fake/lag-v1; echo 12 > /fake/lag-v2
restart_node
sources opt
upd run
expect_rc "a syncing node that does NOT advance after the update → rolled back" "$ROLLED_BACK"
check "…reason: not keeping up" logged "not keeping up with the network after 300s: local height 88"
rm -f /fake/lag-v1 /fake/lag-v2
fresh base
conf HEALTH_MAX_LAG_BLOCKS 0
sources opt
upd run
check "idle chain (no new blocks at all), allowed lag 0: equal heights are comparable → healthy" bash -c "test $RC = 0 && grep -q 'local height 100, reference 100, same block and state' $LOG"

section "ML-DSA-65"
fresh base; sources badpq
BEFORE="$(snapshot)"
upd run
expect_rc "valid Ed25519, INVALID ML-DSA-65 signature, verifier installed: exit 1" 1
check "…refused loudly before anything is downloaded or installed" bash -c "grep -q 'ML-DSA-65 SIGNATURE CHECK FAILED for $WEB/rel/badpq/manifest-mainnet.json' $LOG && ! grep -q 'downloading' $LOG"
check "…nothing changed, no restart" test "$(snapshot)" = "$BEFORE" -a "$(restarts)" = 0
sources badpq opt
upd run
check "a source with a bad ML-DSA-65 signature next to a good one: the good one is installed" bash -c "test $RC = 0 && grep -q 'ML-DSA-65 SIGNATURE CHECK FAILED' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
fresh baseold                            # like node 1.6.0: its CLI has no 'release verify'
check "(setup) installed CLI has no verifier; the installer said ML-DSA-65 was not verified" bash -c "! $CLI release verify --help && grep -q 'ML-DSA-65 signature present; not verified yet' $LOG"
# On such a node Ed25519 is the only check before installing: it alone must stop a forgery.
BEFORE="$(snapshot)"
for src in forged wrongkey; do
  sources "$src"
  upd run
  expect_rc "no ML-DSA-65 verifier installed, $src manifest: exit 1" 1
  check "…refused by the Ed25519 check alone, nothing downloaded" bash -c "grep -q '\[!\] SIGNATURE CHECK FAILED for $WEB/rel/$src/manifest-mainnet.json — this manifest was NOT signed by the release key' $LOG && ! grep -q 'downloading' $LOG"
done
check "…nothing changed, no restart" test "$(snapshot)" = "$BEFORE" -a "$(restarts)" = 0
sources opt
upd run
expect_rc "no verifier installed → update proceeds on Ed25519, exit 0" 0
check "…and the ML-DSA-65 signature is verified with the CLI of the new release before the restart" bash -c "grep -q 'ML-DSA-65 signature present; not verified yet' $LOG && grep -q 'signature OK (ML-DSA-65 release key .*checked with the CLI of this release)' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
fresh baseold; sources badpq
upd run
expect_rc "no verifier installed + invalid ML-DSA-65: caught after the swap, exit $ROLLED_BACK" "$ROLLED_BACK"
check "…rolled back WITHOUT ever restarting the node, recorded as failed" bash -c "grep -q 'UPDATE FAILED: release 9.1.0 — the ML-DSA-65 SIGNATURE of release 9.1.0 does NOT verify' $LOG && test \"\$(sed -n 's/^FAILED_VERSIONS=//p' $STATE)\" = 9.1.0 && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
check "…binary and CLI are the previous ones, no restart, node still v1" test "$(sha $BIN)" = "$V1_SHA" -a "$(sha $CLI)" = "$(rel_sha baseold cli)" -a "$(restarts)" = 0 -a "$(node_tag)" = "v1"
reset_all
install badpqfresh
expect_rc "installer, fresh install of a release whose ML-DSA-65 signature is invalid: refused (exit 1)" 1
check "…caught with the CLI of that release before the service is started; files removed again" bash -c "grep -q 'ML-DSA-65 SIGNATURE of release 9.0.0 does NOT verify' $LOG && test ! -e $BIN -a ! -e $CLI -a ! -e $CONF/manifest.json && ! grep -q '^start rougechain-validator' $CALLS 2>/dev/null"

section "modes: notify, off, check, pin"
fresh base; sources opt
BEFORE="$(snapshot)"
conf MODE notify
upd run
expect_rc "MODE=notify: exit 0" 0
check "…reports the release, installs nothing, no restart" bash -c "grep -q 'UPDATE AVAILABLE: release 9.1.0 (installed: 9.0.0). Not installed (MODE=notify)' $LOG && grep -q '^LAST_RESULT=available: 9.1.0 (not installed: MODE=notify)' $STATE"
check "…nothing changed" test "$(snapshot)" = "$BEFORE" -a "$(restarts)" = 0 -a "$(installed)" = "9.0.0"
sources mand
upd run
check "MODE=notify + a mandatory release: says MANDATORY and the height" logged "UPDATE AVAILABLE: release 9\.1\.0 .*MANDATORY, install before block 235"
upd status
check "status: latest seen is marked mandatory" logged "latest seen +9\.1\.0 \(mandatory, before block 235\)"
conf MODE off
upd run
check "MODE=off: nothing done" bash -c "test $RC = 0 && grep -q 'auto-update is off' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
upd check
check "check works even with MODE=off, and changes nothing" bash -c "test $RC = 0 && grep -q 'UPDATE AVAILABLE: release 9.1.0 .*Not installed (check only)' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
conf MODE bogus
upd run
check "an invalid MODE is treated as notify (nothing installed) and reported" bash -c "test $RC = 0 && grep -q \"MODE='bogus' is not auto, notify or off\" $LOG && grep -q 'Not installed (MODE=notify)' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
conf MODE auto
conf PIN_VERSION 9.1.0
sources newer opt
upd run
expect_rc "PIN_VERSION=9.1.0 with 9.2.0 and 9.1.0 on offer: exit 0" 0
check "…the pinned release is installed, not the newest; the newer one is reported" bash -c "test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0 && grep -q 'PIN_VERSION=9.1.0: release 9.2.0 is available and will NOT be installed' $LOG"
R0="$(restarts)"
upd run
check "…and it stays there: pinned, nothing to install, no restart" bash -c "test $RC = 0 && grep -q 'pinned to 9.1.0 (installed: 9.1.0) — nothing to install' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0 && test \"\$(grep -c '^restart rougechain-validator' $CALLS)\" = $R0"
fresh base; sources opt newer
conf PIN_VERSION 9.0.0
upd run
check "pinned to the installed release: nothing is installed" bash -c "test $RC = 0 && grep -q 'nothing to install' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
conf PIN_VERSION 9.5.0
upd run
check "pinned to a release no source offers: nothing is installed" bash -c "test $RC = 0 && grep -q 'nothing to install' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
conf PIN_VERSION 8.9.0
sources old opt
upd run
check "a pin BELOW the installed release never downgrades" bash -c "test $RC = 0 && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0 && test \"\$(grep -c '^restart rougechain-validator' $CALLS)\" = 0"
conf PIN_VERSION latest
upd run
check "an invalid PIN_VERSION installs nothing and is reported" bash -c "test $RC = 0 && grep -q \"PIN_VERSION='latest' is not a version\" $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
conf PIN_VERSION ""
upd run
check "pin removed → the newest release is installed" test "$(installed)" = "9.1.0"

section "timing: optional releases wait a per-host delay, mandatory ones do not"
fresh base; sources opt
JITTER=5000; NOW=$T0                      # this host's place in the 6 h window: 50 % = 10800 s
upd run
expect_rc "optional release, first seen now: exit 0" 0
check "…scheduled, not installed, no restart" bash -c "grep -q 'optional release 9.1.0: scheduled for .*10800s left' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0 && ! grep -q '^restart' $CALLS"
check "…state records when" bash -c "grep -qx 'PENDING_VERSION=9.1.0' $STATE && grep -qx 'PENDING_FIRST_SEEN=$T0' $STATE && grep -qx 'PENDING_INSTALL_AFTER=$((T0 + 10800))' $STATE"
upd status
check "status shows the pending release and its time" logged "pending +9\.1\.0 — not before 20"
NOW=$((T0 + 10799)); upd run
check "one second before its time: still waiting (the first-seen time is kept)" bash -c "grep -q 'scheduled for .*1s left' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0 && grep -qx 'PENDING_FIRST_SEEN=$T0' $STATE"
NOW=$((T0 + 10800)); upd run
check "at its time: installed" bash -c "test $RC = 0 && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
fresh base; sources opt
JITTER=9999; NOW=$T0; upd run
NOW=$((T0 + 100)); upd run --now
check "run --now skips the delay" bash -c "test $RC = 0 && grep -q -- '--now: no delay' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
fresh base; sources opt
conf OPTIONAL_DELAY_MAX_SECS 0
JITTER=9999; upd run
check "OPTIONAL_DELAY_MAX_SECS=0: no delay" test "$(installed)" = "9.1.0"
fresh base; sources opt
env -i PATH="$RUN_PATH" HOME=/root "${TEST_ENV[@]}" ROUGECHAIN_UPDATER_TEST_NOW="$T0" "$UPD" run > "$LOG" 2>&1
A1="$(st PENDING_INSTALL_AFTER)"
env -i PATH="$RUN_PATH" HOME=/root "${TEST_ENV[@]}" ROUGECHAIN_UPDATER_TEST_NOW="$((T0 + 5))" "$UPD" run > "$LOG" 2>&1
A2="$(st PENDING_INSTALL_AFTER)"
check "without the test override the delay is stable for this host and within the 6 h window" test -n "$A1" -a "$A1" = "$A2" -a "$A1" -ge "$T0" -a "$A1" -le "$((T0 + 21600))"
# mandatory
fresh base; sources mand                 # mandatory, upgrade_before_height 235; the chain is at 100
JITTER=5000; NOW=$T0
upd run
expect_rc "mandatory release, deadline far (height 100 of 235): exit 0" 0
check "…waits its short per-host delay IN the run (300 s of at most 600), then installs" bash -c "grep -q 'mandatory release 9.1.0: installing in 300s (per-host delay, at most 600s)' $LOG && grep -q 'UPDATE OK: release 9.1.0' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
chain 226
fresh base; sources mand                 # 235 − 226 = 9 ≤ margin 10
JITTER=9999; NOW=$T0
upd run
check "mandatory release, chain within the safety margin of the upgrade height: installed immediately" bash -c "test $RC = 0 && grep -q 'within 10 blocks of upgrade height 235 .*installing now' $LOG && ! grep -q 'installing in ' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
chain 224
fresh base; sources mand                 # 235 − 224 = 11 > margin 10
JITTER=9999; NOW=$T0
upd run
check "…one block outside the margin: the per-host delay applies" logged "mandatory release 9\.1\.0: installing in 599s"
chain 240
fresh base; sources mand
JITTER=9999; upd run
check "mandatory release, chain already PAST the upgrade height: installed immediately" bash -c "test $RC = 0 && grep -q 'installing now' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
chain 100

section "validator safety: do not restart the designated proposer while it has transactions"
fresh base VALIDATOR=1 PUBLIC_URL=https://node.example.com
OWN="$(jq -r .public_key_hex $DATA/node-keys.json)"
echo "$OWN" > /fake/proposer; echo 3 > /fake/mempool
restart_node
check "(setup) the node reports itself as designated proposer, mining, 3 pending transactions" bash -c "test \"\$(curl -fsS $LOCAL/api/stats | jq -r .designated_proposer_next)\" = $OWN && test \"\$(curl -fsS $LOCAL/api/stats | jq -r .is_mining)\" = true && curl -fsS $LOCAL/metrics | grep -qx 'rougechain_mempool_size 3'"
conf PROPOSER_DEFER_MAX_SECS 60
sources opt
R0="$(restarts)"
upd run
expect_rc "designated proposer with pending transactions: exit 0" 0
check "…the restart is deferred, bounded (60 s), then done anyway" bash -c "grep -q 'designated proposer of the next block and has 3 pending transaction(s) — deferring the restart (at most 60s)' $LOG && grep -q 'still the designated proposer with pending transactions after 60s — restarting anyway' $LOG && grep -q 'UPDATE OK' $LOG"
check "…exactly one restart, after the deferral" test "$(($(restarts) - R0))" = 1
fresh base VALIDATOR=1 PUBLIC_URL=https://node.example.com
OWN="$(jq -r .public_key_hex $DATA/node-keys.json)"
echo "$OWN" > /fake/proposer; echo 0 > /fake/mempool
restart_node
sources opt; upd run
check "designated proposer but an EMPTY mempool: no deferral" bash -c "test $RC = 0 && ! grep -q 'deferring the restart' $LOG && grep -q 'UPDATE OK' $LOG"
fresh base VALIDATOR=1 PUBLIC_URL=https://node.example.com
echo "00112233445566778899aabbccddeeff" > /fake/proposer; echo 5 > /fake/mempool
restart_node
sources opt; upd run
check "another validator is the designated proposer: no deferral" bash -c "test $RC = 0 && ! grep -q 'deferring the restart' $LOG && grep -q 'UPDATE OK' $LOG"
fresh base                               # not a validator (no --mine)
OWN="$(jq -r .public_key_hex $DATA/node-keys.json)"
echo "$OWN" > /fake/proposer; echo 5 > /fake/mempool
restart_node
sources opt; upd run
check "a node that does not produce blocks is never deferred" bash -c "test $RC = 0 && ! grep -q 'deferring the restart' $LOG"
chain 230
fresh base VALIDATOR=1 PUBLIC_URL=https://node.example.com
OWN="$(jq -r .public_key_hex $DATA/node-keys.json)"
echo "$OWN" > /fake/proposer; echo 3 > /fake/mempool
restart_node
sources mand; JITTER=9999
upd run
check "deadline override: mandatory release near its upgrade height → no deferral, no delay" bash -c "test $RC = 0 && grep -q 'upgrade height is near — not deferring' $LOG && ! grep -q 'deferring the restart (at most' $LOG && grep -q 'UPDATE OK' $LOG"
chain 100
fresh base VALIDATOR=1 PUBLIC_URL=https://node.example.com
OWN="$(jq -r .public_key_hex $DATA/node-keys.json)"
echo "$OWN" > /fake/proposer; echo 3 > /fake/mempool
restart_node
sources opt; upd run --now
check "run --now does not defer either" bash -c "test $RC = 0 && ! grep -q 'deferring the restart' $LOG && grep -q 'UPDATE OK' $LOG"
rm -f /fake/proposer /fake/mempool

section "lock: one install or update at a time"
fresh base; sources opt
BEFORE="$(snapshot)"
flock /run/rougechain-update-mainnet.lock sleep 6 &
FLOCK_PID=$!
sleep 0.5
upd run
expect_rc "a second run while the lock is held: exit 0, nothing done" 0
check "…says another run is in progress, changed nothing" bash -c "grep -q 'another install or update is running for mainnet' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0"
check "…nothing changed" test "$(snapshot)" = "$BEFORE" -a "$(restarts)" = 0
install opt
expect_rc "the installer refuses to run while the lock is held: exit 1" 1
check "…with a clear message" logged "another install or update is running for mainnet"
wait "$FLOCK_PID" 2> /dev/null
upd run
check "after the lock is released the update runs" test "$(installed)" = "9.1.0"
check "the node started by the update does not hold the lock (a later run is not blocked)" bash -c "flock -n /run/rougechain-update-mainnet.lock true"

section "releases that need no restart, or no start"
fresh base; sources samebin
upd run
expect_rc "a release with the SAME node binary (new CLI only): exit 0" 0
check "…installed without restarting the node" bash -c "test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0 && grep -q 'the node binary is unchanged, no restart was needed' $LOG && ! grep -q '^restart' $CALLS"
check "…the CLI was replaced, the old one kept as .prev" test "$(sha $CLI)" = "$(rel_sha samebin cli)" -a "$(sha $CLI.prev)" = "$(rel_sha base cli)"
fresh base; sources opt
sysd stop rougechain-validator
STARTS0="$(grep -cE '^(re)?start rougechain-validator' "$CALLS")"
upd run
expect_rc "the node service was stopped by the operator: exit 0" 0
check "…files are updated but the service is NOT started" bash -c "test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0 && grep -q 'rougechain-validator was not running and was not started' $LOG && test \"\$(grep -cE '^(re)?start rougechain-validator' $CALLS)\" = $STARTS0"
check "…node is still down" bash -c "! curl -fsS --max-time 2 $LOCAL/api/health"

section "releases the updater must not install by itself"
fresh base; sources genesis
BEFORE="$(snapshot)"
upd run
expect_rc "a release with a different genesis file: exit 1" 1
check "…refused (a genesis change is never done unattended), nothing changed" bash -c "grep -q 'comes with a genesis file different from the installed one' $LOG"
check "…nothing changed" test "$(snapshot)" = "$BEFORE" -a "$(restarts)" = 0
sources mininst
upd run
expect_rc "min_installer_version newer than this updater, no updater in the manifest: exit 1" 1
check "…refused with what to do, nothing changed" bash -c "grep -q 'release 9.1.0 needs updater v99.0.0 or newer' $LOG"
check "…nothing changed" test "$(snapshot)" = "$BEFORE" -a "$(restarts)" = 0
check "…neither is recorded as a failed release" bash -c "test -z \"\$(sed -n 's/^FAILED_VERSIONS=//p' $STATE)\""
cp "$UNIT" /tmp/unit.bak
sed -i '1d' "$UNIT"                      # no longer "managed by install-validator.sh"
sources opt; upd run
expect_rc "a unit the installer did not write: exit 1" 1
check "…refused" logged "was not written by install-validator.sh"
cp /tmp/unit.bak "$UNIT"
mv "$CONF/manifest.json" /tmp/manifest.bak
upd run
expect_rc "no install record: exit 1" 1
check "…refused" logged "no install record"
mv /tmp/manifest.bak "$CONF/manifest.json"
cp "$UCONF" /tmp/uconf.bak
# shellcheck disable=SC2016  # literal $(…): it must reach the file unexpanded
printf 'MODE=auto\nRELEASE_BASE_URLS=%s\nHEALTH_DEADLINE_SECS=$(touch /tmp/pwned)\nFOO=bar\nthis is not a setting\nREFERENCE_URLS=http://x/$(id)\n' "$WEB/rel/base" > "$UCONF"
upd run
check "update.conf is parsed, never executed: bad lines are reported, defaults used" bash -c "test $RC = 0 && test ! -e /tmp/pwned && grep -q 'HEALTH_DEADLINE_SECS=.* is not a number' $LOG && grep -q 'unknown setting FOO' $LOG && grep -q 'line not understood' $LOG && grep -q 'REFERENCE_URLS must be space-separated http(s) URLs' $LOG && grep -q 'up to date' $LOG"
cp /tmp/uconf.bak "$UCONF"

section "the updater updates itself only from a signed manifest"
fresh base
OLD_UPD_SHA="$(sha $UPDATER)"
INS_SHA="$(rel_sha ins installer)"
sources ins
upd run
expect_rc "release 9.1.0 names a newer updater (v2.9.0) in its signed manifest: exit 0" 0
check "…the updater replaced itself with exactly that file (sha256), old one kept as .prev" test "$(sha $UPDATER)" = "$INS_SHA" -a "$(sha $UPDATER.prev)" = "$OLD_UPD_SHA" -a "$INS_SHA" != "$OLD_UPD_SHA"
check "…verified by sha256, then continued as the new one and finished the update" bash -c "grep -q 'updater verified: sha256 $INS_SHA' $LOG && grep -q 'the updater was replaced by the one in the signed release (v.* -> v2.9.0); continuing with it' $LOG && grep -q 'rougechain-update\[mainnet\]: ==> v2.9.0 run' $LOG && grep -q 'UPDATE OK: release 9.1.0' $LOG"
check "…origin recorded; installed command reports the new version; node updated" bash -c "grep -qx 'UPDATER_SOURCE=signed release 9.1.0' $STATE && test \"\$($UPD --version)\" = 2.9.0 && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
check "…the node was restarted once (not once per updater)" test "$(restarts)" = 1
fresh base; sources insmin
upd run
check "a release that NEEDS a newer updater (min_installer_version 2.9.0) and ships it: self-update, then install" bash -c "test $RC = 0 && test \"\$($UPD --version)\" = 2.9.0 && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
fresh base
OLD_UPD_SHA="$(sha $UPDATER)"
sources insold
upd run
check "a release naming an OLDER updater (v1.0.0): this one is kept, the release is installed" bash -c "test $RC = 0 && grep -q 'names updater v1.0.0, older than this one' $LOG && test \"\$(sha256sum $UPDATER | cut -d ' ' -f 1)\" = $OLD_UPD_SHA && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.1.0"
fresh base
OLD_UPD_SHA="$(sha $UPDATER)"; BEFORE="$(snapshot)"
sources insbad
upd run
expect_rc "an updater script that does not match the signed sha256: exit 1" 1
check "…refused; updater, node and everything else unchanged" bash -c "grep -q 'updater: sha256 .* does not match the signed manifest' $LOG"
check "…nothing changed" test "$(snapshot)" = "$BEFORE" -a "$(sha $UPDATER)" = "$OLD_UPD_SHA" -a "$(restarts)" = 0
sources insgarbage
upd run
expect_rc "a signed 'updater' that is not an install-validator.sh: exit 1" 1
check "…refused, updater unchanged" bash -c "grep -q 'is not a usable install-validator.sh' $LOG && test \"\$(sha256sum $UPDATER | cut -d ' ' -f 1)\" = $OLD_UPD_SHA"

section "what the timer runs"
fresh base; sources opt
EXEC="$(sed -n 's/^ExecStart=//p' /etc/systemd/system/rougechain-update.service)"
# shellcheck disable=SC2086
env -i PATH="$RUN_PATH" HOME=/root "${TEST_ENV[@]}" ROUGECHAIN_UPDATER_TEST_NOW="$T0" ROUGECHAIN_UPDATER_TEST_SLEEP_DIV=50 ROUGECHAIN_UPDATER_TEST_JITTER=0 $EXEC > "$LOG" 2>&1
RC=$?
expect_rc "the update unit's ExecStart, run as is: exit 0" 0
check "…installed the new release" test "$(installed)" = "9.1.0" -a "$(node_tag)" = "v2"
fresh base; sources opt
env -i PATH="$RUN_PATH" HOME=/root "$UPD" run > "$LOG" 2>&1
RC=$?
expect_rc "WITHOUT the test variables (as on a real node) nothing from this test server is installed: exit 1" 1
check "…a plain-HTTP release source is not even fetched outside test mode; nothing installed" bash -c "grep -q 'could not fetch http://' $LOG && ! grep -q 'TEST MODE' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 9.0.0 && test \"\$(grep -c '^restart' $CALLS)\" = 0"

ref_down
sysd stop rougechain-validator > /dev/null 2>&1 || true
# shellcheck disable=SC1091
printf '\n%s: %d passed, %d failed\n' "$(. /etc/os-release && echo "$ID $VERSION_ID")" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
