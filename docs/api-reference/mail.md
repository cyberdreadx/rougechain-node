# Mail API

Endpoints for the PQC-encrypted mail system. Mail uses the same ML-KEM-768 encryption as the messenger but adds subject lines, folders, threading, and a name registry.

## Name Registry

### Register a Name

```http
POST /api/names/register
Content-Type: application/json
```

Register a human-readable email address (e.g., `alice@rouge.quant`).

```json
{
  "name": "alice",
  "publicKey": "your-signing-public-key-hex",
  "encPublicKey": "your-ml-kem768-public-key-hex"
}
```

### Response

```json
{
  "success": true,
  "address": "alice@rouge.quant"
}
```

### Error

```json
{
  "success": false,
  "error": "Name already taken"
}
```

---

### Lookup a Name

```http
GET /api/names/lookup?name=alice
```

### Response

```json
{
  "name": "alice",
  "publicKey": "abc123...",
  "encPublicKey": "def456..."
}
```

---

### Reverse Lookup (Public Key to Name)

```http
GET /api/names/reverse?publicKey=abc123...
```

### Response

```json
{
  "name": "alice",
  "publicKey": "abc123..."
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
