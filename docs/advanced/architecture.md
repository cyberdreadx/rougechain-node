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
│  │ (Actix)  │  │ Engine   │  │ / PoS    │  │ Server   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │              │              │              │       │
│  ┌────┴──────────────┴──────────────┴──────────────┴────┐ │
│  │                    Storage Layer                      │ │
│  │  chain.jsonl │ validators-db (RocksDB) │ messenger-db│ │
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
| **REST API** | HTTP endpoints via Actix-web |
| **Blockchain Engine** | Block production, transaction processing, state management |
| **Validator / PoS** | Stake tracking, proposer selection, rewards |
| **Messenger Server** | Stores encrypted messages and wallet registrations |
| **Mail Server** | Stores encrypted mail, name registry |
| **P2P Layer** | Peer discovery, block/tx propagation |
| **AMM/DEX** | Liquidity pools, swap execution, price calculation |
| **Bridge** | qETH bridge from Base Sepolia |

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
│  └─ Block hashes, tx hashes, Merkle   │
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
7. Validator includes it in next block
8. Block is signed and propagated to peers
```

### Message Flow

```
1. Sender looks up recipient's ML-KEM-768 public key
2. ML-KEM-768 encapsulation generates shared secret
3. HKDF derives AES-256 key from shared secret
4. Message is encrypted with AES-GCM (for both sender and recipient)
5. Encrypted blobs are sent to server
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

| Store | Format | Content |
|-------|--------|---------|
| `chain.jsonl` | Append-only JSON lines | Block data |
| `tip.json` | JSON | Current chain tip reference |
| `validators-db/` | RocksDB | Validator stakes and state |
| `messenger-db/` | RocksDB | Encrypted messages and wallets |

### Client Storage

| Store | Location | Content |
|-------|----------|---------|
| Wallet keys | `localStorage` | Encrypted ML-DSA-65 and ML-KEM-768 keys |
| Block list | `localStorage` | Blocked wallet addresses |
| Mail settings | `localStorage` | Email signature preferences |
| Display name | `localStorage` | User's messenger display name |

## Security Model

| Principle | Implementation |
|-----------|---------------|
| **Keys never leave client** | All signing/encryption happens in-browser |
| **Server is untrusted** | Server only stores encrypted data |
| **Quantum-resistant** | NIST-approved PQC algorithms throughout |
| **No seed phrases** | Keys are stored directly (backup via file export) |
| **Dual encryption** | Messages encrypted for both sender and recipient |
