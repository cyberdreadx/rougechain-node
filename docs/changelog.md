# Changelog

All notable changes to RougeChain.

---

## Testnet v0.2.4 — March 2026

### Added
- **Social layer** — On-chain social features with plays, likes, comments, follows, and tips. Data is stored server-side in sled with ML-DSA-65 signed writes; tips settle on-chain via `rc.transfer()`
- **Standalone posts** — Create, delete, and fetch posts (max 4000 chars) with threaded replies via `replyToId`. Global timeline and personalized following feed endpoints
- **Reposts** — Toggle repost on any post; repost counts aggregated per post with viewer state
- **Post stats** — Aggregate endpoint returns likes, reposts, reply count, and viewer's liked/reposted state for any post
- **Following feed** — Authenticated endpoint returns posts from users the viewer follows, sorted newest-first
- **qRougee social integration** — TrackDetail shows play counts, like button, tip modal, and comments. TrackCard badges show plays/likes. ArtistProfile shows followers and follow button. Library includes a "Liked" tab. Home page sorts discovery by popularity
- **SDK v1.0.0** — `rc.social` namespace with 19 methods: `createPost`, `deletePost`, `toggleRepost`, `getPost`, `getPostStats`, `getPostReplies`, `getUserPosts`, `getGlobalTimeline`, `getFollowingFeed`, plus existing play/like/comment/follow methods
- **WASM STARK prover** — Browser-side STARK proof generation via `core/wasm-prover/` compiled to WebAssembly. Unshield and shielded transfer operations now generate real winterfell STARK proofs client-side without relying on a trusted server
- **Groq-powered Quantum Bot** — Messenger AI bot proxied through the node using Groq's `llama-3.1-8b-instant` model with a comprehensive RougeChain knowledge base
- **Mail & messenger unread badges** — Browser extension and QWalla app show unread count badges on both Chat and Mail tabs with hover tooltips (e.g. "3 unread emails"). The browser extension icon badge displays the combined unread total
- **Native browser notifications** — Browser extension fires system notifications for new messages, new mail, received/sent tokens, contract deployments, staking events, and balance changes via WebSocket and periodic polling
- **Mail reply pre-fill** — Clicking "Reply" in the browser extension auto-populates the recipient, subject (with "Re:"), and quoted original message body
- **Mail attachments (extension)** — Browser extension mail compose and read views now support file attachments with upload, preview, and download, matching the website's feature set
- **Initial unread count polling (QWalla)** — App fetches actual unread chat and mail counts from the server on launch so tab badges are accurate immediately, not just after a real-time event arrives

### Fixed
- **PWA wallet persistence** — Wallet private keys now persist in `localStorage` when no vault password is set, preventing wallet loss on PWA/tab restart. Password-protected vaults continue to use encrypted storage only
- **Browser extension key regeneration** — Removed aggressive version-based key regeneration that was replacing existing valid keys and causing loss of on-chain identity (faucet funds)
- **Quantum Bot registration** — Bot wallets use unique per-browser IDs and register as non-discoverable to prevent display name conflicts
- **Browser extension messenger** — All 8 messenger endpoints migrated from legacy unsigned v1 to ML-DSA-65 signed v2 endpoints, fixing "Registration failed" errors in production
- **Browser extension mail decryption** — Ported v2 multi-recipient CEK encryption/decryption to the extension, fixing "[Unable to decrypt]" on mail sent from the website
- **QWalla mail encryption** — Added v2 CEK encryption/decryption for cross-client mail compatibility with the website and browser extension
- **QWalla message signing** — Messages now include ML-DSA-65 content signatures; fixed `ml_dsa65.sign` argument order that caused "secretKey expected Uint8Array of length 4032" errors
- **Message signature display** — Three-state indicator: green check (verified), red X (failed), grey shield (no signature) — prevents false negatives on unsigned legacy messages
- **Shielded note badge** — Browser extension wallet tab now shows shielded notes for the current wallet only (per-wallet `getActiveNotes`) instead of the global chain stat
- **Unread badge persistence** — Badge clears correctly after viewing messages; `lastKnownUnread` persisted to `chrome.storage.local` to survive service worker restarts
- **QWalla `@qwalla.mail` domain** — Mail addresses now display as `@qwalla.mail` throughout the app instead of `@rouge.quant`
- **QWalla mail name resolution** — Mail list and detail views resolve and display registered names instead of raw wallet IDs

### Changed
- **Validator economics** — Base fee burn reduced from 100% to 50%; remaining 50% flows into the tip pool for validator rewards. A 0.1 XRGE/block minimum tip floor is guaranteed from the staking reserves allocation
- **Minimum stake** — Enforced at 10,000 XRGE (previously unenforced). Staking requests below this threshold are rejected
- **Entropy prefetch** — ANU QRNG entropy is now fetched in a background thread and cached, eliminating per-block blocking HTTP calls that could stall block production for up to 20 seconds
- Service worker cache bumped to `rougechain-v2` to invalidate stale assets on existing PWA installs
- Session-only private keys policy updated: `localStorage` used for unprotected wallets, `sessionStorage`-only when vault passphrase is configured

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
- **Session-only private keys** — Web app stores private keys in `sessionStorage` (cleared on tab close) instead of `localStorage`; encrypted wallet blob persists in `localStorage` *(superseded in v0.2.4: localStorage used when no vault password is set for PWA persistence)*
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
