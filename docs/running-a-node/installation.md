# Installation

## System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| **CPU** | 1 vCPU | 2+ vCPU |
| **RAM** | 512 MB | 1–2 GB |
| **Disk** | 5 GB SSD | 20 GB SSD |
| **Network** | 10 Mbps | 100 Mbps |
| **OS** | Linux (Ubuntu 22.04+, Debian 12), macOS, Windows | Ubuntu 22.04 LTS |

The daemon is a single Rust binary with low overhead. A **$5/month VPS** (Hetzner CX22, DigitalOcean Basic Droplet, Vultr Cloud Compute) is more than enough for testnet.

---

## Docker (Fastest)

Run a node with a single command — no Rust toolchain needed:

```bash
docker run -d \
  --name rougechain-node \
  -p 5100:5100 \
  -v qv-data:/data \
  rougechain/node \
  --mine --peers https://testnet.rougechain.io/api
```

Verify it's running:

```bash
curl http://127.0.0.1:5100/api/health
```

### docker-compose

For a persistent setup, create a `.env` file:

```env
API_PORT=5100
QV_PEERS=https://testnet.rougechain.io/api
CHAIN_ID=rougechain-devnet-1
```

Then start:

```bash
git clone https://github.com/cyberdreadx/rougechain-node
cd rougechain-node
docker compose up -d
```

View logs:

```bash
docker compose logs -f node
```

### Build the image locally

```bash
git clone https://github.com/cyberdreadx/rougechain-node
cd rougechain-node
docker build -t rougechain/node .
```

---

## Build from Source

Install and build manually if you prefer not to use Docker.

### Prerequisites

#### Linux / macOS

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Install build dependencies (Ubuntu/Debian)
sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev

# Install build dependencies (macOS)
xcode-select --install
```

#### Windows

1. Install [Rust](https://rustup.rs)
2. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
3. Ensure `cargo` is in your PATH

### Compile

```bash
# Clone the repository
git clone https://github.com/cyberdreadx/rougechain-node
cd rougechain-node/core

# Build release binary
cargo build --release -p quantum-vault-daemon

# Binary location
./target/release/quantum-vault-daemon --help
```

## Verify Installation

```bash
./target/release/quantum-vault-daemon --version
```

Expected output:
```
quantum-vault-daemon 0.1.0
```

## First Run

### Option A: Connect to Testnet

```bash
./target/release/quantum-vault-daemon \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api"
```

### Option B: Start Local Devnet

```bash
./target/release/quantum-vault-daemon --mine --api-port 5100
```

## Verify Node is Running

```bash
curl http://127.0.0.1:5100/api/health
```

Expected response:
```json
{"status":"ok","chain_id":"rougechain-devnet-1","height":0}
```

## Directory Structure

After first run, data is stored at:

| OS | Default Location |
|----|------------------|
| Linux/macOS | `~/.quantum-vault/core-node/` |
| Windows | `C:\Users\<you>\.quantum-vault\core-node\` |

## Updating

```bash
cd rougechain-node
git pull
cd core
cargo build --release -p quantum-vault-daemon

# Restart the node
```

## Troubleshooting

### "cargo not found"

```bash
source ~/.cargo/env
# or restart your terminal
```

### "OpenSSL not found"

```bash
# Ubuntu/Debian
sudo apt install libssl-dev pkg-config

# Fedora/RHEL
sudo dnf install openssl-devel

# macOS
brew install openssl
```

### "Address already in use"

Another process is using port 5100:

```bash
# Find and kill it
lsof -i :5100
kill -9 <PID>

# Or use a different port
./quantum-vault-daemon --api-port 5101
```

### Build fails on Windows

Ensure you have Visual Studio Build Tools with C++ workload installed.

---

## Environment Variables

All CLI flags can also be set via environment variables:

| Variable | CLI Flag | Default | Description |
|----------|----------|---------|-------------|
| `QV_PEERS` | `--peers` | — | Comma-separated peer URLs |
| `QV_PUBLIC_URL` | `--public-url` | — | This node's public URL for peer discovery |
| `QV_CORS_ORIGINS` | — | localhost only | Comma-separated allowed CORS origins |
| `QV_API_KEYS` | `--api-keys` | — | Comma-separated API keys for authenticated access |
| `QV_BRIDGE_CUSTODY_ADDRESS` | `--bridge-custody-address` | — | EVM custody address (enables bridge) |
| `QV_BASE_SEPOLIA_RPC` | `--base-sepolia-rpc` | `https://sepolia.base.org` | Base Sepolia RPC URL |

Common CLI-only flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Bind address. Use `0.0.0.0` for public nodes |
| `--api-port` | `5101` | REST API port |
| `--mine` | off | Enable block production |
| `--data-dir` | `~/.quantum-vault/core-node/` | Chain data directory |
| `--chain-id` | `rougechain-devnet-1` | Network chain ID |
| `--block-time-ms` | `400` | Target block time in milliseconds |
