# Messenger API

Endpoints for the end-to-end encrypted PQC messenger.

All messages are encrypted client-side using ML-KEM-768 key encapsulation and AES-GCM. The server only stores encrypted blobs — it cannot read message contents.

> **v2 API (March 2026):** All write operations now use `/api/v2/` endpoints that require ML-DSA-65 signed requests with timestamp validation and nonce-based anti-replay protection. Legacy unsigned endpoints return HTTP 410 (Gone) in production.

## Signed Request Format

All v2 write endpoints accept a signed request body:

```json
{
  "payload": {
    "action": "register_wallet",
    "from": "ml-dsa65-public-key-hex",
    "timestamp": 1710100000000,
    "nonce": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    "...": "operation-specific fields"
  },
  "signature": "ml-dsa65-signature-hex",
  "public_key": "ml-dsa65-public-key-hex"
}
```

The server verifies: (1) the ML-DSA-65 signature, (2) the timestamp is within a 5-minute window, (3) the `from` field matches the signing key, and (4) the nonce has not been used before.

## Register Messenger Wallet

```http
POST /api/v2/messenger/wallets/register
Content-Type: application/json
```

Register your wallet's encryption public key so others can send you encrypted messages and mail. **This is required before receiving mail from other apps.** Requires a signed request.

### Request Body (signed)

```json
{
  "payload": {
    "id": "wallet-uuid-or-public-key",
    "displayName": "Alice",
    "signingPublicKey": "ml-dsa65-signing-public-key-hex",
    "encryptionPublicKey": "ml-kem768-encryption-public-key-hex",
    "from": "ml-dsa65-signing-public-key-hex",
    "timestamp": 1710100000000,
    "nonce": "random-hex-nonce"
  },
  "signature": "ml-dsa65-signature-hex",
  "public_key": "ml-dsa65-signing-public-key-hex"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique wallet identifier |
| `displayName` | string | Human-readable name (unique, case-insensitive) |
| `signingPublicKey` | string | ML-DSA-65 public key (hex) |
| `encryptionPublicKey` | string | ML-KEM-768 public key (hex) — needed for E2E encryption |

### Response

```json
{
  "success": true
}
```

---

## List Messenger Wallets

```http
GET /api/messenger/wallets
```

Returns all registered messenger wallets.

### Response

```json
{
  "success": true,
  "wallets": [
    {
      "id": "wallet-uuid",
      "display_name": "Alice",
      "signing_public_key": "abc123...",
      "encryption_public_key": "def456..."
    }
  ]
}
```

---

## Send Message

```http
POST /api/v2/messenger/messages
Content-Type: application/json
```

Requires a signed request. The sender is authenticated via the ML-DSA-65 signature.

### Request Body (signed)

The `payload` includes the message fields plus `from`, `timestamp`, and `nonce`:

```json
{
  "payload": {
    "conversationId": "conv-uuid",
    "senderPublicKey": "sender-pub-hex",
    "recipientPublicKey": "recipient-pub-hex",
    "senderEncrypted": "base64-encrypted-for-sender",
    "recipientEncrypted": "base64-encrypted-for-recipient",
    "senderDisplayName": "Alice",
    "recipientDisplayName": "Bob",
    "selfDestruct": false,
    "destructSeconds": 0,
    "from": "sender-pub-hex",
    "timestamp": 1710100000000,
    "nonce": "random-hex-nonce"
  },
  "signature": "ml-dsa65-signature-hex",
  "public_key": "sender-pub-hex"
}
```

Messages are encrypted twice — once for the sender (so they can read their sent messages) and once for the recipient. The server stores both ciphertexts.

### Self-Destruct Messages

Set `selfDestruct: true` and `destructSeconds` to a value. After the recipient reads the message, it is marked as read and hidden from the UI.

### Response

```json
{
  "success": true,
  "messageId": "msg-uuid"
}
```

---

## Get Messages

```http
POST /api/v2/messenger/messages/list
Content-Type: application/json
```

Requires a signed request. The server verifies the caller is a participant in the conversation.

### Request Body (signed)

```json
{
  "payload": {
    "conversationId": "conv-uuid",
    "from": "your-pub-hex",
    "timestamp": 1710100000000,
    "nonce": "random-hex-nonce"
  },
  "signature": "ml-dsa65-signature-hex",
  "public_key": "your-pub-hex"
}
```

### Response

```json
{
  "messages": [
    {
      "id": "msg-uuid",
      "conversationId": "conv-uuid",
      "senderPublicKey": "abc...",
      "senderDisplayName": "Alice",
      "encrypted": "base64-ciphertext",
      "timestamp": 1706745600000,
      "selfDestruct": false,
      "mediaType": null
    }
  ]
}
```

---

## Mark Message as Read

```http
POST /api/v2/messenger/messages/read
Content-Type: application/json
```

Used for self-destruct messages. Requires a signed request with `messageId` and `conversationId` in the payload.

## Delete Message

```http
POST /api/v2/messenger/messages/delete
Content-Type: application/json
```

Requires a signed request with `messageId` and `conversationId` in the payload. The caller must be a conversation participant.

## Delete Conversation

```http
POST /api/v2/messenger/conversations/delete
Content-Type: application/json
```

Requires a signed request with `conversationId` in the payload. The caller must be a conversation participant.

---

## Get Conversations

```http
POST /api/v2/messenger/conversations/list
Content-Type: application/json
```

Returns all conversations for a wallet. Requires a signed request.

### Response

```json
{
  "conversations": [
    {
      "conversationId": "conv-uuid",
      "participants": [
        {
          "publicKey": "abc...",
          "displayName": "Alice"
        },
        {
          "publicKey": "def...",
          "displayName": "Bob"
        }
      ],
      "lastMessage": "2024-01-31T12:00:00Z",
      "unreadCount": 2
    }
  ]
}
```

---

## Media Messages

The messenger supports image and video attachments. Media is encrypted and sent as base64 within the message payload.

| Limit | Value |
|-------|-------|
| Max upload size | 50 MB (before compression) |
| Compressed target | ~1.5 MB |
| Image format | Converted to WebP client-side |
| Video format | Converted to WebM (VP9) client-side |

The client automatically compresses large media before encryption and sending.

---

## Encryption Flow

```
Sender                                    Recipient
  │                                          │
  │ 1. Generate shared secret via ML-KEM-768 │
  │ 2. Derive AES-256 key via HKDF           │
  │ 3. Encrypt message with AES-GCM          │
  │ 4. Encrypt for self (sender copy)        │
  │ 5. Encrypt for recipient                 │
  │                                          │
  │── POST /messages (both ciphertexts) ────►│
  │                                          │
  │                    6. Decapsulate shared secret
  │                    7. Derive same AES key
  │                    8. Decrypt message
