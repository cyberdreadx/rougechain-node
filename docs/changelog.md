# Changelog

All notable changes to RougeChain.

---

## Testnet v0.2.0 — March 2026

### Added
- **PQC Mail** — Encrypted email with `@rouge.quant` addresses, threading, and folder management
- **RC-721 NFTs** — Collections, batch minting, royalties, transferring, burning, and freezing
- **AMM/DEX** — Uniswap V2-style liquidity pools, swaps, and price charts
- **XRGE Bridge** — Bidirectional bridge for XRGE between RougeChain and Base (ERC-20)
- **Shielded Transactions** — Private transfers using STARK proofs with on-chain nullifiers
- **Token Staking Pools** — Stake custom tokens with configurable reward rates
- **Governance** — On-chain proposal creation and weighted voting
- **Token Locking** — Time-locked and vesting token locks
- **Token Allowances** — Approve and spend-from delegation
- **ZK Rollup (Phase 3)** — Batch transaction accumulation with proof submission
- **Tiered Rate Limiting** — Validators and peers get separate rate limit tiers
- **Network Globe** — 3D visualization of connected nodes on the blockchain page
- **SDK** — `@rougechain/sdk` npm package for building dApps
- **Docker Support** — One-command node deployment with `docker run`
- **Node Dashboard** — Built-in web dashboard at `http://localhost:5100` when running a node
- **Name Registry** — Register human-readable names for wallets (`alice@rouge.quant`)
- **Browser Extensions** — Chrome/Firefox wallet extensions with vault lock

### Changed
- Default block time reduced from 1000ms to **400ms**
- `--peers` URL now requires `/api` suffix (e.g., `https://testnet.rougechain.io/api`)
- v1 endpoints that accept private keys are disabled by default (use `--dev` to enable)
- Secure v2 API with client-side signing is the default for all write operations

### Security
- All signatures use **ML-DSA-65** (FIPS 204)
- All key encapsulation uses **ML-KEM-768** (FIPS 203)
- Client-side signing — private keys never leave your browser
- Validator-proven rate limiting with PQC signature verification

---

## Testnet v0.1.0 — February 2026

### Added
- **Core blockchain** — Proof of Stake L1 with PQC cryptography
- **Wallet** — Generate ML-DSA-65 keypairs, send/receive XRGE
- **Faucet** — Request Testnet tokens
- **Validator staking** — Stake XRGE to become a block proposer
- **Encrypted Messenger** — E2E encrypted messaging with ML-KEM-768 and AES-GCM
- **Self-destruct messages** — Messages that auto-delete after being read
- **Token creation** — Create custom tokens with metadata
- **Token burning** — Official burn address with on-chain tracking
- **P2P networking** — Peer discovery, block propagation, and automatic sync
- **ETH Bridge (qETH)** — Bridge ETH from Base Sepolia with 6-decimal precision
- **Block Explorer** — Browse blocks, transactions, and addresses
- **gRPC API** — Chain, wallet, validator, and messenger services
- **REST API** — Full HTTP API for all blockchain operations
