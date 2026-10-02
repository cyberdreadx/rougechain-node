#!/usr/bin/env bash
#
# RougeChain node / validator installer — signed releases.
#
#   curl -sSL https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/scripts/install-validator.sh | sudo bash
#
# What it does
#   1. Downloads the release manifest for the chosen network from every source (primary + mirror)
#      with its detached signatures, and verifies the Ed25519 signature with OpenSSL against the
#      release public key EMBEDDED in this script (never a downloaded key). The newest release
#      with a valid signature is used. Nothing is installed unless it verifies. When a `rougechain`
#      CLI with `release verify` is already installed, the ML-DSA-65 signature is verified too.
#   2. Downloads the node binary, the `rougechain` CLI and the genesis file named in that
#      signed manifest (primary URL, then mirrors) and checks size + sha256 against it.
#   3. Creates a dedicated system user, installs the binary, writes a hardened systemd unit
#      and starts the node. It generates the node identity (node-keys.json, mode 0600) only
#      if none exists; existing keys and chain data are never overwritten.
#   4. Sets up AUTO-UPDATE: a systemd timer that installs later signed releases by itself, checks
#      the node's health afterwards and rolls back if the check fails (AUTO_UPDATE=0 to opt out).
#   Re-running it upgrades in place (the previous binaries are kept as <file>.prev).
#
# Settings (environment variables; pass them after `sudo`, e.g. `| sudo NETWORK=testnet bash`)
#   NETWORK      mainnet (default) | testnet
#   NODE_NAME    name shown to the network            (default: <hostname>-node)
#   PUBLIC_URL   https URL peers can reach this node's API at (needed for a validator)
#   VALIDATOR    1 = run with --mine. Set it only AFTER this node's key is staked. (default: 0)
#   DATA_DIR     chain data + node-keys.json           (default: /var/lib/rougechain/<network>)
#   API_PORT     HTTP API port, bound to HOST          (default: 5100 mainnet, 5101 testnet)
#   P2P_PORT     gRPC port                             (default: 4100 mainnet, 4101 testnet)
#   HOST         bind address                          (default: 127.0.0.1)
#   PEERS        comma-separated peer API URLs         (default: the network's public node)
#   AUTO_UPDATE  1 = install signed releases automatically, 0 = never (sets MODE in
#                /etc/rougechain/<network>/update.conf). Not set: an existing update.conf is
#                kept; a new install gets MODE=auto.
#   NO_START     1 = install only; do not start or restart the service
#   ALLOW_DOWNGRADE  1 = allow installing a release older than the one already installed
#   REPLACE_LEGACY_UNIT  1 = replace a systemd unit that this installer did not write
#   RELEASE_BASE_URLS  space-separated bases serving manifest-<network>.json (+ .ed25519.sig,
#                      .mldsa65.sig); all are asked (default: api.rougechain.io + the GitHub mirror)
# Options
#   --dry-run    fetch + verify the release and print what would be done; change nothing
#   --help       show this text
#
# Auto-update (installed as /usr/local/bin/rougechain-update; this same script, run as
# `install-validator.sh updater …`)
#   rougechain-update status [--network N]   installed / latest release, last result, next check
#   rougechain-update check  [--network N]   look for a newer signed release; change nothing
#   rougechain-update run    [--network N] [--now] [--retry-failed]
#                                            what the timer runs: install a newer signed release
#   Settings: /etc/rougechain/<network>/update.conf (MODE=auto|notify|off, PIN_VERSION, …)
#
# Supported: Ubuntu 22.04 / 24.04 and Debian 12 on x86_64, with systemd.
# Docs: https://docs.rougechain.io/running-a-node/releases.html
#       https://docs.rougechain.io/running-a-node/auto-update.html
#
set -euo pipefail

INSTALLER_VERSION="2.1.0"

# Ed25519 release public key: the raw 32-byte key, base64. Every release manifest must carry a
# valid signature by this key. Written by scripts/release/embed-installer-key.mjs from
# releases/keys/release-ed25519.pub.pem. While it is the placeholder, the installer refuses to run.
RELEASE_ED25519_PUBKEY_B64="brz8q1pF/xZFyO94KLQvM52X5ufgx96laFEuJ9B7skg="
# ML-DSA-65 (FIPS 204) release public key: the raw 1952-byte key, lowercase hex — the content of
# releases/keys/release-mldsa65.pub, written by the same tool. Stock OpenSSL 3.0 cannot check
# ML-DSA, so this key is used with the installed `rougechain release verify` (CLI >= 1.2.0).
RELEASE_MLDSA65_PUBKEY_HEX="af91956eba7875bd7cf6a31e3cdd97ac0a633c83539bbd906157269caf08b15336c06ae2f5a7b066894e1026627f41cd5b3a396ab8a64a038c4d3b06d96a7fbfb014bc68cda61a027c6b498409bd833234b017fb84e020c61368cf5a96eaa247abab59f84fa0774c71706b6d75c91a94aa4aaa9760b520f9c5642cd08afa7e730ea8beb62bfd4bd190fa837c1c0aed7237bf1cb3a5b52a646e226af8908cc7a23de39efe9ba681a3953c44104f0b05fb83d952724799b8bf644ea42237a03cdb3b1e7655a0f1f9523ca0bd7ba5e2c22add76bf450b9a44897fafdc0d77af38aa2997204b2296b07ba67d1fc6c64fd0a96cb7cdf733f2fa8a528c59430c10d09204642fdf37dd87a2f753b209f595c22fad535745c6cd63cac2a9d4f444a2c29a8865e5fff8a18c26b55abe93c3534cc27ba2e972d8ea90e23615a441d0d33d834f92d38c95a8620e2ae190492150eeb5a5204c4099e44c89f614ed264a11e98ddf9bacbbd29bd5f38cbbd43b4ced8cad258a9eda0746767826a4cff4ad32558ce1f0de3bd6a6450dd41323fe6cba43dc4ad06e9f02db07bd34f5f355b75a42ae54737d11e004770089b5ce6aa8fc172c7eb13e4679ed5acb74e6c8f31b39fd00f3c316f2327124a51f41be8fcc51af3ef71475999c46709a141cca25e59ee60670573ad6d4b3886ea9971601538d615328e289962cfd3ef6594a9d6496bf3097bc1351ee29f3a42efb5a8e789e0ca56109146fa11d9614d855b5036adf134ece7c4daf751fcee2fb725cbbe39dc6efb24a930a7b33ff80887445015f4167486b38a2b1225d1e35756f045495508c4375d3370cc649e584113cde195a79c94452aa8615eab6033df43bfd17a5e074806855771ce303352d7552c1be5b4e60dfb8f549cf9e0e7819bc3427f3c978d2fd6cf7b07df3af687d8ea4318c552de7c7f0bcb6d7c30a1981f4a1490e440aba6ad74a64d2c8d125d8fa51be4cae863c48159c76061ab6d9f5b9aa70a681990d3229259ace57684c9a76a2cb65fbfec65d44e40ea9905addcc4e69c9de15f68d6aef3b290376bd78515d94d005323e61caa3dfccfb1940a7f98c90180a31bc64a2228991a784e130858ea4c6a8cbb2b50ce696ee92d6b8469174c479754f72d51971f33de1b5a9c7c4bcabb2870481d1398fbfe151ede14824308129253a58f5b3b396855e20451973bb15cea499a40d784629758cba85f0819dc6afaa586a91826bac7466c89261f746e65558ea65876b5bd5dd5ec02ef49d012628ddb10b6c23799b00abc9db23d7e8c07f54ff35533b556169ac767f141f468f675dcdbb15432d2f9cc1ce25cf17eec0bbfa54237f4726c952cb5cb5fb3811ecaecb6eafa6c60c57fae9bb1edd77382735be854b7c4261a92e55fefe197793ac12af8a8442b239b62bf90c40f5cb2b1f1bfa29f623faf10c7692a9ee01d268afe37671e07e01ece5d3618087a3428d1b9fc2d010bbdc9a450406823537f9d521c8d95e72e43169b4779e90d549245a77b25ceff3e20cab00a4490c55e6ddfbbbe08c443d01ffa1e927d4716152378497412c97d671e184e850a33b0bebe19e284c6edf2c85d56c9f8a08a9ded033c5e165b3bafb92207b1ff34d1127d8b1a3c0ec412ccbfb97c1cf2cb1b7e41a8220e30e4c85b06cc1b9a9f333f784f8193ed8bfd748bf6515f0fd9fc84111a5f98d2f680b8ad5215f809669ab9a376eb71be8b6f3a0a8bd0183c6cc4d8cd0a716fb19190489bf5bd93c296a26ae9960e5db0e69e2ccd6d38a26cd3b5d8e1f656f432ae9e5031574f37b79c4b4411173ab661b31340211a080b89185a55b41ad591b6d88a9773b7365e07e359ce4ffa463fa043e111f049c8af698c03e82025ec263d35f7e10cb58725ac1cfce4491dc0bcf2747ecb2b16d2c6fe0fe78cfdea2e3d9809270dad5f64ffeb6bef4aa39fa37037a240716fc53eecd8daece5a234fb74dd8cbe0b8ec1b875f9939d60f3cdb51db801b8e8e337c223122f89caf3461f942135ef36bb884d9b6a186e271d08cc1c0eec0aa48018d07d4d8e7fbbc0fb485303d5a79f90fcd786b538e1340e7a3793dcff03f6b1cd90fd41d1237a77314f41795b46b18463596509356d646c72a64e0d7baabee5a62f2a5af7d207f7d5ad3d9f7778b80f352823815cd183a875c5f29d6d3ce0819e4c97af1feb51c7941ce1906896da1e27e53941d18f9ce20aed3e2a20a73a78c2299917a098b5b14ec7735b7c75553591fb296cd419dc4120359fc1f925bc3639d3f750614a006df92815df92b26c09cf7b33cc061aacfd34a2121d67d4dd183029c079f15da8213ec873936692ac055ac58560f203dd838b5ed3d7db44ba3cb5f7226b8f07ea2ec12f790e0d5a4a3185cb288b4574707356c56b5edd23dafd14aa9e78f4d48e4dc4e453d17267d47529c9cc8986aad75ae68430269fe1ed2ae86999157ec738c94dfde9ab6a366bb081eb486aa450424422abd47ed63595edc4c1bac51d29958bbf2b385338666c0e0c10a1d4aba089a5ad83128050bef75343673158036bccb4182e50b09b028d1d05fbcaa7aed59cf9ec77457ac19b7146403b3dffc2dccdf9a5fff0295f19c19ae4ed760e7d5490094977605288d6086a713c91e059321ddb62a0720fec7cffaedbe2049497f46667aecd910b2a306026a29a25058ae18914d73e76b941f85631b6dbf00176fd4e2667ee65aa56e8218e7c62dfb4df488deb3317883642860fda017c1a7"
readonly RELEASE_KEY_PLACEHOLDER="PLACEHOLDER_RELEASE_KEY_NOT_PROVISIONED"

# The file this script was started from. Empty when it is piped into bash (`curl … | sudo bash`):
# then its own bytes are not available to it. Must be read here, outside any function.
SELF_PATH="${BASH_SOURCE[0]:-}"

readonly UNIT_MARKER="# Managed by RougeChain install-validator.sh"
readonly RUN_USER="rougechain"
readonly STATE_ROOT="/var/lib/rougechain"
readonly CONF_ROOT="/etc/rougechain"
readonly DEFAULT_BASE_URLS="https://api.rougechain.io/releases https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/releases"
readonly MAX_MANIFEST_BYTES=262144
readonly MLDSA65_SIG_BYTES=3309
readonly MLDSA65_PUB_HEX_CHARS=3904

# Auto-update: the installed copy of this script, its command, its state.
readonly LIB_DIR="/usr/local/lib/rougechain"
readonly UPDATER_PATH="$LIB_DIR/install-validator.sh"
readonly UPDATER_CMD="/usr/local/bin/rougechain-update"
readonly UPDATER_STATE_ROOT="/var/lib/rougechain-updater"
readonly UPDATER_MARKER="# Managed by RougeChain install-validator.sh (auto-update)"
# Activations a release manifest lists that GET /api/stats does not report in `upgrade_schedule`
# (so the health check cannot compare them). Everything else in the manifest must match.
readonly UNREPORTED_ACTIVATIONS="canonical_ledger_fork"
# Exit codes of `rougechain-update run`.
readonly EXIT_ROLLED_BACK=3      # the update failed its checks and the previous release was restored
readonly EXIT_ROLLBACK_FAILED=4  # …and the node did not come back afterwards: needs the operator

ACTION="install"     # install | run | check | status
DRY_RUN=0
TEST_MODE=0
FORCE_NOW=0
RETRY_FAILED=0
WORK=""
LOG_PREFIX=""
LAST_ERROR=""
STATE_READY=0
FAKE_NOW=""
PQ_KEY_FILE=""
PQ_CLI=""

if [ -t 1 ]; then
  C_HEAD=$'\033[1;35m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_HEAD=""; C_WARN=""; C_ERR=""; C_OFF=""
fi
# In updater mode every line carries LOG_PREFIX ("rougechain-update[<network>]: ") so it can be
# found in the journal: journalctl -t rougechain-update
log()  { printf '%s%s==>%s %s\n' "$LOG_PREFIX" "$C_HEAD" "$C_OFF" "$*"; }
note() { printf '%s    %s\n' "$LOG_PREFIX" "$*"; }
warn() { printf '%s%s[!]%s %s\n' "$LOG_PREFIX" "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { LAST_ERROR="$*"; printf '%s%s[x]%s %s\n' "$LOG_PREFIX" "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

cleanup() { if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf -- "$WORK"; fi; }

# On the way out of an updater run that failed: leave the reason where `status` shows it.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$ACTION" = "run" ] && [ "$STATE_READY" = 1 ] && [ -n "$LAST_ERROR" ]; then
    state_set LAST_RESULT "error: $LAST_ERROR" || true
  fi
  cleanup
  exit "$rc"
}

usage() {
  if [ -n "$SELF_PATH" ] && [ -f "$SELF_PATH" ] && [ -r "$SELF_PATH" ]; then
    sed -n '/^# RougeChain node/,/^#       https:..docs.rougechain.io.running-a-node.auto-update/p' "$SELF_PATH" | sed 's/^# \{0,1\}//'
  else
    echo "RougeChain installer v$INSTALLER_VERSION. Options: --dry-run, --help."
    echo "Settings and documentation: https://docs.rougechain.io/running-a-node/releases.html"
  fi
}

# ── helpers ──────────────────────────────────────────────────────────────────

# ver_lt A B — true when semver A is strictly lower than B.
ver_lt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

# fetch URL DEST MAX_BYTES — download over HTTPS only (HTTP is allowed in test mode only).
fetch() {
  local url="$1" dest="$2" max="$3" proto="=https"
  if [ "$TEST_MODE" = 1 ]; then proto="=http,https"; fi
  curl --fail --silent --show-error --location \
    --proto "$proto" --proto-redir "$proto" --tlsv1.2 \
    --connect-timeout 15 --max-time 900 --retry 2 --retry-delay 2 \
    --max-filesize "$max" --output "$dest" "$url"
}

file_size() { stat -c '%s' "$1"; }
file_sha256() { sha256sum "$1" | cut -d ' ' -f 1; }

# systemctl, without the lock file descriptor (anything it starts must not inherit the lock).
sysctl() { systemctl "$@" 9>&-; }

# Run a program as the unprivileged service user when we are root and that user exists
# (signature checks and version probes parse untrusted input: not as root).
run_as_service_user() {
  if [ "$(id -u)" -eq 0 ] && getent passwd "$RUN_USER" > /dev/null 2>&1; then
    runuser -u "$RUN_USER" -- "$@" 9>&-
  else
    "$@" 9>&-
  fi
}

