# RougeChain Wallet Extension

Quantum-safe cryptocurrency wallet & encrypted messenger browser extension for RougeChain.

## Features

- **Wallet**: View balances, send/receive XRGE, claim faucet, custom token support
- **Messenger**: E2E encrypted chat using ML-KEM-768 + ML-DSA-65
- **Security**: Vault lock with AES-256-GCM encryption, auto-lock timer, PBKDF2 key derivation
- **Cross-browser**: Chrome, Edge, Brave, Opera, Arc, Firefox (Manifest V3)

## Post-Quantum Cryptography

- **ML-DSA-65** (FIPS 204) — CRYSTALS-Dilithium digital signatures
- **ML-KEM-768** (FIPS 203) — CRYSTALS-Kyber key encapsulation
- **AES-256-GCM** — Symmetric encryption for messages and wallet vault

## Development

```bash
cd browser-extension
npm install
npm run dev     # Vite dev server
npm run build   # Production build → dist/
```

## Install in Chrome

1. Run `npm run build`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the `browser-extension/dist` folder

## Install in Firefox

1. Run `npm run build`
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select `browser-extension/dist/manifest.json`

## Architecture

```
browser-extension/
├── dist/                    # Built extension (load this in browser)
├── src/
│   ├── lib/                 # Core libraries
│   │   ├── storage.ts       # chrome.storage.local wrapper
│   │   ├── network.ts       # Node API configuration
│   │   ├── pqc-blockchain.ts # ML-DSA-65 key gen & signing
│   │   ├── pqc-wallet.ts    # Balance, transactions, tokens
│   │   ├── pqc-messenger.ts # E2E encrypted messaging
│   │   └── unified-wallet.ts # Wallet encryption & locking
│   ├── popup/               # React popup UI
│   │   ├── App.tsx           # Tab navigation
│   │   ├── tabs/
│   │   │   ├── WalletTab.tsx
│   │   │   ├── MessengerTab.tsx
│   │   │   └── SettingsTab.tsx
│   │   └── components/
│   │       ├── UnlockScreen.tsx
│   │       └── CreateWalletScreen.tsx
│   └── background/
│       └── service-worker.ts # Auto-lock timer
├── manifest.json            # Manifest V3
├── popup.html               # Extension popup entry
└── package.json
```
