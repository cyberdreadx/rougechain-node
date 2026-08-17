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

// Generate a new post-quantum wallet (24-word BIP-39 mnemonic + keypair)
const wallet = Wallet.generate();
console.log('Public key:', wallet.publicKey);
console.log('Recovery phrase:', wallet.mnemonic); // save this to restore the wallet

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

// Generate a new wallet WITH a 24-word BIP-39 recovery phrase (default, recommended)
const wallet = Wallet.generate();
console.log(wallet.mnemonic); // "word1 word2 … word24"

// 12-word phrase instead of 24
const wallet12 = Wallet.generate(128);

// Generate from pure entropy — no mnemonic, cannot be seed-restored
const random = Wallet.generateRandom();

// Restore from a BIP-39 recovery phrase (optionally with a 25th-word passphrase)
const fromSeed = Wallet.fromMnemonic('word1 word2 … word24');

// Restore from saved hex keys
const restored = Wallet.fromKeys(publicKey, privateKey);

// Derive the short Bech32m address (rouge1…) from the public key
const address = await wallet.address();

// Export for storage — includes `mnemonic` when the wallet has one
const keys = wallet.toJSON(); // { publicKey, privateKey, mnemonic? }

// Verify keypair integrity
const valid = wallet.verify(); // true
```

> The mnemonic model is what the [MCP server](mcp-server.md) uses via `ROUGECHAIN_MNEMONIC`.
> Store the phrase securely — anyone with it controls the wallet.

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
// Pool queries
await rc.dex.getPools();
await rc.dex.getPool('XRGE-MTK');
await rc.dex.getPriceHistory('XRGE-MTK');  // PriceSnapshot[] — for building charts
await rc.dex.getPoolStats('XRGE-MTK');     // volume, swap counts (total + 24h)
await rc.dex.getPoolEvents('XRGE-MTK');    // swap/add/remove event history

// Quote & swap
await rc.dex.quote({ poolId: 'XRGE-MTK', tokenIn: 'XRGE', tokenOut: 'MTK', amountIn: 100 });
await rc.dex.swap(wallet, { tokenIn: 'XRGE', tokenOut: 'MTK', amountIn: 100, minAmountOut: 95 });

// Liquidity
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

### Mail Name Registry (`rc.mail`)

Register human-readable names and resolve recipients before sending encrypted mail. Third-party apps must call these for cross-app mail to work.

All write operations require a `wallet` parameter for ML-DSA-65 signed requests via `/api/v2/` endpoints with anti-replay nonce protection.

```typescript
// Register wallet on the node first (signed request)
await rc.messenger.registerWallet(wallet, {
  id: wallet.publicKey,
  displayName: "Alice",
  signingPublicKey: wallet.publicKey,
  encryptionPublicKey: encPubKey,
});

// Register a mail name (signed request)
await rc.mail.registerName(wallet, "alice", wallet.publicKey);

// Resolve a name → wallet info (public, no signing needed)
const resolved = await rc.mail.resolveName("bob");
// { entry: { name, wallet_id }, wallet: { id, encryption_public_key, ... } }

// Reverse lookup: wallet ID → name (public, no signing needed)
const name = await rc.mail.reverseLookup(wallet.publicKey); // "alice"

// Release a name (signed request)
await rc.mail.releaseName(wallet, "alice");

// Send mail (signed request, multi-recipient CEK encryption)
await rc.mail.send(wallet, { from, to, subject, body, encrypted_subject, encrypted_body });

// Read inbox / sent (signed requests)
const inbox = await rc.mail.getInbox(wallet);
const sent = await rc.mail.getSent(wallet);

// Manage mail (signed requests)
await rc.mail.markRead(wallet, messageId);
await rc.mail.move(wallet, messageId, "trash");
await rc.mail.delete(wallet, messageId);
```

### Messenger (`rc.messenger`)

All operations use ML-DSA-65 signed requests with nonce-based anti-replay protection.

```typescript
await rc.messenger.getWallets();
await rc.messenger.registerWallet(wallet, { id, displayName, signingPublicKey, encryptionPublicKey });
await rc.messenger.getConversations(wallet);
await rc.messenger.createConversation(wallet, [pubKeyA, pubKeyB]);
await rc.messenger.getMessages(wallet, conversationId);
await rc.messenger.sendMessage(wallet, conversationId, encryptedContent, { selfDestruct: true, destructAfterSeconds: 30 });
await rc.messenger.deleteMessage(wallet, messageId, conversationId);
await rc.messenger.deleteConversation(wallet, conversationId);
```

### Social (`rc.social`)

On-chain posts, replies, reposts, follows, likes, and track comments. Writes are
ML-DSA-65 signed; reads are public.

```typescript
// Reads
await rc.social.getGlobalTimeline(50, 0);        // newest-first feed
await rc.social.getPost(postId, viewerPubKey);   // single post + stats
await rc.social.getUserPosts(pubKey);
await rc.social.getPostReplies(postId);
await rc.social.getTrackStats(trackId, viewerPubKey);
await rc.social.getArtistStats(artistPubKey, viewerPubKey);

