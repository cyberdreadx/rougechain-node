<p align="center">
  <a href="https://rougechain.io">
    <img src="https://rougechain.io/logo.webp" alt="RougeChain" width="80" height="80" />
  </a>
</p>

<h1 align="center">@rougechain/sdk</h1>

<p align="center">
  <strong>Build quantum-safe dApps on RougeChain</strong><br />
  Transfers · DEX · NFTs · Shielded Transactions · Bridge · Rollups · Mail · Messenger
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rougechain/sdk"><img src="https://img.shields.io/npm/v/@rougechain/sdk?color=00d2be&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@rougechain/sdk"><img src="https://img.shields.io/npm/dm/@rougechain/sdk?color=00d2be" alt="npm downloads" /></a>
  <a href="https://github.com/cyberdreadx/rougechain-node/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
  <a href="https://docs.rougechain.io"><img src="https://img.shields.io/badge/docs-rougechain-00d2be" alt="docs" /></a>
</p>

---

The official SDK for **RougeChain** — a post-quantum Layer 1 blockchain secured by **ML-DSA-65** (CRYSTALS-Dilithium). All transaction signing happens client-side with NIST-approved post-quantum cryptography. Private keys never leave your application.

Works in the **browser**, **Node.js 18+**, and **React Native**.

## Install

```bash
npm install @rougechain/sdk
```

## 30-Second Quickstart

```typescript
import { RougeChain, Wallet } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");
const wallet = Wallet.generate();

// Get testnet tokens
await rc.faucet(wallet);

// Send 100 XRGE
await rc.transfer(wallet, { to: recipientPubKey, amount: 100 });

// Check balance
const { balance } = await rc.getBalance(wallet.publicKey);
```

## Features

| Feature | Sub-client | Description |
|---------|-----------|-------------|
| **Wallet** | — | ML-DSA-65 keypair generation, import/export, client-side signing |
| **Transfers** | `rc` | Send XRGE or custom tokens, burn tokens |
| **Token Creation** | `rc` | Launch new tokens with on-chain logo support |
| **Staking** | `rc` | Stake/unstake XRGE for validation |
| **DEX** | `rc.dex` | AMM pools, swaps with slippage protection, liquidity |
| **NFTs** | `rc.nft` | RC-721 collections, mint, batch mint, royalties, freeze |
| **Shielded** | `rc.shielded` | Private transfers with zk-STARK proofs, shield/unshield XRGE |
| **Bridge** | `rc.bridge` | ETH ↔ qETH, USDC ↔ qUSDC, XRGE bridge (Base Mainnet/Sepolia) |
| **Rollup** | `rc` | zk-STARK batch proofs, rollup status, submit transfers |
| **Mail** | `rc.mail` | On-chain encrypted email (`@rouge.quant`) |
| **Messenger** | `rc.messenger` | E2E encrypted messaging with self-destruct |

## Wallet & Addresses

```typescript
import { Wallet, pubkeyToAddress, isRougeAddress, formatAddress } from "@rougechain/sdk";

// Generate a new post-quantum keypair
const wallet = Wallet.generate();

// Get the compact rouge1... address (~63 chars vs 3904-char hex pubkey)
const address = await wallet.address();
// "rouge1q8f3x7k2m4n9p..."

// Restore from saved keys
const restored = Wallet.fromKeys(publicKey, privateKey);

// Export for storage
const keys = wallet.toJSON(); // { publicKey, privateKey }

// Verify keypair integrity
wallet.verify(); // true

// Address utilities
const addr = await pubkeyToAddress(someHexPubKey);
const display = formatAddress(addr); // "rouge1q8f3x7...k9m2"
isRougeAddress("rouge1q8f3x7k2m4..."); // true
```

## Transfers & Tokens

```typescript
// Send XRGE
await rc.transfer(wallet, { to: recipient, amount: 100 });

// Send custom token
await rc.transfer(wallet, { to: recipient, amount: 50, token: "MYTOKEN" });

// Create a new token (costs 100 XRGE)
await rc.createToken(wallet, {
  name: "My Token",
  symbol: "MTK",
  totalSupply: 1_000_000,
  image: "https://example.com/logo.png", // optional — URL or data:image/webp;base64,...
});

// Update token metadata (creator only)
await rc.updateTokenMetadata(wallet, {
  symbol: "MTK",
  image: "data:image/webp;base64,UklGR...", // base64 logos persist on-chain
  description: "A community token",
  website: "https://mytoken.io",
});

// Burn tokens
await rc.burn(wallet, 500);
```

## DEX (`rc.dex`)

