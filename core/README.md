# Quantum Vault Core (Rust)

The Rust-based core node implementation for RougeChain. Handles block production,
transaction processing, peer synchronization, and exposes gRPC + HTTP APIs.

## Crate Structure

- `daemon` - Binary that runs the node and exposes HTTP + JSON-RPC + WebSocket APIs
- `cli` - CLI wallet binary (`rougechain`) for key management and transactions
- `types` - Shared types, transaction encoding, and codec helpers
- `crypto` - Hashing + PQC signing (ML-DSA-65) + encryption (ML-KEM-768)
- `consensus` - Proposer selection utilities
- `storage` - Chain, validator, messenger, pool persistence (sled)
- `vm` - WASM smart contract runtime (wasmi sandbox)
- `p2p` - TCP gossip scaffolding

## Key Features

### Post-Quantum Cryptography
- **ML-DSA-65** (CRYSTALS-Dilithium) for all transaction signatures
- Quantum-resistant transaction signing and verification
- Client-side signature verification via the v2 API
- Dual-format signature support for backward compatibility

### Transaction Signing
- **V1 (daemon-signed)**: The daemon signs transactions using `encode_tx_for_signing()` which serializes the `TxV1` struct without the `sig` field
- **V2 (client-signed)**: The browser signs a JSON payload with sorted keys. The daemon stores the original signed payload in `TxV1.signed_payload` so peers can verify the signature during block import

### AMM/DEX (Uniswap V2-style)
- Constant product market maker (x * y = k)
- 0.3% swap fee
- Multi-hop routing
- LP token minting/burning
- Pool event tracking and price history

### Bridge (qETH)
- Bridge ETH from Base Sepolia to qETH on RougeChain
- Bridge withdrawals: burn qETH and record withdrawal for operator fulfillment
- Configurable custody address via `--bridge-custody-address`
- 6 decimal places for qETH amounts

### Token System
- Custom token creation with configurable supply
- Token burning via official burn address (`XRGE_BURN_0x...DEAD`)
- On-chain burn tracking per token

### P2P Networking
- Automatic peer discovery through known peers
- Block sync with incremental imports
- Per-peer exponential backoff for unreachable peers (20s → 10min max)
- First failure logged, subsequent failures suppressed until peer recovers
- Transaction and block broadcast to all peers

### Secure v2 API
- Client-side transaction signing
- Private keys never sent to server
- Timestamp validation (5-minute window)
- Nonce for replay protection

### BFT Finality
- Domain-separated ML-DSA-65 vote signatures (`ROUGECHAIN_VOTE:{height}:{round}:{hash}`)
- Quorum verification: block finalized at 2/3+ stake precommits
- Persistent finality proofs in sled (`finality-db`)
- Node loads finalized height from DB on startup

### Event Indexer
- sled-backed multi-index: by address, type, token, block
- Automatic backfill from chain store on startup
- Paginated query API at `/api/indexer/*`

### Prometheus Metrics
- `/metrics` endpoint (Prometheus text format)
- Gauges: block height, finalized height, validators, staked, mempool, peers, ws clients, base fee, indexed events
- Counters: total fees collected, total fees burned

## Running the Node

```bash
# Development
cargo run -p quantum-vault-daemon -- --mine

# Production build
cargo build --release
./target/release/quantum-vault-daemon --mine --host 0.0.0.0 --api-port 5100

# With peer sync
./target/release/quantum-vault-daemon --mine --peers https://testnet.rougechain.io/api

# With bridge support
./target/release/quantum-vault-daemon --mine --bridge-custody-address 0xYOUR_ADDRESS

# Full production example
./target/release/quantum-vault-daemon \
  --mine \
  --host 0.0.0.0 \
  --api-port 8900 \
  --peers https://testnet.rougechain.io/api \
  --bridge-custody-address 0xYOUR_ADDRESS

# Docker (recommended)
docker compose up -d

# Docker with Prometheus monitoring
docker compose --profile monitoring up -d
```

### CLI Wallet

