# Architecture

An overview of RougeChain's system architecture.

## High-Level Architecture

```
┌───────────────────────────────────────────────────────────┐
│                      Clients                               │
│                                                           │
│  ┌──────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │ Website  │  │ Browser Extension│  │ @rougechain/sdk│  │
│  │ React    │  │ Chrome / Firefox │  │ npm package    │  │
│  └────┬─────┘  └────────┬─────────┘  └───────┬────────┘  │
│       │                 │                     │           │
│       │   Client-side ML-DSA-65 signing       │           │
│       │   Client-side ML-KEM-768 encryption   │           │
│       └────────────┬────┴─────────────────────┘           │
└────────────────────┼──────────────────────────────────────┘
                     │ HTTPS REST API
                     ▼
┌───────────────────────────────────────────────────────────┐
│                   Core Node (Rust)                        │
│                                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ REST API │  │Blockchain│  │Validator │  │Messenger │ │
│  │ (Axum)   │  │ Engine   │  │ / PoS    │  │ Server   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │              │              │              │       │
│  ┌────┴──────────────┴──────────────┴──────────────┴────┐ │
│  │                    Storage Layer                      │ │
│  │  sled: chain-db │ validators-db │ messenger-db │ …   │ │
│  └──────────────────────────────────────────────────────┘ │
└────────────────────┬──────────────────────────────────────┘
                     │ P2P (HTTP)
                     ▼
┌───────────────────────────────────────────────────────────┐
│                    Peer Nodes                             │
│         Block sync │ TX broadcast │ Peer discovery        │
└───────────────────────────────────────────────────────────┘
```

## Components

### Core Node (Rust)

The backend is a single Rust binary (`quantum-vault-daemon`) that includes:

| Module | Responsibility |
|--------|---------------|
| **REST API** | HTTP endpoints via Axum 0.6 (on hyper), default `--api-port` 5101. Peers sync over this same port — there is no separate P2P port |
| **gRPC API** | tonic client services (chain, wallet, validator, messenger) on `--port`, default 4101. Not used for peer traffic |
| **Blockchain Engine** | Block production, transaction processing, state management |
| **Validator / PoS** | Stake tracking, proposer selection, rewards |
| **Messenger Server** | Stores encrypted messages and wallet registrations |
| **Mail Server** | Stores encrypted mail, name registry |
| **P2P Layer** | HTTP polling of peers' `/api/peers`, `/api/stats` and `/api/blocks`; HTTP push of new blocks and txs |
| **AMM/DEX** | Liquidity pools, swap execution, price calculation |
| **Bridge** | R1 production bridge to Base mainnet (XRGE, qETH, qUSDC); separate Bitcoin bridge. V3 post-quantum XRGE bridge code is present but not activated |

### Frontend (React + TypeScript)

