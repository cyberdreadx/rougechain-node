# Deploying RougeChain on a VPS

## Overview

- **Core Node**: Deploy on a VPS (runs 24/7)
- **Frontend**: Deploy on Netlify (auto-deploys from GitHub)

## Part 1: Core Node on VPS

### Prerequisites

1. SSH access to your VPS
2. Rust toolchain installed
3. Domain name pointed to VPS IP (for SSL)

### Step 1: Connect to VPS

```bash
ssh user@your-vps-ip
```

### Step 2: Install Rust (if not installed)

```bash
sudo apt update && sudo apt upgrade -y
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"
rustc --version
```

### Step 3: Clone the Project

```bash
git clone https://github.com/cyberdreadx/rougechain-node.git rougechain
cd rougechain
```

### Step 4: Build the Core Node

```bash
cd core
cargo build --release
```

This takes 5-10 minutes on a typical VPS.

### Step 5: Run the Daemon

**As the primary testnet node** (this IS `testnet.rougechain.io`):

```bash
tmux new-session -d -s daemon "$(pwd)/target/release/quantum-vault-daemon \
  --mine --host 0.0.0.0 --api-port 5100 \
  --bridge-custody-address 0xYOUR_BRIDGE_ADDRESS"
```

**As a secondary node** (peers with the testnet):

```bash
tmux new-session -d -s daemon "$(pwd)/target/release/quantum-vault-daemon \
  --mine \
  --peers https://testnet.rougechain.io/api \
  --bridge-custody-address 0xYOUR_BRIDGE_ADDRESS"
```

Check the daemon:

```bash
tmux attach -t daemon
# Ctrl+B then D to detach without stopping
```

### Step 6: Configure Firewall

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP (for certbot)
sudo ufw allow 443/tcp    # HTTPS
sudo ufw allow 4101/tcp   # gRPC (optional, for direct peer connections)
sudo ufw enable
```

### Step 7: Setup Nginx Reverse Proxy

Install Nginx:

```bash
sudo apt install nginx -y
```

Create `/etc/nginx/sites-available/testnet-rougechain`:

```nginx
server {
    server_name testnet.yourdomain.com;

    location /api/ {
        proxy_pass http://127.0.0.1:5100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ws {
        proxy_pass http://127.0.0.1:5100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    listen 80;
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/testnet-rougechain /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Step 8: Setup SSL with Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d testnet.yourdomain.com
```

### Step 9: Verify

```bash
curl https://testnet.yourdomain.com/api/stats
```

## Part 2: Frontend on Netlify

1. Push code to GitHub
2. Go to [netlify.com](https://netlify.com) → Add new site → Import from GitHub
3. Build settings:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Environment variables:
   - `VITE_CORE_API_URL_TESTNET` = `https://testnet.yourdomain.com/api`
5. Deploy

The frontend auto-deploys on every `git push`.

## Managing the Daemon

### View Logs

```bash
tmux attach -t daemon
# Ctrl+B then D to detach
```

### Restart After Code Update

```bash
cd ~/rougechain && git pull
cd core && cargo build --release
pkill -9 -f quantum-vault; sleep 3
tmux new-session -d -s daemon "$(pwd)/target/release/quantum-vault-daemon \
  --mine --host 0.0.0.0 --api-port 5100 \
  --bridge-custody-address 0xYOUR_BRIDGE_ADDRESS"
```

### Stop the Daemon

```bash
tmux kill-session -t daemon
# or
pkill -9 -f quantum-vault
```

### Alternative: systemd Service

If you prefer auto-restart on reboot instead of tmux:

```bash
sudo tee /etc/systemd/system/quantum-vault-daemon.service > /dev/null <<'EOF'
[Unit]
Description=Quantum Vault Core Node
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/rougechain/core
ExecStart=/path/to/rougechain/core/target/release/quantum-vault-daemon \
  --mine --host 0.0.0.0 --api-port 5100 \
  --bridge-custody-address 0xYOUR_BRIDGE_ADDRESS
Environment=QV_PEERS=https://testnet.rougechain.io/api
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable quantum-vault-daemon
sudo systemctl start quantum-vault-daemon
```

Monitor with:

```bash
sudo systemctl status quantum-vault-daemon
sudo journalctl -u quantum-vault-daemon -f
```

## Troubleshooting

### Database Lock Error

```
Error: "IO error: could not acquire lock..."
```

An old daemon process is still running. Kill it:

```bash
pkill -9 -f quantum-vault
sleep 3
# then start again
```

If `pkill` doesn't work (process name too long), use:

```bash
ps aux | grep quantum-vault
kill -9 <PID>
```

### Port Already in Use

```bash
sudo lsof -i :5100
sudo kill -9 <PID>
```

### 502 Bad Gateway

Nginx can't reach the daemon. Check:

1. Is the daemon running? `ps aux | grep quantum-vault`
2. Is it on the right port? Check `--api-port` matches nginx `proxy_pass`
3. Restart nginx: `sudo systemctl restart nginx`

### Peer Sync Errors

Dead peers are automatically backed off with exponential cooldown (20s → 10min). The first failure is logged; subsequent failures are suppressed. Peers recover automatically when they come back online.

### tmux Session Dies Immediately

The daemon is crashing on startup. Run it directly (not in tmux) to see the error:

```bash
./target/release/quantum-vault-daemon --mine --host 0.0.0.0 --api-port 5100
```

Common causes: database lock, port conflict, or missing arguments.

## Security Checklist

- [ ] Firewall configured (UFW)
- [ ] Node running as non-root user
- [ ] SSL/HTTPS enabled (Let's Encrypt)
- [ ] tmux or systemd for persistence
- [ ] Regular backups of chain data

## Backup Chain Data

```bash
# Backup
tar -czf rougechain-backup-$(date +%Y%m%d).tar.gz ~/.quantum-vault/core-node/

# Restore
tar -xzf rougechain-backup-YYYYMMDD.tar.gz -C ~/
```
