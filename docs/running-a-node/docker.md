# Docker

Run a RougeChain node without installing Rust or any build dependencies.

## Requirements

Any VPS or machine with Docker installed. Minimum specs:

- **1 vCPU**, 512 MB RAM, 5 GB SSD, 10 Mbps
- Recommended: 2 vCPU, 1–2 GB RAM, 20 GB SSD
- A $5/month VPS is enough for testnet

## Quick Start

```bash
docker run -d \
  --name rougechain-node \
  -p 5100:5100 \
  -v qv-data:/data \
  rougechain/node \
  --mine --peers https://testnet.rougechain.io/api
```

Your node will:
- Sync with the testnet
- Produce blocks (`--mine`)
- Persist chain data to the `qv-data` Docker volume
- Serve the REST API on port `5100`

Verify:

```bash
curl http://127.0.0.1:5100/api/stats | python3 -m json.tool
```

## docker-compose

For a persistent production setup, clone the repo and use `docker-compose`:

```bash
git clone https://github.com/cyberdreadx/rougechain-node
cd rougechain-node
```

Optionally create a `.env` file to override defaults:

```env
API_PORT=5100
QV_PEERS=https://testnet.rougechain.io/api
QV_CORS_ORIGINS=https://yourdapp.com,https://rougechain.io
CHAIN_ID=rougechain-devnet-1
```

Start:

```bash
docker compose up -d
```

View logs:

```bash
docker compose logs -f node
```

Stop:

```bash
docker compose down
```

## Building the Image

Build locally instead of pulling from the registry:

```bash
docker build -t rougechain/node .
```

The Dockerfile uses a multi-stage build:
1. **Builder stage** — compiles the Rust daemon in a full Rust image
2. **Runtime stage** — copies only the binary into a minimal Debian image (~50 MB)

## Data Persistence

Chain data is stored at `/data` inside the container. Mount a volume to keep it across restarts:

```bash
# Named volume (recommended)
-v qv-data:/data

# Host directory
-v /srv/rougechain-data:/data
```

Data includes:
- Block database
- Validator state
- Pool/DEX state
- NFT collections
- Node keys (`node-keys.json`)

## Custom Configuration

Pass CLI flags after the image name:

```bash
docker run -d \
  -p 5100:5100 \
  -v qv-data:/data \
  rougechain/node \
  --mine \
  --peers https://testnet.rougechain.io/api \
  --chain-id rougechain-devnet-1 \
  --block-time-ms 400
```

Set CORS origins via environment variable:

```bash
docker run -d \
  -p 5100:5100 \
  -v qv-data:/data \
  -e QV_CORS_ORIGINS="https://yourdapp.com" \
  rougechain/node \
  --mine --peers https://testnet.rougechain.io/api
```

## Becoming a Validator

Once your Docker node is running and synced:

1. Open the [Validators page](https://rougechain.io/validators) in your browser
2. Connect your wallet
3. Stake XRGE to register as a validator
4. Your node will begin participating in block production

Your node earns:
- **20%** of priority tips when selected as block proposer
- **A share of 70%** of priority tips, weighted by your stake
- A minimum tip floor of 0.1 XRGE/block is guaranteed from staking reserves

## Health Checks

```bash
# Node health
curl http://127.0.0.1:5100/api/health

# Network stats (peers, height, mining status)
curl http://127.0.0.1:5100/api/stats

# Validator list
curl http://127.0.0.1:5100/api/validators
```

## Updating

```bash
cd rougechain-node
git pull
docker compose build
docker compose up -d
```

Or if using `docker run`:

```bash
docker build -t rougechain/node .
docker stop rougechain-node
docker rm rougechain-node
docker run -d --name rougechain-node -p 5100:5100 -v qv-data:/data rougechain/node --mine --peers https://testnet.rougechain.io/api
```

The `qv-data` volume persists across container rebuilds, so your chain data is preserved.