```typescript
// List all pools
const pools = await rc.dex.getPools();

// Get a single pool
const pool = await rc.dex.getPool("XRGE-MTK");

// Get price history (PriceSnapshot[]) — for building charts
const prices = await rc.dex.getPriceHistory("XRGE-MTK");
// Each snapshot: { pool_id, timestamp, block_height, reserve_a, reserve_b, price_a_in_b, price_b_in_a }

// Get pool stats (volume, trade count)
const stats = await rc.dex.getPoolStats("XRGE-MTK");

// Get pool events (swaps, adds, removes)
const events = await rc.dex.getPoolEvents("XRGE-MTK");

// Get a swap quote
const quote = await rc.dex.quote({
  poolId: "XRGE-MTK",
  tokenIn: "XRGE",
  tokenOut: "MTK",
  amountIn: 100,
});
console.log(`You'll receive ${quote.amount_out} MTK`);

// Execute swap with slippage protection
await rc.dex.swap(wallet, {
  tokenIn: "XRGE",
  tokenOut: "MTK",
  amountIn: 100,
  minAmountOut: quote.amount_out * 0.98, // 2% slippage
});

// Create a new liquidity pool
await rc.dex.createPool(wallet, {
  tokenA: "XRGE",
  tokenB: "MTK",
  amountA: 10_000,
  amountB: 5_000,
});

// Add / remove liquidity
await rc.dex.addLiquidity(wallet, {
  poolId: "XRGE-MTK",
  amountA: 1000,
  amountB: 500,
});
await rc.dex.removeLiquidity(wallet, { poolId: "XRGE-MTK", lpAmount: 100 });
```

## NFTs (`rc.nft`)

RC-721 standard with collections, royalties, freezing, and batch minting.

```typescript
// Create a collection (5% royalty, max 10k supply)
await rc.nft.createCollection(wallet, {
  symbol: "ART",
  name: "My Art Collection",
  royaltyBps: 500,
  maxSupply: 10_000,
});

// Mint
await rc.nft.mint(wallet, {
  collectionId: "abc123",
  name: "Piece #1",
  metadataUri: "https://example.com/nft/1.json",
  attributes: { rarity: "legendary" },
});

// Batch mint (up to 50 at once)
await rc.nft.batchMint(wallet, {
  collectionId: "abc123",
  names: ["#1", "#2", "#3"],
});

// Transfer with sale price (triggers royalty)
await rc.nft.transfer(wallet, {
  collectionId: "abc123",
  tokenId: 1,
  to: buyerPubKey,
  salePrice: 100,
});

// Query
const myNfts = await rc.nft.getByOwner(wallet.publicKey);
```

## Bridge (`rc.bridge`)

Bridge assets between **Base Sepolia** and **RougeChain L1**. Supports ETH ↔ qETH, USDC ↔ qUSDC, and XRGE.

```typescript
// Check bridge status & supported tokens
const config = await rc.bridge.getConfig();
// { enabled: true, supportedTokens: ["ETH", "USDC"], chainId: 84532 }

// Claim qETH after depositing ETH to custody address
await rc.bridge.claim({
  evmTxHash: "0x...",
  evmAddress: "0x...",
  evmSignature: "0x...",
  recipientPubkey: wallet.publicKey,
  token: "ETH",
});

// Claim qUSDC after depositing USDC
await rc.bridge.claim({
  evmTxHash: "0x...",
  evmAddress: "0x...",
  evmSignature: "0x...",
  recipientPubkey: wallet.publicKey,
  token: "USDC",
});

// Withdraw qETH → receive ETH on Base Sepolia
await rc.bridge.withdraw(wallet, {
  amount: 500_000,
  evmAddress: "0xYourAddress",
  tokenSymbol: "qETH",
});

// XRGE bridge
const xrgeConfig = await rc.bridge.getXrgeConfig();
await rc.bridge.withdrawXrge(wallet, {
  amount: 1000,
  evmAddress: "0xYourAddress",
});
```

## Rollup (zk-STARK Batch Proofs)

Submit transfers to the rollup accumulator for batched STARK proving. Transfers are collected into batches of up to 32 and proven with a single zk-STARK proof.

```typescript
// Check rollup status
const status = await rc.getRollupStatus();
// { pending_transfers, completed_batches, current_state_root, ... }

// Submit a transfer to the rollup batch
const result = await rc.submitRollupTransfer({
  sender: wallet.publicKey,
  receiver: recipientPubKey,
  amount: 100,
  fee: 1,
});
// result.queued = true (waiting for batch) or result.batch_completed = true

// Get a completed batch result
const batch = await rc.getRollupBatch(1);
// { batch_id, transfer_count, proof_size_bytes, proof_time_ms, verified, ... }
```

## Mail (`rc.mail`)

On-chain encrypted email with `@rouge.quant` addresses.

```typescript
// Send an encrypted email
await rc.mail.send({
  from: wallet.publicKey,
  to: recipientPubKey,
  subject: "Hello",
  body: "This is a test",
  encrypted_subject: encryptedSubject,
  encrypted_body: encryptedBody,
});

