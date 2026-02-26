# @rougechain/sdk

Official SDK for **RougeChain** — a post-quantum Layer 1 blockchain secured by ML-DSA-65 (CRYSTALS-Dilithium) signatures.

Build dApps on RougeChain from any JavaScript/TypeScript environment: browser, Node.js, or React Native.

## Installation

```bash
npm install @rougechain/sdk
```

## Quick Start

```typescript
import { RougeChain, Wallet } from '@rougechain/sdk';

// Connect to a RougeChain node
const rc = new RougeChain('https://testnet.rougechain.io/api');

// Generate a new post-quantum wallet
const wallet = Wallet.generate();
console.log('Public key:', wallet.publicKey);

// Request testnet tokens
await rc.faucet(wallet);

// Check balance
const balance = await rc.getBalance(wallet.publicKey);
console.log('Balance:', balance);

// Transfer tokens
await rc.transfer(wallet, { to: recipientPubKey, amount: 100 });
```

## Core Concepts

### Wallet

All signing happens client-side. Private keys never leave your application.

```typescript
import { Wallet } from '@rougechain/sdk';

// Generate a new ML-DSA-65 keypair
const wallet = Wallet.generate();

// Restore from saved keys
const restored = Wallet.fromKeys(publicKey, privateKey);

// Export for storage (your responsibility to store securely)
const keys = wallet.toJSON(); // { publicKey, privateKey }

// Verify keypair integrity
const valid = wallet.verify(); // true
```

### Client

The `RougeChain` client handles all API communication. Pass a wallet to any write method to sign transactions automatically.

```typescript
import { RougeChain } from '@rougechain/sdk';

const rc = new RougeChain('https://testnet.rougechain.io/api');

// With API key (if the node requires it)
const rc = new RougeChain('https://testnet.rougechain.io/api', {
  apiKey: 'your-api-key',
});

// Custom fetch (useful for Node.js < 18 or React Native)
const rc = new RougeChain('https://testnet.rougechain.io/api', {
  fetch: customFetchFn,
});
```

## API Reference

### Queries (no wallet needed)

```typescript
// Node
const stats = await rc.getStats();
const health = await rc.getHealth();

// Blocks
const blocks = await rc.getBlocks({ limit: 10 });
const summary = await rc.getBlocksSummary('24h');

// Balance
const balance = await rc.getBalance(publicKey);
const tokenBal = await rc.getTokenBalance(publicKey, 'MYTOKEN');

// Tokens
const tokens = await rc.getTokens();
const meta = await rc.getTokenMetadata('MYTOKEN');
const holders = await rc.getTokenHolders('MYTOKEN');

// Validators
const validators = await rc.getValidators();
const finality = await rc.getFinality();

// Burned tokens
const burned = await rc.getBurnedTokens();
```

### Transfers & Tokens

```typescript
// Transfer XRGE
await rc.transfer(wallet, { to: recipient, amount: 100 });

// Transfer custom token
await rc.transfer(wallet, { to: recipient, amount: 50, token: 'MYTOKEN' });

// Create a new token
await rc.createToken(wallet, {
  name: 'My Token',
  symbol: 'MTK',
  totalSupply: 1_000_000,
});

// Burn tokens
await rc.burn(wallet, 500, 1, 'XRGE');

// Faucet (testnet only)
await rc.faucet(wallet);
```

### Staking

```typescript
await rc.stake(wallet, { amount: 1000 });
await rc.unstake(wallet, { amount: 500 });
```

### DEX (rc.dex)

```typescript
// List pools
const pools = await rc.dex.getPools();

// Get pool details
const pool = await rc.dex.getPool('XRGE-MTK');

// Get swap quote
const quote = await rc.dex.quote({
  poolId: 'XRGE-MTK',
  tokenIn: 'XRGE',
  amountIn: 100,
});

// Execute swap
await rc.dex.swap(wallet, {
  tokenIn: 'XRGE',
  tokenOut: 'MTK',
  amountIn: 100,
  minAmountOut: 95,
});

// Create pool
await rc.dex.createPool(wallet, {
  tokenA: 'XRGE',
  tokenB: 'MTK',
  amountA: 10000,
  amountB: 5000,
});

// Add / remove liquidity
await rc.dex.addLiquidity(wallet, { poolId: 'XRGE-MTK', amountA: 1000, amountB: 500 });
await rc.dex.removeLiquidity(wallet, { poolId: 'XRGE-MTK', lpAmount: 100 });

// Pool analytics
const events = await rc.dex.getPoolEvents('XRGE-MTK');
const stats = await rc.dex.getPoolStats('XRGE-MTK');
```

