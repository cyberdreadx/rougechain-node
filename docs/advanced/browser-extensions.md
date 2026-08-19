# Browser Extensions

RougeChain provides browser extensions that serve as quantum-safe wallets, similar to how MetaMask works for Ethereum — but using post-quantum cryptography.

## Available Extensions

| Extension | Description | Store |
|-----------|-------------|-------|
| **RougeChain Wallet** | Primary browser extension | [Chrome Web Store](https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj) |

## Features

- **Wallet** — View balances, send/receive XRGE, claim faucet, custom token support
- **Encrypted Messenger** — E2E encrypted chat using ML-KEM-768 + ML-DSA-65
- **PQC Mail** — Encrypted email with `@rouge.quant` addresses
- **Vault Lock** — AES-256-GCM encryption with PBKDF2 key derivation and auto-lock timer
- **Cross-browser** — Chrome, Edge, Brave, Opera, Arc, Firefox (Manifest V3)

## Installation

### From Chrome Web Store

1. Visit the extension page on the Chrome Web Store
2. Click **Add to Chrome**
3. The extension icon appears in your toolbar

### From Source

```bash
cd browser-extension
npm install
npm run build
```

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `browser-extension/dist` folder

### Firefox

```bash
cd browser-extension
npm install
npm run build
```

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `browser-extension/dist/manifest.json`

## DApp Integration

The extension (and the Qwalla mobile app's dApp browser) inject a `window.rougechain`
provider object, similar to MetaMask's `window.ethereum` — but the API is
RougeChain-specific, **not** the EVM/ethers API. In particular there is **no
`getAddress()` and no `getNetwork()`**; you obtain the user's public key by calling
`connect()`.

> ⚠️ **Common mistake:** calling `window.rougechain.getAddress()` throws
> `e.getAddress is not a function`. That method does not exist — RougeChain is not
> EVM-compatible. Use `connect()` (below) and read `.publicKey`.

### Detecting the extension and connecting

```javascript
// 1. Detect
if (!window.rougechain?.isRougeChain) {
  throw new Error("RougeChain wallet not found — install the extension or open in Qwalla.");
}

// 2. Connect (prompts the user, returns their public key)
const { publicKey, displayName, encryptionPublicKey } = await window.rougechain.connect();
console.log("Connected:", publicKey);
```

The provider may not be injected the instant your script runs. Either check for it
after the `rougechain#initialized` event, or poll briefly:

```javascript
function getProvider(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (window.rougechain?.isRougeChain) return resolve(window.rougechain);
    const onReady = () => resolve(window.rougechain);
    window.addEventListener("rougechain#initialized", onReady, { once: true });
    setTimeout(() => reject(new Error("RougeChain wallet not detected")), timeoutMs);
  });
}
```

### Deriving a `rouge1…` address

`connect()` returns the **public key** (hex). If you need the short Bech32m
`rouge1…` address, derive it with the SDK:

```javascript
import { pubkeyToAddress } from "@rougechain/sdk";
const { publicKey } = await window.rougechain.connect();
const address = await pubkeyToAddress(publicKey); // rouge1...
```

### Provider API

| Method | Signature | Description |
|--------|-----------|-------------|
| `isRougeChain` | `boolean` | Property — `true` on the authentic provider. Use it to detect the wallet. |
| `connect()` | `→ { publicKey, displayName?, encryptionPublicKey? }` | Prompt the user to connect. Returns their public key. This replaces `getAddress()`. |
| `getBalance()` | `→ { balance, tokens }` | Get the connected wallet's XRGE balance and token balances. |
| `signTransaction(payload)` | `→ { signature, signedPayload }` | Sign a transaction payload with ML-DSA-65 (key never leaves the wallet). |
| `sendTransaction(payload)` | `→ { txId }` | Sign **and** broadcast a transaction. |
| `on(event, cb)` | `void` | Subscribe to events (e.g. account/connection changes). |
| `removeListener(event, cb)` | `void` | Remove an event listener. |

Authenticity: the genuine provider also sets a non-enumerable
`Symbol.for("rougechain:authentic")` to `true`, so a dApp can guard against a page
that pre-defines a fake `window.rougechain`:

```javascript
const authentic = window.rougechain?.[Symbol.for("rougechain:authentic")] === true;
```

## Security

| Feature | Implementation |
|---------|---------------|
| **Vault encryption** | AES-256-GCM with a PBKDF2-derived key (600k iterations); a password (min 8 chars) is mandatory at wallet creation |
| **Auto-lock** | Configurable timer via background service worker |
| **Key storage** | Encrypted blob in `chrome.storage.local`; the decrypted key is held only in `chrome.storage.session` (memory) and never written to disk. Legacy plaintext wallets are force-migrated to encrypted storage. |
| **Signing** | ML-DSA-65 (FIPS 204) — quantum-resistant |
| **Encryption** | ML-KEM-768 (FIPS 203) — quantum-resistant |

## Permissions

The extensions request minimal permissions:

| Permission | Purpose |
|------------|---------|
| `storage` | Store encrypted wallet data |
| `alarms` | Auto-lock timer |
| `notifications` | Transaction alerts |
| Host permissions | Connect to RougeChain nodes (`rougechain.io`, `testnet.rougechain.io`, `localhost`) |

## Why Not MetaMask?

MetaMask and all EVM wallets use **secp256k1 / ECDSA** cryptography. RougeChain uses **ML-DSA-65 / ML-KEM-768** (post-quantum). The key formats, signature schemes, and transaction structures are fundamentally incompatible. RougeChain's extensions are purpose-built for quantum-safe operations.

See [PQC Cryptography](pqc-cryptography.md) for details on the algorithms used.
