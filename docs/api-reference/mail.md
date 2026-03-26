# Mail API

Endpoints for the PQC-encrypted mail system. Mail uses ML-KEM-768 encryption with a Content Encryption Key (CEK) pattern for multi-recipient support, ML-DSA-65 unified signatures, and name registry with atomic registration.

> **v2 API (March 2026):** All write operations now use `/api/v2/` endpoints that require ML-DSA-65 signed requests with timestamp validation and nonce-based anti-replay protection. Legacy unsigned endpoints return HTTP 410 (Gone) in production.

## Signed Request Format

All v2 write endpoints accept a signed request body:

```json
{
  "payload": {
    "name": "alice",
    "walletId": "wallet-uuid",
    "from": "ml-dsa65-public-key-hex",
    "timestamp": 1710100000000,
    "nonce": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
  },
  "signature": "ml-dsa65-signature-hex",
  "public_key": "ml-dsa65-public-key-hex"
}
```

The server verifies: (1) the ML-DSA-65 signature, (2) the timestamp is within a 5-minute window, (3) the `from` field matches the signing key, (4) the nonce has not been used before, and (5) the caller is authorized for the operation.

## Name Registry

**Important for third-party apps:** Before a user can receive mail, two things must be registered on the node:
1. Their **wallet** (via `/api/v2/messenger/wallets/register`) — provides the encryption key
2. Their **mail name** (via `/api/v2/names/register`) — maps a human-readable name to the wallet

### Register a Name

```http
POST /api/v2/names/register
Content-Type: application/json
```

Register a human-readable email address (e.g., `alice@rouge.quant`). Requires a signed request. Registration uses atomic compare-and-swap to prevent race conditions.

**Request (signed):**
```json
{
  "payload": {
    "name": "alice",
    "walletId": "wallet-uuid-or-public-key",
    "from": "signing-public-key-hex",
    "timestamp": 1710100000000,
    "nonce": "random-hex-nonce"
  },
  "signature": "ml-dsa65-signature-hex",
  "public_key": "signing-public-key-hex"
}
```

**Response:**
```json
{
  "success": true,
  "entry": {
    "name": "alice",
    "wallet_id": "wallet-uuid-or-public-key",
    "registered_at": "2026-03-11T00:00:00Z"
  }
}
```

**Error:**
```json
{
  "success": false,
  "error": "Name already taken"
}
```

---

### Resolve a Name

```http
GET /api/names/resolve/:name
```

Returns the name entry and associated wallet (with encryption keys).

**Response:**
```json
{
  "success": true,
  "entry": {
    "name": "alice",
    "wallet_id": "wallet-uuid",
    "registered_at": "2026-03-11T00:00:00Z"
  },
  "wallet": {
    "id": "wallet-uuid",
    "display_name": "Alice",
    "signing_public_key": "abc123...",
    "encryption_public_key": "def456..."
  }
}
```

---

### Reverse Lookup (Wallet ID → Name)

```http
GET /api/names/reverse/:walletId
```

**Response:**
```json
{
  "success": true,
  "name": "alice"
}
```

---

### Release a Name

```http
POST /api/v2/names/release
Content-Type: application/json
```

Requires a signed request. The caller must own the name (verified via signing key).

```json
{
  "payload": {
    "name": "alice",
    "from": "signing-public-key-hex",
    "timestamp": 1710100000000,
    "nonce": "random-hex-nonce"
  },
  "signature": "ml-dsa65-signature-hex",
  "public_key": "signing-public-key-hex"
}
```

---

## Send Mail

```http
POST /api/v2/mail/send
Content-Type: application/json
```

Requires a signed request. The sender is authenticated via ML-DSA-65 signature verification.

### Request Body

```json
{
  "from": "alice",
  "fromPublicKey": "sender-pub-hex",
  "to": "bob",
  "toPublicKey": "recipient-pub-hex",
  "senderEncrypted": "base64-encrypted-for-sender",
  "recipientEncrypted": "base64-encrypted-for-recipient",
  "replyToId": null
}
```

The `senderEncrypted` and `recipientEncrypted` fields contain the encrypted subject and body. Both sender and recipient get their own copy, just like the messenger.

Set `replyToId` to the ID of the mail being replied to, enabling threading.

### Response

```json
{
  "success": true,
  "id": "mail-uuid"
}
```

---

## Get Inbox

```http
POST /api/v2/mail/folder
Content-Type: application/json
```

Requires a signed request with `"folder": "inbox"` in the payload. The caller's wallet is resolved from the signing key.

### Response

```json
{
  "mail": [
    {
      "id": "mail-uuid",
      "from": "alice",
      "fromPublicKey": "abc...",
      "to": "bob",
      "toPublicKey": "def...",
      "encrypted": "base64-ciphertext",
      "timestamp": 1706745600000,
      "read": false,
      "replyToId": null
    }
  ]
}
```

---

## Get Sent Mail

