#!/usr/bin/env bash
#
# RougeChain node / validator installer — signed releases.
#
#   curl -sSL https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/scripts/install-validator.sh | sudo bash
#
# What it does
#   1. Downloads the release manifest for the chosen network and its detached Ed25519
#      signature, and verifies the signature with OpenSSL against the release public key
#      EMBEDDED in this script (never a downloaded key). Nothing is installed unless it verifies.
#   2. Downloads the node binary, the `rougechain` CLI and the genesis file named in that
#      signed manifest (primary URL, then mirrors) and checks size + sha256 against it.
#   3. Creates a dedicated system user, installs the binary, writes a hardened systemd unit
#      and starts the node. It generates the node identity (node-keys.json, mode 0600) only
#      if none exists; existing keys and chain data are never overwritten.
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
#   NO_START     1 = install only; do not start or restart the service
#   ALLOW_DOWNGRADE  1 = allow installing a release older than the one already installed
#   REPLACE_LEGACY_UNIT  1 = replace a systemd unit that this installer did not write
#   RELEASE_BASE_URLS  space-separated bases serving manifest-<network>.json (+ .ed25519.sig),
#                      tried in order (default: api.rougechain.io, then the GitHub mirror)
# Options
#   --dry-run    fetch + verify the release and print what would be done; change nothing
#   --help       show this text
#
# Supported: Ubuntu 22.04 / 24.04 and Debian 12 on x86_64, with systemd.
# Docs: https://docs.rougechain.io/running-a-node/releases.html
#
set -euo pipefail

INSTALLER_VERSION="2.0.0"

# Ed25519 release public key: the raw 32-byte key, base64. Every release manifest must carry a
# valid signature by this key. Written by scripts/release/embed-installer-key.mjs from
# releases/keys/release-ed25519.pub.pem. While it is the placeholder, the installer refuses to run.
RELEASE_ED25519_PUBKEY_B64="PLACEHOLDER_RELEASE_KEY_NOT_PROVISIONED"
readonly RELEASE_KEY_PLACEHOLDER="PLACEHOLDER_RELEASE_KEY_NOT_PROVISIONED"

readonly UNIT_MARKER="# Managed by RougeChain install-validator.sh"
readonly RUN_USER="rougechain"
readonly STATE_ROOT="/var/lib/rougechain"
readonly CONF_ROOT="/etc/rougechain"
readonly DEFAULT_BASE_URLS="https://api.rougechain.io/releases https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/releases"
readonly MAX_MANIFEST_BYTES=262144

DRY_RUN=0
TEST_MODE=0
WORK=""

if [ -t 1 ]; then
  C_HEAD=$'\033[1;35m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_HEAD=""; C_WARN=""; C_ERR=""; C_OFF=""
fi
log()  { printf '%s==>%s %s\n' "$C_HEAD" "$C_OFF" "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '%s[!]%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '%s[x]%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

cleanup() { if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf -- "$WORK"; fi; }

usage() {
  if [ -r "${BASH_SOURCE[0]:-}" ]; then
    sed -n '/^# RougeChain node/,/^# Docs:/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

load_config() {
  NETWORK="${NETWORK:-mainnet}"
  case "$NETWORK" in
    mainnet)
      CHAIN_ID="rougechain-mainnet-1"
      DEF_PEERS="https://api.rougechain.io/api"; DEF_API_PORT=5100; DEF_P2P_PORT=4100
      SERVICE="rougechain-validator"; BIN_PATH="/usr/local/bin/quantum-vault-daemon"
      CLI_PATH="/usr/local/bin/rougechain"; CLI_RPC="https://api.rougechain.io" ;;
    testnet)
      CHAIN_ID="rougechain-devnet-1"
      DEF_PEERS="https://testnet.rougechain.io/api"; DEF_API_PORT=5101; DEF_P2P_PORT=4101
      SERVICE="rougechain-validator-testnet"; BIN_PATH="/usr/local/bin/quantum-vault-daemon-testnet"
      CLI_PATH="/usr/local/bin/rougechain-testnet"; CLI_RPC="https://testnet.rougechain.io" ;;
    *) die "NETWORK must be 'mainnet' or 'testnet' (got '$NETWORK')" ;;
  esac
  PEERS="${PEERS:-$DEF_PEERS}"
  API_PORT="${API_PORT:-$DEF_API_PORT}"
  P2P_PORT="${P2P_PORT:-$DEF_P2P_PORT}"
  HOST="${HOST:-127.0.0.1}"
  DATA_DIR="${DATA_DIR:-$STATE_ROOT/$NETWORK}"
  CONF_DIR="$CONF_ROOT/$NETWORK"
  PUBLIC_URL="${PUBLIC_URL:-}"
  VALIDATOR="${VALIDATOR:-0}"
  NO_START="${NO_START:-0}"
  ALLOW_DOWNGRADE="${ALLOW_DOWNGRADE:-0}"
  REPLACE_LEGACY_UNIT="${REPLACE_LEGACY_UNIT:-0}"
  RELEASE_BASE_URLS="${RELEASE_BASE_URLS:-$DEFAULT_BASE_URLS}"
  UNIT_FILE="/etc/systemd/system/$SERVICE.service"
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
select_release_key() {
  local test_flag="${ROUGECHAIN_INSTALLER_TEST:-}" test_key="${ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE:-}"
  if [ -n "$test_flag" ] || [ -n "$test_key" ]; then
    if [ "$test_flag" != "1" ] || [ -z "$test_key" ]; then
      die "test override needs BOTH ROUGECHAIN_INSTALLER_TEST=1 and ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=<pem file>. Unset both for a real install."
    fi
    [ -r "$test_key" ] || die "ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE: cannot read $test_key"
    TEST_MODE=1
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
}

