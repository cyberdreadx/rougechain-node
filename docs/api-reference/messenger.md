# Messenger API

Endpoints for the end-to-end encrypted PQC messenger.

All messages are encrypted client-side using ML-KEM-768 key encapsulation and AES-GCM. The server only stores encrypted blobs — it cannot read message contents.

## Register Messenger Wallet

```http
POST /api/messenger/wallets/register
Content-Type: application/json
```

Register your wallet's encryption public key so others can send you encrypted messages and mail. **This is required before receiving mail from other apps.**

### Request Body

```json
{
  "id": "wallet-uuid-or-public-key",
  "displayName": "Alice",
  "signingPublicKey": "ml-dsa65-signing-public-key-hex",
  "encryptionPublicKey": "ml-kem768-encryption-public-key-hex"
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
POST /api/messenger/messages
Content-Type: application/json
```

### Request Body

```json
{
  "conversationId": "conv-uuid",
  "senderPublicKey": "sender-pub-hex",
  "recipientPublicKey": "recipient-pub-hex",
  "senderEncrypted": "base64-encrypted-for-sender",
  "recipientEncrypted": "base64-encrypted-for-recipient",
  "senderDisplayName": "Alice",
  "recipientDisplayName": "Bob",
  "selfDestruct": false,
  "destructSeconds": 0
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
GET /api/messenger/messages?conversationId=conv-uuid&publicKey=your-pub-hex
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `conversationId` | string | The conversation ID |
| `publicKey` | string | Your public key (to get your encrypted copy) |

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
POST /api/messenger/messages/read
Content-Type: application/json
```

Used for self-destruct messages.

```json
{
  "messageId": "msg-uuid"
}
```

---

## Get Conversations

```http
GET /api/messenger/conversations?publicKey=your-pub-hex
```

Returns all conversations for a wallet.

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

The `@rougechain/sdk` provides a high-level API for messenger operations:

```typescript
import { RougeChain } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");

// Register wallet (required for receiving messages and mail)
await rc.messenger.registerWallet({
  id: walletId,
  displayName: "Alice",
  signingPublicKey: sigPubKey,
  encryptionPublicKey: encPubKey,
});

// Conversations
const convos = await rc.messenger.getConversations(walletId);
await rc.messenger.createConversation([walletIdA, walletIdB]);

// Messages
const msgs = await rc.messenger.getMessages(conversationId);
await rc.messenger.sendMessage(conversationId, walletId, encryptedContent, {
  selfDestruct: true,
  destructAfterSeconds: 30,
});
await rc.messenger.markRead(messageId);
await rc.messenger.deleteMessage(messageId);
```

**TypeScript types:** `MessengerWallet`, `MessengerConversation`, `MessengerMessage`
