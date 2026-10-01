# Docker

Run a RougeChain node without installing Rust or any build dependencies.

## Requirements

Any VPS or machine with Docker installed. Minimum specs:

- **1 vCPU**, 1 GB RAM, 5 GB SSD, 10 Mbps
- Recommended: 2 vCPU, 1–2 GB RAM, 20 GB SSD
- A $5/month VPS is enough for testnet

## Quick Start

```bash
docker run -d \
  --name rougechain-node \
  -p 127.0.0.1:5100:8900 \
  -v qv-data:/data/rougechain \
  rougechain/node \
  --data-dir /data/rougechain --host 0.0.0.0 --api-port 8900 \
  --mine --peers https://testnet.rougechain.io/api
```

Inside the container the node listens on port `8900` and stores data in `/data/rougechain` (the image's volume). Arguments after the image name **replace** the image's default command (`--data-dir /data/rougechain --host 0.0.0.0 --api-port 8900 --mine`), so always repeat `--data-dir`, `--host` and `--api-port` as above; otherwise the node binds to `127.0.0.1:5101` inside the container (unreachable), writes outside the volume, and fails the image's health check (which probes `8900`). Publishing on `127.0.0.1` keeps the API off the public internet; put a reverse proxy in front if peers need to reach you (see [Public Node](../p2p-networking/public-node.md)).

Your node will:
- Sync with the testnet
- Produce blocks (`--mine`) whenever it is the designated proposer
- Persist chain data to the `qv-data` Docker volume
- Serve the REST API on host port `5100`

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
QV_PEERS=https://api.rougechain.io/api
QV_CORS_ORIGINS=https://yourdapp.com,https://rougechain.io
```

The compose file always starts the node from the **mainnet** genesis (`--genesis /etc/rougechain/genesis.json`), which sets the chain id to `rougechain-mainnet-1`; a `CHAIN_ID` value is ignored when a genesis file is given, so point `QV_PEERS` at mainnet peers. It also always passes `--mine`. `API_PORT` is the host port mapped to the container's `8900`. If `QV_CORS_ORIGINS` is unset (or `*`), the node uses its built-in origin list.

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
2. **Runtime stage** — copies the daemon (`rougechain-node`) and the `rougechain` CLI, plus the genesis files, into a minimal Debian image

## Data Persistence

Chain data is stored at `/data/rougechain` inside the container (when the node runs with `--data-dir /data/rougechain`, as the image's default command and the examples here do). Mount a volume there to keep it across restarts:

```bash
# Named volume (recommended)
-v qv-data:/data/rougechain

# Host directory
-v /srv/rougechain-data:/data/rougechain
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
  -p 127.0.0.1:5100:8900 \
  -v qv-data:/data/rougechain \
  rougechain/node \
  --data-dir /data/rougechain --host 0.0.0.0 --api-port 8900 \
  --mine \
  --peers https://testnet.rougechain.io/api \
  --chain-id rougechain-devnet-1 \
  --block-time-ms 400
```

Set CORS origins via environment variable:

```bash
docker run -d \
  -p 127.0.0.1:5100:8900 \
  -v qv-data:/data/rougechain \
  -e QV_CORS_ORIGINS="https://yourdapp.com" \
  rougechain/node \
  --data-dir /data/rougechain --host 0.0.0.0 --api-port 8900 \
  --mine --peers https://testnet.rougechain.io/api
```

## Becoming a Validator

Once your Docker node is running and synced:

1. Fund your node's own key (`/data/rougechain/node-keys.json`) with ≥ 10,000 XRGE plus the fee
2. Stake **from that key** with the bundled CLI, e.g. `docker exec rougechain-node rougechain --node-keys /data/rougechain/node-keys.json stake 10000` (add `--rpc` for testnet). Staking from a browser wallet stakes the wallet's key, not the node's, and the node then never counts as a validator. See [Becoming a Validator](../staking/becoming-validator.md)
3. Your node then votes on blocks, and proposes whenever it is the designated proposer (the validator with the most stake)

Your node earns:
- **20%** of priority tips when it is the designated proposer
- **A share of 70%** of priority tips in every block, weighted by your stake
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
docker run -d --name rougechain-node -p 127.0.0.1:5100:8900 -v qv-data:/data/rougechain rougechain/node --data-dir /data/rougechain --host 0.0.0.0 --api-port 8900 --mine --peers https://testnet.rougechain.io/api
```

The `qv-data` volume persists across container rebuilds, so your chain data is preserved.