ensure_deps() {
  local missing=() c
  for c in curl openssl jq sha256sum base64 stat install runuser useradd; do
    command -v "$c" > /dev/null 2>&1 || missing+=("$c")
  done
  [ -e /etc/ssl/certs/ca-certificates.crt ] || missing+=("ca-certificates")
  [ ${#missing[@]} -eq 0 ] && return 0
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
  for c in curl openssl jq sha256sum base64 stat install runuser useradd; do
    command -v "$c" > /dev/null 2>&1 || die "'$c' is still missing after installing packages"
  done
}

fetch_manifest() {
  local base name="manifest-$NETWORK.json" m="$WORK/manifest.candidate" s="$WORK/manifest.candidate.sig" re_base='^https?://[^[:space:]]+$'
  log "fetching the signed release manifest ($NETWORK)"
  for base in $RELEASE_BASE_URLS; do
    [[ "$base" =~ $re_base ]] || die "RELEASE_BASE_URLS: '$base' is not a URL"
    base="${base%/}"
    rm -f -- "$m" "$s"
    if ! fetch "$base/$name" "$m" "$MAX_MANIFEST_BYTES"; then
      warn "could not fetch $base/$name — trying the next source"
      continue
    fi
    if ! fetch "$base/$name.ed25519.sig" "$s" 4096; then
      warn "could not fetch the signature $base/$name.ed25519.sig — trying the next source"
      continue
    fi
    if verify_ed25519 "$m" "$s"; then
      mv -f -- "$m" "$WORK/manifest.json"
      mv -f -- "$s" "$WORK/manifest.json.ed25519.sig"
      MANIFEST_SOURCE="$base/$name"
      note "signature OK (Ed25519 release key $RELEASE_KEY_FPR)"
      note "source: $MANIFEST_SOURCE"
      return 0
    fi
    warn "SIGNATURE CHECK FAILED for $base/$name — this manifest was NOT signed by the release key and is ignored"
  done
  die "no release manifest with a valid signature could be obtained — nothing was installed. If a source reported a failed signature check, do not retry blindly: report it (https://github.com/cyberdreadx/rougechain-node/security)."
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
  if ver_lt "$INSTALLER_VERSION" "$MIN_INSTALLER"; then
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
  REL_MANDATORY="$(jq -r '.mandatory' "$WORK/manifest.json")"
  REL_BEFORE="$(jq -r '.upgrade_before_height // "n/a"' "$WORK/manifest.json")"
  REL_NOTES="$(jq -r '.notes_url // ""' "$WORK/manifest.json")"
  log "release $REL_VERSION ($(mf '.released')), source commit $(mf '.source_commit')"
  note "binary  $BIN_NAME"
  note "sha256  $BIN_SHA"
  if [ "$HAS_CLI" = 1 ]; then note "cli     $CLI_NAME  sha256 $CLI_SHA"; fi
  if [ "$REL_MANDATORY" = "true" ]; then note "MANDATORY upgrade — install before block $REL_BEFORE"; fi
  jq -r '.activations[] | "    activation  \(.height)  \(.name)"' "$WORK/manifest.json"
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

install_files() {
  BIN_CHANGED=0
  if [ "$BIN_CURRENT" = 0 ]; then
    if [ -f "$BIN_PATH" ]; then
      cp -p -- "$BIN_PATH" "$BIN_PATH.prev"
      note "previous binary kept as $BIN_PATH.prev"
    fi
    install -m 0755 -o root -g root "$NEW_BIN" "$BIN_PATH.new"
    mv -f -- "$BIN_PATH.new" "$BIN_PATH"
    BIN_CHANGED=1
    log "installed $BIN_PATH (release $REL_VERSION)"
    # Catch a binary that cannot run here (e.g. a missing shared library) before the service does.
    if ! runuser -u "$RUN_USER" -- "$BIN_PATH" --version > "$WORK/version.log" 2>&1; then
      sed 's/^/      /' "$WORK/version.log" >&2
      die "the installed binary does not run on this system (see above). The previous binary, if any, is $BIN_PATH.prev."
    fi
  fi
  if [ "$HAS_CLI" = 1 ] && [ "$CLI_CURRENT" = 0 ]; then
    if [ -f "$CLI_PATH" ]; then
      cp -p -- "$CLI_PATH" "$CLI_PATH.prev"
      note "previous CLI kept as $CLI_PATH.prev"
    fi
    install -m 0755 -o root -g root "$NEW_CLI" "$CLI_PATH.new"
    mv -f -- "$CLI_PATH.new" "$CLI_PATH"
    if ! runuser -u "$RUN_USER" -- "$CLI_PATH" --version > "$WORK/version.log" 2>&1; then
      sed 's/^/      /' "$WORK/version.log" >&2
      die "the installed rougechain CLI does not run on this system (see above). The previous CLI, if any, is $CLI_PATH.prev."
    fi
    log "installed $CLI_PATH (rougechain CLI, release $REL_VERSION)"
  fi
  if [ "$HAS_GENESIS" = 1 ] && [ "$GEN_CURRENT" = 0 ]; then
    if [ -f "$CONF_DIR/genesis.json" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
      die "the release's genesis file differs from $CONF_DIR/genesis.json and $DATA_DIR already holds data. A genesis change means a different chain — refusing to replace it."
    fi
    install -m 0644 -o root -g root "$WORK/genesis.json" "$CONF_DIR/genesis.json"
  fi
  # Keep the verified manifest + signature: the record of what is installed (and the downgrade guard).
  install -m 0644 -o root -g root "$WORK/manifest.json" "$CONF_DIR/manifest.json"
  install -m 0644 -o root -g root "$WORK/manifest.json.ed25519.sig" "$CONF_DIR/manifest.json.ed25519.sig"
}

service_active() {
  [ -d /run/systemd/system ] && systemctl is-active --quiet "$SERVICE" 2>/dev/null
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
  systemctl daemon-reload
  if [ "$NO_START" = 1 ]; then
    if service_active && { [ "$BIN_CHANGED" = 1 ] || [ "$UNIT_CHANGED" = 1 ]; }; then
      warn "NO_START=1: the running service still uses the OLD binary/unit. Restart it when ready: systemctl restart $SERVICE"
    fi
    return 0
  fi
  systemctl enable "$SERVICE" > /dev/null 2>&1 || warn "could not enable $SERVICE at boot"
  if service_active; then
    if [ "$BIN_CHANGED" = 1 ] || [ "$UNIT_CHANGED" = 1 ]; then
      log "restarting $SERVICE"
      systemctl restart "$SERVICE"
    else
      log "$SERVICE is running and already up to date — not restarted"
    fi
  else
    log "starting $SERVICE"
    systemctl start "$SERVICE"
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
  # --rpc is always given: the CLI signs with the node key and talks to the network's public API.
  cli="$cli_name --rpc $CLI_RPC --node-keys $KEYS_FILE"
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
       rougechain --rpc $CLI_RPC --node-keys $KEYS_FILE whoami     # your validator address
       rougechain --rpc $CLI_RPC --node-keys $KEYS_FILE stake 10000
       rougechain --rpc $CLI_RPC --node-keys $KEYS_FILE validator-status
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

  Upgrades: re-run this installer. It verifies the new signed release and keeps the old binaries
  as $BIN_PATH.prev (and $CLI_PATH.prev). Your keys and data are not touched.
STEPS
  if [ -z "$PUBLIC_URL" ] && [ "$VALIDATOR" = 1 ]; then
    warn "VALIDATOR=1 without PUBLIC_URL: peers cannot reach this node, so its votes and blocks will not propagate."
  fi
  if [ "$HOST" != "127.0.0.1" ]; then
    warn "the API is bound to $HOST. Do not expose port $API_PORT to the internet directly — put a TLS reverse proxy in front."
  fi
}

main() {
  parse_args "$@"
  load_config
  check_platform
  select_release_key
  if [ "$DRY_RUN" != 1 ] && [ "$(id -u)" -ne 0 ]; then
    die "run as root: curl -sSL <installer url> | sudo bash   (use --dry-run to only check the release)"
  fi
  ensure_deps
  WORK="$(mktemp -d)"
  trap cleanup EXIT
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
  print_next_steps
}

main "$@"
