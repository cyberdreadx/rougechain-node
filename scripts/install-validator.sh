#!/usr/bin/env bash
#
# RougeChain validator — one-command installer.
#
#   curl -sSL https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/scripts/install-validator.sh | bash
#
# Installs deps, builds the daemon + CLI, sets up a systemd service that syncs
# and (once you stake) produces blocks, and prints the exact fund/stake steps.
# Idempotent — safe to re-run (it upgrades in place). Override anything via env:
#
#   NODE_NAME=my-validator PUBLIC_URL=https://node.example.com \
#     bash install-validator.sh                       # mainnet, reachable
#   CHAIN_ID=rougechain-devnet-1 PEERS=https://testnet.rougechain.io/api \
#     API_PORT=5101 P2P_PORT=4101 DATA_DIR=~/.quantum-vault/testnet \
#     GENESIS_FILE=genesis-devnet.json bash install-validator.sh   # testnet
#
set -euo pipefail

# ── config (env-overridable) ────────────────────────────────────────────────
REPO="${REPO:-https://github.com/cyberdreadx/rougechain-node.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/rougechain}"
CHAIN_ID="${CHAIN_ID:-rougechain-mainnet-1}"
PEERS="${PEERS:-https://api.rougechain.io/api}"
GENESIS_FILE="${GENESIS_FILE:-genesis-mainnet.json}"
DATA_DIR="${DATA_DIR:-$HOME/.quantum-vault/mainnet}"
API_PORT="${API_PORT:-5100}"
P2P_PORT="${P2P_PORT:-4100}"
NODE_NAME="${NODE_NAME:-$(hostname 2>/dev/null || echo node)-validator}"
PUBLIC_URL="${PUBLIC_URL:-}"          # e.g. https://node.example.com — needed so peers can reach you
SERVICE="${SERVICE:-rougechain-validator}"
MIN_STAKE="${MIN_STAKE:-10000}"

log()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

log "RougeChain validator installer — chain=$CHAIN_ID node=$NODE_NAME"

# ── 1. dependencies ─────────────────────────────────────────────────────────
if command -v apt-get >/dev/null 2>&1; then
  log "installing build dependencies (apt)…"
  $SUDO apt-get update -y -qq
  $SUDO apt-get install -y -qq git curl build-essential protobuf-compiler libssl-dev pkg-config
else
  warn "non-apt system — ensure git, a C toolchain, protobuf-compiler, libssl-dev and pkg-config are installed."
fi
if ! command -v cargo >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  log "installing Rust toolchain…"
  curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
fi
export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null 2>&1 || die "cargo not found after install — open a new shell and re-run."

# ── 2. fetch + build ────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  log "updating existing checkout at $INSTALL_DIR…"
  git -C "$INSTALL_DIR" pull --ff-only || warn "could not fast-forward; using existing checkout"
else
  log "cloning $REPO → $INSTALL_DIR…"
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR/core"
log "building daemon + CLI (this can take 10–30 min on a small VPS — grab a coffee)…"
cargo build --release -p quantum-vault-daemon
cargo build --release -p quantum-vault-cli 2>/dev/null || cargo build --release --bin rougechain 2>/dev/null || warn "CLI build skipped (you can stake from the web wallet instead)"
BIN="$INSTALL_DIR/core/target/release/quantum-vault-daemon"
CLI="$INSTALL_DIR/core/target/release/rougechain"
[ -x "$BIN" ] || die "daemon binary not found at $BIN"
GENESIS="$INSTALL_DIR/core/daemon/$GENESIS_FILE"
[ -f "$GENESIS" ] || die "genesis file not found: $GENESIS"
mkdir -p "$DATA_DIR"

# ── 3. systemd service (syncs now; produces blocks once you stake) ───────────
# --mine is safe before staking: an unstaked node is never selected as proposer,
# so it simply syncs until you stake, then starts producing automatically.
PUBLIC_FLAG=""; [ -n "$PUBLIC_URL" ] && PUBLIC_FLAG="  --public-url $PUBLIC_URL \\"
if command -v systemctl >/dev/null 2>&1; then
  log "installing systemd service '$SERVICE'…"
  $SUDO tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<UNIT
[Unit]
Description=RougeChain validator ($CHAIN_ID)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
ExecStart=$BIN \\
  --mine \\
  --genesis $GENESIS \\
  --chain-id $CHAIN_ID \\
  --peers $PEERS \\
  --data-dir $DATA_DIR \\
  --host 127.0.0.1 --api-port $API_PORT --port $P2P_PORT \\
  --node-name $NODE_NAME \\
$PUBLIC_FLAG
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now "$SERVICE"
  log "service started — it's syncing now."
else
  warn "no systemd — run the daemon yourself:"
  echo "  $BIN --mine --genesis $GENESIS --chain-id $CHAIN_ID --peers $PEERS --data-dir $DATA_DIR --host 127.0.0.1 --api-port $API_PORT --port $P2P_PORT --node-name $NODE_NAME ${PUBLIC_URL:+--public-url $PUBLIC_URL}"
fi

# ── 4. next steps ───────────────────────────────────────────────────────────
KEYS="$DATA_DIR/node-keys.json"
echo
log "Installed. Your node is syncing. To become a validator:"
cat <<STEPS

  1) Back up your validator key (this IS your identity — losing it loses the stake):
       $KEYS

  2) Find your validator address:
       ${CLI:+$CLI --node-keys $KEYS whoami}
       (or open the wallet on rougechain.io — same key if you imported it)

  3) Fund it with >= $MIN_STAKE XRGE (+ ~0.1 fee), then stake:
       ${CLI:+$CLI --node-keys $KEYS stake $MIN_STAKE}
       (or stake from the web wallet)

  4) Confirm you're live:
       ${CLI:+$CLI --node-keys $KEYS validator-status}
     You want  ✓ Staked  and  ✓ In active set  — then blocks start automatically.

  Logs:    journalctl -u $SERVICE -f
  Upgrade: re-run this installer (or scripts/update-node.sh)
$([ -z "$PUBLIC_URL" ] && echo "
  NOTE: no PUBLIC_URL set. Your blocks won't propagate until peers can reach you.
  Re-run with PUBLIC_URL=https://your-domain (and open port $P2P_PORT) once you have one.")
STEPS
