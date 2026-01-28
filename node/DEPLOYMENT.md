# Public Deployment Guide

## Overview

This guide explains how to deploy RougeChain L1 nodes publicly so users can create wallets, send tokens, and interact with the blockchain.

## Prerequisites

1. **Server/VPS** with:
   - Public IP address
   - Node.js 18+ installed
   - Open ports (P2P port, API port)
   - Firewall configured

2. **Domain name** (optional but recommended)

## Step 1: Network Configuration

### Ports

- **P2P Port**: Default `4100` (for node-to-node communication)
- **API Port**: Default `5100` (P2P port + 1000, for HTTP API)

### Firewall Rules

```bash
# Allow P2P port (node-to-node)
sudo ufw allow 4100/tcp

# Allow API port (public HTTP access)
sudo ufw allow 5100/tcp

# Or use your custom ports
sudo ufw allow <P2P_PORT>/tcp
sudo ufw allow <API_PORT>/tcp
```

## Step 2: Deploy Node

### Option A: Single Public Node

```bash
# On your server
cd /path/to/quantum-vault
npm install
npm install --save @noble/post-quantum
npm install --save-dev tsx

# Start public node
npm run l1:node:dev -- \
  --name public-node-1 \
  --host 0.0.0.0 \
  --port 4100 \
  --apiPort 5100 \
  --blockTimeMs 1000 \
  --light
```

**Key flags:**
- `--host 0.0.0.0`: Listen on all interfaces (not just localhost)
- `--port 4100`: P2P port for node connections
- `--apiPort 5100`: HTTP API port for users
- `--light`: Low-resource mode (recommended for lightweight systems)
- `--mine`: Enable block production (optional)

### Validator Keys (Required for voting)

To participate in validator voting/finality, start your node with the same keys you used to stake:

```bash
npm run l1:node:dev -- \
  --name validator-node-1 \
  --host 0.0.0.0 \
  --port 4100 \
  --apiPort 5100 \
  --validatorPubKey YOUR_PUBLIC_KEY_HEX \
  --validatorPrivKey YOUR_PRIVATE_KEY_HEX
```

If you do not supply validator keys, the node will still run, but it will not cast validator votes.

### Option B: Multiple Nodes (Recommended)

**Node 1 (Primary/Miner):**
```bash
npm run l1:node:dev -- \
  --name node-1 \
  --host 0.0.0.0 \
  --port 4100 \
  --apiPort 5100 \
  --light
```

**Node 2 (Secondary/Validator):**
```bash
npm run l1:node:dev -- \
  --name node-2 \
  --host 0.0.0.0 \
  --port 4101 \
  --apiPort 5101 \
  --peers YOUR_SERVER_IP:4100 \
  --validatorPubKey YOUR_PUBLIC_KEY_HEX \
  --validatorPrivKey YOUR_PRIVATE_KEY_HEX
```

## Step 3: Process Management

### Using PM2 (Recommended)

```bash
# Install PM2
npm install -g pm2

# Start node with PM2
pm2 start npm --name "rougechain-node" -- run l1:node:dev -- \
  --name public-node \
  --host 0.0.0.0 \
  --port 4100 \
  --apiPort 5100 \
  --light

# Save PM2 config
pm2 save

# Setup auto-start on reboot
pm2 startup
```

### Using systemd

Create `/etc/systemd/system/rougechain.service`:

```ini
[Unit]
Description=RougeChain L1 Node
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/quantum-vault
ExecStart=/usr/bin/npm run l1:node:dev -- --name public-node --host 0.0.0.0 --port 4100 --apiPort 5100 --light
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable rougechain
sudo systemctl start rougechain
sudo systemctl status rougechain
```

## Step 3.5: Lightweight Mode (Recommended)

For low-resource systems, use the `--light` preset. It caps peers/mempool, reduces log volume, and limits work per block.

```bash
# Lightweight node (no mining)
npm run l1:node:dev -- \
  --name public-node-1 \
  --host 0.0.0.0 \
  --port 4100 \
  --apiPort 5100 \
  --light
```

You can also override specific limits:

```bash
npm run l1:node:dev -- \
  --name public-node-1 \
  --host 0.0.0.0 \
  --port 4100 \
  --apiPort 5100 \
  --log-level warn \
  --max-peers 8 \
  --max-known-peers 25 \
  --max-mempool 500 \
  --max-txs-per-block 50 \
  --max-pending-blocks 10 \
  --vote-history 20 \
  --disable-peer-discovery
```

Mining is optional. If you want block production, add `--mine`.

## Step 4: Reverse Proxy (Optional but Recommended)

