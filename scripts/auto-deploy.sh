#!/bin/bash
# RougeChain Daemon Auto-Deploy Script
# Checks for new commits on main, pulls, builds, and restarts the service.
# Run via cron every 2 minutes: */2 * * * * /path/to/auto-deploy.sh >> /var/log/rougechain-deploy.log 2>&1

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
REPO_DIR="${ROUGECHAIN_REPO:-/opt/quantum-vault}"
BRANCH="${ROUGECHAIN_BRANCH:-main}"
SERVICE_NAME="${ROUGECHAIN_SERVICE:-rougechain}"
LOCK_FILE="/tmp/rougechain-deploy.lock"
LOG_PREFIX="[deploy $(date '+%Y-%m-%d %H:%M:%S')]"
# ────────────────────────────────────────────────────────────────────────────

# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
    pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "$LOG_PREFIX Already running (PID $pid), skipping."
        exit 0
    fi
    rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap "rm -f $LOCK_FILE" EXIT

cd "$REPO_DIR"

# Fetch latest without merging
git fetch origin "$BRANCH" --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
    # No new commits
    exit 0
fi

echo "$LOG_PREFIX New commits detected: $LOCAL -> $REMOTE"
echo "$LOG_PREFIX Pulling changes..."
git pull origin "$BRANCH" --quiet

echo "$LOG_PREFIX Building daemon..."
cd core
cargo build --release -p quantum-vault-daemon 2>&1

echo "$LOG_PREFIX Restarting service..."
sudo systemctl restart "$SERVICE_NAME"

# Wait for service to come up
sleep 3
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "$LOG_PREFIX ✅ Deploy complete. Service is running."
    echo "$LOG_PREFIX Commit: $(git rev-parse --short HEAD) - $(git log -1 --pretty=%s)"
else
    echo "$LOG_PREFIX ❌ Service failed to start after deploy!"
    sudo systemctl status "$SERVICE_NAME" --no-pager -l
    exit 1
fi
