#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/srv/rougechain"
CORE_DIR="$REPO_DIR/core"
PM2_NAME="rougechain-node"
BINARY="$CORE_DIR/target/release/quantum-vault-daemon"
KILL_TIMEOUT=10000

NODE_ARGS="--mine --host 0.0.0.0 --api-port 5100"
NODE_ARGS+=" --peers https://xrge-node.gltch.app/api"
# NODE_ARGS+=" --node-name srv421059"

echo "==> Pulling latest changes..."
cd "$REPO_DIR"
git stash -q 2>/dev/null || true
git pull --ff-only
git stash pop -q 2>/dev/null || true

echo "==> Checking for core changes..."
CORE_CHANGED=$(git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep '^core/' || true)

if [ -n "$CORE_CHANGED" ]; then
    echo "==> Core changes detected — building release binary..."
    cd "$CORE_DIR"
    cargo build --release
else
    echo "==> No core changes — skipping rebuild."
fi

echo "==> Restarting $PM2_NAME..."
pm2 describe "$PM2_NAME" > /dev/null 2>&1 && pm2 delete "$PM2_NAME"
sleep 2

# Kill any zombie processes holding DB locks
pkill -9 -f quantum-vault-daemon 2>/dev/null || true
sleep 1

pm2 start "$BINARY" \
    --name "$PM2_NAME" \
    --kill-timeout "$KILL_TIMEOUT" \
    -- $NODE_ARGS

pm2 save

echo ""
echo "==> Waiting for node to start..."
sleep 5

echo "==> Status:"
pm2 show "$PM2_NAME" | grep -E "status|uptime|restart"
echo ""
echo "==> Chain stats:"
curl -s http://127.0.0.1:5100/api/stats | python3 -m json.tool 2>/dev/null || echo "(node not ready yet)"
echo ""
echo "==> Deploy complete."