# Clock and sleep. The updater's test suite (TEST MODE only) can start the clock at a chosen
# time and shorten the waits; a sleep then advances that clock by its full length.
now() { if [ -n "$FAKE_NOW" ]; then printf '%s' "$FAKE_NOW"; else date +%s; fi; }
do_sleep() {
  local secs="$1" div ms
  if [ -n "$FAKE_NOW" ]; then
    FAKE_NOW=$((FAKE_NOW + secs))
    div="${ROUGECHAIN_UPDATER_TEST_SLEEP_DIV:-0}"
    if [[ "$div" =~ ^[1-9][0-9]*$ ]]; then
      ms=$((secs * 1000 / div))
      sleep "$((ms / 1000)).$(printf '%03d' $((ms % 1000)))"
    fi
  else
    sleep "$secs"
  fi
}
fmt_time() { if [[ "${1:-}" =~ ^[0-9]+$ ]]; then date -u -d "@$1" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || printf '%s' "$1"; else printf 'never'; fi; }

# Updater state: KEY=VALUE lines in a root-owned file (never sourced).
state_get() { # state_get KEY [DEFAULT]
  local v=""
  if [ -r "$UPD_STATE_DIR/state" ]; then
    v="$(grep -m 1 "^$1=" "$UPD_STATE_DIR/state" 2>/dev/null | cut -d '=' -f 2- || true)"
  fi
  printf '%s' "${v:-${2:-}}"
}
state_set() { # state_set KEY VALUE
  local f="$UPD_STATE_DIR/state" value
  value="$(printf '%s' "$2" | tr '\n\r' '  ' | cut -c 1-400)"
  { if [ -f "$f" ]; then grep -v "^$1=" "$f" || true; fi; printf '%s=%s\n' "$1" "$value"; } > "$f.tmp"
  mv -f -- "$f.tmp" "$f"
}

# One install or update at a time per network.
acquire_lock() { # acquire_lock — returns 1 when another run holds the lock
  exec 9> "$LOCK_FILE" || die "cannot open the lock file $LOCK_FILE"
  flock -n 9
}

# api_get URL DEST [MAX_SECONDS] — a small JSON GET from this node's API or from a reference node.
# Plain HTTP is allowed (the local API, private peers): the answer is only compared, never
# executed, and every value taken from it is validated by jval.
api_get() {
  curl --fail --silent --location --proto '=http,https' --proto-redir '=http,https' \
    --connect-timeout 5 --max-time "${3:-10}" --max-filesize 16777216 --output "$2" "$1" 2> /dev/null 9>&-
}
# jval FILE JQ_FILTER REGEX — print the value if it exists and matches REGEX, else return 1.
jval() {
  local v
  v="$(jq -r "($2) | if . == null then empty else tostring end" "$1" 2> /dev/null)" || return 1
  [[ "$v" =~ $3 ]] || return 1
  printf '%s' "$v"
}
readonly RE_UINT='^(0|[1-9][0-9]*)$'
readonly RE_HEX='^[0-9a-fA-F]{8,8192}$'

# verify_ed25519 MANIFEST SIG_B64_FILE — true only if the signature verifies against the release key.
verify_ed25519() {
  local manifest="$1" sig_b64="$2" sig_bin="$WORK/sig.bin"
  if ! tr -d ' \n\r' < "$sig_b64" | base64 -d > "$sig_bin" 2>/dev/null; then return 1; fi
  if [ "$(file_size "$sig_bin")" != 64 ]; then return 1; fi
  openssl pkeyutl -verify -pubin -inkey "$WORK/release-key.pem" -rawin \
    -in "$manifest" -sigfile "$sig_bin" > /dev/null 2>&1
}

# mf FILTER — read a value from the VERIFIED manifest.
mf() { jq -er "$1" "$WORK/manifest.json" 2>/dev/null || die "the signed manifest has no valid value for: $1"; }

# download_verified LABEL DEST SHA256 SIZE URL... — first URL that yields the exact file wins.
download_verified() {
  local label="$1" dest="$2" sha="$3" size="$4" url got
  shift 4
  for url in "$@"; do
    note "downloading $label: $url"
    rm -f -- "$dest"
    if ! fetch "$url" "$dest" "$size"; then
      warn "$label: download failed from $url"
      continue
    fi
    got="$(file_size "$dest")"
    if [ "$got" != "$size" ]; then
      warn "$label: size $got from $url does not match the signed manifest ($size) — rejected"
      continue
    fi
    got="$(file_sha256 "$dest")"
    if [ "$got" != "$sha" ]; then
      warn "$label: sha256 $got from $url does not match the signed manifest ($sha) — rejected"
      continue
    fi
    note "$label verified: sha256 $sha ($size bytes)"
    return 0
  done
  rm -f -- "$dest"
  return 1
}

# ── steps ────────────────────────────────────────────────────────────────────

parse_args() {
  if [ "${1:-}" = "updater" ]; then
    # `install-validator.sh updater …` is what /usr/local/bin/rougechain-update runs.
    shift
    ACTION="run"
    NETWORK="mainnet"      # the updater takes its network from --network only, never the environment
    while [ $# -gt 0 ]; do
      case "$1" in
        run|check|status) ACTION="$1" ;;
        --network) [ $# -ge 2 ] || die "--network needs a value"; NETWORK="$2"; shift ;;
        --network=*) NETWORK="${1#--network=}" ;;
        --now) FORCE_NOW=1 ;;
        --retry-failed) RETRY_FAILED=1 ;;
        --help|-h) updater_usage; exit 0 ;;
        --version) echo "$INSTALLER_VERSION"; exit 0 ;;
        *) die "unknown updater option: $1 (see rougechain-update --help)" ;;
      esac
      shift
    done
    return 0
  fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --help|-h) usage; exit 0 ;;
      --version) echo "$INSTALLER_VERSION"; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
}

updater_usage() {
  cat <<USAGE
rougechain-update (installer v$INSTALLER_VERSION) — signed auto-update for a RougeChain node

  rougechain-update status [--network mainnet|testnet]
      installed release, newest release seen, last result, next scheduled check
  rougechain-update check [--network N]
      look for a newer signed release and report it; changes nothing
  rougechain-update run [--network N] [--now] [--retry-failed]
      what the timer runs: install a newer signed release, check the node's health, roll back
      if the check fails.  --now skips the randomised delay and the proposer deferral;
      --retry-failed tries a release again that failed its health check on this node.

Settings: /etc/rougechain/<network>/update.conf  (MODE=auto|notify|off, PIN_VERSION, …)
Exit codes of run: 0 nothing to do / installed / deferred, 1 could not check or refused,
  $EXIT_ROLLED_BACK update failed and was rolled back, $EXIT_ROLLBACK_FAILED rolled back but the node did not come back.
Docs: https://docs.rougechain.io/running-a-node/auto-update.html
USAGE
}

# Names and paths that depend only on the network.
network_defaults() {
  NETWORK="${NETWORK:-mainnet}"
  case "$NETWORK" in
    mainnet)
      CHAIN_ID="rougechain-mainnet-1"
      DEF_PEERS="https://api.rougechain.io/api"; DEF_API_PORT=5100; DEF_P2P_PORT=4100
      SERVICE="rougechain-validator"; BIN_PATH="/usr/local/bin/quantum-vault-daemon"
      CLI_PATH="/usr/local/bin/rougechain"; CLI_NET_ARG=""
      UPD_SERVICE="rougechain-update" ;;
    testnet)
      CHAIN_ID="rougechain-devnet-1"
      DEF_PEERS="https://testnet.rougechain.io/api"; DEF_API_PORT=5101; DEF_P2P_PORT=4101
      SERVICE="rougechain-validator-testnet"; BIN_PATH="/usr/local/bin/quantum-vault-daemon-testnet"
      CLI_PATH="/usr/local/bin/rougechain-testnet"; CLI_NET_ARG=" --network testnet"
      UPD_SERVICE="rougechain-update-testnet" ;;
    *) die "NETWORK must be 'mainnet' or 'testnet' (got '$NETWORK')" ;;
  esac
  CONF_DIR="$CONF_ROOT/$NETWORK"
  UNIT_FILE="/etc/systemd/system/$SERVICE.service"
  UPD_UNIT_FILE="/etc/systemd/system/$UPD_SERVICE.service"
  UPD_TIMER_FILE="/etc/systemd/system/$UPD_SERVICE.timer"
  UPD_CONF="$CONF_DIR/update.conf"
  UPD_STATE_DIR="$UPDATER_STATE_ROOT/$NETWORK"
  LOCK_FILE="/run/rougechain-update-$NETWORK.lock"
}

load_config() {
  network_defaults
  PEERS="${PEERS:-$DEF_PEERS}"
  API_PORT="${API_PORT:-$DEF_API_PORT}"
  P2P_PORT="${P2P_PORT:-$DEF_P2P_PORT}"
  HOST="${HOST:-127.0.0.1}"
  DATA_DIR="${DATA_DIR:-$STATE_ROOT/$NETWORK}"
  PUBLIC_URL="${PUBLIC_URL:-}"
  VALIDATOR="${VALIDATOR:-0}"
  NO_START="${NO_START:-0}"
  ALLOW_DOWNGRADE="${ALLOW_DOWNGRADE:-0}"
  REPLACE_LEGACY_UNIT="${REPLACE_LEGACY_UNIT:-0}"
  RELEASE_BASE_URLS="${RELEASE_BASE_URLS:-$DEFAULT_BASE_URLS}"
  AUTO_UPDATE="${AUTO_UPDATE:-}"
  KEYS_FILE="$DATA_DIR/node-keys.json"
  if [ -z "${NODE_NAME:-}" ]; then
    NODE_NAME="$(hostname 2>/dev/null | tr -c 'A-Za-z0-9._\n-' '-' | cut -c 1-48 || true)"
    NODE_NAME="${NODE_NAME:-rougechain}-node"
  fi

  # These values are written into a systemd unit: accept only plain, unambiguous characters.
  local re_name='^[A-Za-z0-9._-]{1,64}$' re_url='^https?://[A-Za-z0-9._:/-]+$' re_port='^[0-9]{1,5}$'
  local re_path='^/[A-Za-z0-9._/-]+$' re_host='^[A-Za-z0-9.:-]{1,64}$' re_peers='^https?://[A-Za-z0-9._:/,-]+$'
  local re_bool='^[01]$' v
  [[ "$NODE_NAME" =~ $re_name ]] || die "NODE_NAME may only contain letters, digits, '.', '_' and '-' (max 64)"
  [[ -z "$PUBLIC_URL" || "$PUBLIC_URL" =~ $re_url ]] || die "PUBLIC_URL must look like https://node.example.com"
  [[ "$PEERS" =~ $re_peers ]] || die "PEERS must be a comma-separated list of http(s) URLs"
  [[ "$HOST" =~ $re_host ]] || die "HOST must be an IP address or host name"
  [[ "$DATA_DIR" =~ $re_path && "$DATA_DIR" != *..* && "$DATA_DIR" != */ ]] || die "DATA_DIR must be an absolute path without spaces, '..' or a trailing '/'"
  for v in "$API_PORT" "$P2P_PORT"; do
    if ! [[ "$v" =~ $re_port ]] || [ "$v" -lt 1 ] || [ "$v" -gt 65535 ]; then
      die "API_PORT / P2P_PORT must be a port number (1-65535)"
    fi
  done
  [ "$API_PORT" != "$P2P_PORT" ] || die "API_PORT and P2P_PORT must differ"
  for v in "$VALIDATOR" "$NO_START" "$ALLOW_DOWNGRADE" "$REPLACE_LEGACY_UNIT"; do
    [[ "$v" =~ $re_bool ]] || die "VALIDATOR, NO_START, ALLOW_DOWNGRADE and REPLACE_LEGACY_UNIT must be 0 or 1"
  done
  [[ -z "$AUTO_UPDATE" || "$AUTO_UPDATE" =~ $re_bool ]] || die "AUTO_UPDATE must be 0 or 1"
}

check_platform() {
  [ "$(uname -s)" = "Linux" ] || die "unsupported system: $(uname -s). This installer supports Ubuntu 22.04/24.04 and Debian 12 on x86_64."
  [ "$(uname -m)" = "x86_64" ] || die "unsupported CPU architecture: $(uname -m). Release binaries are built for x86_64 only — build from source instead (docs: running-a-node/installation)."
  [ -r /etc/os-release ] || die "cannot identify the operating system (/etc/os-release is missing). Supported: Ubuntu 22.04/24.04, Debian 12."
  local id ver
  # shellcheck disable=SC1091
  id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  # shellcheck disable=SC1091
  ver="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  case "$id:$ver" in
    ubuntu:22.04|ubuntu:24.04|debian:12) OS_LABEL="$id $ver" ;;
    *) die "unsupported operating system: ${id:-unknown} ${ver:-unknown}. Supported: Ubuntu 22.04, Ubuntu 24.04, Debian 12 (x86_64). On anything else, build from source (docs: running-a-node/installation)." ;;
  esac
}

# The release key must be a real key. A TEST key can be substituted only by setting BOTH
# ROUGECHAIN_INSTALLER_TEST=1 and ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=<pem>; that is for the
# installer's own test suite and disables release authenticity.
# In TEST MODE only, ROUGECHAIN_INSTALLER_TEST_MLDSA_PUBKEY_FILE=<release-mldsa65.pub> supplies the
# matching ML-DSA-65 test key (without it the ML-DSA check is skipped), and the updater's clock
# can be set: ROUGECHAIN_UPDATER_TEST_NOW=<epoch>, ROUGECHAIN_UPDATER_TEST_SLEEP_DIV=<n> (sleeps
# are n times shorter), ROUGECHAIN_UPDATER_TEST_JITTER=<0-9999> (the per-host delay fraction).
select_release_key() {
  local test_flag="${ROUGECHAIN_INSTALLER_TEST:-}" test_key="${ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE:-}"
  local test_pq="${ROUGECHAIN_INSTALLER_TEST_MLDSA_PUBKEY_FILE:-}"
  if [ -n "$test_flag" ] || [ -n "$test_key" ] || [ -n "$test_pq" ]; then
    if [ "$test_flag" != "1" ] || [ -z "$test_key" ]; then
      die "test override needs BOTH ROUGECHAIN_INSTALLER_TEST=1 and ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=<pem file>. Unset both for a real install."
    fi
    [ -r "$test_key" ] || die "ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE: cannot read $test_key"
    [ -z "$test_pq" ] || [ -r "$test_pq" ] || die "ROUGECHAIN_INSTALLER_TEST_MLDSA_PUBKEY_FILE: cannot read $test_pq"
    TEST_MODE=1
    if [[ "${ROUGECHAIN_UPDATER_TEST_NOW:-}" =~ ^[1-9][0-9]*$ ]]; then FAKE_NOW="$ROUGECHAIN_UPDATER_TEST_NOW"; fi
    warn "################################################################################"
    warn "#  TEST MODE: release signatures are checked against a TEST key from            #"
    warn "#  $test_key"
    warn "#  NOT against the RougeChain release key. Plain HTTP downloads are allowed.    #"
    warn "#  NEVER use this on a real node: anything signed by that key will be installed. #"
    warn "################################################################################"
    return 0
  fi
  if [ "$RELEASE_ED25519_PUBKEY_B64" = "$RELEASE_KEY_PLACEHOLDER" ]; then
    die "this installer has no release signing key yet (placeholder key), so it cannot verify any release and refuses to install. Signed releases are being provisioned — until then follow the manual steps: https://docs.rougechain.io/staking/becoming-validator.html"
  fi
  if [ "$RELEASE_MLDSA65_PUBKEY_HEX" = "$RELEASE_KEY_PLACEHOLDER" ]; then
    die "this installer carries the Ed25519 release key but only a placeholder key for ML-DSA-65 — it was not provisioned correctly and refuses to run. Download the current installer."
  fi
}