```bash
# Build
cargo build --release -p quantum-vault-cli

# Key management
rougechain keygen --label "main"
rougechain keys
rougechain whoami

# Queries
rougechain balance
rougechain token-balances
rougechain validators
rougechain stats
rougechain history --limit 50

# Transactions (ML-DSA-65 signed)
rougechain transfer <to_pubkey> 1000
rougechain stake 5000
rougechain vote <proposal_id> yes

# Raw JSON-RPC
rougechain rpc rouge_getStats
```

### Running in tmux (recommended for VPS)

```bash
tmux new-session -d -s daemon "/path/to/quantum-vault-daemon --mine --host 0.0.0.0 --api-port 5100"
tmux attach -t daemon     # view logs
# Ctrl+B then D to detach without stopping
```

## Command Line Options

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Host to bind (use `0.0.0.0` for public access) |
| `--port` | `4101` | gRPC port |
| `--api-port` | `5101` | HTTP API port |
| `--chain-id` | `rougechain-devnet-1` | Chain identifier |
| `--block-time-ms` | `400` | Block time in milliseconds |
| `--mine` | `false` | Enable mining/block production |
| `--data-dir` | `~/.quantum-vault/` | Data directory |
| `--api-keys` | `None` | Comma-separated API keys (env: `QV_API_KEYS`) |
| `--peers` | `None` | Comma-separated peer URLs (env: `QV_PEERS`) |
| `--public-url` | `None` | Public URL for peer discovery (env: `QV_PUBLIC_URL`) |
| `--bridge-custody-address` | `None` | Bridge custody address (env: `QV_BRIDGE_CUSTODY_ADDRESS`) |
| `--base-sepolia-rpc` | `https://sepolia.base.org` | Base Sepolia RPC URL |
| `--rate-limit-per-minute` | `0` | Global rate limit (0 = unlimited) |
| `--rate-limit-read-per-minute` | `0` | Read operation rate limit |
| `--rate-limit-write-per-minute` | `0` | Write operation rate limit |
| `--faucet-whitelist` | `None` | Faucet whitelist (env: `QV_FAUCET_WHITELIST`) |

## API Endpoints

See `PUBLIC_API.md` in the project root for full API documentation.

### Key Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/stats` | GET | Node statistics |
| `/api/balance/{pubkey}` | GET | Get balance |
| `/api/blocks` | GET | List blocks |
| `/api/tokens` | GET | List all tokens |
| `/api/pools` | GET | List liquidity pools |
| `/api/swap/quote` | POST | Get swap quote |
| `/api/burned` | GET | Get burned token stats |
| `/api/peers` | GET | List connected peers |
| `/api/finality/:height` | GET | Get BFT finality proof |
| `/api/fee` | GET | Current fee info (EIP-1559) |
| `/api/indexer/address/:addr` | GET | Events by address |
| `/api/indexer/type/:type` | GET | Events by tx type |
| `/api/indexer/token/:symbol` | GET | Events by token |
| `/api/indexer/block/:height` | GET | Events by block |
| `/api/indexer/stats` | GET | Indexer statistics |
| `/metrics` | GET | Prometheus metrics |
| `/api/bridge/config` | GET | Bridge configuration |
| `/api/v2/*` | POST | Secure client-signed transactions |
| `/api/ws` | WS | Real-time block/tx updates |
| `/rpc` | POST | JSON-RPC 2.0 (eth_*/rouge_*) |

### V2 Endpoints (Client-Signed)

| Endpoint | Description |
|----------|-------------|
| `/api/v2/transfer` | Transfer tokens |
| `/api/v2/token/create` | Create a new token |
| `/api/v2/pool/create` | Create a liquidity pool |
| `/api/v2/pool/add-liquidity` | Add liquidity to a pool |
| `/api/v2/pool/remove-liquidity` | Remove liquidity |
| `/api/v2/swap/execute` | Execute a token swap |
| `/api/v2/stake` | Stake XRGE |
| `/api/v2/unstake` | Unstake XRGE |
| `/api/v2/faucet` | Request testnet tokens |