// Writes (signed)
await rc.social.createPost(wallet, 'gm from RougeChain');
await rc.social.createPost(wallet, 'nice!', parentPostId); // reply
await rc.social.deletePost(wallet, postId);
await rc.social.toggleRepost(wallet, postId);
await rc.social.toggleFollow(wallet, artistPubKey);
await rc.social.toggleLike(wallet, trackId);
await rc.social.postComment(wallet, trackId, 'great track');
```

### Push Notifications

```typescript
// Register for push notifications (PQC-signed) — pass the wallet, not raw keys
await rc.registerPushToken(wallet, 'ExponentPushToken[xxx]');           // platform defaults to "expo"
await rc.registerPushToken(wallet, 'ExponentPushToken[xxx]', 'expo');

// Unregister
await rc.unregisterPushToken(wallet);
```

### Address Resolution

```typescript
// Resolve rouge1… address to public key, or vice versa
const result = await rc.resolveAddress('rouge1q8f3x...');
// → { address, publicKey, balance }
```

### Account Nonce

```typescript
const nonce = await rc.getNonce(publicKey);
// → { nonce, next_nonce }
```

### Token Allowances (ERC-20 style approve / transferFrom)

There are no `rc.approveAllowance` / `rc.transferFrom` convenience methods. Build the
signed transaction with the exported signer helpers, then submit it with
`rc.submitTx(endpoint, signedTx)`:

```typescript
import {
  createSignedTokenApproval,
  createSignedTokenTransferFrom,
} from '@rougechain/sdk';

// Approve a spender to move up to `amount` of your MTK
await rc.submitTx(
  '/v2/token/approve',
  createSignedTokenApproval(wallet, spenderPubKey, 'MTK', 1000),
);

// Spend an existing allowance on the owner's behalf
await rc.submitTx(
  '/v2/token/transfer-from',
  createSignedTokenTransferFrom(wallet, ownerPubKey, recipientPubKey, 'MTK', 1000),
);

// Read current allowances (public)
await rc.get('/token/allowances');
await rc.get('/token/allowance');
```

> **Freeze/unfreeze** a token you created is a creator-only signed request to
> `/api/v2/token/freeze` (payload `{ tokenSymbol, frozen }`). There is no dedicated
> SDK helper — sign it with the generic `signRequest(wallet, payload)` and post it.

### Multi-Sig Wallets

Multi-sig **queries** are available today:

```typescript
const wallets   = await rc.get('/multisig/wallets');
const myWallets = await rc.get(`/multisig/wallets/${myPubKey}`);
const wallet_   = await rc.get(`/multisig/wallet/${walletId}`);
const proposals = await rc.get(`/multisig/wallet/${walletId}/proposals`);
```

> **Note:** creating a multi-sig wallet and submitting/approving proposals
> (`multisig_create` / `multisig_submit` / `multisig_approve`) are on-chain
> transaction types, but they are **not yet exposed through a stable SDK method or
> public submit endpoint** — the node currently serves the multi-sig read routes
> above only. Do not call `rc.sendTransaction(...)`; that method does not exist.
> Multi-sig write support is tracked for a future release.

### Smart Contracts (`rc.shielded`)

Contract helpers are accessed via the `rc.shielded` sub-client:

```typescript
// Deploy WASM contract
const deploy = await rc.shielded.deployContract({
  wasm: base64WasmBytes,
  deployer: wallet.publicKey,
});

// Call contract method
const result = await rc.shielded.callContract({
  contractAddr: deploy.address,
  method: 'increment',
  caller: wallet.publicKey,
  args: { key: 'value' },
  gasLimit: 10_000_000,
});

// Query contract
const meta = await rc.shielded.getContract(deploy.address);
const state = await rc.shielded.getContractState(deploy.address);
const events = await rc.shielded.getContractEvents(deploy.address);
```

### EIP-1559 Fee Info

```typescript
const feeInfo = await rc.getFeeInfo();
// → { base_fee, total_fee_suggestion, total_fees_burned, block_height }
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
import type {
  Block, Transaction, Validator, LiquidityPool, NftCollection,
  NameEntry, ResolvedName, MailMessage, SendMailParams,
  PriceSnapshot, PoolStats, SwapQuote,
} from '@rougechain/sdk';
```

## Security

- All signatures use ML-DSA-65 (FIPS 204), resistant to quantum attacks
- Private keys never leave your application
- The SDK does not store keys — persistence is your responsibility
- All mail, messenger, and name registry operations use ML-DSA-65 signed requests with timestamp validation and nonce-based anti-replay protection
- Mail uses a CEK pattern for efficient multi-recipient encryption via ML-KEM-768
- TOFU key fingerprint tracking for contact key-change detection

## Source

The SDK source code is in the `sdk/` directory of the [quantum-vault repository](https://github.com/cyberdreadx/rougechain-node).
