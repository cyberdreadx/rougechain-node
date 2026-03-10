# Quick Start

Get started with RougeChain in 5 minutes.

## Step 1: Access the Web App

Visit [rougechain.io](https://rougechain.io) or run locally:

```bash
git clone https://github.com/cyberdreadx/quantum-vault
cd quantum-vault
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

## Step 2: Create Your Wallet

Your wallet is created automatically when you first visit. It includes:

- **Public Key** (ML-DSA-65) - Your address, share freely
- **Private Key** (ML-DSA-65) - Never share this!
- **Encryption Key** (ML-KEM-768) - For secure messaging

Keys are stored locally in your browser.

## Step 3: Get Test Tokens

1. Click **Wallet** in the sidebar
2. Click **Request from Faucet**
3. Receive 1,000 XRGE instantly

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

- Transaction requires amount + 0.1 XRGE fee
- Use faucet to get more tokens

### Wallet not loading

- Clear browser cache
- Check browser console for errors
