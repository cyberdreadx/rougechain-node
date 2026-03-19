# RougeChain - Quantum-Safe Blockchain

RougeChain is a production-ready L1 blockchain powered by NIST-approved post-quantum cryptography (ML-DSA-65 and ML-KEM-768) to protect against quantum computing threats.

**Live Testnet**: [rougechain.io](https://rougechain.io) | **API**: `https://testnet.rougechain.io/api`

## Features

### Core
- **Post-Quantum Cryptography**: ML-DSA-65 signatures and ML-KEM-768 key exchange
- **L1 Node Daemon**: Rust core node with HTTP + gRPC APIs
- **Client-Side Signing**: Private keys never leave your browser - all transactions signed locally
- **Token Burning**: Official on-chain burn address with transparent burn tracking
- **P2P Networking**: Multi-node peering with automatic peer discovery and exponential backoff for unreachable peers

### DeFi (AMM/DEX)
- **Liquidity Pools**: Uniswap V2-style constant product AMM
- **Token Swaps**: Swap between any tokens with 0.3% fee
- **LP Tokens**: Earn fees by providing liquidity
- **Price Charts**: Real-time price history and pool analytics
- **Custom Tokens**: Create and deploy your own tokens on-chain

### Bridge
- **qETH Bridge**: Bridge ETH from Base Sepolia to qETH on RougeChain
- **Bridge Withdrawals**: Burn qETH to withdraw ETH back to Base Sepolia
- **Relayer Support**: Automated bridge withdrawal fulfillment

### Apps
- **Web Wallet**: Create wallets, send tokens, and view transaction history
- **Blockchain Explorer**: Visualize blocks, transactions, and network stats
- **Secure Messenger**: End-to-end encrypted messaging with quantum-safe encryption
- **Quick Swap Widget**: Trade tokens from anywhere in the app

### API
- **Secure v2 API**: Client-side signed transactions (private keys never sent)
- **Legacy v1 API**: Full RESTful API for wallet creation and transaction submission
- **WebSocket**: Real-time updates for blocks and transactions

## Quick Start

### Prerequisites

- Node.js 18+ (frontend)
- Rust toolchain (core node)

### Local Development

```bash
# Clone the repository
git clone https://github.com/cyberdreadx/rougechain-node.git
cd rougechain-node

# Install frontend dependencies
npm install

# Start the frontend dev server
npm run dev
```

In a separate terminal, start the core node:

```bash
cd core
cargo run -p quantum-vault-daemon -- --mine
```

The frontend defaults to `http://localhost:5101/api`. For local development, create a `.env.local` file:

```
VITE_CORE_API_URL=http://127.0.0.1:5101/api
VITE_CORE_API_URL_TESTNET=http://127.0.0.1:5101/api
```

### Connect to Public Testnet

To run a node that syncs with the public testnet:

```bash
cd core
cargo run -p quantum-vault-daemon -- --mine --peers https://testnet.rougechain.io/api
```

### Production Deployment

```bash
# Build the daemon
cd core
cargo build --release

# Run as primary node (no peers needed if you ARE the testnet)
./target/release/quantum-vault-daemon \
  --mine \
  --host 0.0.0.0 \
  --api-port 5100 \
  --bridge-custody-address 0xYOUR_ADDRESS

# Run as secondary node (peers with the testnet)
./target/release/quantum-vault-daemon \
  --mine \
  --host 0.0.0.0 \
  --api-port 5100 \
  --peers https://testnet.rougechain.io/api \
  --bridge-custody-address 0xYOUR_ADDRESS
```

Use tmux to keep the daemon running after disconnecting SSH:

```bash
tmux new-session -d -s daemon "/path/to/quantum-vault-daemon --mine --host 0.0.0.0 --api-port 5100"
tmux attach -t daemon     # view logs
# Ctrl+B then D to detach
```

## Project Structure

```
rougechain-node/
├── core/                  # Rust L1 node daemon
│   ├── daemon/            # Main binary (API server, miner, peer sync)
│   ├── types/             # Shared types and codec helpers
│   ├── crypto/            # PQC signing (ML-DSA-65) and hashing
│   ├── consensus/         # Proposer selection
│   ├── storage/           # Chain, validator, pool persistence
│   └── p2p/               # TCP gossip scaffolding
├── src/                   # React frontend application
│   ├── pages/             # Wallet, Swap, Pools, Bridge, Explorer
│   ├── components/        # UI components
│   ├── lib/               # API clients, PQC signer, network config
│   └── hooks/             # React hooks (ETH price, qETH formatting)
├── scripts/               # Bridge relayer scripts
├── docs/                  # Documentation (GitBook format)
└── public/                # Static assets
```

## Technologies

- **Frontend**: Vite, React, TypeScript, Tailwind CSS, shadcn/ui
- **Backend**: Rust (Axum HTTP + Tonic gRPC)
- **Cryptography**: ML-DSA-65 (CRYSTALS-Dilithium), ML-KEM-768, SHA-256
- **Storage**: RocksDB-backed persistent storage
- **Networking**: HTTP peer sync with automatic discovery

## Network Info

| Property | Value |
|----------|-------|
| Chain ID | `rougechain-devnet-1` |
| Native Token | XRGE |
| Bridged Token | qETH (6 decimals) |
| Testnet URL | `https://testnet.rougechain.io/api` |
| Frontend | `https://rougechain.io` |
| Block Time | 400ms |

## Deployment

See deployment guides:
- `DEPLOYMENT_SUMMARY.md` - Architecture overview
- `DEPLOYMENT_HOSTINGER.md` - VPS deployment with Nginx + SSL
- `DEPLOYMENT_NETLIFY.md` - Frontend deployment on Netlify

## Documentation

- `core/README.md` - Rust core node documentation and CLI reference
- `PUBLIC_API.md` - Full API endpoint documentation
- `TROUBLESHOOTING_TRANSACTIONS.md` - Transaction debugging guide
- `docs/` - Comprehensive documentation (GitBook format)

## License

MIT