// Read inbox
const inbox = await rc.mail.getInbox(wallet.publicKey);

// Move to trash
await rc.mail.move(messageId, "trash");

// Mark as read
await rc.mail.markRead(messageId);
```

## Messenger (`rc.messenger`)

End-to-end encrypted messaging with media and self-destruct support.

```typescript
// Register wallet for messaging
await rc.messenger.registerWallet({
  id: wallet.publicKey,
  displayName: "Alice",
  signingPublicKey: wallet.publicKey,
  encryptionPublicKey: encPubKey,
});

// Create a conversation
const result = await rc.messenger.createConversation([
  wallet.publicKey,
  recipientPubKey,
]);

// Fetch conversations (with extended key matching)
const convos = await rc.messenger.getConversations(wallet.publicKey, {
  signingPublicKey: wallet.publicKey,
  encryptionPublicKey: encPubKey,
});

// Send an encrypted message (with optional self-destruct)
await rc.messenger.sendMessage(conversationId, wallet.publicKey, encryptedContent, {
  selfDestruct: true,
  destructAfterSeconds: 30,
});

// Read messages
const messages = await rc.messenger.getMessages(conversationId);

// Delete a message
await rc.messenger.deleteMessage(messageId);
```

## Shielded Transactions (`rc.shielded`)

Private value transfers using zk-STARK proofs. Shield XRGE into private notes, transfer privately, and unshield back to public balance.

```typescript
import { createShieldedNote, computeCommitment, computeNullifier } from "@rougechain/sdk";

// Shield 100 XRGE into a private note
const { note } = await rc.shielded.shield(wallet, { amount: 100 });
// ⚠️ Save `note` securely — losing it means losing the funds!
// note = { commitment, nullifier, value, randomness, ownerPubKey }

// Check pool stats
const stats = await rc.shielded.getStats();
// { commitment_count, nullifier_count, active_notes }

// Check if a nullifier has been spent
const { spent } = await rc.shielded.isNullifierSpent(note.nullifier);

// Private transfer (requires STARK proof from Rust prover)
await rc.shielded.transfer(wallet, {
  nullifiers: [note.nullifier],
  outputCommitments: [recipientCommitment],
  proof: starkProofHex,
});

// Unshield back to public balance
await rc.shielded.unshield(wallet, {
  nullifiers: [note.nullifier],
  amount: 100,
  proof: starkProofHex,
});

// Client-side crypto primitives
const randomness = generateRandomness();
const commitment = computeCommitment(100, wallet.publicKey, randomness);
const nullifier = computeNullifier(randomness, commitment);
```

## Low-Level Signing

For advanced use cases:

```typescript
import { signTransaction, verifyTransaction, generateNonce } from "@rougechain/sdk";

const payload = {
  type: "transfer" as const,
  from: wallet.publicKey,
  to: recipient,
  amount: 100,
  fee: 1,
  token: "XRGE",
  timestamp: Date.now(),
  nonce: generateNonce(),
};

const signedTx = signTransaction(payload, wallet.privateKey, wallet.publicKey);
const valid = verifyTransaction(signedTx); // true
```

## Environment Support

| Environment | Notes |
|-------------|-------|
| **Browser** | Works with any bundler (Vite, webpack, etc.) |
| **Node.js 18+** | Works out of the box |
| **Node.js < 18** | Pass a fetch polyfill: `new RougeChain(url, { fetch })` |
| **React Native** | Install `react-native-get-random-values` before importing |

## TypeScript

Written in TypeScript with full type declarations shipped. All interfaces are exported:

```typescript
import type {
  Block, Transaction, TokenMetadata, NftCollection,
  NftToken, LiquidityPool, BalanceResponse, Validator,
  BridgeConfig, MailMessage, MessengerMessage, WalletKeys,
  PriceSnapshot, PoolEvent, PoolStats, SwapQuote,
  ShieldParams, ShieldedTransferParams, UnshieldParams, ShieldedStats,
  ShieldedNote,
  RollupStatus, RollupBatchResult, RollupSubmitParams, RollupSubmitResult,
} from "@rougechain/sdk";
```

## Security

- **Post-quantum cryptography** — All signatures use ML-DSA-65 (CRYSTALS-Dilithium), resistant to quantum computer attacks
- **Client-side signing** — Private keys never leave your application
- **No key storage** — The SDK does not store or transmit keys

## Links

- [Website](https://rougechain.io)
- [Documentation](https://docs.rougechain.io)
- [Chrome Extension](https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj)
- [GitHub](https://github.com/cyberdreadx/rougechain-node)

## License

MIT © [RougeChain](https://rougechain.io)