### Using Nginx

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location /api/ {
        proxy_pass http://127.0.0.1:5100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Using Caddy

```
your-domain.com {
    reverse_proxy localhost:5100
}
```

## Step 5: Update Frontend

Update your frontend to point to your public nodes:

```typescript
// In your frontend env
VITE_NODE_API_URL_TESTNET="https://testnet.your-domain.com/api"
VITE_NODE_API_URL_MAINNET="https://mainnet.your-domain.com/api"
// Or direct IPs for quick testing
VITE_NODE_API_URL_TESTNET="http://YOUR_SERVER_IP:5100/api"
VITE_NODE_API_URL_MAINNET="http://YOUR_SERVER_IP:5100/api"
```

## Step 6: Security Considerations

### 1. Rate Limiting

Add rate limiting to prevent abuse:

```bash
npm install express-rate-limit
```

Update `node/src/index.ts` to add rate limiting middleware.

### 2. CORS Configuration

Currently allows all origins (`*`). For production:

```typescript
res.setHeader("Access-Control-Allow-Origin", "https://your-frontend-domain.com");
```

### 3. HTTPS

Use HTTPS for API endpoints:
- Let's Encrypt (free SSL)
- Cloudflare (free SSL + DDoS protection)

### 4. Private Key Security

⚠️ **WARNING**: The `/api/wallet/create` endpoint returns private keys in plain text. In production:
- Encrypt private keys before sending
- Use client-side key generation (recommended)
- Implement proper authentication

## Step 7: Public API Endpoints

Once deployed, users can access:

### Create Wallet
```bash
POST https://your-domain.com/api/wallet/create
Response: {
  "success": true,
  "publicKey": "...",
  "privateKey": "...",  # ⚠️ Encrypt in production!
  "algorithm": "ML-DSA-65"
}
```

### Submit Transaction
```bash
POST https://your-domain.com/api/tx/submit
Body: {
  "fromPrivateKey": "...",
  "fromPublicKey": "...",
  "toPublicKey": "...",
  "amount": 100,
  "fee": 0.1
}
Response: {
  "success": true,
  "txId": "...",
  "tx": {...}
}
```

### Get Balance
```bash
GET https://your-domain.com/api/balance/{publicKey}
Response: {
  "success": true,
  "balance": 1000.5
}
```

### Get Stats
```bash
GET https://your-domain.com/api/stats
Response: {
  "connectedPeers": 5,
  "networkHeight": 1234,
  "isMining": true,
  "nodeId": "...",
  "totalFeesCollected": 50.5,
  "feesInLastBlock": 0.3
}
```

### Get Blocks
```bash
GET https://your-domain.com/api/blocks
Response: {
  "blocks": [...]
}
```

## Step 8: Update Frontend Wallet Code

Update `src/lib/pqc-wallet.ts` to use the new node API instead of Supabase:

```typescript
const NODE_API_URL =
  import.meta.env.VITE_NODE_API_URL_TESTNET ||
  import.meta.env.VITE_NODE_API_URL_MAINNET ||
  "http://localhost:5100";

export async function createWallet(): Promise<Wallet> {
  const res = await fetch(`${NODE_API_URL}/api/wallet/create`, {
    method: "POST",
  });
  const data = await res.json();
  return {
    publicKey: data.publicKey,
    privateKey: data.privateKey, // Store securely!
  };
}

export async function sendTransaction(
  fromPrivateKey: string,
  fromPublicKey: string,
  toPublicKey: string,
  amount: number
) {
  const res = await fetch(`${NODE_API_URL}/api/tx/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromPrivateKey,
      fromPublicKey,
      toPublicKey,
      amount,
    }),
  });
  return res.json();
}
```

## Step 9: Monitoring

### Check Node Status
```bash
curl http://localhost:5100/api/stats
```

### Check Finality + Votes
```bash
curl http://localhost:5100/api/finality
curl http://localhost:5100/api/votes
curl http://localhost:5100/api/validators/stats
```

### View Logs
```bash
# PM2
pm2 logs rougechain-node

# systemd
sudo journalctl -u rougechain -f
```

### Health Check Endpoint
Add to your monitoring:
```bash
curl http://your-domain.com/api/stats
```

## Step 10: Genesis Block

For a fresh public network, you may want to create a genesis block with initial distribution:

```typescript
// Create genesis block with initial supply
// This would need to be done manually or via a migration script
```

## Troubleshooting

### Node not accessible
- Check firewall rules
- Verify `--host 0.0.0.0` is set
- Check if port is already in use: `netstat -tulpn | grep 4100`

### CORS errors
- Update CORS headers in `node/src/index.ts`
- Ensure frontend domain matches allowed origins

### Connection refused
- Verify node is running: `pm2 list` or `systemctl status rougechain`
- Check logs for errors
- Verify API port is correct

## Next Steps

1. **State System**: Implement proper balance tracking (currently scans chain)
2. **Nonce Management**: Track transaction nonces per account
3. **Token Support**: Add token creation and transfers
4. **Explorer**: Build a block explorer
5. **Wallet App**: Create mobile/web wallet app
6. **Consensus**: Replace devnet mining with PoS/BFT

## Example Deployment

```bash
# On Ubuntu/Debian server
sudo apt update
sudo apt install nodejs npm nginx

# Clone and setup
git clone https://github.com/your-repo/quantum-vault.git
cd quantum-vault
npm install
npm install --save @noble/post-quantum
npm install --save-dev tsx

# Install PM2
npm install -g pm2

# Start node
pm2 start npm --name "rougechain" -- run l1:node:dev -- \
  --name public \
  --host 0.0.0.0 \
  --port 4100 \
  --apiPort 5100 \
  --mine

pm2 save
pm2 startup
```

Your node is now publicly accessible at `http://YOUR_SERVER_IP:5100/api/`!
