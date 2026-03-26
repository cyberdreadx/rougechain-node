# Changelog

All notable changes to RougeChain.

---

## Testnet v0.2.3 — March 2026

### Security Hardening
- **Signed API requests** — All 16 mail, messenger, and name registry endpoints now require ML-DSA-65 signed requests via `/api/v2/` routes. Legacy unsigned endpoints return HTTP 410 (Gone)
- **Anti-replay nonces** — Each signed request includes a cryptographically random nonce; duplicates within the timestamp window are rejected server-side
- **Multi-recipient CEK encryption** — Mail content encrypted once with a random AES-256 CEK, KEM-wrapped individually per recipient via ML-KEM-768
- **Unified mail signatures** — Single ML-DSA-65 signature over concatenation of all encrypted parts (subject + body + attachment) prevents partial content substitution
- **TOFU key verification** — Public key fingerprints (SHA-256) tracked on first use with key-change warnings displayed in messenger UI
- **Atomic name registration** — Name registry uses sled compare-and-swap (CAS) to prevent TOCTOU race conditions during name claims
- **Sled messenger storage** — Messenger data migrated from JSON file to sled embedded database with per-record atomic operations and automatic migration from legacy format
- **Server-side input validation** — Length limits enforced on all fields (display names: 50 chars, message content: 2 MB, mail subject: 10 KB, mail body: 512 KB, attachments: 3 MB, max 50 recipients)
- **Session-only private keys** — Web app stores private keys in `sessionStorage` (cleared on tab close) instead of `localStorage`; encrypted wallet blob persists in `localStorage`
- **Legacy decryption removal** — Pre-v2 mail and messenger decryption fallbacks removed to reduce attack surface

### Changed
- Messenger, mail, and name registry SDK methods now require a `wallet` parameter for request signing
- `WHITEPAPER.md` updated to v1.7 with full security hardening documentation

---

## Testnet v0.2.2 — March 2026

### Added
- **SDK v0.8.4** — Name registry methods: `rc.mail.registerName()`, `rc.mail.resolveName()`, `rc.mail.reverseLookup()`, `rc.mail.releaseName()`
- **SDK types** — `NameEntry`, `ResolvedName` exported for TypeScript consumers
- **Browser Extension** — BIP-39 seed phrase support: generate, view, and import 24-word mnemonic phrases

### Fixed
- API docs corrected: name registry endpoints now show actual routes (`/names/resolve/:name`, `/names/reverse/:walletId`) instead of non-existent query-param URLs
- Blockchain explorer chain validation no longer fails on descending block order from API
- Tamper detection demo works correctly with real blocks from the API
- SDK `SwapQuoteParams` now includes required `tokenOut` field

---

## Testnet v0.2.1 — March 2026

### Added
- **Mail Attachments** — Encrypted file attachments (up to 2 MB) via ML-KEM-768
- **Push Notifications** — PQC-signed Expo push token registration (`/api/push/register`)
- **Address Resolution** — Convert between `rouge1…` and hex via `/api/resolve/:input`
- **Account Nonce API** — `GET /api/account/:pubkey/nonce` for replay protection
- **SDK v0.8.2** — `registerPushToken()`, `unregisterPushToken()`, `resolveAddress()`, `getNonce()`

### Fixed
- Auto-migration of stale timestamp-based nonces to sequential nonces on node startup

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
