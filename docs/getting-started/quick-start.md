# Quick Start

Get started with RougeChain in 5 minutes.

## Step 1: Access the Web App

Visit [rougechain.io](https://rougechain.io) or run locally:

```bash
git clone https://github.com/cyberdreadx/rougechain-node
cd rougechain-node
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

## Step 2: Create Your Wallet

Create (or import) a wallet and **set a password** when asked (required, min 8 characters — the wallet is saved only once it's encrypted). It includes:

- **Address** (`rouge1...`) — Your compact Bech32m address, share freely
- **Private Key** (ML-DSA-65) — Never share this!
- **Encryption Key** (ML-KEM-768) — For secure messaging

On the web, your keys are encrypted at rest with AES-256-GCM (PBKDF2, 600k iterations): the password is required, and until you set it during create / import the wallet exists only in the tab's `sessionStorage` (it is never written to `localStorage` unencrypted). While unlocked, the decrypted wallet is kept in `sessionStorage` (cleared when the tab closes). In the browser extension, the decrypted key lives in `chrome.storage.session` and only the encrypted vault is persisted (legacy plaintext extension wallets are force-migrated to encrypted storage on next unlock). Either way, export a `.pqcbackup` — your 24-word phrase alone does not restore your messaging/mail key ([details](create-wallet.md#backup-your-wallet)).

## Step 3: Get Test Tokens

1. Click **Wallet** in the sidebar
2. Click **Request from Faucet**
3. Receive 10,000 XRGE instantly (24-hour cooldown per address)

## Step 4: Send Your First Transaction

1. Click **Send**
2. Enter recipient address
3. Enter amount
4. Click **Send XRGE**

Transaction is signed with your ML-DSA-65 key and broadcast to the network.

## Step 5: View on Blockchain

1. Click **Blockchain** in sidebar
2. See your transaction in the latest block
3. Verify the PQC signature

## What's Next?

- [Run your own node](../running-a-node/README.md)
- [Stake and become a validator](../staking/README.md)
- [Create custom tokens](../advanced/token-creation.md)
- [Use encrypted messenger](../api-reference/messenger.md)
- [Send encrypted mail](../api-reference/mail.md)
- [Install the browser extension](../advanced/browser-extensions.md)
- [Use the SDK](../advanced/sdk.md)

## Troubleshooting

### "Failed to fetch" Error

- Check if you're connected to the right network (Testnet vs Devnet)
- Ensure the node is running if using local devnet

### "Insufficient balance"

- Transaction requires amount + 1 XRGE fee
- Use faucet to get more tokens

### Wallet not loading

- Clear browser cache (do **not** clear site data / `localStorage` unless you have your seed phrase and `.pqcbackup` — it deletes a wallet stored in the browser)
- Check browser console for errors