The website at [rougechain.io](https://rougechain.io) is a single-page application built with:

| Technology | Purpose |
|------------|---------|
| React 18 | UI framework |
| TypeScript | Type safety |
| Vite | Build tool |
| Tailwind CSS | Styling |
| shadcn/ui | Component library |
| `@noble/post-quantum` | PQC cryptography (ML-DSA-65, ML-KEM-768) |

The frontend is a PWA (Progressive Web App) and can be installed on mobile and desktop.

### Browser Extensions

Two Chrome extensions provide wallet functionality:

| Extension | Description |
|-----------|-------------|
| **RougeChain Wallet** | Primary browser extension |
| **rougechain-wallet** | Secondary extension |

Both inject a `window.rougechain` provider (similar to MetaMask's `window.ethereum`) for dApp integration.

### SDK (`@rougechain/sdk`)

The npm package `@rougechain/sdk` provides a programmatic interface for interacting with RougeChain from Node.js or browser applications.

## Cryptography Stack

```
┌─────────────────────────────────────────┐
│            Application Layer            │
│  Transactions │ Messages │ Mail │ Auth  │
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│         Cryptographic Primitives        │
│                                         │
│  ML-DSA-65 (FIPS 204)                  │
│  └─ Signing: txs, blocks, stakes       │
│                                         │
│  ML-KEM-768 (FIPS 203)                 │
│  └─ Key encapsulation: messenger, mail │
│                                         │
│  AES-256-GCM                           │
│  └─ Symmetric encryption of content    │
│                                         │
│  HKDF (SHA-256)                        │
│  └─ Key derivation from shared secrets │
│                                         │
│  SHA-256                               │
│  └─ Block hashes, tx hashes           │
└─────────────────────────────────────────┘
```

## Data Flow

### Transaction Flow

```
1. User creates transaction in browser
2. Transaction payload is constructed
3. ML-DSA-65 signs the payload client-side
4. Signed transaction is sent to node via REST API
5. Node verifies signature
6. Transaction enters mempool
7. The designated proposer includes it in the next block
8. Block is signed and propagated to peers
```

### Message Flow

```
1. Sender looks up recipient's ML-KEM-768 public key
2. ML-KEM-768 encapsulation generates shared secret
3. HKDF derives AES-256 key from shared secret
4. Message is encrypted with AES-GCM (for both sender and recipient)
5. The encrypted package is sent to the server
6. Recipient fetches encrypted blob
7. ML-KEM-768 decapsulation recovers shared secret
8. Message is decrypted client-side
```

### Mail Flow

```
1. User registers a name (e.g., alice@rouge.quant) via Name Registry
2. Sender composes email, encrypts subject + body with PQC
3. Encrypted mail is stored on the server
4. Recipient fetches and decrypts client-side
5. Thread history is reconstructed via replyToId chain
```

## Storage

### Node Storage

All node state lives in [sled](https://github.com/spacejam/sled) embedded databases (`*-db/` directories) under the data directory, plus a few JSON files.

| Store | Format | Content |
|-------|--------|---------|
| `chain-db/` | sled | Block data (the chain tip is the last key) |
| `validators-db/` | sled | Validator stakes and state |
| `messenger-db/`, `mail-db/` | sled | Encrypted messages, mail, and wallet registrations |
| other `*-db/` | sled | Pools, NFTs, finality, nonces, social, and other state |
| `chain.jsonl` | JSON lines | Legacy only: imported once into `chain-db` on first start, then renamed to `chain.jsonl.bak` |

### Client Storage

| Store | Location | Content |
|-------|----------|---------|
| Wallet keys | `localStorage` | ML-DSA-65 and ML-KEM-768 keys — only as an AES-256-GCM encrypted vault (password required); decrypted keys live in `sessionStorage` while unlocked |
| Block list | `localStorage` | Blocked wallet addresses |
| Mail settings | `localStorage` | Email signature preferences |
| Display name | `localStorage` | User's messenger display name |

## Security Model

| Principle | Implementation |
|-----------|---------------|
| **Keys never leave client** | All signing/encryption happens in-browser |
| **Server is untrusted** | Messages and mail are stored only as ciphertext (the server still sees metadata such as sender, recipients, and timing) |
| **Quantum-resistant L1** | NIST-approved PQC algorithms for L1 signatures and messaging. Base-side bridge custody is classical today — see [Security Overview](../security.md) |
| **BIP-39 mnemonics** | Wallets derive from a 24-word BIP-39 mnemonic (256-bit entropy); the mnemonic is the primary backup for the signing key. The ML-KEM-768 messaging key is derived from the mnemonic (`ml_kem768.keygen(SHA-512("<mnemonic>|rougee-gram|kem-v1"))`, same as Qwalla) for wallets created or imported from the phrase since 2026-10-01; older website wallets and extension wallets have a random one that only their `.pqcbackup` file restores. With a wallet password set, keys are encrypted at rest with AES-256-GCM (PBKDF2, 600k iterations) |
| **Signed v2 writes** | `/api/v2` writes require an ML-DSA-65 signature over a canonical payload; legacy v1 write endpoints return `410 Gone` in production |
| **Per-recipient encryption** | Messages encrypted for the sender and every recipient |

### v2 Signed Write Requirements

Every write through `/api/v2` is authenticated by signature, not by a session:

1. The request is a signed envelope `{ payload, signature, public_key }`.
2. The signature is an **ML-DSA-65** signature over the canonical `payload` bytes.
3. `payload.timestamp` must fall within a **±5-minute** window of server time.
4. `payload.from` must equal the signing public key (`public_key`).
5. A **signature replay guard** (`SEEN_SIGNATURES`, keyed by `sha256(signature)`, 5-minute window, persisted to `replay_guard.json` across restarts) rejects any signature already seen in-window.
6. Legacy v1 write endpoints return **410 Gone** in production.