```http
POST /api/v2/mail/folder
Content-Type: application/json
```

Same as inbox but with `"folder": "sent"` in the payload. Requires a signed request.

---

## Get Single Mail

```http
POST /api/v2/mail/message
Content-Type: application/json
```

Requires a signed request with `messageId` in the payload.

---

## Mark as Read

```http
POST /api/v2/mail/read
Content-Type: application/json
```

Requires a signed request with `messageId` in the payload.

---

## Move to Folder

```http
POST /api/v2/mail/move
Content-Type: application/json
```

Requires a signed request with `messageId` and `folder` in the payload. Valid folders: `inbox`, `sent`, `trash`, `starred`, `drafts`.

---

## Get Trash

```http
POST /api/v2/mail/folder
Content-Type: application/json
```

Same as inbox/sent but with `"folder": "trash"` in the payload. Requires a signed request.

---

## Delete Mail

```http
POST /api/v2/mail/delete
Content-Type: application/json
```

Permanently deletes a mail item. Requires a signed request with `messageId` in the payload. The caller must be a participant (sender or recipient).

---

## Email Domains

| Domain | Platform |
|--------|----------|
| `@rouge.quant` | Website and browser extensions |
| `@qwalla.mail` | QWalla mobile app (future) |

---

## Threading

Mail threading is handled client-side by following the `replyToId` chain. When viewing a mail, the client:

1. Fetches both inbox and sent mail
2. Walks the `replyToId` chain to build the thread
3. Displays messages in chronological order
4. Collapses older messages, expands the latest two

---

## Encryption

Mail uses a Content Encryption Key (CEK) pattern for efficient multi-recipient support:

1. Generate a random 256-bit AES key (the CEK)
2. Encrypt subject, body, and attachment with the CEK via AES-256-GCM
3. For each recipient (and the sender): encapsulate a shared secret via ML-KEM-768, derive a wrapping key via HKDF, and encrypt the CEK with AES-GCM
4. Sign the concatenation of all encrypted parts (subject + body + attachment) with ML-DSA-65 (unified signature)
5. Server stores the encrypted content with per-recipient wrapped keys

---

## Attachments

Mail supports encrypted file attachments up to **2 MB**. Attachments are encrypted client-side using the same ML-KEM-768 scheme as the message body.

### Sending with Attachment

Include the `attachmentEncrypted` and `hasAttachment` fields in the send request:

```json
{
  "fromWalletId": "sender-wallet-id",
  "toWalletIds": ["recipient-wallet-id"],
  "subjectEncrypted": "ml-kem-encrypted-subject",
  "bodyEncrypted": "ml-kem-encrypted-body",
  "attachmentEncrypted": "ml-kem-encrypted-attachment-json",
  "signature": "ml-dsa-65-signature",
  "replyToId": null,
  "hasAttachment": true
}
```

### Attachment Payload

The `attachmentEncrypted` field contains an ML-KEM encrypted JSON string:

```json
{
  "name": "photo.jpg",
  "type": "image/jpeg",
  "data": "base64-encoded-file-data",
  "size": 102400
}
```

| Field  | Type   | Description |
|--------|--------|-------------|
| `name` | string | Original filename |
| `type` | string | MIME type |
| `data` | string | Base64-encoded file content |
| `size` | number | File size in bytes |

### Reading Attachments

When fetching mail (inbox/sent/trash), messages with attachments will include the `attachment_encrypted` field. The client must:

1. Decrypt using the recipient's ML-KEM-768 private key
2. Parse the JSON to extract the attachment metadata and data
3. Display inline (images) or offer download (other types)

---

## SDK Usage

The `@rougechain/sdk` provides a high-level API for name registry and mail operations. All write operations now require a `wallet` parameter for ML-DSA-65 request signing:

```typescript
import { RougeChain, Wallet } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");
const wallet = Wallet.generate();

// Register wallet + name (signed requests)
await rc.messenger.registerWallet(wallet, {
  id: wallet.publicKey,
  displayName: "Alice",
  signingPublicKey: wallet.publicKey,
  encryptionPublicKey: encPubKey,
});
await rc.mail.registerName(wallet, "alice", wallet.publicKey);

// Resolve a recipient before sending (public, no signing needed)
const recipient = await rc.mail.resolveName("bob");
// recipient.wallet.encryption_public_key → use for ML-KEM encryption

// Reverse lookup (public, no signing needed)
const name = await rc.mail.reverseLookup(wallet.publicKey); // "alice"

// Send, read, manage mail (all signed requests)
await rc.mail.send(wallet, { from, to, subject, body, encrypted_subject, encrypted_body });
const inbox = await rc.mail.getInbox(wallet);
await rc.mail.markRead(wallet, messageId);
await rc.mail.move(wallet, messageId, "trash");
await rc.mail.delete(wallet, messageId);
```

**TypeScript types:** `NameEntry`, `ResolvedName`, `MailMessage`, `SendMailParams`

