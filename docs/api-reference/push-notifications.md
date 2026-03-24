# Push Notifications API

Register and unregister Expo push tokens for real-time mobile notifications. Both endpoints require **ML-DSA-65 signed payloads** — only the wallet owner can register or unregister their token.

## Register Push Token

```http
POST /api/push/register
Content-Type: application/json
```

### Request (SignedTransactionRequest)

```json
{
  "payload": {
    "type": "push_register",
    "from": "wallet-public-key",
    "pushToken": "ExponentPushToken[xxx]",
    "platform": "expo",
    "timestamp": 1234567890123,
    "nonce": "random-hex"
  },
  "signature": "ml-dsa-65-signature-hex",
  "public_key": "wallet-public-key"
}
```

### Response

```json
{
  "success": true
}
```

---

## Unregister Push Token

```http
POST /api/push/unregister
Content-Type: application/json
```

### Request (SignedTransactionRequest)

```json
{
  "payload": {
    "type": "push_unregister",
    "from": "wallet-public-key",
    "timestamp": 1234567890123,
    "nonce": "random-hex"
  },
  "signature": "ml-dsa-65-signature-hex",
  "public_key": "wallet-public-key"
}
```

### Response

```json
{
  "success": true
}
```

---

## Security

Push token registration is secured with the same `SignedTransactionRequest` pattern used by v2 API endpoints:

1. The payload is signed client-side with the wallet's ML-DSA-65 private key
2. The server verifies the signature against the `public_key`
3. Timestamp must be within 5 minutes to prevent replay attacks
4. Only the wallet owner can register a push token for their public key

This prevents spoofing — an attacker cannot register a rogue push token for someone else's wallet.

---

## SDK Usage

```typescript
import { RougeChain } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");

// Register
await rc.registerPushToken(
  publicKey,
  privateKey,
  "ExponentPushToken[xxx]"
);

// Unregister
await rc.unregisterPushToken(publicKey, privateKey);
```