### NFTs (rc.nft)

RougeChain implements the RC-721 NFT standard with collections, royalties, freezing, and batch minting.

```typescript
// Create a collection
await rc.nft.createCollection(wallet, {
  symbol: 'ART',
  name: 'My Art Collection',
  royaltyBps: 500, // 5% royalty
  maxSupply: 10000,
  description: 'A post-quantum NFT collection',
});

// Mint an NFT
await rc.nft.mint(wallet, {
  collectionId: 'abc123',
  name: 'Piece #1',
  metadataUri: 'https://example.com/nft/1.json',
  attributes: { rarity: 'legendary' },
});

// Batch mint (up to 50)
await rc.nft.batchMint(wallet, {
  collectionId: 'abc123',
  names: ['#1', '#2', '#3'],
  uris: ['https://example.com/1.json', 'https://example.com/2.json', 'https://example.com/3.json'],
});

// Transfer with optional sale price (triggers royalty)
await rc.nft.transfer(wallet, {
  collectionId: 'abc123',
  tokenId: 1,
  to: buyerPubKey,
  salePrice: 100, // triggers royalty payment to creator
});

// Burn, lock, freeze
await rc.nft.burn(wallet, { collectionId: 'abc123', tokenId: 1 });
await rc.nft.lock(wallet, { collectionId: 'abc123', tokenId: 2, locked: true });
await rc.nft.freezeCollection(wallet, { collectionId: 'abc123', frozen: true });

// Queries
const collections = await rc.nft.getCollections();
const collection = await rc.nft.getCollection('abc123');
const tokens = await rc.nft.getTokens('abc123', { limit: 20, offset: 0 });
const token = await rc.nft.getToken('abc123', 1);
const myNfts = await rc.nft.getByOwner(wallet.publicKey);
```

### Bridge (rc.bridge)

Bridge between Base Sepolia ETH and RougeChain qETH.

```typescript
// Check bridge status
const config = await rc.bridge.getConfig();
// { enabled: true, custodyAddress: '0x...', chainId: 84532 }

// Withdraw qETH to receive ETH on Base Sepolia
await rc.bridge.withdraw(wallet, {
  amount: 500000, // in qETH units
  evmAddress: '0xYourBaseSepoliaAddress',
});

// Claim (after depositing ETH to custody address)
await rc.bridge.claim({
  evmTxHash: '0x...',
  evmAddress: '0x...',
  evmSignature: '0x...', // personal_sign from MetaMask
  recipientPubkey: wallet.publicKey,
});

// List pending withdrawals
const withdrawals = await rc.bridge.getWithdrawals();
```

### Low-Level Signing

For advanced use cases, sign transactions manually:

```typescript
import { signTransaction, verifyTransaction, generateNonce } from '@rougechain/sdk';

const payload = {
  type: 'transfer' as const,
  from: wallet.publicKey,
  to: recipient,
  amount: 100,
  fee: 1,
  token: 'XRGE',
  timestamp: Date.now(),
  nonce: generateNonce(),
};

const signedTx = signTransaction(payload, wallet.privateKey, wallet.publicKey);
const valid = verifyTransaction(signedTx); // true
```

## Environment Setup

### Browser

Works out of the box with any bundler (Vite, webpack, etc.).

### Node.js 18+

Works out of the box (native `fetch` and `crypto.getRandomValues`).

### Node.js < 18

Provide a fetch polyfill:

```typescript
import fetch from 'node-fetch';
const rc = new RougeChain('https://testnet.rougechain.io/api', { fetch });
```

### React Native

Install a `crypto.getRandomValues` polyfill before importing the SDK:

```typescript
import 'react-native-get-random-values';
import { RougeChain, Wallet } from '@rougechain/sdk';
```

## TypeScript

The SDK is written in TypeScript and ships with full type declarations. All interfaces are exported:

```typescript
import type {
  Block,
  Transaction,
  TokenMetadata,
  NftCollection,
  NftToken,
  LiquidityPool,
  BalanceResponse,
  Validator,
  BridgeConfig,
  WalletKeys,
  ApiResponse,
} from '@rougechain/sdk';
```

## Security

- **Post-quantum cryptography**: All signatures use ML-DSA-65 (CRYSTALS-Dilithium), resistant to quantum attacks.
- **Client-side signing**: Private keys never leave your application. Transactions are signed locally and submitted to the node pre-signed.
- **No key storage**: The SDK does not store keys. Persistence is your application's responsibility.

## License

MIT
