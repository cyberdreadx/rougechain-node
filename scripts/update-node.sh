#!/usr/bin/env bash
#
# update-node.sh — one command to bring a RougeChain node up to the latest main:
# fetch, fast-forward, rebuild the release binary, restart the service, health-check.
#
# Usage:
#   ./scripts/update-node.sh
#
# Override any of these via env if your setup differs:
#   ROUGECHAIN_REPO     repo dir            (default: the repo this script lives in)
#   ROUGECHAIN_BRANCH   branch to track     (default: main)
#   ROUGECHAIN_SERVICE  systemd unit name   (default: rougechain)
#   ROUGECHAIN_API_PORT health-check port   (default: 5100)
#
# Safe by design: refuses to run on a dirty tree, only fast-forwards (never
# rewrites local history), and aborts if the service doesn't come back healthy.

set -euo pipefail

REPO_DIR="${ROUGECHAIN_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${ROUGECHAIN_BRANCH:-main}"
SERVICE="${ROUGECHAIN_SERVICE:-rougechain}"
API_PORT="${ROUGECHAIN_API_PORT:-5100}"

# cargo is often not on a non-interactive PATH (e.g. over ssh) — find it.
CARGO="${CARGO:-$(command -v cargo || echo "$HOME/.cargo/bin/cargo")}"
if [ ! -x "$CARGO" ]; then
  echo "✖ cargo not found (looked for '$CARGO'). Install Rust or set \$CARGO." >&2
  exit 1
fi

cd "$REPO_DIR"

echo "==> Repo:    $REPO_DIR"
echo "==> Branch:  $BRANCH   Service: $SERVICE"

# Refuse to clobber uncommitted work.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✖ Working tree has uncommitted changes — aborting so nothing is lost." >&2
  git status --short >&2
  echo "  Commit/stash your changes (or 'git checkout -- <file>') and re-run." >&2
  exit 1
fi

git fetch origin "$BRANCH" --quiet
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "✓ Already up to date at $(git rev-parse --short HEAD). Nothing to do."
  exit 0
fi

echo "==> Updating $(git rev-parse --short "$LOCAL") -> $(git rev-parse --short "$REMOTE")"
git merge --ff-only "origin/$BRANCH"

echo "==> Building release binary (this can take a few minutes)…"
( cd core && "$CARGO" build --release -p quantum-vault-daemon )

echo "==> Restarting $SERVICE…"
sudo systemctl restart "$SERVICE"
sleep 3

if ! systemctl is-active --quiet "$SERVICE"; then
  echo "✖ $SERVICE did not come back up. Logs:" >&2
  sudo systemctl status "$SERVICE" --no-pager -l | tail -20 >&2
  exit 1
fi

echo "==> Health:"
if curl -fsS --max-time 8 "http://127.0.0.1:${API_PORT}/api/health"; then
  echo ""
  echo "✓ Updated to $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
else
  echo ""
  echo "✖ Service is active but /api/health did not respond on :${API_PORT}." >&2
  exit 1
fi
