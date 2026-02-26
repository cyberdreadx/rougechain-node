# Deployment Summary

## Architecture

```
┌─────────────────┐         ┌──────────────────────────┐
│   Netlify        │         │  Primary VPS              │
│   (Frontend)     │────────▶│  testnet.rougechain.io    │
│   rougechain.io  │  API    │  - Daemon (port 5100)     │
│   - React UI     │  Calls  │  - Nginx reverse proxy    │
│   - Free SSL     │         │  - SSL via Let's Encrypt  │
│   - CDN          │         │  - Mining enabled          │
└─────────────────┘         └────────────┬─────────────┘
                                         │ P2P Sync
                            ┌────────────▼─────────────┐
                            │  Secondary VPS            │
                            │  - Daemon (port 5100)     │
                            │  - Peers with primary     │
                            │  - Mining enabled          │
                            └──────────────────────────┘
```

## Components

| Component | Hosted On | URL |
|-----------|-----------|-----|
| Frontend | Netlify | `https://rougechain.io` |
| Primary Node | VPS | `https://testnet.rougechain.io/api` |
| Secondary Node(s) | VPS | Peers with primary |

## Quick Deploy

### 1. Primary Node (the testnet)

```bash
# Build
cd core && cargo build --release

# Run in tmux (no --peers since this IS the testnet)
tmux new-session -d -s daemon "/path/to/quantum-vault-daemon \
  --mine --host 0.0.0.0 --api-port 5100 \
  --bridge-custody-address 0xYOUR_ADDRESS"
```

Set up Nginx to reverse proxy `testnet.rougechain.io` → `localhost:5100`, then add SSL with certbot.

### 2. Secondary Node (peers with testnet)

```bash
# Build
cd core && cargo build --release

# Run in tmux
tmux new-session -d -s daemon "/path/to/quantum-vault-daemon \
  --mine \
  --peers https://testnet.rougechain.io/api \
  --bridge-custody-address 0xYOUR_ADDRESS"
```

### 3. Frontend (Netlify)

1. Push code to GitHub
2. Import repo on [netlify.com](https://netlify.com)
3. Build settings: command `npm run build`, publish `dist`
4. Environment variable: `VITE_CORE_API_URL_TESTNET=https://testnet.rougechain.io/api`
5. Deploy - auto-deploys on every git push

## Environment Variables

### Frontend (.env)

```bash
VITE_CORE_API_URL=https://testnet.rougechain.io/api
VITE_CORE_API_URL_TESTNET=https://testnet.rougechain.io/api
VITE_NODE_API_URL=https://testnet.rougechain.io/api
VITE_NODE_API_URL_TESTNET=https://testnet.rougechain.io/api
```

For local development, create `.env.local` (gitignored) with `localhost` URLs.

### Daemon (optional)

```bash
QV_API_KEYS=key1,key2          # Enable API key auth
QV_PEERS=https://peer1/api     # Peer URLs
QV_PUBLIC_URL=https://mynode    # Public URL for peer discovery
QV_BRIDGE_CUSTODY_ADDRESS=0x.. # Bridge custody address
```

## Managing the Daemon

```bash
tmux attach -t daemon          # View daemon logs
# Ctrl+B then D               # Detach (keeps running)
tmux kill-session -t daemon    # Stop daemon

# Restart after code update
pkill -9 -f quantum-vault
sleep 3
cd core && cargo build --release
tmux new-session -d -s daemon "/path/to/quantum-vault-daemon --mine ..."
```

## Nginx Config (for primary node)

```nginx
server {
    server_name testnet.rougechain.io;

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

Then enable SSL:

```bash
sudo ln -s /etc/nginx/sites-available/testnet-rougechain /etc/nginx/sites-enabled/
sudo certbot --nginx -d testnet.rougechain.io
```

## Test Your Setup

```bash
# Test API
curl https://testnet.rougechain.io/api/stats

# Should return JSON like:
# {"connected_peers":1,"network_height":120,"is_mining":true,...}
```

## Cost

- **VPS**: ~$5-10/month each
- **Netlify**: Free (frontend hosting)
- **Domain**: ~$10/year

## Full Guides

- `DEPLOYMENT_HOSTINGER.md` - Detailed VPS deployment with systemd and Nginx
- `DEPLOYMENT_NETLIFY.md` - Frontend deployment on Netlify
- `core/README.md` - All CLI options and API endpoints