write_release_key() {
  local pem="$WORK/release-key.pem" raw="$WORK/release-key.raw"
  if [ "$TEST_MODE" = 1 ]; then
    cp -- "$ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE" "$pem"
  else
    printf '%s' "$RELEASE_ED25519_PUBKEY_B64" | base64 -d > "$raw" 2>/dev/null || die "embedded release key is not valid base64"
    [ "$(file_size "$raw")" = 32 ] || die "embedded release key is not a 32-byte Ed25519 key"
    {
      printf '%s\n' "-----BEGIN PUBLIC KEY-----"
      # SubjectPublicKeyInfo header for Ed25519 (RFC 8410) + the raw key
      { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; cat "$raw"; } | base64 -w 0
      printf '\n%s\n' "-----END PUBLIC KEY-----"
    } > "$pem"
  fi
  openssl pkey -pubin -in "$pem" -noout 2>/dev/null || die "release public key is not a valid public key"
  RELEASE_KEY_FPR="$(openssl pkey -pubin -in "$pem" -outform DER 2>/dev/null | tail -c 32 | sha256sum | cut -d ' ' -f 1)"

  # The ML-DSA-65 key, as a file in the releases/keys/release-mldsa65.pub format, readable by the
  # unprivileged user the verifier runs as.
  local pq_dir="$WORK/pq" hex=""
  mkdir -p "$pq_dir"
  chmod 0711 "$WORK"; chmod 0755 "$pq_dir"
  PQ_KEY_FILE=""
  if [ "$TEST_MODE" = 1 ]; then
    if [ -n "${ROUGECHAIN_INSTALLER_TEST_MLDSA_PUBKEY_FILE:-}" ]; then
      hex="$(grep -v '^#' "$ROUGECHAIN_INSTALLER_TEST_MLDSA_PUBKEY_FILE" | tr -d ' \n\r')"
    fi
  else
    hex="$RELEASE_MLDSA65_PUBKEY_HEX"
  fi
  if [ -n "$hex" ]; then
    if ! [[ "$hex" =~ ^[0-9a-f]+$ ]] || [ "${#hex}" != "$MLDSA65_PUB_HEX_CHARS" ]; then
      die "the ML-DSA-65 release key is not a 1952-byte key in lowercase hex"
    fi
    printf '%s\n' "$hex" > "$pq_dir/release-mldsa65.pub"
    chmod 0644 "$pq_dir/release-mldsa65.pub"
    PQ_KEY_FILE="$pq_dir/release-mldsa65.pub"
    RELEASE_PQ_KEY_FPR="$(printf '%b' "$(printf '%s' "$hex" | sed 's/../\\x&/g')" | sha256sum | cut -d ' ' -f 1)"
  fi
}

# Is there an ML-DSA-65 verifier? That is an installed `rougechain` CLI (from an earlier verified
# release) that has `release verify`. Sets PQ_CLI ("" when there is none).
find_pq_verifier() {
  PQ_CLI=""
  [ -n "$PQ_KEY_FILE" ] || return 0
  if [ -x "$CLI_PATH" ] && run_as_service_user "$CLI_PATH" release verify --help > /dev/null 2>&1; then
    PQ_CLI="$CLI_PATH"
  fi
}

# verify_mldsa MANIFEST SIG_FILE [CLI] — true only if the ML-DSA-65 signature verifies.
verify_mldsa() {
  run_as_service_user "${3:-$PQ_CLI}" release verify --manifest "$1" --sig "$2" --pubkey "$PQ_KEY_FILE" > /dev/null 2>&1
}

# mldsa_sig_wellformed SIG_FILE — base64 of exactly 3309 bytes (checked even without a verifier).
mldsa_sig_wellformed() {
  local n
  n="$(tr -d ' \n\r' < "$1" | base64 -d 2> /dev/null | wc -c)" || return 1
  [ "$n" = "$MLDSA65_SIG_BYTES" ]
}

