# PQC Messaging & Mail

RougeChain includes two built-in communication systems — both fully end-to-end encrypted with post-quantum cryptography.

## Overview

| Feature | Messenger | Mail |
|---------|-----------|------|
| **Purpose** | Real-time chat | Async email |
| **Encryption** | ML-KEM-768 + AES-GCM | ML-KEM-768 + AES-GCM |
| **Addresses** | Wallet public keys | `@rouge.quant` / `@qwalla.mail` names |
| **Media** | Images, videos (auto-compressed) | Text + attachments (up to 2 MB) |
| **Self-destruct** | ✅ Configurable timer | ❌ |
| **Folders** | — | Inbox, Sent, Trash |
| **Threading** | Conversations | Reply chains |
| **Server sees** | Encrypted blobs only | Encrypted blobs only |

## Why Post-Quantum?

Classical encrypted messengers (Signal, WhatsApp) use algorithms like X25519 and Ed25519. A sufficiently powerful quantum computer could break these with Shor's algorithm.

RougeChain's messaging uses **ML-KEM-768** (CRYSTALS-Kyber, FIPS 203) for key encapsulation — resistant to both classical and quantum attacks. Messages encrypted today remain secure even if quantum computers arrive in the future.

## How It Works

```
Alice                                       Bob
  │                                          │
  │ 1. Look up Bob's ML-KEM-768 public key   │
  │ 2. Encapsulate → shared secret           │
  │ 3. HKDF → AES-256 key                   │
  │ 4. AES-GCM encrypt (for Bob)            │
  │ 5. AES-GCM encrypt (for self)           │
  │                                          │
  │── Both ciphertexts sent to server ──────►│
  │                                          │
  │                  6. Decapsulate → same shared secret
  │                  7. HKDF → same AES-256 key
  │                  8. AES-GCM decrypt
```

**Key principle:** The server stores two encrypted blobs per message — one for the sender, one for the recipient. It never has the keys to decrypt either.

## Messenger

The real-time messenger is built into the RougeChain web app and browser extension.

### Features

- **E2E encrypted conversations** between any two wallets
- **Media sharing** — images (auto-converted to WebP) and videos (VP9 WebM), compressed client-side
- **Self-destruct messages** — set a timer; message disappears after being read
- **Display names** — register a name that shows in conversations
- **Contact blocking** — client-side block list stored in localStorage
- **Conversation management** — create, view, and delete conversations

### Getting Started

1. Go to **Messenger** in the sidebar
2. Your wallet is automatically registered
3. Enter a recipient's public key to start a conversation
4. Messages are encrypted before leaving your browser

### API Endpoints

See [Messenger API Reference](../api-reference/messenger.md) for full endpoint documentation.

## PQC Mail

Mail adds traditional email features on top of the same PQC encryption layer.

### `@rouge.quant` Addresses

Instead of sharing long public keys, register a human-readable name:

| Action | Result |
|--------|--------|
| Register "alice" | You get `alice@rouge.quant` |
| Send to "bob" | System looks up Bob's public key automatically |

Names are unique and first-come-first-served.

### Mail Features

- **Subject lines** — encrypted along with the body
- **Folders** — Inbox, Sent, Trash with move/delete operations
- **Threading** — reply chains built client-side via `replyToId`
- **Mark as read** — track read status per message

### Email Domains

| Domain | Platform |
|--------|----------|
| `@rouge.quant` | Website and browser extensions |
| `@qwalla.mail` | QWalla mobile app (future) |

### Getting Started

1. Go to **Mail** in the sidebar
2. Click **Register Name** and choose your `@rouge.quant` address
3. Send encrypted mail to any registered name
4. All encryption/decryption happens in your browser

### API Endpoints

See [Mail API Reference](../api-reference/mail.md) for full endpoint documentation.

## Security Properties

| Property | Details |
|----------|---------|
| **Quantum-resistant** | ML-KEM-768 key encapsulation (FIPS 203) |
| **Forward secrecy** | Each message uses a fresh encapsulation |
| **Zero-knowledge server** | Server stores only ciphertext — cannot read messages |
| **Client-side crypto** | All encryption/decryption in the browser via WebAssembly |
| **Dual ciphertext** | Sender and recipient each get their own encrypted copy |

## SDK Usage

```typescript
import { RougeChain, Wallet } from '@rougechain/sdk';

const rc = new RougeChain('https://testnet.rougechain.io/api');
const wallet = Wallet.generate();

// Step 1: Register wallet (provides encryption key to the node)
await rc.messenger.registerWallet({
  id: wallet.publicKey,
  displayName: 'Alice',
  signingPublicKey: wallet.publicKey,
  encryptionPublicKey: encPubKey,
});

// Step 2: Register a mail name
await rc.mail.registerName('alice', wallet.publicKey);

// Resolve a recipient's name → wallet + encryption key
const bob = await rc.mail.resolveName('bob');
// bob.wallet.encryption_public_key → use for ML-KEM encryption

// Reverse lookup
const name = await rc.mail.reverseLookup(wallet.publicKey); // "alice"
```

For the full messenger and mail APIs, see the [SDK documentation](sdk.md).
