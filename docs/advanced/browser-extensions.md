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

The extension injects a `window.rougechain` provider object, similar to MetaMask's `window.ethereum`. DApps can use this to interact with the user's wallet.

### Detecting the Extension

```javascript
if (window.rougechain) {
  console.log('RougeChain wallet detected');
  const address = await window.rougechain.getAddress();
}
```

### Provider API

| Method | Description |
|--------|-------------|
| `getAddress()` | Get the user's public key |
| `signTransaction(tx)` | Sign a transaction with ML-DSA-65 |
| `getBalance()` | Get the wallet's balance |
| `getNetwork()` | Get the current network (testnet/devnet) |

## Security

| Feature | Implementation |
|---------|---------------|
| **Vault encryption** | AES-256-GCM with PBKDF2-derived key |
| **Auto-lock** | Configurable timer via background service worker |
| **Key storage** | `chrome.storage.local` (encrypted) |
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
