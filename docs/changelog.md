# Changelog

All notable changes to RougeChain.

---

## Wallet message signing (`signMessage`) for logins and token gating — 2026-10-06

- New provider method `window.rougechain.signMessage({ message })` → `{ signature, publicKey, address }`
  in the browser extension **1.8.0** (built from source; not yet in the Chrome Web Store at the time
  of this entry). Qwalla gets it with its next update. Sites must feature-detect.
- The signature is ML-DSA-65 over `"\x19RougeChain Signed Message:\n" + byte length + "\n" + message`.
  A node only verifies transaction signatures over JSON documents, so a signed message can never be
  a transaction, and the reverse.
- `@rougechain/sdk` **1.13.0** (in the repository; not yet on npm) adds `signMessage`,
  `verifyMessage`, `createSignInMessage`, `parseSignInMessage` and `verifySignIn`.
- New page: [Wallet Authentication](advanced/wallet-authentication.md), with the exact formats and a
  complete token-gating server. No node change; `signTransaction` is unchanged.

## Mainnet: blocks 235 and 245 active; documentation brought up to date — 2026-10-06

- Mainnet passed **block 235** (mintable tokens, contract royalty reads) and **block 245**
  (monetary-integrity rule) in early October 2026; both operator nodes run release 1.6.3 and report
  `upgrade_schedule` `235 / 235 / 245`. The height-245 rule is in force: a block carrying a `slash`
  transaction, a faucet-flagged transaction, an invalid fee or one of the fifteen suspended types is
  invalid. Shielded transfers, token locking, token staking pools, on-chain governance and vote
  delegation are therefore **not available** — see [Status](status.md#suspended-since-block-245) for
  why and what replaces them (shielded pool V2 in development, unaudited).
- Documentation revised to match the running chain: `WHITEPAPER.md` (repository root)
  v2.4 (upgrade table with 235 and 245; STARK and shielded-pool corrections; staking, fee, bridge and
  messenger facts; the consensus redesign decided 2026-10-06 recorded as planned, not built),
  [Status](status.md), staking, bridge, messaging and API pages. Live figures (3 validators, base fee
  at the 0.001 floor, `__staking_rewards__` = 0, `__treasury__` ≈ 52 XRGE) were read from the node
  API on 2026-10-06. The whitepaper PDF shipped with the web apps still reflects v2.3.
- No code change.

## Node release 1.6.3: messenger and mail hardening — 2026-10-05

- Not a consensus change (no activation height). A messenger directory entry can only be replaced
  by the wallet that owns it (signing key); an encryption key registered to another wallet is
  refused; mail names and folders follow the owning wallet only.
- The unauthenticated legacy read routes for mail and messenger return `410 Gone`; clients use the
  signed `/api/v2` routes.
- The shielded API routes refuse a suspended transaction type before processing request data.
- [Release notes](running-a-node/release-1.6.3.md).

## Node release 1.6.2: monetary-integrity rule — mainnet 245, testnet 1390 — 2026-10-04

- Consensus upgrade (`upgrade_schedule.monetary_integrity`). From its height a block is invalid if
  it carries a transaction with a fee that is not a finite number ≥ 0, a `slash` transaction, a
  faucet-flagged transaction on a network without a faucet, or a transaction of a suspended type
  (shielded, token lock/stake, governance, delegation and the legacy `token_approve` /
  `token_transfer_from` types; allowances through `approve` / `transfer_from` are unaffected). The suspended features
  are off until a later release restores them. Below the height nothing changes; mainnet history
  replays identically.
- No activation height: stricter verification on the manual bridge-deposit claim route; the gRPC
  faucet honours the faucet switch; invalid fees are refused at the mempool and by the producer.
- Active on testnet since block 1390 (2026-10-04): transfers and the faucet finalize as before; a
  suspended type is refused with `this transaction type is suspended`.
- Mandatory: [upgrade notice](running-a-node/mandatory-upgrade-2026-10-245.md).

## Node: contracts can read NFT royalties (CONTRACT_NFT_ROYALTY) — built, activation not scheduled — 2026-10-01

- Consensus upgrade, **not active on any network** (`upgrade_schedule.contract_nft_royalty` is
  `null`). From its height contracts get two read-only host functions:
  `host_nft_royalty_bps(col, clen) → i32` (`0`–`10000`, `-1` not found) and
  `host_nft_royalty_recipient(col, clen, out, cap) → i32` (length, `-1` not found, `-2` buffer too
  small). The recipient is the canonical ledger key the wallet royalty path credits, so a contract
  that sells NFTs can pay royalty with `host_transfer`. Planned to activate at the same height as
  TOKEN_MINTING.
- Before activation nothing changes: a contract importing them fails exactly like one importing an
  unknown function. No new transaction fields, no state-root change; mainnet replay 0–137 identical.
- Same activation: `nft_create_collection` with `royaltyBps` above `10000` (over 100%) or not an
  exact integer (negative, fractional, a string, or wider than 16 bits — previously truncated) is
  rejected at creation: the API returns `400 royaltyBps must be an integer between 0 and 10000`, the
  mempool and producer refuse it, and a block carrying one is invalid. Before activation creation
  behaves exactly as before (history replays unchanged).
- New example: `contracts/nft_marketplace` — an escrow marketplace (list → escrow → buy with an
  attached XRGE payment → royalty + seller paid in integer quanta → NFT to the buyer; cancel).

## Node: mintable tokens (TOKEN_MINTING) — built, activation not scheduled — 2026-10-01

- Consensus upgrade, **not active on any network** (`upgrade_schedule.token_minting` is `null`).
  From its height a token can be created with `mintable: true` and an optional integer
  `max_supply` (≥ `initial_supply`; cap on total issuance), and its creator can mint more through
  `/api/v2/token/mint`. Block apply enforces creator-only, mintable-at-creation and the cap, and
  advances `total_minted` deterministically; once a mintable token exists the state root commits the
  mint ledger.
- Before activation nothing changes on-chain. The API now **refuses** `mintable` / `max_supply` on
  create (they used to be silently ignored, giving a fixed-supply token) and refuses mint requests,
  instead of accepting a mint that every block then dropped.
- History is unaffected: the new transaction fields are omitted when unset, so every existing
  transaction and block encodes and hashes exactly as before (pinned by tests, mainnet replay 0–137).

## Web wallet: messaging key derived from the recovery phrase — 2026-10-01

- New wallets created on rougechain.io, and wallets imported from a recovery phrase (or private
  key), now get an ML-KEM-768 messaging/mail key **derived from the phrase**, exactly as Qwalla
  does: `ml_kem768.keygen(SHA-512("<phrase>|rougee-gram|kem-v1"))` (signing private key hex in place
  of the phrase when there is none). Restoring from the 24-word phrase on the website or in Qwalla
  now gives the same messaging key, so old messages and mail stay readable.
- Existing wallets keep their current key — nothing stored is re-derived. Wallets created on the
  website before this change have a random key: keep their `.pqcbackup` to read old messages.
  Importing such a wallet from its phrase gives it the derived key (registered on next messenger /
  mail visit), as a phrase import already gave it a new key before.
- A `.pqcbackup` that contains encryption keys keeps them exactly; one without gets the derived pair.

## SDK 1.11.0: NFT batch-mint attributes, create-token fee — 2026-10-01

- Batch mints now sign per-NFT attributes as `attributes`, the field the node reads (SDK, site and
  core client). Earlier clients sent `batchAttributes`, which the node ignored, so batch-minted NFTs
  got no attributes. Requires `@rougechain/sdk` **1.11.0**; no node change.
- The SDK / core `create_token` builders now default the signed fee to 100 XRGE, what the node
  charges (it was 10).

## Web wallet: keys never stored unencrypted — 2026-10-01

- **Security fix (rougechain.io).** A new or imported wallet was saved to `localStorage` unencrypted
  before the password step, and stayed there if you left onboarding (the password was optional).
  Now the wallet is held only in the tab's `sessionStorage` until you set its password, which is
  **required** (min 8 characters, also during onboarding); only the AES-256-GCM vault is persisted.
- Existing wallets that an older version stored unencrypted keep working, but the site asks you to
  set a password before using them (with a backup option); the plaintext copy is then deleted.

## Payable contract calls (block 190) — 2026-09-28

- A contract call can carry a signed payment: `attach: {"symbol": "XRGE" | TOKEN, "amount": N}` (integer:
  quanta for XRGE, raw units for tokens). It moves to the contract **only if the call succeeds**; a
  contract refuses a payment by failing the call. Contracts read it with `host_get_attached_amount` /
  `host_get_attached_symbol`. Enables entry fees and shops. Mandatory node upgrade before block 190.
- `loot_roll`'s `roll` now costs 0.5 XRGE, so its treasury can't be drained by free rolls.
- SDK **1.10.0** (`attach`, `xrgeToQuanta`), extension **1.5.0** (approval shows the payment), MCP
  server **1.3.0**, site contract page "Attach payment".

## Node fix: exact JSON number parsing — 2026-09-28

- Contract-call fees (`gasLimit × 0.000001`) could print with more digits than the previous JSON parser
  read back exactly, so peers rejected mainnet block 177 while the producer accepted it. Nodes now parse
  numbers exactly (binary `718200bc…`); every node must run it to follow the chain past block 176.

## Grind-proof contract randomness (block 170) — 2026-09-28

- **Security fix.** One-step `host_random` rolls could be ground: the seed is fixed by the parent block
  (public) and the transaction (chosen by the sender), so a player could sign many variants offline
  and send only a winner. The earlier docs wrongly implied this was safe. No contracts were deployed.
- **`host_block_hash(height)` from block 170** (GAME_READY 3): the hash of a finished block up to 256
  back. Games commit, then settle from the hash of the next block. `contracts/loot_roll` now uses
  `roll` + `settle`. Mandatory node upgrade before block 170 — see the
  [upgrade guide](running-a-node/mandatory-upgrade-2026-09-28.md).

## Finality, game-ready contracts and LP fee collection — 2026-09-28

Node release `dbe0fc0` (binary sha256 `46e29456…`), **mandatory**:
[upgrade guide](running-a-node/mandatory-upgrade-2026-09-28.md).

- **Verified BFT finality (block 150).** Every block from 151 carries its parent's ≥⅔-stake
  precommit certificate; nodes reject blocks without one. See [Finality](staking/finality.md).
- **Player-signed contracts (block 150).** Deploy (`/api/v2/contract/publish`, 10 XRGE) and call
  (`/api/v2/contract/execute`, `gasLimit × 0.000001` XRGE) are signed by the player, who is the
  caller the contract sees. Contracts read their arguments.
- **Game-ready contracts (block 160).** Contracts hold and send custom tokens and NFTs, create their
  own collection and mint to players, roll `host_random`; moves inside cross-contract calls apply; the
  state root covers NFTs and contract code and storage. Example: `contracts/loot_roll`.
- **Contract API.** Free query endpoint, events paging and WebSocket `contract:<addr>` events,
  `Failed` receipts for reverted calls. SDK **1.9.0** `rc.contracts`, extension **1.4.0** contract
  signing, MCP server **1.2.0**.
- **LP fee collection.** Pools shows each position's uncollected fees; **Collect fees** withdraws
  exactly the fee growth and leaves the deposit (node ledger `GET /api/pool/:id/earnings/:owner`).
- **Explorer.** Swap amounts are labelled with the input token (1,000 QTEK no longer shows as XRGE).

## Messenger — deterministic threads and recoverable delete — 2026-09-25

Node release `59478e6` (binary sha256 `9a93d68b…`, non-consensus; installed on the primary 2026-09-25).

- **1:1 conversations now have a deterministic id** (`dm_…`, derived from the two participants' canonical wallet ids), and creating one that already exists returns it with `existing: true` instead of a duplicate thread. Groups are unchanged.
- **Deleting a conversation is now per participant and recoverable**: it moves to your trash for 30 days (`conversations/list` with `folder: "trash"`), `conversations/restore` brings it back, `purge: true` waives your window; the thread is removed for good only once every participant has deleted it. Message delete works the same way for the sender (`messages/restore`).
- Details: [Messenger API](api-reference/messenger.md). Addresses public issue rougechain-node #73.

## Docs status sync — 2026-09-21

- Added [Status & Roadmap](status.md), [Security Overview](security.md), [Finality](staking/finality.md),
  [Bridge Security Model](bridge/security-model.md), [V3 Post-Quantum XRGE Bridge](bridge/v3-xrge-bridge.md)
  and [Authority Rotation](bridge/authority-rotation.md).
- Clarified what is live (mainnet, hardened R1 bridge for XRGE / qETH / qUSDC) versus built but
  **not activated** (FINALITY_V2, V3 XRGE bridge with ML-DSA-65 authorization).
- Corrected stale claims: Base Sepolia → Base mainnet, qUSDC "planned" → live, auto-refund → disabled
  in production, generic BFT finality wording.

## Security Hardening — 2026-08-19

### Security Hardening
- **On-chain bridge verification** — The bridge now verifies the actual on-chain Base deposit instead of trusting caller-supplied messages. An XRGE claim requires an EVM signature and derives the credited amount from the on-chain `Transfer` log. The qETH EntryPoint/balance-delta claim path was removed in favor of a direct-to-custody, recipient-bound ECDSA claim only
- **Signature replay guard** — Signed transactions are now protected by a process-global replay guard keyed by `sha256(signature)` with a 5-minute window, closing the in-window replay hole left by the timestamp check alone
- **Bridge confirmation depth & limits** — Default bridge confirmation depth raised to **6**; added a withdraw kill-switch and a per-transaction withdrawal cap
- **Token freeze authorization** — Token freeze now cryptographically verifies the request signature and requires `signer == creator`
- **Wallet keys encrypted at rest** — Wallet keys are encrypted with **AES-256-GCM** (PBKDF2, 600k iterations) behind a mandatory password (min 8 chars); the decrypted key is kept only in memory and never written to disk, and legacy plaintext wallets are force-migrated

---

## Testnet v0.2.4 — March 2026

### Added
- **Social layer** — Node-hosted social features (not on-chain) with plays, likes, comments, follows, and tips. Data is stored server-side in sled with ML-DSA-65 signed writes; tips settle on-chain via `rc.transfer()`
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
- **Custom token transfers** — `v2_transfer` handler now correctly sets `token_symbol` on `TxPayload` (previously only set `token_name`), which the balance engine actually reads. Without this, all custom token transfers silently moved XRGE instead of the selected token
- **Browser extension token send** — Added token picker dropdown to the send form so users can send any held token, not just XRGE. Upgraded from legacy v1 `/tx/submit` (which sent the private key to the server) to v2 signed endpoint with client-side ML-DSA-65 signing
- **Browser extension import token** — Added MetaMask-style "Import Custom Token" flow: enter a symbol, validates on-chain, persists to tracked list. Replaced the "All Tokens on Chain" dump with a curated held + imported view
- **Qwalla custom token balance validation** — Send screen now fetches and validates the correct token balance when sending a custom token, instead of always checking XRGE balance
- **Website send dialog pre-selection** — Clicking "Send" from a token's detail view now pre-selects that token instead of always defaulting to XRGE
- **Swap pre-fill from Trade button** — "Trade on this Pool" now passes `tokenIn`/`tokenOut` URL params to the swap page, correctly pre-filling both sides of the swap
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
