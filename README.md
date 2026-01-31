# RougeChain - Quantum-Safe Blockchain

RougeChain is a production-ready L1 blockchain powered by NIST-approved post-quantum cryptography (ML-DSA-65 and ML-KEM-768) to protect against quantum computing threats.

## Features

### Core
- **Post-Quantum Cryptography**: ML-DSA-65 signatures and ML-KEM-768 key exchange
- **L1 Node Daemon**: Rust core node with HTTP + gRPC APIs
- **Client-Side Signing**: Private keys never leave your browser - all transactions signed locally
- **Token Burning**: Official on-chain burn address with transparent burn tracking

### DeFi (AMM/DEX)
- **Liquidity Pools**: Uniswap V2-style constant product AMM
- **Token Swaps**: Swap between any tokens with 0.3% fee
- **LP Tokens**: Earn fees by providing liquidity
- **Price Charts**: Real-time price history and pool analytics

### Apps
- **Web Wallet**: Create wallets, send tokens, and view transaction history
- **Blockchain Explorer**: Visualize blocks, transactions, and network stats
- **Secure Messenger**: End-to-end encrypted messaging with quantum-safe encryption
- **Quick Swap Widget**: Trade tokens from anywhere in the app

### API
- **Secure v2 API**: Client-side signed transactions (private keys never sent)
- **Legacy API**: Full RESTful API for wallet creation and transaction submission
- **WebSocket**: Real-time updates for blocks and transactions

## Quick Start

### Prerequisites

- Node.js 18+ (frontend)
- Rust toolchain (core node)

### Installation

```sh
# Clone the repository
git clone <YOUR_GIT_URL>
cd quantum-vault

# Install frontend dependencies
npm install

# Start development server
npm run dev
```

### Running the Core Node (Rust)

```sh
cd core
# Start a mining node
cargo run -p quantum-vault-daemon -- --host 0.0.0.0 --port 4100 --api-port 5100 --mine
```

## Project Structure

- `core/` - Rust L1 node daemon
- `src/` - React frontend application

## Technologies

- **Frontend**: Vite, React, TypeScript, Tailwind CSS, shadcn-ui
- **Backend**: Rust (axum + tonic)
- **Cryptography**: @noble/post-quantum (ML-DSA-65, ML-KEM-768)
- **Storage**: File-based JSONL storage for blockchain data

## Deployment

See deployment guides:
- `DEPLOYMENT_SUMMARY.md` - Quick overview
- `DEPLOYMENT_HOSTINGER.md` - VPS deployment guide
- `DEPLOYMENT_NETLIFY.md` - Frontend deployment guide
- `QUICK_START_VPS.sh` - Automated VPS setup script

## Documentation

- `core/README.md` - Rust core node documentation
- `PUBLIC_API.md` - Public API documentation
- `TROUBLESHOOTING_TRANSACTIONS.md` - Transaction debugging guide

## License

MIT
