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

### Messenger Encryption

```
Alice                                       Bob
  │                                          │
  │ 1. Look up Bob's ML-KEM-768 public key   │
  │ 2. Encapsulate → shared secret           │
  │ 3. HKDF → AES-256 key                   │
  │ 4. AES-GCM encrypt (for Bob)            │
  │ 5. AES-GCM encrypt (for self)           │
  │                                          │
  │── Signed request to /api/v2/... ────────►│
  │                                          │
  │                  6. Decapsulate → same shared secret
  │                  7. HKDF → same AES-256 key
  │                  8. AES-GCM decrypt
```

**Key principle:** The server stores two encrypted blobs per message — one for the sender, one for the recipient. It never has the keys to decrypt either.

### Mail Encryption (CEK Pattern)

Mail uses a Content Encryption Key (CEK) pattern for efficient multi-recipient support:

1. Generate a random 256-bit AES key (the CEK)
2. Encrypt all mail content (subject, body, attachment) once with the CEK via AES-256-GCM
3. For each recipient (and the sender): KEM-wrap the CEK using their ML-KEM-768 public key
4. Sign the concatenation of all encrypted parts with ML-DSA-65 (unified signature)

This design encrypts content only once regardless of recipient count.

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
| `@rouge.quant` | Website and browser extension |
| `@qwalla.mail` | QWalla mobile app |

Both domains resolve against the same on-chain name registry — the domain is a client-side display choice only.

### Getting Started

1. Go to **Mail** in the sidebar
2. Click **Register Name** and choose your `@rouge.quant` address
3. Send encrypted mail to any registered name
4. All encryption/decryption happens in your browser

### API Endpoints

See [Mail API Reference](../api-reference/mail.md) for full endpoint documentation.

## Authenticated Requests

All mail, messenger, and name registry write operations require ML-DSA-65 signed requests via `/api/v2/` endpoints. Each request includes:

- **`from`** — Sender's ML-DSA-65 public key
- **`timestamp`** — Millisecond-precision timestamp (valid within a 5-minute window)
- **`nonce`** — 16 bytes of random hex (prevents replay attacks)
- **`signature`** — ML-DSA-65 signature over the canonical JSON payload

The server verifies the signature, validates the timestamp, confirms the sender owns the wallet, and rejects duplicate nonces. Legacy unsigned endpoints return HTTP 410 (Gone) in production.

## Trust-on-First-Use (TOFU)

The messenger tracks public key fingerprints (SHA-256 hash) for contacts:

- On first interaction, the contact's key fingerprint is stored locally
- On subsequent interactions, the fingerprint is compared — a "Key Changed" warning appears if it differs
- The shortened fingerprint is shown in the chat header for manual verification

## Security Properties

| Property | Details |
|----------|---------|
| **Quantum-resistant** | ML-KEM-768 key encapsulation (FIPS 203) |
| **Forward secrecy** | Each message uses a fresh encapsulation |
| **Zero-knowledge server** | Server stores only ciphertext — cannot read messages |
| **Client-side crypto** | All encryption/decryption in the browser via WebAssembly |
| **Dual ciphertext** | Sender and recipient each get their own encrypted copy |
| **Signed requests** | All API calls authenticated with ML-DSA-65 signatures |
| **Anti-replay** | Nonce + timestamp prevents request replay attacks |
| **TOFU** | Key fingerprint tracking with change detection |
| **Unified signatures** | Mail signed over all encrypted parts (subject + body + attachment) |
| **CEK multi-recipient** | Efficient per-recipient key wrapping without re-encryption |
| **Atomic name registry** | Compare-and-swap prevents race conditions on name claims |
| **Persistent or vaulted keys** | Private keys in localStorage (no password) or AES-256-GCM encrypted blob (with vault passphrase); active session keys in sessionStorage |

## Notifications & Unread Badges

### Browser Extension

The browser extension tracks unread counts for both **Chat** and **Mail** tabs:

| Feature | Details |
|---------|---------|
| **Tab badges** | Chat and Mail tabs display a numeric badge when unread items exist |
| **Tooltips** | Hovering a badged tab shows "3 unread messages" or "2 unread emails" |
| **Extension icon badge** | The combined unread total (chat + mail) is shown on the browser toolbar icon via `chrome.action.setBadgeText` |
| **System notifications** | Native OS notifications for new messages, new mail, received/sent tokens, contract events, staking, and balance changes |
| **Badge clearing** | Viewing a conversation or inbox marks items as read server-side and updates the badge immediately |

Notifications are powered by two channels:
- **WebSocket** — Real-time transaction and balance events via `wss://testnet.rougechain.io/api/ws`
- **Polling** — Unread messenger and mail counts checked every 15 seconds via signed `/api/v2/` endpoints

### QWalla Mobile App

QWalla provides the same unread badge experience:

