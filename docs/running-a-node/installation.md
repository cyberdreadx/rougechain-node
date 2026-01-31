# Installation

Build and run a RougeChain node from source.

## Prerequisites

### Linux / macOS

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Install build dependencies (Ubuntu/Debian)
sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev

# Install build dependencies (macOS)
xcode-select --install
```

### Windows

1. Install [Rust](https://rustup.rs)
2. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
3. Ensure `cargo` is in your PATH

## Build from Source

```bash
# Clone the repository
git clone https://github.com/your-repo/quantum-vault
cd quantum-vault/core

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
  --peers "https://testnet.rougechain.io"
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
cd quantum-vault
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
