# Auto-Deploy Setup

RougeChain daemon auto-deploys on all servers when code is pushed to `main`.

## How It Works

A cron job runs every 2 minutes on each server:
1. `git fetch` checks for new commits
2. If new commits exist: `git pull` → `cargo build --release` → `systemctl restart`
3. If no new commits: exits silently (no build, no restart)
4. Lock file prevents overlapping builds

## Quick Setup (Per Server)

```bash
# 1. Make the script executable
chmod +x /opt/quantum-vault/scripts/auto-deploy.sh

# 2. Allow the deploy user to restart the service without a password
echo "$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart rougechain, /usr/bin/systemctl status rougechain, /usr/bin/systemctl is-active rougechain" | sudo tee /etc/sudoers.d/rougechain-deploy

# 3. Add cron job (runs every 2 minutes)
(crontab -l 2>/dev/null; echo "*/2 * * * * /opt/quantum-vault/scripts/auto-deploy.sh >> /var/log/rougechain-deploy.log 2>&1") | crontab -

# 4. Create log file
sudo touch /var/log/rougechain-deploy.log
sudo chown $(whoami) /var/log/rougechain-deploy.log
```

## Configuration

Set these environment variables in crontab or `/etc/environment` to override defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUGECHAIN_REPO` | `/opt/quantum-vault` | Path to the cloned repo |
| `ROUGECHAIN_BRANCH` | `main` | Branch to track |
| `ROUGECHAIN_SERVICE` | `rougechain` | systemd service name |

Example with custom paths:
```bash
*/2 * * * * ROUGECHAIN_REPO=/home/user/quantum-vault ROUGECHAIN_SERVICE=rougechain-node /home/user/quantum-vault/scripts/auto-deploy.sh >> /var/log/rougechain-deploy.log 2>&1
```

## Monitoring

```bash
# Check recent deploys
tail -20 /var/log/rougechain-deploy.log

# Check if cron is running
crontab -l | grep rougechain
```

## Disable Auto-Deploy

```bash
crontab -l | grep -v auto-deploy | crontab -
```