ensure_deps() {
  local missing=() c
  for c in curl openssl jq sha256sum base64 stat install runuser useradd flock; do
    command -v "$c" > /dev/null 2>&1 || missing+=("$c")
  done
  [ -e /etc/ssl/certs/ca-certificates.crt ] || missing+=("ca-certificates")
  [ ${#missing[@]} -eq 0 ] && return 0
  if [ "$ACTION" != "install" ]; then
    die "missing tools: ${missing[*]} — the updater installs no packages. Install them (apt-get install curl ca-certificates openssl jq util-linux)."
  fi
  if [ "$DRY_RUN" = 1 ]; then
    die "missing tools: ${missing[*]} — a dry run installs nothing. Install them (apt-get install curl ca-certificates openssl jq) or run without --dry-run."
  fi
  log "installing required packages (missing: ${missing[*]})"
  export DEBIAN_FRONTEND=noninteractive
  if ! apt-get update -qq; then
    warn "apt-get update reported errors (a package mirror may be mid-sync) — retrying once"
    sleep 10
    apt-get update -qq || warn "apt-get update still reports errors — trying with the package lists that are available"
  fi
  apt-get install -y -qq --no-install-recommends curl ca-certificates openssl jq coreutils util-linux passwd > /dev/null \
    || die "could not install the required packages (curl ca-certificates openssl jq). Install them with apt-get and re-run."
  for c in curl openssl jq sha256sum base64 stat install runuser useradd flock; do
    command -v "$c" > /dev/null 2>&1 || die "'$c' is still missing after installing packages"
  done
}

# Ask EVERY source for the manifest and keep each copy that is authentic: valid Ed25519
# signature by the embedded release key, right network and chain, a well-formed ML-DSA-65
# signature next to it — and, when a verifier is installed, a valid ML-DSA-65 signature.
# Asking all sources (not stopping at the first) is what defeats a stale or frozen mirror:
# the caller picks the NEWEST authentic release.
# Sets CAND_DIRS / CAND_VERSIONS / CAND_SOURCES and the counters N_SIG_FAIL, N_FETCH_FAIL.
collect_candidates() {
  local base name="manifest-$NETWORK.json" re_base='^https?://[^[:space:]]+$' n=0 dir m v
  local re_ver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  CAND_DIRS=(); CAND_VERSIONS=(); CAND_SOURCES=(); N_SIG_FAIL=0; N_FETCH_FAIL=0
  log "fetching the signed release manifest ($NETWORK)"
  find_pq_verifier
  for base in $RELEASE_BASE_URLS; do
    [[ "$base" =~ $re_base ]] || die "RELEASE_BASE_URLS: '$base' is not a URL"
    base="${base%/}"
    n=$((n + 1)); dir="$WORK/cand/$n"; m="$dir/manifest.json"
    mkdir -p "$dir"; chmod 0755 "$WORK/cand" "$dir"
    if ! fetch "$base/$name" "$m" "$MAX_MANIFEST_BYTES"; then
      warn "could not fetch $base/$name — trying the next source"
      N_FETCH_FAIL=$((N_FETCH_FAIL + 1)); continue
    fi
    if ! fetch "$base/$name.ed25519.sig" "$m.ed25519.sig" 4096; then
      warn "could not fetch the signature $base/$name.ed25519.sig — trying the next source"
      N_FETCH_FAIL=$((N_FETCH_FAIL + 1)); continue
    fi
    if ! verify_ed25519 "$m" "$m.ed25519.sig"; then
      warn "SIGNATURE CHECK FAILED for $base/$name — this manifest was NOT signed by the release key and is ignored"
      N_SIG_FAIL=$((N_SIG_FAIL + 1)); continue
    fi
    # Authentic. Is it a manifest for this network at all? (A signed testnet manifest served
    # under the mainnet name must not be used — and must not hide a good source either.)
    if ! jq -e 'type == "object"' "$m" > /dev/null 2>&1; then
      warn "$base/$name: the signed manifest is not a JSON object — ignored"; continue
    fi
    if [ "$(jq -r '.network // ""' "$m")" != "$NETWORK" ]; then
      warn "$base/$name: the manifest is for network '$(jq -r '.network // ""' "$m")', not '$NETWORK' — ignored"; continue
    fi
    if [ "$(jq -r '.chain_id // ""' "$m")" != "$CHAIN_ID" ]; then
      warn "$base/$name: the manifest chain id '$(jq -r '.chain_id // ""' "$m")' is not $CHAIN_ID — ignored"; continue
    fi
    v="$(jq -r '.version // ""' "$m")"
    if ! [[ "$v" =~ $re_ver ]]; then warn "$base/$name: bad version in the signed manifest — ignored"; continue; fi
    if ! fetch "$base/$name.mldsa65.sig" "$m.mldsa65.sig" 8192; then
      warn "could not fetch the signature $base/$name.mldsa65.sig (a release carries BOTH signatures) — trying the next source"
      N_FETCH_FAIL=$((N_FETCH_FAIL + 1)); continue
    fi
    if ! mldsa_sig_wellformed "$m.mldsa65.sig"; then
      warn "SIGNATURE CHECK FAILED for $base/$name — its ML-DSA-65 signature file is not a $MLDSA65_SIG_BYTES-byte signature; ignored"
      N_SIG_FAIL=$((N_SIG_FAIL + 1)); continue
    fi
    chmod 0644 "$m" "$m.ed25519.sig" "$m.mldsa65.sig"
    if [ -n "$PQ_CLI" ]; then
      if ! verify_mldsa "$m" "$m.mldsa65.sig"; then
        warn "ML-DSA-65 SIGNATURE CHECK FAILED for $base/$name — the Ed25519 signature is valid but the post-quantum signature is NOT. This manifest is refused."
        N_SIG_FAIL=$((N_SIG_FAIL + 1)); continue
      fi
    fi
    CAND_DIRS+=("$dir"); CAND_VERSIONS+=("$v"); CAND_SOURCES+=("$base/$name")
  done
}

# use_candidate INDEX — make that verified manifest the one everything else reads.
use_candidate() {
  local dir="${CAND_DIRS[$1]}"
  cp -f -- "$dir/manifest.json" "$WORK/manifest.json"
  cp -f -- "$dir/manifest.json.ed25519.sig" "$WORK/manifest.json.ed25519.sig"
  cp -f -- "$dir/manifest.json.mldsa65.sig" "$WORK/manifest.json.mldsa65.sig"
  MANIFEST_SOURCE="${CAND_SOURCES[$1]}"
  note "signature OK (Ed25519 release key $RELEASE_KEY_FPR)"
  if [ -n "$PQ_CLI" ]; then
    PQ_STATUS="verified"
    note "signature OK (ML-DSA-65 release key ${RELEASE_PQ_KEY_FPR:-?}, checked with $PQ_CLI)"
  else
    PQ_STATUS="unchecked"
    note "ML-DSA-65 signature present; not verified yet (no installed rougechain CLI with 'release verify')"
  fi
  note "source: $MANIFEST_SOURCE"
}

# newest_candidate — index of the candidate with the highest version (the first one on a tie).
newest_candidate() {
  local i best=-1
  for i in "${!CAND_VERSIONS[@]}"; do
    if [ "$best" = -1 ] || ver_lt "${CAND_VERSIONS[$best]}" "${CAND_VERSIONS[$i]}"; then best="$i"; fi
  done
  printf '%s' "$best"
}

fetch_manifest() {
  collect_candidates
  if [ ${#CAND_DIRS[@]} -eq 0 ]; then
    die "no release manifest with a valid signature could be obtained — nothing was installed. If a source reported a failed signature check, do not retry blindly: report it (https://github.com/cyberdreadx/rougechain-node/security)."
  fi
  use_candidate "$(newest_candidate)"
}

validate_manifest() {
  local re_ver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' re_sha='^[0-9a-f]{64}$' re_file='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  local re_int='^[1-9][0-9]*$' re_url='^https://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$' url
  if [ "$TEST_MODE" = 1 ]; then re_url='^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$'; fi
  jq -e 'type == "object"' "$WORK/manifest.json" > /dev/null 2>&1 || die "the signed manifest is not a JSON object"
  [ "$(mf '.schema')" = "1" ] || die "unsupported manifest schema $(mf '.schema | tostring') — download the latest installer"
  [ "$(mf '.network')" = "$NETWORK" ] || die "the manifest is for network '$(mf '.network')', not '$NETWORK'"
  [ "$(mf '.chain_id')" = "$CHAIN_ID" ] || die "the manifest chain id '$(mf '.chain_id')' is not $CHAIN_ID"
  REL_VERSION="$(mf '.version')"
  [[ "$REL_VERSION" =~ $re_ver ]] || die "manifest: bad version"
  MIN_INSTALLER="$(mf '.min_installer_version')"
  [[ "$MIN_INSTALLER" =~ $re_ver ]] || die "manifest: bad min_installer_version"
  if [ "$ACTION" = "install" ] && ver_lt "$INSTALLER_VERSION" "$MIN_INSTALLER"; then
    die "this installer (v$INSTALLER_VERSION) is too old for release $REL_VERSION (needs v$MIN_INSTALLER or newer) — download the current installer"
  fi
  BIN_NAME="$(mf '.binary.name')"; BIN_SHA="$(mf '.binary.sha256')"; BIN_SIZE="$(mf '.binary.size | tostring')"
  [[ "$BIN_NAME" =~ $re_file && "$BIN_SHA" =~ $re_sha && "$BIN_SIZE" =~ $re_int ]] || die "manifest: bad binary entry"
  mapfile -t BIN_URLS < <(mf '.binary | [.url] + .mirrors | .[]')
  [ ${#BIN_URLS[@]} -ge 1 ] || die "manifest: no binary URL"
  for url in "${BIN_URLS[@]}"; do [[ "$url" =~ $re_url ]] || die "manifest: binary URL is not an https URL: $url"; done
  HAS_CLI=0; CLI_URLS=()
  if [ "$(jq -r '.cli | type' "$WORK/manifest.json")" = "object" ]; then
    HAS_CLI=1
    CLI_NAME="$(mf '.cli.name')"; CLI_SHA="$(mf '.cli.sha256')"; CLI_SIZE="$(mf '.cli.size | tostring')"
    [[ "$CLI_NAME" =~ $re_file && "$CLI_SHA" =~ $re_sha && "$CLI_SIZE" =~ $re_int ]] || die "manifest: bad cli entry"
    [ "$CLI_NAME" != "$BIN_NAME" ] || die "manifest: cli and binary have the same name"
    mapfile -t CLI_URLS < <(mf '.cli | [.url] + .mirrors | .[]')
    [ ${#CLI_URLS[@]} -ge 1 ] || die "manifest: no cli URL"
    for url in "${CLI_URLS[@]}"; do [[ "$url" =~ $re_url ]] || die "manifest: cli URL is not an https URL: $url"; done
  fi
  HAS_GENESIS=0; GEN_URLS=()
  if [ "$(jq -r '.genesis | type' "$WORK/manifest.json")" = "object" ]; then
    HAS_GENESIS=1
    GEN_SHA="$(mf '.genesis.sha256')"; GEN_SIZE="$(mf '.genesis.size | tostring')"
    [[ "$GEN_SHA" =~ $re_sha && "$GEN_SIZE" =~ $re_int ]] || die "manifest: bad genesis entry"
    mapfile -t GEN_URLS < <(mf '.genesis | [.url] + .mirrors | .[]')
    for url in "${GEN_URLS[@]}"; do [[ "$url" =~ $re_url ]] || die "manifest: genesis URL is not an https URL: $url"; done
  fi
  # Optional (releases from 1.6.1 on): the installer/updater script of this release. It is the
  # only source the installed updater is ever replaced from.
  HAS_INSTALLER=0; INS_URLS=()
  if [ "$(jq -r '.installer | type' "$WORK/manifest.json")" = "object" ]; then
    HAS_INSTALLER=1
    INS_NAME="$(mf '.installer.name')"; INS_SHA="$(mf '.installer.sha256')"; INS_SIZE="$(mf '.installer.size | tostring')"
    [[ "$INS_NAME" =~ $re_file && "$INS_SHA" =~ $re_sha && "$INS_SIZE" =~ $re_int ]] || die "manifest: bad installer entry"
    [ "$INS_SIZE" -le 4194304 ] || die "manifest: the installer entry is implausibly large"
    mapfile -t INS_URLS < <(mf '.installer | [.url] + .mirrors | .[]')
    [ ${#INS_URLS[@]} -ge 1 ] || die "manifest: no installer URL"
    for url in "${INS_URLS[@]}"; do [[ "$url" =~ $re_url ]] || die "manifest: installer URL is not an https URL: $url"; done
  fi
  local re_act='^[a-z0-9][a-z0-9_]{0,63} (0|[1-9][0-9]*)$' act
  while IFS= read -r act; do
    [[ "$act" =~ $re_act ]] || die "manifest: bad activation entry"
  done < <(jq -r '.activations[] | "\(.name) \(.height)"' "$WORK/manifest.json" 2> /dev/null)
  REL_MANDATORY="$(jq -r '.mandatory' "$WORK/manifest.json")"
  REL_BEFORE="$(jq -r '.upgrade_before_height // "n/a"' "$WORK/manifest.json")"
  REL_NOTES="$(jq -r '.notes_url // ""' "$WORK/manifest.json")"
  log "release $REL_VERSION ($(mf '.released')), source commit $(mf '.source_commit')"
  note "binary  $BIN_NAME"
  note "sha256  $BIN_SHA"
  if [ "$HAS_CLI" = 1 ]; then note "cli     $CLI_NAME  sha256 $CLI_SHA"; fi
  if [ "$HAS_INSTALLER" = 1 ]; then note "updater $INS_NAME  sha256 $INS_SHA"; fi
  if [ "$REL_MANDATORY" = "true" ]; then note "MANDATORY upgrade — install before block $REL_BEFORE"; fi
  while IFS= read -r act; do
    note "activation  $act"
  done < <(jq -r '.activations[] | "\(.height)  \(.name)"' "$WORK/manifest.json")
  if [ -n "$REL_NOTES" ]; then note "notes   $REL_NOTES"; fi
}

check_existing_install() {
  INSTALLED_VERSION=""
  if [ -f "$CONF_DIR/manifest.json" ]; then
    INSTALLED_VERSION="$(jq -r '.version // ""' "$CONF_DIR/manifest.json" 2>/dev/null || true)"
  fi
  if [ -n "$INSTALLED_VERSION" ] && ver_lt "$REL_VERSION" "$INSTALLED_VERSION"; then
    [ "$ALLOW_DOWNGRADE" = 1 ] || die "release $REL_VERSION is OLDER than the installed release $INSTALLED_VERSION — refusing to downgrade (a stale mirror, or a replayed old manifest). Set ALLOW_DOWNGRADE=1 only if you really intend to roll back."
    warn "downgrading from $INSTALLED_VERSION to $REL_VERSION (ALLOW_DOWNGRADE=1)"
  fi
  if [ -f "$UNIT_FILE" ] && ! grep -qF -- "$UNIT_MARKER" "$UNIT_FILE"; then
    if [ "$REPLACE_LEGACY_UNIT" != 1 ]; then
      die "$UNIT_FILE exists but was not written by this installer (an earlier source-build install?). Replacing it would start the node on a different data directory ($DATA_DIR) — and a validator must keep its node-keys.json. Migration steps: https://docs.rougechain.io/running-a-node/releases.html#nodes-installed-from-source (stop the service, move the existing data directory to $DATA_DIR owned by '$RUN_USER', re-run with REPLACE_LEGACY_UNIT=1)."
    fi
    # Replacing an existing node's unit must never end with a freshly generated identity.
    if [ "$DRY_RUN" != 1 ] && [ ! -e "$KEYS_FILE" ]; then
      die "REPLACE_LEGACY_UNIT=1, but there is no node key at $KEYS_FILE. The existing node's node-keys.json must be in place first (see https://docs.rougechain.io/running-a-node/releases.html#nodes-installed-from-source) — refusing to generate a new identity for an existing node."
    fi
    LEGACY_UNIT=1
  else
    LEGACY_UNIT=0
  fi
}

print_plan() {
  local keys_state="will be generated" mine_state="off (set VALIDATOR=1 after staking)" start_state="yes"
  if [ -e "$KEYS_FILE" ]; then
    keys_state="exists — kept"
  elif [ -d "$DATA_DIR" ] && [ ! -r "$DATA_DIR" ]; then
    keys_state="unknown — run as root to check"
  fi
  if [ "$VALIDATOR" = 1 ]; then mine_state="ON (--mine)"; fi
  if [ "$NO_START" = 1 ]; then start_state="no (NO_START=1)"; fi
  log "plan"
  note "system            $OS_LABEL, x86_64"
  note "network           $NETWORK ($CHAIN_ID)"
  note "release           $REL_VERSION${INSTALLED_VERSION:+ (installed: $INSTALLED_VERSION)}"
  note "binary            $BIN_PATH"
  if [ "$HAS_CLI" = 1 ]; then
    note "staking CLI       $CLI_PATH"
  else
    note "staking CLI       not part of this release"
  fi
  note "service           $SERVICE  ($UNIT_FILE)"
  note "runs as           $RUN_USER (system user, no login shell)"
  note "data + node key   $DATA_DIR  (node-keys.json: $keys_state)"
  note "config            $CONF_DIR"
  note "API               http://$HOST:$API_PORT   gRPC port $P2P_PORT"
  note "peers             $PEERS"
  note "node name         $NODE_NAME"
  note "public URL        ${PUBLIC_URL:-none}"
  note "block production  $mine_state"
  note "start service     $start_state"
  note "auto-update       $(plan_auto_update)"
}

# What will happen to auto-update, for the plan (changes nothing).
plan_auto_update() {
  local mode="auto" src
  if [ -f "$UPD_CONF" ]; then mode="$(conf_mode_of "$UPD_CONF")"; fi
  if [ "$AUTO_UPDATE" = 0 ]; then mode="off"; elif [ "$AUTO_UPDATE" = 1 ]; then mode="auto"; fi
  if [ "$HAS_INSTALLER" = 1 ]; then src="updater from this signed release"
  elif self_is_file; then src="updater = this installer file (not covered by a release signature)"
  elif [ -f "$UPDATER_PATH" ]; then src="updater already installed"
  else src="NOT available yet: this release names no updater and the installer was piped — see the note at the end"; fi
  printf 'MODE=%s (%s) — %s' "$mode" "$UPD_CONF" "$src"
}

download_release() {
  NEW_BIN="$WORK/$BIN_NAME"
  if [ -f "$BIN_PATH" ] && [ "$(file_sha256 "$BIN_PATH")" = "$BIN_SHA" ]; then
    BIN_CURRENT=1
    log "binary already installed and matches the signed manifest"
  else
    BIN_CURRENT=0
    log "downloading the node binary"
    download_verified "binary" "$NEW_BIN" "$BIN_SHA" "$BIN_SIZE" "${BIN_URLS[@]}" \
      || die "could not obtain a binary matching the signed manifest from any source — nothing was installed"
  fi
  CLI_CURRENT=1
  if [ "$HAS_CLI" = 1 ]; then
    NEW_CLI="$WORK/$CLI_NAME"
    if [ -f "$CLI_PATH" ] && [ "$(file_sha256 "$CLI_PATH")" = "$CLI_SHA" ]; then
      note "rougechain CLI already installed and matches the signed manifest"
    else
      CLI_CURRENT=0
      log "downloading the rougechain CLI"
      download_verified "cli" "$NEW_CLI" "$CLI_SHA" "$CLI_SIZE" "${CLI_URLS[@]}" \
        || die "could not obtain a rougechain CLI matching the signed manifest from any source — nothing was installed"
    fi
  fi
  if [ "$HAS_GENESIS" = 1 ]; then
    if [ -f "$CONF_DIR/genesis.json" ] && [ "$(file_sha256 "$CONF_DIR/genesis.json")" = "$GEN_SHA" ]; then
      GEN_CURRENT=1
    else
      GEN_CURRENT=0
      download_verified "genesis" "$WORK/genesis.json" "$GEN_SHA" "$GEN_SIZE" "${GEN_URLS[@]}" \
        || die "could not obtain a genesis file matching the signed manifest from any source — nothing was installed"
    fi
  fi
  if [ "$ACTION" = "install" ] && [ "$HAS_INSTALLER" = 1 ]; then download_installer; fi
}

# The installer/updater script named in the signed manifest → $WORK/installer.sh (NEW_INS_VERSION).
# INS_CURRENT=1 when the installed updater already is that file.
download_installer() {
  INS_CURRENT=0
  if [ -f "$UPDATER_PATH" ] && [ "$(file_sha256 "$UPDATER_PATH")" = "$INS_SHA" ]; then
    INS_CURRENT=1
    return 0
  fi
  download_verified "updater" "$WORK/installer.sh" "$INS_SHA" "$INS_SIZE" "${INS_URLS[@]}" \
    || die "could not obtain the updater script matching the signed manifest from any source — nothing was installed"
  NEW_INS_VERSION="$(script_version "$WORK/installer.sh")"
  if [ -z "$NEW_INS_VERSION" ] || ! bash -n "$WORK/installer.sh" 2> /dev/null; then
    die "the updater script named in the signed manifest is not a usable install-validator.sh — nothing was installed"
  fi
}

# script_version FILE — the INSTALLER_VERSION of an install-validator.sh ("" if it has none).
script_version() {
  sed -n 's/^INSTALLER_VERSION="\(\(0\|[1-9][0-9]*\)\.\(0\|[1-9][0-9]*\)\.\(0\|[1-9][0-9]*\)\)"$/\1/p' "$1" 2> /dev/null | head -n 1
}

# Was this script started from a regular file that really is this installer?
self_is_file() {
  [ -n "$SELF_PATH" ] && [ -f "$SELF_PATH" ] && [ -r "$SELF_PATH" ] \
    && [ "$(script_version "$SELF_PATH")" = "$INSTALLER_VERSION" ] \
    && grep -qxF "RELEASE_ED25519_PUBKEY_B64=\"$RELEASE_ED25519_PUBKEY_B64\"" "$SELF_PATH"
}

setup_user_and_dirs() {
  if ! getent passwd "$RUN_USER" > /dev/null; then
    log "creating system user '$RUN_USER'"
    useradd --system --user-group --home-dir "$STATE_ROOT" --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
  fi
  install -d -m 0755 -o root -g root "$CONF_ROOT" "$CONF_DIR"
  if [ ! -d "$STATE_ROOT" ]; then install -d -m 0750 -o "$RUN_USER" -g "$RUN_USER" "$STATE_ROOT"; fi
  if [ -d "$DATA_DIR" ]; then
    # Existing data: never chown/chmod recursively, never delete. Only insist on the right owner.
    local owner
    owner="$(stat -c '%U' "$DATA_DIR")"
    [ "$owner" = "$RUN_USER" ] || die "$DATA_DIR exists but is owned by '$owner'. The service runs as '$RUN_USER': run 'chown -R $RUN_USER:$RUN_USER $DATA_DIR' yourself after checking it is the directory you mean, then re-run."
    chmod 0700 "$DATA_DIR"
  else
    install -d -m 0700 -o "$RUN_USER" -g "$RUN_USER" "$DATA_DIR"
  fi
}

# Put the release's files in place. The previous binary and CLI are kept as <file>.prev and the
# previous install record is saved, so undo_swap can restore exactly what was there.
# Returns 1 (SWAP_ERR set) if a file could not be written, a new program does not run here, or
# the ML-DSA-65 signature turns out not to verify; nothing is undone by this function.
# It is called in an `if`, where `set -e` does not apply: every step is checked explicitly.
swap_in_files() {
  local f line
  BIN_CHANGED=0; CLI_CHANGED=0; CLI_HAD_OLD=0; SWAP_ERR=""
  PREV_REC="$WORK/prev-record"
  mkdir -p "$PREV_REC" || { SWAP_ERR="could not create a work directory"; return 1; }
  for f in manifest.json manifest.json.ed25519.sig manifest.json.mldsa65.sig; do
    if [ -f "$CONF_DIR/$f" ]; then
      cp -p -- "$CONF_DIR/$f" "$PREV_REC/$f" || { SWAP_ERR="could not save the current install record ($f)"; return 1; }
    fi
  done
  if [ "$BIN_CURRENT" = 0 ]; then
    if [ -f "$BIN_PATH" ]; then
      cp -p -- "$BIN_PATH" "$BIN_PATH.prev" || { SWAP_ERR="could not keep the previous binary as $BIN_PATH.prev (disk full?)"; return 1; }
      note "previous binary kept as $BIN_PATH.prev"
    fi
    BIN_CHANGED=1
    if ! install -m 0755 -o root -g root "$NEW_BIN" "$BIN_PATH.new" || ! mv -f -- "$BIN_PATH.new" "$BIN_PATH" \
        || [ "$(file_sha256 "$BIN_PATH")" != "$BIN_SHA" ]; then
      SWAP_ERR="could not write the new binary to $BIN_PATH (disk full, or a read-only file system?)"; return 1
    fi
    log "installed $BIN_PATH (release $REL_VERSION)"
    # Catch a binary that cannot run here (e.g. a missing shared library) before the service does.
    if ! runuser -u "$RUN_USER" -- "$BIN_PATH" --version > "$WORK/version.log" 2>&1 9>&-; then
      while IFS= read -r line; do warn "  $line"; done < "$WORK/version.log"
      SWAP_ERR="the installed binary does not run on this system (see above)"
      return 1
    fi
  fi
  if [ "$HAS_CLI" = 1 ] && [ "$CLI_CURRENT" = 0 ]; then
    if [ -f "$CLI_PATH" ]; then
      cp -p -- "$CLI_PATH" "$CLI_PATH.prev" || { SWAP_ERR="could not keep the previous CLI as $CLI_PATH.prev (disk full?)"; return 1; }
      CLI_HAD_OLD=1
      note "previous CLI kept as $CLI_PATH.prev"
    fi
    CLI_CHANGED=1
    if ! install -m 0755 -o root -g root "$NEW_CLI" "$CLI_PATH.new" || ! mv -f -- "$CLI_PATH.new" "$CLI_PATH" \
        || [ "$(file_sha256 "$CLI_PATH")" != "$CLI_SHA" ]; then
      SWAP_ERR="could not write the new rougechain CLI to $CLI_PATH (disk full, or a read-only file system?)"; return 1
    fi
    if ! runuser -u "$RUN_USER" -- "$CLI_PATH" --version > "$WORK/version.log" 2>&1 9>&-; then
      while IFS= read -r line; do warn "  $line"; done < "$WORK/version.log"
      SWAP_ERR="the installed rougechain CLI does not run on this system (see above)"
      return 1
    fi
    log "installed $CLI_PATH (rougechain CLI, release $REL_VERSION)"
  fi
  if [ "$HAS_GENESIS" = 1 ] && [ "$GEN_CURRENT" = 0 ]; then
    install -m 0644 -o root -g root "$WORK/genesis.json" "$CONF_DIR/genesis.json" || { SWAP_ERR="could not write $CONF_DIR/genesis.json"; return 1; }
  fi
  # Keep the verified manifest + signatures: the record of what is installed (and the downgrade guard).
  for f in manifest.json manifest.json.ed25519.sig manifest.json.mldsa65.sig; do
    if ! install -m 0644 -o root -g root "$WORK/$f" "$CONF_DIR/$f" || ! cmp -s "$WORK/$f" "$CONF_DIR/$f"; then
      SWAP_ERR="could not write the install record $CONF_DIR/$f"; return 1
    fi
  done

  # The ML-DSA-65 signature could not be checked before (no verifier was installed). If the CLI
  # that is installed now can check it, it must verify — before the node is (re)started.
  if [ "$PQ_STATUS" = "unchecked" ] && [ -n "$PQ_KEY_FILE" ] && [ -x "$CLI_PATH" ] \
      && run_as_service_user "$CLI_PATH" release verify --help > /dev/null 2>&1; then
    if verify_mldsa "$CONF_DIR/manifest.json" "$CONF_DIR/manifest.json.mldsa65.sig" "$CLI_PATH"; then
      PQ_STATUS="verified-after-install"
      note "signature OK (ML-DSA-65 release key ${RELEASE_PQ_KEY_FPR:-?}, checked with the CLI of this release)"
    else
      SWAP_ERR="the ML-DSA-65 SIGNATURE of release $REL_VERSION does NOT verify (its Ed25519 signature did). Do not run this release; report it: https://github.com/cyberdreadx/rougechain-node/security"
      return 1
    fi
  fi
  return 0
}

# restore_prev PATH HAD_OLD — put <PATH>.prev back as PATH; what is there now is kept as
# <PATH>.failed. Never leaves PATH missing when a previous file exists: if there is no room for
# a copy, the .prev file itself is moved back.
restore_prev() {
  local path="$1" had_old="$2"
  rm -f -- "${path:?}.new" 2> /dev/null || true
  if [ "$had_old" = 1 ] && [ -f "$path.prev" ]; then
    if [ -f "$path" ] && cmp -s "$path" "$path.prev"; then return 0; fi   # it was never replaced
    if [ -f "$path" ]; then mv -f -- "$path" "$path.failed" || return 1; fi
    if cp -p -- "$path.prev" "$path.restore" 2> /dev/null && mv -f -- "$path.restore" "$path"; then return 0; fi
    rm -f -- "${path:?}.restore" 2> /dev/null || true
    mv -f -- "$path.prev" "$path"
  else
    # there was nothing before (a first install): take the new file away again
    if [ -f "$path" ]; then mv -f -- "$path" "$path.failed" || return 1; fi
  fi
}

# Undo swap_in_files: the previous binary, CLI and install record come back; what was installed
# is kept as <file>.failed for inspection. Returns 1 if something could not be restored.
undo_swap() {
  local f rc=0 had_bin=0
  if [ "${BIN_CHANGED:-0}" = 1 ]; then
    if [ -f "$BIN_PATH.prev" ]; then had_bin=1; fi
    restore_prev "$BIN_PATH" "$had_bin" || rc=1
  fi
  if [ "${CLI_CHANGED:-0}" = 1 ]; then
    restore_prev "$CLI_PATH" "$CLI_HAD_OLD" || rc=1
  fi
  for f in manifest.json manifest.json.ed25519.sig manifest.json.mldsa65.sig; do
    if [ -f "$PREV_REC/$f" ]; then
      if ! cmp -s "$PREV_REC/$f" "$CONF_DIR/$f"; then
        install -m 0644 -o root -g root "$PREV_REC/$f" "$CONF_DIR/$f" || rc=1
      fi
    else
      rm -f -- "${CONF_DIR:?}/${f:?}" || rc=1
    fi
  done
  return "$rc"
}

install_files() {
  if [ "$HAS_GENESIS" = 1 ] && [ "$GEN_CURRENT" = 0 ]; then
    if [ -f "$CONF_DIR/genesis.json" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
      die "the release's genesis file differs from $CONF_DIR/genesis.json and $DATA_DIR already holds data. A genesis change means a different chain — refusing to replace it."
    fi
  fi
  if ! swap_in_files; then
    # Do not leave a release in place that failed to install: put back what was there.
    if undo_swap; then
      die "$SWAP_ERR — what was there before was put back (the files of this release are kept as *.failed); the service was not (re)started."
    fi
    die "$SWAP_ERR — AND the previous files could not all be put back. Check $BIN_PATH, $BIN_PATH.prev and $CONF_DIR/manifest.json before starting the service."
  fi
}

have_systemd() { [ -d /run/systemd/system ]; }
service_active() {
  have_systemd && sysctl is-active --quiet "$SERVICE" 2>/dev/null
}

# Node identity: generated once, by the daemon itself, as the service user with umask 077.
# `--print-state-digest` initialises the data directory exactly as a normal start does (which
# creates node-keys.json when there is none), prints a digest and exits without opening ports.
ensure_node_keys() {
  KEYS_GENERATED=0
  if [ -e "$KEYS_FILE" ]; then
    log "node key exists — keeping it ($KEYS_FILE)"
    # Tighten permissions only; the content is never touched.
    chmod 0600 "$KEYS_FILE"
    return 0
  fi
  if service_active; then
    warn "no node-keys.json yet but the service is running — it creates the key itself; not generating one"
    return 0
  fi
  log "generating the node identity (node-keys.json)"
  local genesis_args=()
  if [ "$HAS_GENESIS" = 1 ]; then genesis_args=(--genesis "$CONF_DIR/genesis.json"); fi
  # shellcheck disable=SC2016
  if ! runuser -u "$RUN_USER" -- env HOME="$DATA_DIR" sh -c 'umask 077 && cd "$1" && shift && exec "$@"' sh "$DATA_DIR" \
      "$BIN_PATH" --chain-id "$CHAIN_ID" "${genesis_args[@]}" --data-dir "$DATA_DIR" --print-state-digest \
      > "$WORK/keygen.log" 2>&1; then
    warn "the node could not initialise its data directory:"
    sed 's/^/      /' "$WORK/keygen.log" | tail -n 20 >&2
    die "node key generation failed — the service was not started. Nothing else was changed."
  fi
  [ -s "$KEYS_FILE" ] || die "the node ran but did not create $KEYS_FILE"
  chmod 0600 "$KEYS_FILE"
  KEYS_GENERATED=1
}

unit_content() {
  local genesis_line="" public_line="" mine_line="" home_line="ProtectHome=yes" desc_extra=""
  if [ "$HAS_GENESIS" = 1 ]; then genesis_line="  --genesis $CONF_DIR/genesis.json \\"$'\n'; fi
  if [ -n "$PUBLIC_URL" ]; then public_line=" \\"$'\n'"  --public-url $PUBLIC_URL"; fi
  if [ "$VALIDATOR" = 1 ]; then mine_line=" \\"$'\n'"  --mine"; fi
  # ProtectHome would hide a data directory placed under /home, /root or /run/user.
  case "$DATA_DIR/" in /home/*|/root/*|/run/user/*) home_line="# ProtectHome omitted: the data directory is under a home directory" ;; esac
  if [ "$TEST_MODE" = 1 ]; then desc_extra=" [INSTALLED WITH A TEST RELEASE KEY]"; fi
  cat <<UNIT
$UNIT_MARKER v$INSTALLER_VERSION — re-running the installer rewrites this file.
# Local settings: put QV_* environment variables in $CONF_DIR/node.env (optional, survives upgrades).
[Unit]
Description=RougeChain node ($NETWORK, $CHAIN_ID)$desc_extra
Documentation=https://docs.rougechain.io/running-a-node/releases.html
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
Environment=HOME=$DATA_DIR
EnvironmentFile=-$CONF_DIR/node.env
WorkingDirectory=$DATA_DIR
ExecStart=$BIN_PATH \\
  --chain-id $CHAIN_ID \\
$genesis_line  --data-dir $DATA_DIR \\
  --host $HOST --api-port $API_PORT --port $P2P_PORT \\
  --peers $PEERS \\
  --node-name $NODE_NAME$public_line$mine_line
Restart=always
RestartSec=10
LimitNOFILE=65536
UMask=0077

# Sandboxing: the node may write only to its data directory and gets no privileges.
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
$home_line
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT
}

install_unit() {
  UNIT_CHANGED=0
  unit_content > "$WORK/unit"
  if [ -f "$UNIT_FILE" ] && cmp -s "$WORK/unit" "$UNIT_FILE"; then return 0; fi
  if [ "$LEGACY_UNIT" = 1 ]; then
    cp -p -- "$UNIT_FILE" "$UNIT_FILE.legacy"
    warn "replaced a unit not written by this installer; the old one is kept as $UNIT_FILE.legacy"
  fi
  install -d -m 0755 /etc/systemd/system
  install -m 0644 -o root -g root "$WORK/unit" "$UNIT_FILE"
  UNIT_CHANGED=1
  log "wrote $UNIT_FILE"
}

start_service() {
  STARTED=0
  if [ ! -d /run/systemd/system ]; then
    warn "systemd is not running here — the unit was written but the service was not started"
    return 0
  fi
  sysctl daemon-reload
  if [ "$NO_START" = 1 ]; then
    if service_active && { [ "$BIN_CHANGED" = 1 ] || [ "$UNIT_CHANGED" = 1 ]; }; then
      warn "NO_START=1: the running service still uses the OLD binary/unit. Restart it when ready: systemctl restart $SERVICE"
    fi
    return 0
  fi
  sysctl enable "$SERVICE" > /dev/null 2>&1 || warn "could not enable $SERVICE at boot"
  if service_active; then
    if [ "$BIN_CHANGED" = 1 ] || [ "$UNIT_CHANGED" = 1 ]; then
      log "restarting $SERVICE"
      sysctl restart "$SERVICE"
    else
      log "$SERVICE is running and already up to date — not restarted"
    fi
  else
    log "starting $SERVICE"
    sysctl start "$SERVICE"
  fi
  STARTED=1
  local i
  for i in $(seq 1 30); do
    if curl --silent --fail --max-time 3 "http://127.0.0.1:$API_PORT/api/health" > /dev/null 2>&1; then
      note "node API is answering on port $API_PORT"
      return 0
    fi
    if ! service_active && [ "$i" -gt 5 ]; then break; fi
    sleep 2
  done
  warn "the node API did not answer on 127.0.0.1:$API_PORT yet. Check: journalctl -u $SERVICE -n 50"
}

print_next_steps() {
  local key_short="" cli cli_name
  local svc_state="(not started — start it with: systemctl enable --now $SERVICE)" mine_note="(block production is off)."
  if [ "$STARTED" = 1 ]; then svc_state="(running)"; fi
  if [ "$VALIDATOR" = 1 ]; then mine_note="until its key is staked (--mine is on)."; fi
  local key_state="existing key, unchanged"
  if [ "$KEYS_GENERATED" = 1 ]; then key_state="NEW key, generated just now"; fi
  if [ ! -e "$KEYS_FILE" ]; then key_state="not created yet — the node creates it on first start"; fi
  if [ -r "$KEYS_FILE" ]; then
    key_short="$(jq -r '.public_key_hex // "" | .[0:16]' "$KEYS_FILE" 2>/dev/null || true)"
  fi
  cli_name="$(basename "$CLI_PATH")"
  # The CLI signs with the node key and submits to the network's public API (mainnet by default,
  # --network testnet for testnet); stake/unstake/transfer go through the signed /api/v2 routes.
  cli="$cli_name$CLI_NET_ARG --node-keys $KEYS_FILE"
  echo
  log "Done. RougeChain node release $REL_VERSION is installed ($NETWORK)."
  cat <<STEPS

  Service   $SERVICE   $svc_state
  Logs      journalctl -u $SERVICE -f
  Health    curl -s http://127.0.0.1:$API_PORT/api/health
  Node key  $KEYS_FILE   ($key_state${key_short:+, public key $key_short…})

  1) BACK UP THE NODE KEY NOW, offline:
       $KEYS_FILE
     It is this node's identity. Once you stake, it holds the stake and signs your blocks;
     losing it loses the validator and the ability to unstake. Never run two nodes with it.

  2) This node is a full node: it syncs and serves its local API. It does NOT produce
     blocks $mine_note

  To become a validator
  3) Fund and stake THIS key (min. 10,000 XRGE on mainnet, + 1 XRGE fee). The stake transaction
     must be signed by the key in node-keys.json.
STEPS
  if [ -x "$CLI_PATH" ] && [ "$HAS_CLI" = 1 ]; then
    cat <<STEPS
     The 'rougechain' CLI from this signed release is installed as $CLI_PATH.
     The key file is readable only by the '$RUN_USER' user, so run the CLI as that user:
       sudo -u $RUN_USER $cli whoami
           # prints your validator address (rouge1…) — send the XRGE to it, then:
       sudo -u $RUN_USER $cli stake 10000
       sudo -u $RUN_USER $cli validator-status
           # want: Staked + In active set
     (no sudo? as root: runuser -u $RUN_USER -- $cli_name …)
STEPS
  else
    cat <<STEPS
     This release does not include the 'rougechain' CLI — build it from source on a machine
     with Rust:
       git clone https://github.com/cyberdreadx/rougechain-node && cd rougechain-node/core
       cargo build --release -p quantum-vault-cli        # -> target/release/rougechain
     then, as root on this server (the key file is readable only by '$RUN_USER' and root):
       rougechain$CLI_NET_ARG --node-keys $KEYS_FILE whoami     # your validator address
       rougechain$CLI_NET_ARG --node-keys $KEYS_FILE stake 10000
       rougechain$CLI_NET_ARG --node-keys $KEYS_FILE validator-status
STEPS
  fi
  cat <<STEPS
     Guide: https://docs.rougechain.io/staking/becoming-validator.html
$(if [ "$VALIDATOR" = 1 ]; then
    echo "  4) Block production (--mine) is already enabled: once the key is staked and in the active set,
     the node votes and proposes when it is the designated proposer."
  else
    echo "  4) After the stake is confirmed, turn on block production by re-running this installer with
     VALIDATOR=1 and a PUBLIC_URL peers can reach (an HTTPS reverse proxy to port $API_PORT):
       curl -sSL https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/scripts/install-validator.sh \\
         | sudo NETWORK=$NETWORK VALIDATOR=1 PUBLIC_URL=https://node.example.com bash"
  fi)

  Upgrades: $(if [ "$UPDATER_STATE" = "on" ]; then
    echo "AUTOMATIC. A timer ($UPD_SERVICE.timer) looks for a newer signed release every hour, installs
  it, checks the node's health and rolls back if the check fails.
       rougechain-update status$CLI_NET_ARG       # installed / latest release, last result, next check
       $UPD_CONF     # MODE=auto|notify|off, PIN_VERSION, delays
  Docs: https://docs.rougechain.io/running-a-node/auto-update.html"
  elif [ "$UPDATER_STATE" = "notify" ]; then
    echo "NOTIFY ONLY (MODE=notify in $UPD_CONF): the timer reports a newer signed
  release in the journal and in 'rougechain-update status$CLI_NET_ARG', and installs nothing."
  elif [ "$UPDATER_STATE" = "off" ]; then
    echo "auto-update is OFF (MODE=off in $UPD_CONF). Re-run this installer to
  upgrade, or set MODE=auto (or notify) there and run: systemctl enable --now $UPD_SERVICE.timer"
  else
    echo "re-run this installer. AUTO-UPDATE IS NOT SET UP on this node (see the note below)."
  fi)
  A manual upgrade is always possible: re-run this installer. It verifies the new signed release
  and keeps the old binaries as $BIN_PATH.prev (and $CLI_PATH.prev). Keys and data are not touched.
STEPS
  if [ "$UPDATER_STATE" = "unavailable" ]; then
    warn "AUTO-UPDATE WAS NOT INSTALLED. Release $REL_VERSION names no updater in its signed manifest, and this"
    warn "installer was piped into bash, so its own bytes cannot be kept as the updater. Do ONE of:"
    warn "  - re-run this same command after the next release (its signed manifest carries the updater), or"
    warn "  - download install-validator.sh to a file, read it, and run that file: sudo bash install-validator.sh"
    warn "Until then upgrade by re-running the installer (docs: running-a-node/auto-update)."
  fi
  if [ -z "$PUBLIC_URL" ] && [ "$VALIDATOR" = 1 ]; then
    warn "VALIDATOR=1 without PUBLIC_URL: peers cannot reach this node, so its votes and blocks will not propagate."
  fi
  if [ "$HOST" != "127.0.0.1" ]; then
    warn "the API is bound to $HOST. Do not expose port $API_PORT to the internet directly — put a TLS reverse proxy in front."
  fi
}

# ── auto-update: settings ────────────────────────────────────────────────────

default_update_conf() { # default_update_conf MODE
  cat <<CONF
# RougeChain auto-update settings ($NETWORK). Read by rougechain-update as plain KEY=VALUE lines
# (it is never executed). Written once by install-validator.sh; your changes are kept.
# Docs: https://docs.rougechain.io/running-a-node/auto-update.html

# auto   = install newer SIGNED releases automatically (default)
# notify = only report them (journal + "rougechain-update status")
# off    = do nothing
MODE=$1

# Stay on exactly this release (e.g. 1.6.1): nothing newer is installed while this is set.
# A mandatory release you do not install takes this node off the network at its fork height.
PIN_VERSION=

# Optional releases wait a random time — fixed per host — of up to this many seconds (6 h), so
# that the nodes of the network do not all restart together.
OPTIONAL_DELAY_MAX_SECS=21600
# Mandatory releases wait at most this long, and not at all once the chain is within
# DEADLINE_MARGIN_BLOCKS of the release's upgrade height.
MANDATORY_DELAY_MAX_SECS=600
DEADLINE_MARGIN_BLOCKS=10

# A validator that is the designated proposer of the next block and has pending transactions
# is not restarted for up to this many seconds (not applied when the upgrade height is near).
PROPOSER_DEFER_MAX_SECS=300

# Health check after the restart. The API must answer within HEALTH_START_TIMEOUT_SECS; then,
# before HEALTH_DEADLINE_SECS, the node must agree with a reference node (same block, same
# state root) and be at most HEALTH_MAX_LAG_BLOCKS behind it. Otherwise the previous release
# is put back.
HEALTH_START_TIMEOUT_SECS=120
HEALTH_DEADLINE_SECS=300
HEALTH_MAX_LAG_BLOCKS=2

# Extra reference nodes for the health check: space-separated API URLs such as
# https://node.example.com/api . The node's own --peers are always used.
REFERENCE_URLS=

# Where release manifests are fetched from (space-separated). Empty = https://api.rougechain.io/releases
# and the GitHub mirror. Every source is asked; the newest validly signed release wins.
RELEASE_BASE_URLS=
CONF
}

# conf_mode_of FILE — the MODE in an update.conf (auto when the file has none; notify when invalid).
conf_mode_of() {
  local v
  v="$(sed -n 's/^[[:space:]]*MODE=[[:space:]]*\([^[:space:]#]*\).*$/\1/p' "$1" 2> /dev/null | tail -n 1 | tr -d "\"'")"
  case "$v" in auto|notify|off) printf '%s' "$v" ;; "") printf 'auto' ;; *) printf 'notify' ;; esac
}

set_conf_mode() { # set_conf_mode FILE MODE — change only the MODE line
  if grep -q '^[[:space:]]*MODE=' "$1"; then
    sed "s/^[[:space:]]*MODE=.*$/MODE=$2/" "$1" > "$1.tmp"
  else
    { cat "$1"; printf 'MODE=%s\n' "$2"; } > "$1.tmp"
  fi
  chmod 0644 "$1.tmp"
  mv -f -- "$1.tmp" "$1"
}

# Read update.conf into UC_*. Anything not understood is reported and the SAFE reading is used:
# a bad MODE or PIN_VERSION means "install nothing" (notify), a bad number means the default.
load_update_conf() {
  UC_MODE="auto"; UC_PIN=""; UC_OPT_DELAY=21600; UC_MAND_DELAY=600; UC_MARGIN=10; UC_DEFER=300
  UC_START_TIMEOUT=120; UC_DEADLINE=300; UC_MAX_LAG=2; UC_REFS=""; UC_BASES=""
  [ -f "$UPD_CONF" ] || return 0
  local line key val u ok
  local re_kv='^([A-Z_]+)=(.*)$' re_num='^[0-9]{1,7}$' re_u='^https?://[A-Za-z0-9._:/-]+$'
  local re_ver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    case "$line" in ""|"#"*) continue ;; esac
    if ! [[ "$line" =~ $re_kv ]]; then warn "$UPD_CONF: line not understood, ignored: ${line:0:60}"; continue; fi
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    case "$key" in
      MODE)
        case "$val" in
          auto|notify|off) UC_MODE="$val" ;;
          *) warn "$UPD_CONF: MODE='${val:0:20}' is not auto, notify or off — treating it as notify (nothing is installed)"; UC_MODE="notify" ;;
        esac ;;
      PIN_VERSION)
        if [ -z "$val" ] || [[ "$val" =~ $re_ver ]]; then UC_PIN="$val"
        else warn "$UPD_CONF: PIN_VERSION='${val:0:20}' is not a version like 1.6.1 — nothing is installed until it is fixed"; UC_MODE="notify"; fi ;;
      OPTIONAL_DELAY_MAX_SECS|MANDATORY_DELAY_MAX_SECS|DEADLINE_MARGIN_BLOCKS|PROPOSER_DEFER_MAX_SECS|HEALTH_START_TIMEOUT_SECS|HEALTH_DEADLINE_SECS|HEALTH_MAX_LAG_BLOCKS)
        if ! [[ "$val" =~ $re_num ]]; then warn "$UPD_CONF: $key='${val:0:20}' is not a number — using the default"; continue; fi
        val=$((10#$val))
        case "$key" in
          OPTIONAL_DELAY_MAX_SECS) UC_OPT_DELAY="$val" ;;
          MANDATORY_DELAY_MAX_SECS) UC_MAND_DELAY="$val" ;;
          DEADLINE_MARGIN_BLOCKS) UC_MARGIN="$val" ;;
          PROPOSER_DEFER_MAX_SECS) UC_DEFER="$val" ;;
          HEALTH_START_TIMEOUT_SECS) if [ "$val" -ge 10 ]; then UC_START_TIMEOUT="$val"; else warn "$UPD_CONF: $key must be at least 10 — using the default"; fi ;;
          HEALTH_DEADLINE_SECS) if [ "$val" -ge 10 ]; then UC_DEADLINE="$val"; else warn "$UPD_CONF: $key must be at least 10 — using the default"; fi ;;
          HEALTH_MAX_LAG_BLOCKS) UC_MAX_LAG="$val" ;;
        esac ;;
      REFERENCE_URLS|RELEASE_BASE_URLS)
        ok=1
        for u in $val; do [[ "$u" =~ $re_u ]] || ok=0; done
        if [ "$ok" != 1 ]; then warn "$UPD_CONF: $key must be space-separated http(s) URLs — ignored"; continue; fi
        if [ "$key" = "REFERENCE_URLS" ]; then UC_REFS="$val"; else UC_BASES="$val"; fi ;;
      *) warn "$UPD_CONF: unknown setting $key — ignored" ;;
    esac
  done < "$UPD_CONF"
}

# ── auto-update: installing the updater itself ───────────────────────────────

updater_wrapper_content() {
  cat <<WRAP
#!/bin/sh
$UPDATER_MARKER — do not edit.
# rougechain-update: signed auto-update for RougeChain nodes. See: rougechain-update --help
exec /bin/bash $UPDATER_PATH updater "\$@"
WRAP
}

updater_unit_content() {
  cat <<UNIT
$UPDATER_MARKER v$INSTALLER_VERSION — re-running the installer rewrites this file.
# Settings: $UPD_CONF
[Unit]
Description=RougeChain node auto-update ($NETWORK): install newer signed releases
Documentation=https://docs.rougechain.io/running-a-node/auto-update.html
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$UPDATER_CMD run --network $NETWORK
SyslogIdentifier=rougechain-update
# A run may wait (per-host delay, proposer deferral), download and health-check.
TimeoutStartSec=2h
Nice=10
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UNIT
}

updater_timer_content() {
  cat <<UNIT
$UPDATER_MARKER v$INSTALLER_VERSION — re-running the installer rewrites this file.
[Unit]
Description=RougeChain node auto-update check ($NETWORK), hourly
Documentation=https://docs.rougechain.io/running-a-node/auto-update.html

[Timer]
OnBootSec=10min
OnCalendar=hourly
# Each host checks at its own fixed minute, so the nodes do not all ask at once.
RandomizedDelaySec=30min
FixedRandomDelay=yes
Persistent=yes
Unit=$UPD_SERVICE.service

[Install]
WantedBy=timers.target
UNIT
}

# write_if_changed CONTENT_FILE DEST MODE — returns 0 if DEST was written.
write_if_changed() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 1; fi
  install -m "$3" -o root -g root "$1" "$2.new"
  mv -f -- "$2.new" "$2"
}

# install_updater_program SRC LABEL — keep SRC as the installed updater (and the command for it).
install_updater_program() {
  install -d -m 0755 -o root -g root "$LIB_DIR"
  if [ "$1" != "$UPDATER_PATH" ] && ! { [ -f "$UPDATER_PATH" ] && cmp -s "$1" "$UPDATER_PATH"; }; then
    if [ -f "$UPDATER_PATH" ]; then cp -p -- "$UPDATER_PATH" "$UPDATER_PATH.prev"; fi
    install -m 0755 -o root -g root "$1" "$UPDATER_PATH.new"
    mv -f -- "$UPDATER_PATH.new" "$UPDATER_PATH"
    log "installed the updater: $UPDATER_PATH (v$(script_version "$UPDATER_PATH"), from: $2)"
  fi
  updater_wrapper_content > "$WORK/wrapper"
  if write_if_changed "$WORK/wrapper" "$UPDATER_CMD" 0755; then note "command: $UPDATER_CMD"; fi
  if [ "$(state_get UPDATER_SOURCE)" != "$2" ]; then state_set UPDATER_SOURCE "$2"; fi
}

# Installer step: settings, the updater program, its service + timer.
# UPDATER_STATE: on | notify | off | unavailable (no trustworthy copy of the updater to install).
install_updater() {
  local src="" label="" mode desired
  UPDATER_STATE="unavailable"
  install -d -m 0755 -o root -g root "$UPDATER_STATE_ROOT" "$UPD_STATE_DIR"
  STATE_READY=1

  # Settings first: an opt-out is recorded even when the updater itself cannot be installed yet.
  if [ ! -f "$UPD_CONF" ]; then
    mode="auto"; if [ "$AUTO_UPDATE" = 0 ]; then mode="off"; fi
    default_update_conf "$mode" > "$WORK/update.conf"
    install -m 0644 -o root -g root "$WORK/update.conf" "$UPD_CONF"
    log "wrote $UPD_CONF (MODE=$mode)"
  elif [ -n "$AUTO_UPDATE" ]; then
    desired="auto"; if [ "$AUTO_UPDATE" = 0 ]; then desired="off"; fi
    if [ "$(conf_mode_of "$UPD_CONF")" != "$desired" ]; then
      set_conf_mode "$UPD_CONF" "$desired"
      log "AUTO_UPDATE=$AUTO_UPDATE: set MODE=$desired in $UPD_CONF (other settings kept)"
    fi
  else
    note "keeping the existing $UPD_CONF (MODE=$(conf_mode_of "$UPD_CONF"))"
  fi
  mode="$(conf_mode_of "$UPD_CONF")"

  # Which bytes become the installed updater? Only ones with a known origin:
  #  1. the script named (sha256) in the SIGNED manifest of this release — chains to the release key;
  #  2. else the installer FILE the operator is running right now — the same trust they already
  #     gave it by running it as root, nothing more;
  #  3. else (piped installer, release without an updater entry) nothing: a second download of
  #     "the installer" could be different bytes, verified by nobody.
  # An installed updater is never replaced by an older one.
  if [ "$HAS_INSTALLER" = 1 ]; then
    label="signed release $REL_VERSION"
    if [ "$INS_CURRENT" = 1 ]; then
      src="$UPDATER_PATH"
    elif [ -f "$UPDATER_PATH" ] && ver_lt "$NEW_INS_VERSION" "$(script_version "$UPDATER_PATH")"; then
      src="$UPDATER_PATH"; label="$(state_get UPDATER_SOURCE "installed earlier")"
      note "the installed updater (v$(script_version "$UPDATER_PATH")) is newer than the one in release $REL_VERSION (v$NEW_INS_VERSION) — kept"
    else
      src="$WORK/installer.sh"
    fi
  elif self_is_file; then
    if [ -f "$UPDATER_PATH" ] && ver_lt "$INSTALLER_VERSION" "$(script_version "$UPDATER_PATH")"; then
      src="$UPDATER_PATH"; label="$(state_get UPDATER_SOURCE "installed earlier")"
    else
      src="$SELF_PATH"; label="installer file run by the operator (v$INSTALLER_VERSION, not covered by a release signature)"
    fi
  elif [ -f "$UPDATER_PATH" ]; then
    src="$UPDATER_PATH"; label="$(state_get UPDATER_SOURCE "installed earlier")"
  else
    return 0
  fi
  install_updater_program "$src" "$label"

  updater_unit_content > "$WORK/upd.service"
  updater_timer_content > "$WORK/upd.timer"
  install -d -m 0755 /etc/systemd/system
  if write_if_changed "$WORK/upd.service" "$UPD_UNIT_FILE" 0644; then log "wrote $UPD_UNIT_FILE"; fi
  if write_if_changed "$WORK/upd.timer" "$UPD_TIMER_FILE" 0644; then log "wrote $UPD_TIMER_FILE"; fi

  case "$mode" in auto) UPDATER_STATE="on" ;; notify) UPDATER_STATE="notify" ;; *) UPDATER_STATE="off" ;; esac
  if have_systemd; then
    sysctl daemon-reload
    if [ "$mode" = "off" ]; then
      sysctl disable --now "$UPD_SERVICE.timer" > /dev/null 2>&1 || true
      log "auto-update is off: $UPD_SERVICE.timer is disabled"
    elif sysctl enable --now "$UPD_SERVICE.timer" > /dev/null 2>&1; then
      log "auto-update timer enabled: $UPD_SERVICE.timer (MODE=$mode)"
    else
      warn "could not enable $UPD_SERVICE.timer — enable it with: systemctl enable --now $UPD_SERVICE.timer"
    fi
  else
    note "systemd is not running here — the auto-update timer was written but not enabled"
  fi
}

# ── auto-update: what is installed, where the node listens ───────────────────

# unit_arg FLAG — the value of a daemon flag in the node's unit ("" if absent).
unit_arg() {
  sed -n "s/^.*[[:space:]]$1[[:space:]]\{1,\}\([^[:space:]\\\\]\{1,\}\).*$/\1/p" "$UNIT_FILE" | head -n 1
}

load_node_from_unit() {
  local re_port='^[0-9]{1,5}$' re_path='^/[A-Za-z0-9._/-]+$' re_host='^[A-Za-z0-9.:-]{1,64}$' re_peers='^https?://[A-Za-z0-9._:/,-]+$'
  [ -f "$UNIT_FILE" ] || die "$UNIT_FILE not found — this node was not installed with install-validator.sh, so there is nothing to update"
  grep -qF -- "$UNIT_MARKER" "$UNIT_FILE" || die "$UNIT_FILE was not written by install-validator.sh — the updater only manages nodes installed by it"
  DATA_DIR="$(unit_arg --data-dir)"; API_PORT="$(unit_arg --api-port)"; HOST="$(unit_arg --host)"; PEERS="$(unit_arg --peers)"
  [[ "$DATA_DIR" =~ $re_path && "$API_PORT" =~ $re_port && "$HOST" =~ $re_host ]] || die "could not read --data-dir / --api-port / --host from $UNIT_FILE"
  [[ "$PEERS" =~ $re_peers ]] || PEERS="$DEF_PEERS"
  KEYS_FILE="$DATA_DIR/node-keys.json"
  IS_VALIDATOR=0
  if grep -qE -- '(^|[[:space:]])--mine([[:space:]]|\\|$)' "$UNIT_FILE"; then IS_VALIDATOR=1; fi
  local api_host="$HOST"
  case "$HOST" in 0.0.0.0|::|"[::]") api_host="127.0.0.1" ;; *:*) api_host="[$HOST]" ;; esac
  LOCAL_API="http://$api_host:$API_PORT/api"
  # Reference nodes for the health check: the node's peers, then the operator's extra ones.
  REFS=()
  local u seen=" "
  for u in ${PEERS//,/ } $UC_REFS; do
    u="${u%/}"
    case "$u" in */api) ;; *) u="$u/api" ;; esac
    case "$seen" in *" $u "*) continue ;; esac
    seen="$seen$u "
    REFS+=("$u")
  done
}

# ── auto-update: timing ──────────────────────────────────────────────────────

# host_jitter VERSION — 0…9999, fixed for this host + network + release (so a host keeps its
# place in the rollout however often the timer fires).
host_jitter() {
  local id h
  if [ "$TEST_MODE" = 1 ] && [[ "${ROUGECHAIN_UPDATER_TEST_JITTER:-}" =~ ^[0-9]{1,4}$ ]]; then
    printf '%s' "$((10#$ROUGECHAIN_UPDATER_TEST_JITTER))"; return 0
  fi
  id="$(cat /etc/machine-id 2> /dev/null || true)"
  if [ -z "$id" ]; then id="$(hostname 2> /dev/null || echo unknown)"; fi
  h="$(printf '%s|%s|%s' "$id" "$NETWORK" "$1" | sha256sum | cut -c 1-8)"
  printf '%s' "$((16#$h % 10000))"
}

# deadline_near — the release has an upgrade height and the local chain is within the margin
# of it (or past it). Also true when the node does not answer: waiting protects nothing then.
deadline_near() {
  local h
  [[ "$REL_BEFORE" =~ $RE_UINT ]] || return 1
  if api_get "$LOCAL_API/stats" "$WORK/t-stats.json" 5 && h="$(jval "$WORK/t-stats.json" '.network_height' "$RE_UINT")"; then
    [ $((REL_BEFORE - h)) -le "$UC_MARGIN" ]
  else
    return 0
  fi
}

# wait_for_window — 0: install now; 1: not yet (an optional release still in its delay window).
wait_for_window() {
  local first window after t remaining chunk
  if [ "$FORCE_NOW" = 1 ]; then note "--now: no delay"; return 0; fi
  first="$(state_get PENDING_FIRST_SEEN)"
  if [ "$(state_get PENDING_VERSION)" != "$REL_VERSION" ] || ! [[ "$first" =~ $RE_UINT ]]; then
    first="$(now)"
    state_set PENDING_VERSION "$REL_VERSION"
    state_set PENDING_FIRST_SEEN "$first"
  fi
  if [ "$REL_MANDATORY" = "true" ]; then
    if deadline_near; then
      note "mandatory release, and the chain is within $UC_MARGIN blocks of upgrade height $REL_BEFORE (or the node is not answering): installing now"
      return 0
    fi
    window="$UC_MAND_DELAY"
  else
    window="$UC_OPT_DELAY"
  fi
  after=$((first + window * $(host_jitter "$REL_VERSION") / 10000))
  state_set PENDING_INSTALL_AFTER "$after"
  t="$(now)"
  if [ "$t" -ge "$after" ]; then return 0; fi
  remaining=$((after - t))
  if [ "$REL_MANDATORY" = "true" ]; then
    log "mandatory release $REL_VERSION: installing in ${remaining}s (per-host delay, at most ${UC_MAND_DELAY}s)"
    while [ "$t" -lt "$after" ]; do
      chunk=$((after - t)); if [ "$chunk" -gt 30 ]; then chunk=30; fi
      do_sleep "$chunk"
      t="$(now)"
      if deadline_near; then note "the upgrade height is near — not waiting any longer"; break; fi
    done
    return 0
  fi
  log "optional release $REL_VERSION: scheduled for $(fmt_time "$after") (per-host delay within ${UC_OPT_DELAY}s of first seeing it, ${remaining}s left). To install now: rougechain-update run --now"
  return 1
}

# A validator that is the designated proposer of the next block and has transactions waiting
# is about to produce a block: do not restart it right now. Bounded; skipped near the deadline.
wait_if_proposing() {
  local waited=0 own dp mine mp said=0 f="$WORK/p-stats.json"
  if [ "$IS_VALIDATOR" != 1 ] || [ "$FORCE_NOW" = 1 ] || [ "$UC_DEFER" -le 0 ]; then return 0; fi
  own="$(jq -r '.public_key_hex // ""' "$KEYS_FILE" 2> /dev/null || true)"
  [[ "$own" =~ $RE_HEX ]] || return 0
  while [ "$waited" -lt "$UC_DEFER" ]; do
    api_get "$LOCAL_API/stats" "$f" 5 || return 0
    mine="$(jq -r '.is_mining // false' "$f" 2> /dev/null || true)"
    dp="$(jval "$f" '.designated_proposer_next' "$RE_HEX" || true)"
    if [ "$mine" != "true" ] || [ "${dp,,}" != "${own,,}" ]; then break; fi
    # Pending transactions: the node's /metrics gauge. If it cannot be read, assume there are some.
    mp="$(curl --silent --fail --max-time 5 "${LOCAL_API%/api}/metrics" 2> /dev/null 9>&- | sed -n 's/^rougechain_mempool_size \([0-9]\{1,9\}\)$/\1/p' | head -n 1 || true)"
    if [ "${mp:-1}" = 0 ]; then break; fi
    if deadline_near; then note "designated proposer with pending transactions, but the upgrade height is near — not deferring"; return 0; fi
    if [ "$said" = 0 ]; then
      log "this validator is the designated proposer of the next block and has ${mp:-an unknown number of} pending transaction(s) — deferring the restart (at most ${UC_DEFER}s)"
      said=1
    fi
    do_sleep 10
    waited=$((waited + 10))
  done
  if [ "$said" = 1 ]; then
    if [ "$waited" -ge "$UC_DEFER" ]; then warn "still the designated proposer with pending transactions after ${UC_DEFER}s — restarting anyway"
    else note "no longer proposing with pending transactions (waited ${waited}s)"; fi
  fi
}

# ── auto-update: health check and rollback ───────────────────────────────────

# wait_api TIMEOUT — the node's API answers GET /api/health.
wait_api() {
  local deadline inactive=0 waited=0
  deadline=$(($(now) + $1))
  while :; do
    if api_get "$LOCAL_API/health" "$WORK/h-health.json" 3 && jq -e '.status' "$WORK/h-health.json" > /dev/null 2>&1; then return 0; fi
    if service_active; then inactive=0; else inactive=$((inactive + 1)); fi
    # The service is not running at all (crashing at start), not merely slow.
    if [ "$waited" -ge 10 ] && [ "$inactive" -ge 5 ]; then return 1; fi
    if [ "$(now)" -ge "$deadline" ]; then return 1; fi
    do_sleep 2
    waited=$((waited + 2))
  done
}

# Before touching anything: is the service running, how high is it, how far behind a reference?
snapshot_pre() {
  local f="$WORK/pre-stats.json" rf="$WORK/pre-ref.json" ref h lag
  PRE_ACTIVE=0; PRE_HEIGHT=""; PRE_LAG=""
  if service_active; then PRE_ACTIVE=1; fi
  if api_get "$LOCAL_API/stats" "$f" 5 && PRE_HEIGHT="$(jval "$f" '.network_height' "$RE_UINT")"; then
    for ref in "${REFS[@]}"; do
      api_get "$ref/stats" "$rf" 10 || continue
      [ "$(jq -r '.chain_id // ""' "$rf" 2> /dev/null || true)" = "$CHAIN_ID" ] || continue
      h="$(jval "$rf" '.network_height' "$RE_UINT")" || continue
      lag=$((h - PRE_HEIGHT)); if [ "$lag" -lt 0 ]; then lag=0; fi
      if [ -z "$PRE_LAG" ] || [ "$lag" -lt "$PRE_LAG" ]; then PRE_LAG="$lag"; fi
    done
  else
    PRE_HEIGHT=""
  fi
}

# The health check of a freshly restarted node. 0 = healthy (HEALTH_NOTE says how it was
# established), 1 = not healthy (HEALTH_MSG says why) → the caller rolls back.
#
#  1. The API answers within HEALTH_START_TIMEOUT_SECS.
#  2. /api/health and /api/stats report the chain id of the release.
#  3. /api/stats.upgrade_schedule has every activation of the manifest at the manifest's height.
#  4. Within HEALTH_DEADLINE_SECS the node agrees with a reference node at a COMPARABLE height and
#     is not behind. Comparable: the lower of the two tips, c = min(local, reference) — both nodes
#     have block c, so its hash can be compared whatever the chain is doing (an idle chain: both
#     are simply at the same height and stay there). When the tips are equal the state roots of
#     /api/stats are compared as well. Not behind: reference − local ≤ HEALTH_MAX_LAG_BLOCKS — or
#     the node was already syncing before the update and is advancing.
#     A difference must be seen twice in a row (5 s apart) to count.
#  An unreachable reference node is NOT a failure: if no reference could be compared with during
#  the whole deadline, the node passes on checks 1–3 plus "height did not go backwards", and
#  that is logged as UNVERIFIED.
health_check() {
  local f="$WORK/h-stats.json" rf="$WORK/h-ref.json" lb="$WORK/h-lblock.json" rb="$WORK/h-rblock.json"
  local cid name want got deadline L="" H LROOT RROOT c lh rh ref verdict why lag
  local matched mismatched bestlag bestref="" besth="" diff_msg="" diff_rounds=0 behind="" api_fail=0 last_l="" warned=0
  HEALTH_MSG=""; HEALTH_NOTE=""; HEALTH_UNVERIFIED=0

  if ! wait_api "$UC_START_TIMEOUT"; then
    HEALTH_MSG="the node API did not answer within ${UC_START_TIMEOUT}s of the restart"; return 1
  fi
  cid="$(jq -r '.chain_id // ""' "$WORK/h-health.json" 2> /dev/null || true)"
  if [ "$cid" != "$CHAIN_ID" ]; then
    HEALTH_MSG="the node reports chain id '${cid:0:64}' — release $REL_VERSION is for $CHAIN_ID"; return 1
  fi
  if ! api_get "$LOCAL_API/stats" "$f" 5; then HEALTH_MSG="GET /api/stats failed"; return 1; fi
  cid="$(jq -r '.chain_id // ""' "$f" 2> /dev/null || true)"
  if [ "$cid" != "$CHAIN_ID" ]; then
    HEALTH_MSG="/api/stats reports chain id '${cid:0:64}' — release $REL_VERSION is for $CHAIN_ID"; return 1
  fi
  while read -r name want; do
    case " $UNREPORTED_ACTIVATIONS " in *" $name "*) continue ;; esac
    got="$(jq -r --arg n "$name" '.upgrade_schedule[$n] | if type == "object" then .height else . end | if . == null then "missing" else tostring end' "$f" 2> /dev/null || echo unreadable)"
    if [ "$got" != "$want" ]; then
      HEALTH_MSG="upgrade schedule mismatch: the node reports $name = ${got:0:24}, the release manifest says $want"; return 1
    fi
  done < <(jq -r '.activations[] | "\(.name) \(.height)"' "$WORK/manifest.json")

  deadline=$(($(now) + UC_DEADLINE))
  while :; do
    matched=0; mismatched=0; bestlag=""
    if api_get "$LOCAL_API/stats" "$f" 5 && L="$(jval "$f" '.network_height' "$RE_UINT")"; then
      api_fail=0; last_l="$L"
      LROOT="$(jval "$f" '.state_root' "$RE_HEX" || true)"
      for ref in "${REFS[@]}"; do
        api_get "$ref/stats" "$rf" 10 || continue
        [ "$(jq -r '.chain_id // ""' "$rf" 2> /dev/null || true)" = "$CHAIN_ID" ] || continue
        H="$(jval "$rf" '.network_height' "$RE_UINT")" || continue
        RROOT="$(jval "$rf" '.state_root' "$RE_HEX" || true)"
        c="$L"; if [ "$H" -lt "$L" ]; then c="$H"; fi
        verdict=""; why=""
        if [ "$L" = "$H" ] && [ -n "$LROOT" ] && [ -n "$RROOT" ]; then
          if [ "${LROOT,,}" = "${RROOT,,}" ]; then verdict="same"
          else verdict="diff"; why="state root at height $L is ${LROOT:0:16}… here and ${RROOT:0:16}… there"; fi
        fi
        if [ "$verdict" != "diff" ] && [ "$c" -gt 0 ] \
            && api_get "$LOCAL_API/block/$c" "$lb" 10 && api_get "$ref/block/$c" "$rb" 10 \
            && lh="$(jval "$lb" '.block.hash' "$RE_HEX")" && rh="$(jval "$rb" '.block.hash' "$RE_HEX")"; then
          if [ "${lh,,}" = "${rh,,}" ]; then verdict="same"
          else verdict="diff"; why="block $c is ${lh:0:16}… here and ${rh:0:16}… there"; fi
        fi
        case "$verdict" in
          same)
            matched=1
            lag=$((H - L)); if [ "$lag" -lt 0 ]; then lag=0; fi
            if [ -z "$bestlag" ] || [ "$lag" -lt "$bestlag" ]; then bestlag="$lag"; bestref="$ref"; besth="$H"; fi ;;
          diff) mismatched=1; diff_msg="this node DIVERGED from $ref: $why" ;;
        esac
      done
    else
      api_fail=$((api_fail + 1))
      if [ "$api_fail" -ge 3 ]; then HEALTH_MSG="the node API stopped answering during the health check"; return 1; fi
    fi
    if [ "$matched" = 1 ]; then
      diff_rounds=0
      if [ "$mismatched" = 1 ] && [ "$warned" = 0 ]; then
        warn "reference nodes disagree with each other — $diff_msg — while this node agrees with $bestref"; warned=1
      fi
      if [ "$bestlag" -le "$UC_MAX_LAG" ]; then
        HEALTH_NOTE="agrees with $bestref (local height $L, reference $besth, same block and state)"; return 0
      fi
      if [ -n "$PRE_LAG" ] && [ "$PRE_LAG" -gt "$UC_MAX_LAG" ] && [ -n "$PRE_HEIGHT" ] && [ "$L" -gt "$PRE_HEIGHT" ]; then
        HEALTH_NOTE="agrees with $bestref at height $L and is syncing (it was $PRE_LAG blocks behind before the update, $bestlag now)"; return 0
      fi
      behind="local height $L, $bestref is at $besth"
    elif [ "$mismatched" = 1 ]; then
      diff_rounds=$((diff_rounds + 1))
      if [ "$diff_rounds" -ge 2 ]; then HEALTH_MSG="$diff_msg"; return 1; fi
    fi
    if [ "$(now)" -ge "$deadline" ]; then break; fi
    do_sleep 5
  done

  if [ -n "$behind" ]; then
    HEALTH_MSG="not keeping up with the network after ${UC_DEADLINE}s: $behind (allowed lag: $UC_MAX_LAG)"; return 1
  fi
  if [ "$diff_rounds" -ge 1 ]; then HEALTH_MSG="$diff_msg"; return 1; fi
  # Nothing could be compared: no reference node was reachable. That says nothing about THIS node.
  if [ -n "$last_l" ] && { [ -z "$PRE_HEIGHT" ] || [ "$last_l" -ge "$PRE_HEIGHT" ]; }; then
    HEALTH_UNVERIFIED=1
    HEALTH_NOTE="UNVERIFIED against a reference node (none could be reached for ${UC_DEADLINE}s: ${REFS[*]}); the local checks passed, height $last_l"
    return 0
  fi
  HEALTH_MSG="the node's height went backwards (${PRE_HEIGHT:-?} before the update, ${last_l:-unknown} now) and no reference node was reachable"
  return 1
}

failed_before() { case " $(state_get FAILED_VERSIONS) " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
mark_failed() { # mark_failed VERSION REASON
  if ! failed_before "$1"; then state_set FAILED_VERSIONS "$(printf '%s %s' "$(state_get FAILED_VERSIONS)" "$1" | sed 's/^ *//')"; fi
  state_set FAILED_LAST "$1 at $(fmt_time "$(now)"): $2"
}
clear_failed() {
  local v out=""
  for v in $(state_get FAILED_VERSIONS); do if [ "$v" != "$1" ]; then out="$out $v"; fi; done
  state_set FAILED_VERSIONS "${out# }"
}

finish_ok() { # finish_ok MESSAGE
  clear_failed "$REL_VERSION"
  state_set PENDING_VERSION ""; state_set PENDING_FIRST_SEEN ""; state_set PENDING_INSTALL_AFTER ""
  state_set LAST_UPDATE "$(now)"
  state_set LAST_UPDATE_RESULT "$INSTALLED_VERSION -> $REL_VERSION: $1"
  state_set LAST_RESULT "updated to $REL_VERSION"
  log "UPDATE OK: release $REL_VERSION is installed (was $INSTALLED_VERSION) — $1"
}

# Put the previous release back, say so loudly, remember the release so it is not tried again.
fail_and_roll_back() { # fail_and_roll_back REASON RESTART(0|1)
  local reason="$1" code="$EXIT_ROLLED_BACK" outcome
  warn "UPDATE FAILED: release $REL_VERSION — $reason"
  warn "ROLLING BACK to release $INSTALLED_VERSION (the failed files are kept as *.failed)"
  if undo_swap; then
    outcome="rolled back to $INSTALLED_VERSION"
  else
    code="$EXIT_ROLLBACK_FAILED"
    outcome="THE ROLLBACK TO $INSTALLED_VERSION IS INCOMPLETE — check $BIN_PATH against $BIN_PATH.prev and $CONF_DIR/manifest.json"
  fi
  if [ "$2" = 1 ]; then
    sysctl restart "$SERVICE" || warn "systemctl restart $SERVICE reported an error"
    if wait_api "$UC_START_TIMEOUT"; then
      outcome="$outcome; the node is answering again"
    else
      code="$EXIT_ROLLBACK_FAILED"
      outcome="$outcome, BUT THE NODE IS NOT ANSWERING — it needs attention now (journalctl -u $SERVICE -n 100)"
    fi
  fi
  mark_failed "$REL_VERSION" "$reason"
  state_set PENDING_VERSION ""; state_set PENDING_FIRST_SEEN ""; state_set PENDING_INSTALL_AFTER ""
  state_set LAST_UPDATE "$(now)"
  state_set LAST_UPDATE_RESULT "$INSTALLED_VERSION -> $REL_VERSION FAILED: $reason; $outcome"
  state_set LAST_RESULT "release $REL_VERSION failed and was rolled back"
  warn "ROLLBACK: $outcome."
  warn "Release $REL_VERSION will NOT be tried again on this node (a newer release will). After fixing the cause: rougechain-update run$CLI_NET_ARG --retry-failed"
  exit "$code"
}

apply_update() {
  snapshot_pre
  wait_if_proposing
  log "installing release $REL_VERSION (installed: $INSTALLED_VERSION)"
  if ! swap_in_files; then
    fail_and_roll_back "$SWAP_ERR" 0
  fi
  if [ "$BIN_CHANGED" != 1 ]; then
    finish_ok "the node binary is unchanged, no restart was needed"
    return 0
  fi
  if [ "$PRE_ACTIVE" != 1 ]; then
    finish_ok "$SERVICE was not running and was not started (no health check)"
    return 0
  fi
  log "restarting $SERVICE"
  sysctl restart "$SERVICE" || warn "systemctl restart $SERVICE reported an error"
  log "health check (API within ${UC_START_TIMEOUT}s; chain id; upgrade schedule; in step with ${REFS[*]} within ${UC_DEADLINE}s)"
  if health_check; then
    if [ "$HEALTH_UNVERIFIED" = 1 ]; then warn "health check: $HEALTH_NOTE"; fi
    finish_ok "healthy: $HEALTH_NOTE"
  else
    fail_and_roll_back "health check: $HEALTH_MSG" 1
  fi
}

# The updater replaces ITSELF only with the script named in a signed manifest it is about to
# install, never with an older one, and then starts again as that script.
maybe_self_update() {
  local args=()
  [ "$HAS_INSTALLER" = 1 ] || return 0
  download_installer
  if [ "$INS_CURRENT" = 1 ]; then return 0; fi
  if ver_lt "$NEW_INS_VERSION" "$INSTALLER_VERSION"; then
    note "release $REL_VERSION names updater v$NEW_INS_VERSION, older than this one (v$INSTALLER_VERSION) — keeping this one"
    return 0
  fi
  if [ -n "${ROUGECHAIN_UPDATER_REEXEC:-}" ]; then
    warn "the updater was already replaced once in this run — continuing as v$INSTALLER_VERSION"
    return 0
  fi
  install_updater_program "$WORK/installer.sh" "signed release $REL_VERSION"
  log "the updater was replaced by the one in the signed release (v$INSTALLER_VERSION -> v$NEW_INS_VERSION); continuing with it"
  if [ "$FORCE_NOW" = 1 ]; then args+=(--now); fi
  if [ "$RETRY_FAILED" = 1 ]; then args+=(--retry-failed); fi
  cleanup
  WORK=""
  exec 9>&-
  ROUGECHAIN_UPDATER_REEXEC=1 exec /bin/bash "$UPDATER_PATH" updater run --network "$NETWORK" "${args[@]}"
}

# ── auto-update: commands ────────────────────────────────────────────────────

cmd_status() {
  local inst="none (no install record)" upd="not installed" timer="not installed" next="" v pin after
  load_update_conf 2> /dev/null
  if [ -f "$CONF_DIR/manifest.json" ]; then inst="$(jq -r '.version // "unknown"' "$CONF_DIR/manifest.json" 2> /dev/null || echo unknown)"; fi
  if [ -f "$UPDATER_PATH" ]; then upd="v$(script_version "$UPDATER_PATH")  ($UPDATER_PATH; from: $(state_get UPDATER_SOURCE unknown))"; fi
  if [ -f "$UPD_TIMER_FILE" ]; then
    timer="installed"
    if have_systemd; then
      timer="$(sysctl is-enabled "$UPD_SERVICE.timer" 2> /dev/null || true)"; timer="${timer:-unknown}"
      next="$(sysctl show "$UPD_SERVICE.timer" --property=NextElapseUSecRealtime --value 2> /dev/null || true)"
    else
      timer="installed (systemd is not running here)"
    fi
  fi
  pin="${UC_PIN:-none}"
  echo "RougeChain auto-update — $NETWORK"
  printf '  %-18s %s\n' "mode" "$UC_MODE   ($UPD_CONF$([ -f "$UPD_CONF" ] || printf ' — not present, defaults'))"
  printf '  %-18s %s\n' "pinned version" "$pin"
  printf '  %-18s %s\n' "installed release" "$inst"
  v="$(state_get LATEST_SEEN)"
  printf '  %-18s %s\n' "latest seen" "${v:-nothing yet}$([ -n "$v" ] && [ "$(state_get LATEST_SEEN_MANDATORY)" = "true" ] && printf ' (mandatory, before block %s)' "$(state_get LATEST_SEEN_BEFORE)")"
  v="$(state_get PENDING_VERSION)"; after="$(state_get PENDING_INSTALL_AFTER)"
  if [ -n "$v" ]; then printf '  %-18s %s\n' "pending" "$v — not before $(fmt_time "$after")"; fi
  printf '  %-18s %s\n' "last check" "$(fmt_time "$(state_get LAST_CHECK)")"
  printf '  %-18s %s\n' "last result" "$(state_get LAST_RESULT "none")"
  printf '  %-18s %s\n' "last update" "$(fmt_time "$(state_get LAST_UPDATE)")$(v="$(state_get LAST_UPDATE_RESULT)"; [ -n "$v" ] && printf ' — %s' "$v")"
  v="$(state_get FAILED_VERSIONS)"
  printf '  %-18s %s\n' "failed releases" "${v:-none}$([ -n "$v" ] && printf ' (not retried; last: %s)' "$(state_get FAILED_LAST)")"
  printf '  %-18s %s\n' "timer" "$UPD_SERVICE.timer: $timer"
  printf '  %-18s %s\n' "next check" "${next:-unknown}"
  printf '  %-18s %s\n' "updater" "$upd"
  echo "  log: journalctl -t rougechain-update     run now: sudo rougechain-update run$CLI_NET_ARG --now"
}

updater_main() {
  local newest pick i v re_ver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  network_defaults
  if [ "$ACTION" = "status" ]; then cmd_status; return 0; fi
  LOG_PREFIX="rougechain-update[$NETWORK]: "
  C_HEAD=""; C_WARN=""; C_ERR=""; C_OFF=""
  [ "$(id -u)" -eq 0 ] || die "run as root: sudo rougechain-update $ACTION"
  select_release_key
  ensure_deps
  install -d -m 0755 -o root -g root "$UPDATER_STATE_ROOT" "$UPD_STATE_DIR"
  STATE_READY=1
  if ! acquire_lock; then
    log "another install or update is running for $NETWORK (lock: $LOCK_FILE) — nothing done"
    return 0
  fi
  load_update_conf
  if [ "$ACTION" = "run" ] && [ "$UC_MODE" = "off" ]; then
    log "auto-update is off (MODE=off in $UPD_CONF) — nothing done"
    state_set LAST_RESULT "off (MODE=off)"
    return 0
  fi
  load_node_from_unit
  [ -f "$CONF_DIR/manifest.json" ] || die "no install record ($CONF_DIR/manifest.json) — run the installer once; the updater only upgrades an existing install"
  INSTALLED_VERSION="$(jq -r '.version // ""' "$CONF_DIR/manifest.json" 2> /dev/null || true)"
  [[ "$INSTALLED_VERSION" =~ $re_ver ]] || die "the install record $CONF_DIR/manifest.json has no valid version"
  RELEASE_BASE_URLS="${UC_BASES:-$DEFAULT_BASE_URLS}"
  NO_START=0

  WORK="$(mktemp -d)"
  trap on_exit EXIT
  write_release_key
  log "v$INSTALLER_VERSION $ACTION — installed release $INSTALLED_VERSION, MODE=$UC_MODE${UC_PIN:+, pinned to $UC_PIN}"
  state_set LAST_CHECK "$(now)"
  collect_candidates
  if [ ${#CAND_DIRS[@]} -eq 0 ]; then
    if [ "$N_SIG_FAIL" -gt 0 ]; then
      die "NO source served a validly signed release manifest ($N_SIG_FAIL failed the signature check) — nothing was changed. If this repeats, report it: https://github.com/cyberdreadx/rougechain-node/security"
    fi
    die "no release source could be reached — nothing was changed; the next run tries again"
  fi
  newest="$(newest_candidate)"
  state_set LATEST_SEEN "${CAND_VERSIONS[$newest]}"
  state_set LATEST_SEEN_MANDATORY "$(jq -r '.mandatory' "${CAND_DIRS[$newest]}/manifest.json")"
  state_set LATEST_SEEN_BEFORE "$(jq -r '.upgrade_before_height // "n/a"' "${CAND_DIRS[$newest]}/manifest.json")"
  for i in "${!CAND_VERSIONS[@]}"; do
    v="${CAND_VERSIONS[$i]}"
    if [ "$v" = "$INSTALLED_VERSION" ]; then
      note "${CAND_SOURCES[$i]}: release $v — the installed release"
    elif ver_lt "$v" "$INSTALLED_VERSION"; then
      warn "${CAND_SOURCES[$i]} serves release $v, OLDER than the installed $INSTALLED_VERSION (a stale mirror, or a replayed old manifest) — ignored"
    else
      note "${CAND_SOURCES[$i]}: release $v"
    fi
  done

  pick="$newest"
  if [ -n "$UC_PIN" ]; then
    pick=-1
    for i in "${!CAND_VERSIONS[@]}"; do
      if [ "$pick" = -1 ] && [ "${CAND_VERSIONS[$i]}" = "$UC_PIN" ]; then pick="$i"; fi
    done
    if ver_lt "$INSTALLED_VERSION" "${CAND_VERSIONS[$newest]}" && [ "${CAND_VERSIONS[$newest]}" != "$UC_PIN" ]; then
      warn "PIN_VERSION=$UC_PIN: release ${CAND_VERSIONS[$newest]} is available and will NOT be installed$([ "$(state_get LATEST_SEEN_MANDATORY)" = "true" ] && printf ' — it is MANDATORY (before block %s)' "$(state_get LATEST_SEEN_BEFORE)")"
    fi
    if [ "$pick" = -1 ] || ! ver_lt "$INSTALLED_VERSION" "$UC_PIN"; then
      log "pinned to $UC_PIN (installed: $INSTALLED_VERSION) — nothing to install"
      state_set LAST_RESULT "pinned to $UC_PIN; newest seen ${CAND_VERSIONS[$newest]}"
      return 0
    fi
  fi
  if ! ver_lt "$INSTALLED_VERSION" "${CAND_VERSIONS[$pick]}"; then
    log "up to date: release $INSTALLED_VERSION is installed, the newest signed release is ${CAND_VERSIONS[$newest]}"
    state_set LAST_RESULT "up to date ($INSTALLED_VERSION)"
    if [ -n "$(state_get PENDING_VERSION)" ]; then   # e.g. installed by hand in the meantime
      state_set PENDING_VERSION ""; state_set PENDING_FIRST_SEEN ""; state_set PENDING_INSTALL_AFTER ""
    fi
    return 0
  fi

  use_candidate "$pick"
  validate_manifest
  if failed_before "$REL_VERSION" && [ "$RETRY_FAILED" != 1 ]; then
    warn "release $REL_VERSION FAILED on this node before and was rolled back (${ACTION}: $(state_get FAILED_LAST)). It is not tried again; a newer release will be. After fixing the cause: rougechain-update run$CLI_NET_ARG --retry-failed"
    if [ "$REL_MANDATORY" = "true" ]; then warn "release $REL_VERSION is MANDATORY (before block $REL_BEFORE): this node will fall off the network at that height unless it is upgraded"; fi
    state_set LAST_RESULT "release $REL_VERSION failed earlier and is not retried"
    return 0
  fi
  if [ "$ACTION" = "check" ] || [ "$UC_MODE" = "notify" ]; then
    log "UPDATE AVAILABLE: release $REL_VERSION (installed: $INSTALLED_VERSION)$([ "$REL_MANDATORY" = "true" ] && printf ' — MANDATORY, install before block %s' "$REL_BEFORE"). Not installed ($([ "$ACTION" = "check" ] && printf 'check only' || printf 'MODE=notify')). To install: rougechain-update run$CLI_NET_ARG --now"
    state_set LAST_RESULT "available: $REL_VERSION (not installed: $([ "$ACTION" = "check" ] && printf 'check only' || printf 'MODE=notify'))"
    return 0
  fi
  if ! wait_for_window; then
    state_set LAST_RESULT "release $REL_VERSION scheduled, not before $(fmt_time "$(state_get PENDING_INSTALL_AFTER)")"
    return 0
  fi
  maybe_self_update
  if ver_lt "$INSTALLER_VERSION" "$MIN_INSTALLER"; then
    die "release $REL_VERSION needs updater v$MIN_INSTALLER or newer; this is v$INSTALLER_VERSION and the release's manifest offers no newer one. Re-run the installer once: https://docs.rougechain.io/running-a-node/auto-update.html"
  fi
  # A release that changes the genesis file is a different chain: never done unattended.
  if [ "$HAS_GENESIS" = 1 ]; then
    if [ ! -f "$CONF_DIR/genesis.json" ] || [ "$(file_sha256 "$CONF_DIR/genesis.json")" != "$GEN_SHA" ]; then
      die "release $REL_VERSION comes with a genesis file different from the installed one — the updater does not change a node's genesis. Read the release notes${REL_NOTES:+ ($REL_NOTES)} and upgrade by hand."
    fi
  fi
  download_release
  apply_update
}

main() {
  umask 022
  parse_args "$@"
  if [ "$ACTION" != "install" ]; then
    updater_main
    exit 0
  fi
  load_config
  check_platform
  select_release_key
  if [ "$DRY_RUN" != 1 ] && [ "$(id -u)" -ne 0 ]; then
    die "run as root: curl -sSL <installer url> | sudo bash   (use --dry-run to only check the release)"
  fi
  ensure_deps
  if [ "$DRY_RUN" != 1 ] && ! acquire_lock; then
    die "another install or update is running for $NETWORK (lock: $LOCK_FILE) — try again when it has finished"
  fi
  WORK="$(mktemp -d)"
  trap on_exit EXIT
  write_release_key
  log "RougeChain installer v$INSTALLER_VERSION — $NETWORK on $OS_LABEL"
  fetch_manifest
  validate_manifest
  check_existing_install
  print_plan
  download_release
  if [ "$DRY_RUN" = 1 ]; then
    echo
    log "dry run: the release verified and all files matched the signed manifest. Nothing was changed."
    exit 0
  fi
  setup_user_and_dirs
  install_files
  ensure_node_keys
  install_unit
  start_service
  install_updater
  print_next_steps
}

main "$@"
