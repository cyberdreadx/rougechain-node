# SDK (`@rougechain/sdk`)

The official JavaScript/TypeScript SDK for building on RougeChain.

## Installation

```bash
npm install @rougechain/sdk
```

## Quick Start

```typescript
import { RougeChain, Wallet } from '@rougechain/sdk';

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

## Wallet

All signing happens client-side. Private keys never leave your application.

```typescript
import { Wallet } from '@rougechain/sdk';

// Generate new keypair
const wallet = Wallet.generate();

// Restore from saved keys
const restored = Wallet.fromKeys(publicKey, privateKey);

// Export for storage
const keys = wallet.toJSON(); // { publicKey, privateKey }

// Verify keypair integrity
const valid = wallet.verify(); // true
```

## Client

```typescript
import { RougeChain } from '@rougechain/sdk';

// Basic connection
const rc = new RougeChain('https://testnet.rougechain.io/api');

// With API key
const rc = new RougeChain('https://testnet.rougechain.io/api', {
  apiKey: 'your-api-key',
});
```

## Available Methods

### Queries

```typescript
await rc.getHealth();
await rc.getStats();
await rc.getBlocks({ limit: 10 });
await rc.getBalance(publicKey);
await rc.getValidators();
await rc.getTokens();
await rc.getBurnedTokens();
```

### Transactions

```typescript
await rc.transfer(wallet, { to: recipient, amount: 100 });
await rc.transfer(wallet, { to: recipient, amount: 50, token: 'MYTOKEN' });
await rc.createToken(wallet, { name: 'My Token', symbol: 'MTK', totalSupply: 1_000_000, image: 'https://example.com/logo.png' });
await rc.burn(wallet, 500, 1, 'XRGE');
await rc.faucet(wallet);
```

### Staking

```typescript
await rc.stake(wallet, { amount: 1000 });
await rc.unstake(wallet, { amount: 500 });
```

### DEX (`rc.dex`)

```typescript
await rc.dex.getPools();
await rc.dex.getPool('XRGE-MTK');
await rc.dex.quote({ poolId: 'XRGE-MTK', tokenIn: 'XRGE', tokenOut: 'MTK', amountIn: 100 });
await rc.dex.swap(wallet, { tokenIn: 'XRGE', tokenOut: 'MTK', amountIn: 100, minAmountOut: 95 });
await rc.dex.createPool(wallet, { tokenA: 'XRGE', tokenB: 'MTK', amountA: 10000, amountB: 5000 });
await rc.dex.addLiquidity(wallet, { poolId: 'XRGE-MTK', amountA: 1000, amountB: 500 });
await rc.dex.removeLiquidity(wallet, { poolId: 'XRGE-MTK', lpAmount: 100 });
```

### NFTs (`rc.nft`)

```typescript
await rc.nft.createCollection(wallet, { symbol: 'ART', name: 'My Art', royaltyBps: 500, maxSupply: 10000 });
await rc.nft.mint(wallet, { collectionId: 'abc123', name: 'Piece #1', metadataUri: '...' });
await rc.nft.batchMint(wallet, { collectionId: 'abc123', names: ['#1', '#2'], uris: ['...', '...'] });
await rc.nft.transfer(wallet, { collectionId: 'abc123', tokenId: 1, to: buyerPubKey, salePrice: 100 });
await rc.nft.getCollections();
await rc.nft.getByOwner(wallet.publicKey);
```

### Bridge (`rc.bridge`)

```typescript
await rc.bridge.getConfig();
await rc.bridge.withdraw(wallet, { amount: 500000, evmAddress: '0x...' });
await rc.bridge.claim({ evmTxHash: '0x...', evmAddress: '0x...', evmSignature: '0x...', recipientPubkey: wallet.publicKey });
await rc.bridge.getWithdrawals();
```

## Environment Support

| Environment | Requirements |
|-------------|-------------|
| Browser | Any bundler (Vite, webpack) |
| Node.js 18+ | Works out of the box |
| Node.js < 18 | Provide `node-fetch` polyfill |
| React Native | Install `react-native-get-random-values` |

## TypeScript

Full type declarations are included:

```typescript
import type { Block, Transaction, Validator, LiquidityPool, NftCollection } from '@rougechain/sdk';
```

## Security

- All signatures use ML-DSA-65 (FIPS 204), resistant to quantum attacks
- Private keys never leave your application
- The SDK does not store keys — persistence is your responsibility

## Source

The SDK source code is in the `sdk/` directory of the [quantum-vault repository](https://github.com/cyberdreadx/quantum-vault).
