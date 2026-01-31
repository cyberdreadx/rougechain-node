# Deploying RougeChain on Hostinger VPS

## Overview

- **Core Node**: Deploy on Hostinger VPS (runs 24/7)
- **Frontend**: Deploy on Netlify (or Vercel, or same VPS)

## Part 1: Core Node on Hostinger VPS

### Prerequisites

1. SSH access to your Hostinger VPS
2. Rust toolchain installed
3. Public IP or domain name

### Step 1: Connect to VPS

```bash
ssh root@your-vps-ip
# Or with username
ssh username@your-vps-ip
```

### Step 2: Install Rust (if not installed)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Rust
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"

# Verify
rustc --version
cargo --version
```

### Step 3: Clone/Upload Your Project

**Option A: Git Clone**
```bash
cd /var/www  # or wherever you want
git clone https://github.com/your-username/quantum-vault.git
cd quantum-vault
```

**Option B: Upload via SFTP**
- Use FileZilla or similar
- Upload entire project to `/var/www/quantum-vault` (or your preferred location)

### Step 4: Build the Core Node

```bash
cd /var/www/quantum-vault/core
cargo build --release
```

### Step 5: Configure Firewall

```bash
# Allow P2P port (4100)
sudo ufw allow 4100/tcp

# Allow API port (5100)
sudo ufw allow 5100/tcp

# Allow SSH (if not already)
sudo ufw allow 22/tcp

# Enable firewall
sudo ufw enable
```

### Step 6: Create systemd Service

```bash
sudo tee /etc/systemd/system/quantum-vault-daemon.service > /dev/null <<'EOF'
[Unit]
Description=Quantum Vault Core Node
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/var/www/quantum-vault/core
ExecStart=/var/www/quantum-vault/core/target/release/quantum-vault-daemon --host 0.0.0.0 --port 4100 --api-port 5100 --mine
Environment=QV_API_KEYS=your_api_key_here
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable quantum-vault-daemon
sudo systemctl start quantum-vault-daemon
```

### Step 7: Verify Node is Running

```bash
# Check status
sudo systemctl status quantum-vault-daemon --no-pager

# View logs
sudo journalctl -u quantum-vault-daemon -f

# Test API
curl http://localhost:5100/api/stats
```

### Step 9: Setup Nginx Reverse Proxy (Optional but Recommended)

Install Nginx:
```bash
sudo apt install nginx
```

Create config file `/etc/nginx/sites-available/rougechain`:
```nginx
server {
    listen 80;
    server_name your-domain.com;  # Or your VPS IP

    # API endpoint
    location /api/ {
        proxy_pass http://127.0.0.1:5100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Frontend (if hosting on same VPS)
    location / {
        root /var/www/quantum-vault/dist;
        try_files $uri $uri/ /index.html;
    }
}
```

Enable site:
```bash
sudo ln -s /etc/nginx/sites-available/rougechain /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Step 10: Setup SSL with Let's Encrypt (Recommended)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## Part 2: Frontend on Netlify

### Option A: Deploy from Git

1. **Push to GitHub** (if not already)
   ```bash
   git add .
   git commit -m "Ready for deployment"
   git push
   ```

2. **Connect to Netlify**
   - Go to [netlify.com](https://netlify.com)
   - Click "Add new site" → "Import an existing project"
   - Connect to your GitHub repo
   - Select the repository

3. **Build Settings**
   ```
   Build command: npm run build
   Publish directory: dist
   ```

4. **Environment Variables**
   - Go to Site settings → Environment variables
   - Add:
     - `VITE_NODE_API_URL_TESTNET` = `https://your-testnet-domain.com/api`
     - `VITE_NODE_API_URL_MAINNET` = `https://your-mainnet-domain.com/api`
   - Or use IPs if no domain

5. **Deploy**
   - Click "Deploy site"
   - Netlify will build and deploy automatically

### Option B: Deploy via Netlify CLI

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login
netlify login

# Build your site
npm run build

# Deploy
netlify deploy --prod
```

### Option C: Deploy Frontend on Same VPS

If you want to host frontend on the same VPS:

```bash
# Build frontend
cd /var/www/quantum-vault
npm run build

# The Nginx config above already serves from /dist
# Just update the root path in nginx config
```

## Configuration

### Environment Variables

**On Netlify:**
- `VITE_NODE_API_URL_TESTNET` = `https://your-testnet-domain.com/api` (or your VPS IP)
- `VITE_NODE_API_URL_MAINNET` = `https://your-mainnet-domain.com/api` (or your VPS IP)
- `VITE_CORE_API_KEY` = `your_api_key_here` (if API key auth enabled)

**On VPS (for node):**
- `QV_API_KEYS` = `key1,key2` (optional, enables API key auth)

### Update Frontend to Point to Your Node

In your `.env` file (or Netlify env vars):
```
VITE_NODE_API_URL_TESTNET=https://your-testnet-domain.com/api
VITE_NODE_API_URL_MAINNET=https://your-mainnet-domain.com/api
```

Or if using IP:
```
VITE_NODE_API_URL_TESTNET=http://your-vps-ip:5100/api
VITE_NODE_API_URL_MAINNET=http://your-vps-ip:5100/api
```

## Monitoring

### Check Node Status

```bash
sudo systemctl status quantum-vault-daemon --no-pager
sudo journalctl -u quantum-vault-daemon -f

# Check if API is accessible
curl http://your-vps-ip:5100/api/stats
```

### Restart

```bash
sudo systemctl restart quantum-vault-daemon
```

## Troubleshooting

### Node won't start
```bash
# Check logs
sudo journalctl -u quantum-vault-daemon -f

# Check if port is in use
sudo netstat -tulpn | grep 4100
sudo netstat -tulpn | grep 5100

# Kill process on port if needed
sudo kill -9 <PID>
```

### Can't access from outside
- Check firewall: `sudo ufw status`
- Check if node is listening on `0.0.0.0`: `--host 0.0.0.0`
- Check Hostinger firewall rules in control panel

### systemd not starting on reboot
```bash
sudo systemctl enable quantum-vault-daemon
```

## Quick Start Script

Create `/var/www/quantum-vault/start-node.sh`:

```bash
#!/bin/bash
cd /var/www/quantum-vault/core
./target/release/quantum-vault-daemon --host 0.0.0.0 --port 4100 --api-port 5100 --mine
```

Make executable:
```bash
chmod +x start-node.sh
```

## Security Checklist

- [ ] Firewall configured (ports 4100, 5100)
- [ ] Node running as non-root user (recommended)
- [ ] SSL/HTTPS enabled (Let's Encrypt)
- [ ] systemd auto-restart configured
- [ ] Regular backups of chain data
- [ ] Monitor disk space (chain grows over time)

## Backup Chain Data

```bash
# Backup chain files
tar -czf quantum-vault-backup-$(date +%Y%m%d).tar.gz \
  ~/.quantum-vault/core-node/

# Restore
tar -xzf rougechain-backup-YYYYMMDD.tar.gz -C ~/
```

## Next Steps

1. **Test your node**: `curl http://your-vps-ip:5100/api/stats`
2. **Deploy frontend**: Connect to Netlify
3. **Share your node**: Give users your API URL
4. **Monitor**: Set up alerts for node downtime

Your RougeChain L1 is now publicly accessible! 🚀
