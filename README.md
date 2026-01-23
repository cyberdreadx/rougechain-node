# RougeChain - Quantum-Safe Blockchain

RougeChain is a production-ready L1 blockchain powered by NIST-approved post-quantum cryptography (ML-DSA-65 and ML-KEM-768) to protect against quantum computing threats.

## Features

- **Post-Quantum Cryptography**: ML-DSA-65 signatures and ML-KEM-768 key exchange
- **L1 Node Daemon**: Standalone Node.js blockchain node with TCP P2P networking
- **Web Wallet**: Create wallets, send tokens, and view transaction history
- **Blockchain Explorer**: Visualize blocks, transactions, and network stats
- **Secure Messenger**: End-to-end encrypted messaging with quantum-safe encryption
- **Public API**: RESTful API for wallet creation, transaction submission, and balance queries

## Quick Start

### Prerequisites

- Node.js 18+ installed
- npm or yarn

### Installation

```sh
# Clone the repository
git clone <YOUR_GIT_URL>
cd quantum-vault

# Install dependencies
npm install
npm install --save @noble/post-quantum
npm install --save-dev tsx

# Start development server
npm run dev
```

### Running a Node

```sh
# Start a mining node
npm run l1:node:dev -- --name my-node --host 0.0.0.0 --port 4100 --apiPort 5100 --mine

# Or connect to peers
npm run l1:node:dev -- --peers "127.0.0.1:4101,127.0.0.1:4102" --mine
```

## Project Structure

- `node/` - L1 blockchain node daemon (Node.js)
- `src/` - React frontend application
- `supabase/` - Supabase functions and migrations (legacy)

## Technologies

- **Frontend**: Vite, React, TypeScript, Tailwind CSS, shadcn-ui
- **Backend**: Node.js, TypeScript
- **Cryptography**: @noble/post-quantum (ML-DSA-65, ML-KEM-768)
- **Storage**: File-based JSONL storage for blockchain data

## Deployment

See deployment guides:
- `DEPLOYMENT_SUMMARY.md` - Quick overview
- `DEPLOYMENT_HOSTINGER.md` - VPS deployment guide
- `DEPLOYMENT_NETLIFY.md` - Frontend deployment guide
- `QUICK_START_VPS.sh` - Automated VPS setup script

## Documentation

- `node/README.md` - Node daemon documentation
- `node/FEES.md` - Transaction fee mechanism
- `node/PERFORMANCE.md` - Performance optimizations
- `PUBLIC_API.md` - Public API documentation
- `TROUBLESHOOTING_TRANSACTIONS.md` - Transaction debugging guide

## License

MIT
