# RougeChain - Post-Quantum Programmable Blockchain

RougeChain is a production-ready L1 blockchain built from genesis with NIST-approved post-quantum cryptography (ML-DSA-65, ML-KEM-768). Every signature, transaction, and encrypted message is quantum-safe — not as a future patch, but as the foundation.

**Live Testnet**: [rougechain.io](https://rougechain.io) | **API**: `https://testnet.rougechain.io/api` | **SDK**: `npm i @rougechain/sdk`

## Features

### Core Blockchain
- **Post-Quantum Cryptography**: ML-DSA-65 (FIPS 204) signatures, ML-KEM-768 (FIPS 203) key exchange
- **L1 Node Daemon**: Rust core with HTTP + gRPC APIs
- **Client-Side Signing**: Private keys never leave your browser
- **EIP-1559 Dynamic Fees**: Base fee auto-adjusts ±12.5% per block, base fee burned
- **BFT Finality**: Quorum certificates with ≥2/3 validator stake
- **HD Wallet Derivation**: BIP-44-like PQC key derivation from mnemonic
- **P2P Networking**: Multi-node peering with automatic peer discovery
- **Token Burning**: On-chain burn address with transparent tracking

### WASM Smart Contracts 🆕
- **wasmi Runtime**: Pure-Rust WASM interpreter (Parity/Substrate-grade)
- **Fuel-Metered Execution**: 10M default fuel limit per call
- **12 Host Functions**: Balance, transfer, storage R/W, events, SHA-256, block info
- **Persistent Contract Storage**: sled-backed key-value state per contract
- **Deterministic Addresses**: SHA-256(deployer ‖ nonce) for contract addresses
- **Deploy + Call + Query**: Full contract lifecycle via API

### MCP Agentic Layer 🆕
- **21 MCP Tools**: AI agents interact with RougeChain natively
- **First MCP-Native Blockchain**: No other L1 has built-in MCP integration
- **Chain Queries**: Stats, blocks, balances, tokens, NFTs, pools, validators
- **Contract Operations**: Deploy, call, read state, get events
- **Claude Desktop Ready**: Drop-in `claude_desktop_config.json` support

### DeFi (AMM/DEX)
- **Liquidity Pools**: Uniswap V2-style constant product AMM
- **Token Swaps**: Multi-hop routing with 0.3% fee
- **LP Tokens**: Earn fees by providing liquidity
- **Custom Tokens**: Create and deploy tokens with mint authority

### Staking & Validators
- **Proof of Stake**: Validator selection weighted by stake
- **Validator Names**: Human-readable node identifiers
- **Slashing**: Penalties for misbehavior
- **Unbonding Queue**: 100-block cooldown for unstaking

### Privacy & Shielded Transactions
- **ZK-STARK Proofs**: Winterfell-based shielded transfers
- **Commitment Scheme**: Pedersen-style commitments for note privacy
- **Nullifier Tracking**: Double-spend prevention
- **Rollup Accumulator**: Batch shielded operations for efficiency

### NFTs
- **RC-721 Collections**: Create collections with royalties and metadata
- **Batch Minting**: Mint multiple tokens in a single transaction
- **Transfer & Burn**: Full lifecycle management
- **Collection Freeze**: Prevent further minting

### Messaging & Mail
- **E2E Encrypted Messenger**: Real-time chat with ML-KEM-768 encryption
- **Encrypted Mail**: On-chain mail system with PQC encryption
- **Push Notifications**: Web push for new messages

### Bridge
- **qETH Bridge**: Bridge ETH from Base Sepolia to qETH on RougeChain
- **XRGE Bridge**: Two-way XRGE bridging to Base
- **Relayer**: Automated bridge withdrawal fulfillment

### Governance
- **Proposals**: On-chain governance proposals per token
- **Voting**: Token-weighted voting

### Browser Extension
- **RougeChain Wallet**: Manifest V3 extension for Chrome, Edge, Brave, Firefox, Arc, Opera
- **dApp Provider**: `window.rougechain` API for web integrations

## Quick Start

### Prerequisites
- Node.js 18+ (frontend)
- Rust toolchain (core node)

### Local Development

```bash
# Clone and install
git clone https://github.com/cyberdreadx/rougechain-node.git
cd rougechain-node && npm install

# Start frontend
npm run dev

# In another terminal, start the node
cd core && cargo run -p quantum-vault-daemon -- --mine
```

### Using the SDK

```bash
npm install @rougechain/sdk
```

```typescript
import { RougeChain, Wallet } from '@rougechain/sdk';

const rc = new RougeChain({ baseUrl: 'https://rougechain.io' });
const wallet = Wallet.create();

// Check balance
const balance = await rc.getBalance(wallet.address);

// Deploy a WASM smart contract
const result = await rc.deployContract({
  wasm: base64WasmBytes,
  deployer: wallet.publicKey,
  nonce: 0,
});
```

### MCP Server (AI Agent Integration)

```bash
cd mcp-server && npm install && npm run build
```

Add to your Claude Desktop config:
```json
{
  "mcpServers": {
    "rougechain": {
      "command": "node",
      "args": ["path/to/mcp-server/dist/index.js"],
      "env": { "ROUGECHAIN_URL": "https://rougechain.io" }
    }
  }
}
```

## Project Structure

```
quantum-vault/
├── core/                  # Rust L1 node daemon
│   ├── daemon/            # Main binary (API, miner, peer sync)
│   ├── types/             # Shared types and codec helpers
│   ├── crypto/            # PQC signing (ML-DSA-65) and hashing
│   ├── consensus/         # Proposer selection
│   ├── storage/           # Chain, validator, pool persistence
│   ├── vm/                # WASM smart contract engine (wasmi)
│   └── p2p/               # TCP gossip scaffolding
├── sdk/                   # TypeScript SDK (@rougechain/sdk)
├── mcp-server/            # MCP server for AI agents
├── src/                   # React frontend (Vite + TypeScript)
├── docs/                  # Documentation (GitBook format)
├── scripts/               # Bridge relayer scripts
└── extension/             # Browser wallet extension
```

## Technologies

- **Frontend**: Vite, React, TypeScript, Tailwind CSS, shadcn/ui
- **Backend**: Rust (Axum HTTP + Tonic gRPC)
- **Cryptography**: ML-DSA-65, ML-KEM-768, SHA-256 (NIST FIPS 203/204)
- **Smart Contracts**: wasmi WASM interpreter with fuel metering
- **Privacy**: ZK-STARKs (winterfell) for shielded transactions
- **Storage**: sled embedded database
- **AI Integration**: MCP (Model Context Protocol) server

## Network Info

| Property | Value |
|----------|-------|
| Chain ID | `rougechain-devnet-1` |
| Native Token | XRGE |
| Address Format | `rouge1...` (Bech32m) |
| Testnet URL | `https://testnet.rougechain.io/api` |
| Frontend | `https://rougechain.io` |
| Block Time | 400ms |
| Signing | ML-DSA-65 (CRYSTALS-Dilithium) |
| Encryption | ML-KEM-768 (CRYSTALS-Kyber) |

## License

MIT
