# RougeChain Wallet Extension

Quantum-safe cryptocurrency wallet & encrypted messenger browser extension for RougeChain.

## Features

- **Wallet**: View balances, send/receive XRGE, claim faucet, custom token support
- **Tokens**: Create custom tokens (client-side signed v2 transactions)
- **NFTs**: Create collections (with settable royalty recipient), mint, transfer with sale-price royalties, burn, lock
- **Messenger**: E2E encrypted chat using ML-KEM-768 + ML-DSA-65 with signed API requests
- **Mail**: PQC-encrypted email with `@rouge.quant` addresses, multi-recipient CEK encryption
- **Security**: Wallet creation/import requires a mandatory password — keys are encrypted at rest with AES-256-GCM using a PBKDF2-derived key (600k iterations). The decrypted key is held in memory only (`chrome.storage.session`), never persisted in plaintext; vault lock + auto-lock timer clear it
- **Signed Requests**: All state-changing operations — transfers, token/NFT writes, mail/messenger/name — are signed client-side with ML-DSA-65 over canonical JSON, using the node's `/api/v2/*` endpoints with anti-replay timestamps/nonces
- **TOFU**: Key fingerprint tracking with key-change warnings in messenger
- **Cross-browser**: Chrome, Edge, Brave, Opera, Arc, Firefox (Manifest V3)

## Post-Quantum Cryptography

- **ML-DSA-65** (FIPS 204) — CRYSTALS-Dilithium digital signatures
- **ML-KEM-768** (FIPS 203) — CRYSTALS-Kyber key encapsulation
- **AES-256-GCM** — Symmetric encryption for messages and wallet vault

## Release notes

### 1.8.0

- **Sign a message to prove you control your wallet.** dApps can call
  `window.rougechain.signMessage({ message })` for logins and token gating; it returns
  `{ signature, publicKey, address }`. The signature is over
  `"\x19RougeChain Signed Message:\n" + decimal(byte length) + "\n" + message`, which the chain can
  never accept as a transaction, and it is verified with `verifyMessage` / `verifySignIn` from
  `@rougechain/sdk` 1.13.0. The site must be connected and **every request asks for approval**
  (nothing is remembered). The approval shows the requesting site and the whole message
  (scrollable, never truncated, invisible characters shown as symbols, at most 4,096 bytes). A
  sign-in message also shows its domain, address, nonce and expiry, with a red warning when the
  domain in the message is not the site asking. A message that looks like a transaction payload
  is refused with a pointer to `signTransaction`. `signTransaction` / `sendTransaction` are
  unchanged. dApps should feature-detect:
  `typeof window.rougechain.signMessage === "function"`.

### 1.7.0

- **One recovery phrase restores your messages everywhere.** New wallets and recovery-phrase
  imports now derive the ML-KEM-768 messaging/mail key from the phrase exactly like rougechain.io
  and Qwalla (`SHA-512("<phrase>|rougee-gram|kem-v1")` → `ml_kem768.keygen`, via
  `@rougechain/core/messaging-keys`), so the same 24 words give the same rouge1 address *and* the
  same messaging key in all three apps. A wallet without a phrase derives it from its signing key.
  `.pqcbackup` / JSON backups that already contain messaging keys keep them exactly; only a backup
  without them gets the derived key. **Wallets already in the extension keep their existing
  messaging key** — nothing is re-derived on unlock, migration or re-encryption.
- **Whole XRGE only.** The node stores XRGE transfer amounts as whole numbers, so Send and Shield
  refuse fractional amounts instead of letting the chain drop the fraction.
- **1 XRGE transfer fee.** The Send form shows the node's real 1 XRGE fee and checks amount + fee
  against the balance; the leftover 0.1 XRGE transfer-fee constant is corrected to 1.

## Development

```bash
npm ci                                   # from the monorepo root
npm run dev -w rougechain-wallet-ext     # Vite dev server
npm run typecheck -w rougechain-wallet-ext
npm test -w rougechain-wallet-ext        # vitest: messaging keys, wallet storage, dApp signMessage
npm run build -w rougechain-wallet-ext   # Production build → apps/extension/dist/
```

Store package: zip the *contents* of `dist/` (manifest.json at the zip root) as
`apps/extension/rougechain-wallet-<version>.zip` (`*.zip` is gitignored).

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
│   │   ├── storage.ts       # storage wrapper: decrypted keys → chrome.storage.session (memory-only), rest → chrome.storage.local
│   │   ├── network.ts       # Node API configuration
│   │   ├── address.ts       # rouge1… address utilities
│   │   ├── api-cache.ts     # TTL-based API response cache
│   │   ├── mnemonic.ts      # BIP-39 seed phrase support
│   │   ├── pqc-blockchain.ts # ML-DSA-65 key gen & signing
│   │   ├── pqc-wallet.ts    # Balance, transactions, tokens
│   │   ├── pqc-messenger.ts # E2E encrypted messaging (signed requests)
│   │   ├── pqc-mail.ts      # PQC mail encryption (CEK pattern)
│   │   └── unified-wallet.ts # Wallet encryption & locking
│   ├── popup/               # React popup UI
│   │   ├── App.tsx           # Tab navigation
│   │   ├── tabs/
│   │   │   ├── WalletTab.tsx
│   │   │   ├── TokensTab.tsx
│   │   │   ├── NftsTab.tsx
│   │   │   ├── MailTab.tsx
│   │   │   ├── MessengerTab.tsx
│   │   │   └── SettingsTab.tsx
│   │   └── components/
│   │       ├── UnlockScreen.tsx
│   │       └── CreateWalletScreen.tsx
│   ├── content/             # Content scripts
│   │   ├── inject.ts        # Provider injection
│   │   └── provider.ts      # window.rougechain dApp API
│   ├── approval/            # Transaction approval popup
│   │   ├── main.tsx
│   │   └── App.tsx
│   └── background/
│       └── service-worker.ts # Auto-lock timer
├── manifest.json            # Manifest V3
├── popup.html               # Extension popup entry
└── package.json
```
