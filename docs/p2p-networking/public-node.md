# Running a Public Node

Run a RougeChain node that is publicly accessible and participates fully in the network.

## Requirements

| Requirement | Details |
|-------------|---------|
| Server | VPS or dedicated server with a public IP |
| Domain (recommended) | Point a domain to your server |
| SSL certificate | Required for HTTPS (use Let's Encrypt) |
| Open port | 443 on the reverse proxy (the daemon's API port stays on `127.0.0.1`) |

## Setup

### 1. Build and Install

```bash
git clone https://github.com/cyberdreadx/rougechain-node
cd rougechain-node/core
cargo build --release -p quantum-vault-daemon
sudo cp target/release/quantum-vault-daemon /usr/local/bin/
```

### 2. Configure Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name mynode.rougechain.example.com;

    ssl_certificate /etc/letsencrypt/live/mynode.rougechain.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mynode.rougechain.example.com/privkey.pem;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:5100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set `client_max_body_size` to at least 50M to support messenger media uploads.

> By default the daemon keys rate limits by the connecting IP, which behind this proxy is always `127.0.0.1`. Start it with `--trust-proxy` to key them by the `X-Real-IP` / `X-Forwarded-For` this proxy sets (honoured only for loopback connections). See [Rate Limiting](#rate-limiting).

### 3. Start the Node

```bash
./quantum-vault-daemon \
  --mine \
  --host 127.0.0.1 \
  --api-port 5100 \
  --node-name "MyNode" \
  --peers "https://testnet.rougechain.io/api" \
  --public-url "https://mynode.rougechain.example.com"
```

> **Why `--public-url` is required:** Without it, your node syncs blocks but never tells other nodes "I exist." It stays invisible — it won't appear on the [network globe](https://rougechain.io/blockchain), other nodes can't sync from it, and it won't receive direct block broadcasts. The `--public-url` must be the URL that other nodes on the internet can reach.

Once running, visit `http://127.0.0.1:5100` in your browser to see the **built-in node dashboard** with live block height, peers, mining status, and fees.

### 4. Run as a Service

Create `/etc/systemd/system/rougechain.service`:

```ini
[Unit]
Description=RougeChain Node
After=network.target

[Service]
Type=simple
User=rougechain
ExecStart=/usr/local/bin/quantum-vault-daemon --mine --host 127.0.0.1 --api-port 5100 --peers "https://testnet.rougechain.io/api" --public-url "https://mynode.rougechain.example.com"
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /bin/false rougechain
sudo systemctl enable rougechain
sudo systemctl start rougechain
```

## Verify Your Node

### Health Check

```bash
curl https://mynode.rougechain.example.com/api/health
```

### Check Peers Can See You

```bash
curl https://testnet.rougechain.io/api/peers
# Your node's URL should appear in the list
```

## Security Hardening

### API Keys

`--api-keys` requires an `X-API-Key` (or `Authorization: Bearer`) header on **every** route that is not exempt — reads such as `/api/blocks` and balances included, not just writes:

```bash
./quantum-vault-daemon \
  --mine \
  --api-port 5100 \
  --api-keys "secret-key-1,secret-key-2"
```

Exempt routes: `/`, `/api/health`, `/api/stats`, `/api/v2/*`, `/api/bridge/*`, `/api/messenger/*`, `/api/mail/*`, `/api/names/*`, `/api/finality/*`, the faucet and the bot (signed routes check their own signatures). Peers never send an API key, so a keyed node also refuses the peer routes `/api/blocks/import`, `/api/peers/register` and `/api/tx/broadcast` — use API keys for a private node, not for a public one that should take part in peering.

### Rate Limiting

The node has built-in rate limiting (disabled by default — every limit defaults to `0`, unlimited). Set the read and write limits:

```bash
./quantum-vault-daemon --rate-limit-read-per-minute 600 --rate-limit-write-per-minute 60
```

`GET` requests count against the read limit and every other method against the write limit; `--rate-limit-validator` and `--rate-limit-peer` set separate limits for signed validator requests and registered peers. `--rate-limit-per-minute` is a deprecated alias that applies to both reads and writes when neither of those is set. Limits are keyed by the connecting IP, so behind the nginx proxy above all clients share one bucket unless you add `--trust-proxy` (env `QV_TRUST_PROXY=true`): then a request arriving from loopback is keyed by `X-Real-IP` (else the rightmost `X-Forwarded-For` entry), and any non-loopback connection still by its socket IP. Only enable it when the API port is reachable solely through that local proxy. All routes are limited, including `/api/finality/*`.

### Firewall

Only expose the necessary port:

```bash
sudo ufw default deny incoming
sudo ufw allow ssh
sudo ufw allow 443/tcp
sudo ufw enable
```

## Monitoring

### Check Logs

```bash
sudo journalctl -u rougechain -f
```

### Health Endpoint

Set up a monitoring tool (e.g., UptimeRobot) to poll:

```
https://mynode.rougechain.example.com/api/health
```

### Metrics to Watch

| Metric | How to Check |
|--------|-------------|
| Block height | `GET /api/health` — compare with testnet |
| Peer count | `GET /api/peers` — should be > 0 |
| Validator status | `GET /api/validators` — check your stake |