| Feature | Details |
|---------|---------|
| **Tab badges** | Expo Router `tabBarBadge` on Chat and Mail tabs |
| **Initial poll** | On app launch, actual unread counts are fetched from the server so badges are accurate from the start |
| **Real-time updates** | WebSocket events increment the badge for new messages and mail |
| **Push notifications** | Expo push notifications for messages, mail, and transfers (requires `registerPushToken`) |
| **Badge clearing** | Navigating to the Chat or Mail tab clears the respective unread count |

### Deriving Unread Counts

The server does not expose a dedicated "unread total" endpoint. Clients derive counts from existing data:

- **Chat:** Sum `unread_count` from each conversation returned by `POST /api/v2/messenger/conversations/list`
- **Mail:** Count inbox items where the label's `is_read` field is `false` from `POST /api/v2/mail/folder`

## SDK Usage

All write operations now require a `wallet` parameter for ML-DSA-65 request signing:

```typescript
import { RougeChain, Wallet } from '@rougechain/sdk';

const rc = new RougeChain('https://testnet.rougechain.io/api');
const wallet = Wallet.generate();

// Step 1: Register wallet (signed request)
await rc.messenger.registerWallet(wallet, {
  id: wallet.publicKey,
  displayName: 'Alice',
  signingPublicKey: wallet.publicKey,
  encryptionPublicKey: encPubKey,
});

// Step 2: Register a mail name (signed request)
await rc.mail.registerName(wallet, 'alice', wallet.publicKey);

// Resolve a recipient's name → wallet + encryption key (public, no signing needed)
const bob = await rc.mail.resolveName('bob');
// bob.wallet.encryption_public_key → use for ML-KEM encryption

// Reverse lookup (public, no signing needed)
const name = await rc.mail.reverseLookup(wallet.publicKey); // "alice"
```

For the full messenger and mail APIs, see the [SDK documentation](sdk.md).

## Social Layer

RougeChain includes a built-in social layer for posts, likes, reposts, follows, comments, and play tracking. Social data is stored server-side in sled with ML-DSA-65 signed writes — tips settle on-chain via `rc.transfer()`.

### Features

| Feature | Description |
|---------|-------------|
| **Posts** | Standalone text posts (max 4000 chars) with threaded replies via `replyToId` |
| **Timeline** | Global timeline (newest first) and personalized following feed |
| **Likes** | Toggle likes on posts or tracks — reuses the same endpoint |
| **Reposts** | Toggle reposts on any post |
| **Comments** | Track-level comments with pagination |
| **Follows** | Follow/unfollow any user; follower and following counts |
| **Play counts** | Record plays on tracks (debounced per session) |
| **Tips** | Send XRGE tips to creators via `rc.transfer()` — settles on-chain |

### API Endpoints

**Read (unsigned GET):**
- `GET /api/social/timeline` — Global timeline
- `GET /api/social/post/:postId` — Single post with stats
- `GET /api/social/post/:postId/stats` — Post engagement stats (likes, reposts, replies)
- `GET /api/social/post/:postId/replies` — Threaded replies
- `GET /api/social/user/:pubkey/posts` — User's posts
- `GET /api/social/track/:trackId/stats` — Track stats (plays, likes, comments)
- `GET /api/social/track/:trackId/comments` — Track comments
- `GET /api/social/artist/:pubkey/stats` — Artist stats (followers, following)
- `GET /api/social/user/:pubkey/likes` — User's liked IDs
- `GET /api/social/user/:pubkey/following` — User's followed artists

**Write (v2 signed POST):**
- `POST /api/v2/social/post` — Create a post
- `POST /api/v2/social/post/delete` — Delete your post
- `POST /api/v2/social/like` — Toggle like
- `POST /api/v2/social/repost` — Toggle repost
- `POST /api/v2/social/comment` — Post a comment
- `POST /api/v2/social/comment/delete` — Delete your comment
- `POST /api/v2/social/follow` — Toggle follow
- `POST /api/v2/social/play` — Record a play
- `POST /api/v2/social/feed` — Get following feed (authenticated)

### SDK Usage

```typescript
import { RougeChain, Wallet } from '@rougechain/sdk';

const rc = new RougeChain('https://testnet.rougechain.io/api');
const wallet = Wallet.generate();

// Create a post
const { post } = await rc.social.createPost(wallet, "Hello RougeChain!");

// Reply
await rc.social.createPost(wallet, "Great post!", post.id);

// Like, repost, follow
await rc.social.toggleLike(wallet, post.id);
await rc.social.toggleRepost(wallet, post.id);
await rc.social.toggleFollow(wallet, artistPubKey);

// Read timeline
const timeline = await rc.social.getGlobalTimeline();
const feed = await rc.social.getFollowingFeed(wallet);
```

### CLI Usage

```bash
# Post
rougechain post "Hello from the CLI!"

# Reply
rougechain post "Nice post!" --reply-to <post-id>

# Timeline
rougechain timeline --limit 20

# Your feed (posts from people you follow)
rougechain feed

# Like / repost
rougechain like <post-or-track-id>
rougechain repost <post-id>

# Get a post
rougechain get-post <post-id>
```
