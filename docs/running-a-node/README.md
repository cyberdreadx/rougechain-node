# Running a Node

Run your own RougeChain node to participate in the network, validate transactions, and earn rewards.

The node software is **open source** under the [Apache 2.0 license](https://github.com/cyberdreadx/rougechain-node).

## Node Types

| Type | Description | Requires |
|------|-------------|----------|
| **Full Node** | Syncs and validates all blocks | `--peers` |
| **Mining Node** | Produces new blocks | `--mine` |
| **Public Node** | Accepts external connections | `--host 0.0.0.0` |

## Quick Start

```bash
# Clone the public repo
git clone https://github.com/cyberdreadx/rougechain-node
cd rougechain-node/core

# Build the daemon
cargo build --release -p quantum-vault-daemon

# Run a syncing node
./target/release/quantum-vault-daemon \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api"

# Run a mining node
./target/release/quantum-vault-daemon \
  --mine \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api"
```

## Verify It's Working

```bash
curl http://127.0.0.1:5100/api/health
```

Expected response:
```json
{
  "status": "ok",
  "chain_id": "rougechain-devnet-1",
  "height": 123
}
```

## Next Steps

- [Installation](installation.md) - Detailed setup instructions
- [Configuration](configuration.md) - All CLI options
- [Mining](mining.md) - Block production