```

## Wallet Blocking

Users can block wallets client-side. Blocked wallets are filtered from conversations and contacts. The block list is stored in browser `localStorage` under `pqc_blocked_wallets`.

This is a client-side feature — the server is not involved. Blocked users can still send messages, but they won't appear in the blocking user's UI.

---

## SDK Usage

The `@rougechain/sdk` provides a high-level API for messenger operations. All write operations now require a `wallet` parameter for ML-DSA-65 request signing:

```typescript
import { RougeChain, Wallet } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");
const wallet = Wallet.generate();

// Register wallet (signed request, required for receiving messages and mail)
await rc.messenger.registerWallet(wallet, {
  id: wallet.publicKey,
  displayName: "Alice",
  signingPublicKey: wallet.publicKey,
  encryptionPublicKey: encPubKey,
});

// Conversations (signed requests)
const convos = await rc.messenger.getConversations(wallet);
await rc.messenger.createConversation(wallet, [wallet.publicKey, recipientPubKey]);

// Messages (signed requests)
const msgs = await rc.messenger.getMessages(wallet, conversationId);
await rc.messenger.sendMessage(wallet, conversationId, encryptedContent, {
  selfDestruct: true,
  destructAfterSeconds: 30,
});
await rc.messenger.markRead(wallet, messageId);
await rc.messenger.deleteMessage(wallet, messageId);
```

**TypeScript types:** `MessengerWallet`, `MessengerConversation`, `MessengerMessage`
