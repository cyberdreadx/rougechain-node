# Quantum Vault Core (Rust)

This directory contains the Rust-based core node implementation that replaces
the previous JS node/crypto logic. The React UI remains in `/src` and calls
this daemon via HTTP bridge endpoints and gRPC.

## Crate Structure

- `daemon`: Binary that runs the node and exposes gRPC + HTTP APIs
- `types`: Shared types + codec helpers
- `crypto`: Hashing + PQC signing (ML-DSA-65) helpers
- `consensus`: Proposer selection utilities
- `storage`: Chain, validator, messenger, pool persistence
- `p2p`: TCP gossip scaffolding

## Key Features

### Post-Quantum Cryptography
- **ML-DSA-65** (CRYSTALS-Dilithium) for signatures
- Quantum-resistant transaction signing
- Client-side signature verification

### AMM/DEX (Uniswap V2-style)
- Constant product market maker (x * y = k)
- 0.3% swap fee
- Multi-hop routing
- LP token minting/burning
- Pool event tracking and price history

### Token Burning
- Official burn address: `XRGE_BURN_0x...DEAD`
- Permanent token destruction
- On-chain burn tracking per token

### Secure v2 API
- Client-side transaction signing
- Private keys never sent to server
- Timestamp validation (5-minute window)
- Nonce for replay protection

## Running the Node

```bash
# Development
cargo run -p quantum-vault-daemon -- --host 0.0.0.0 --port 4100 --api-port 5100 --mine

# Production build
cargo build --release
./target/release/quantum-vault-daemon --host 0.0.0.0 --port 4100 --api-port 5100 --mine
```

## Command Line Options

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Host to bind |
| `--port` | `4100` | P2P port |
| `--api-port` | `5100` | HTTP API port |
| `--chain-id` | `rougechain-devnet-1` | Chain identifier |
| `--block-time-ms` | `1000` | Block time in milliseconds |
| `--mine` | `false` | Enable mining/block production |
| `--data-dir` | `~/.quantum-vault/` | Data directory |
| `--api-keys` | `None` | Comma-separated API keys |
| `--peers` | `None` | Comma-separated peer URLs |

## API Endpoints

See `PUBLIC_API.md` in the project root for full API documentation.

### Key Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/stats` | GET | Node statistics |
| `/api/balance/{pubkey}` | GET | Get balance |
| `/api/pools` | GET | List liquidity pools |
| `/api/swap/quote` | POST | Get swap quote |
| `/api/burned` | GET | Get burned token stats |
| `/api/v2/*` | POST | Secure signed transactions |
