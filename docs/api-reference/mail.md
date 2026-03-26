# Mail API

Endpoints for the PQC-encrypted mail system. Mail uses the same ML-KEM-768 encryption as the messenger but adds subject lines, folders, threading, and a name registry.

## Name Registry

**Important for third-party apps:** Before a user can receive mail, two things must be registered on the node:
1. Their **wallet** (via `/api/messenger/wallets/register`) — provides the encryption key
2. Their **mail name** (via `/api/names/register`) — maps a human-readable name to the wallet

### Register a Name

```http
POST /api/names/register
Content-Type: application/json
```

Register a human-readable email address (e.g., `alice@rouge.quant`).

**Request:**
```json
{
  "name": "alice",
  "walletId": "wallet-uuid-or-public-key"
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
DELETE /api/names/release
Content-Type: application/json
```

```json
{
  "name": "alice",
  "walletId": "wallet-uuid"
}
```

---

## Send Mail

```http
POST /api/mail/send
Content-Type: application/json
```

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
GET /api/mail/inbox?publicKey=your-pub-hex
```

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
GET /api/mail/sent?publicKey=your-pub-hex
```

Same response format as inbox, but returns mail you sent.

---

## Get Single Mail

```http
GET /api/mail/message/:id?publicKey=your-pub-hex
```

---

## Mark as Read

```http
POST /api/mail/read
Content-Type: application/json
```

```json
{
  "id": "mail-uuid"
}
```

---

## Move to Trash

```http
POST /api/mail/move
Content-Type: application/json
```

```json
{
  "id": "mail-uuid",
  "folder": "trash"
}
```

---

## Get Trash

```http
GET /api/mail/trash?publicKey=your-pub-hex
```

---

## Delete Mail

```http
DELETE /api/mail/:id
```

Permanently deletes a mail item.

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

Mail uses the same encryption as the messenger:

1. Look up recipient's ML-KEM-768 public key via Name Registry
2. Encapsulate a shared secret
3. Derive AES-256 key via HKDF
4. Encrypt subject + body with AES-GCM
5. Create separate ciphertext for sender and recipient
6. Server stores both encrypted copies

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

The `@rougechain/sdk` provides a high-level API for name registry and mail operations:

```typescript
import { RougeChain } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");

// Register wallet + name (required for receiving mail)
await rc.messenger.registerWallet({
  id: walletId,
  displayName: "Alice",
  signingPublicKey: sigPubKey,
  encryptionPublicKey: encPubKey,
});
await rc.mail.registerName("alice", walletId);

// Resolve a recipient before sending
const recipient = await rc.mail.resolveName("bob");
// recipient.wallet.encryption_public_key → use for ML-KEM encryption

// Reverse lookup
const name = await rc.mail.reverseLookup(walletId); // "alice"

// Send, read, manage mail
await rc.mail.send({ from, to, subject, body, encrypted_subject, encrypted_body });
const inbox = await rc.mail.getInbox(walletId);
await rc.mail.markRead(messageId);
await rc.mail.move(messageId, "trash");
await rc.mail.delete(messageId);
```

**TypeScript types:** `NameEntry`, `ResolvedName`, `MailMessage`, `SendMailParams`

