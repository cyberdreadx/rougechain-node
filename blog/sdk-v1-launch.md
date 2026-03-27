# Building the Future of Social on a Quantum-Safe Blockchain

**@rougechain/sdk v1.0.0 is live.**

Today we're releasing the first production-ready SDK for building decentralized applications on a post-quantum blockchain. And the headline feature might surprise you — it's not another DeFi primitive. It's social.

## Why social belongs on-chain

Every major social platform today is centralized. Your posts, your followers, your entire social graph lives on someone else's servers. They can censor you, deplatform you, sell your data, or shut down entirely — and you lose everything.

Decentralized social protocols like Farcaster and Lens have made progress, but they introduce their own infrastructure (hubs, Polygon) and separate token economies. We asked: what if social was just another feature of the L1 itself?

## `rc.social` — Social as infrastructure

RougeChain v1.0.0 ships a social layer built directly into every node. No separate protocol. No extra token. No additional infrastructure to run.

```typescript
import { RougeChain, Wallet } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");
const wallet = Wallet.generate();

// Your first quantum-safe social post
const { post } = await rc.social.createPost(wallet, "Hello, post-quantum world!");
```

That's a real post, stored on every RougeChain node, signed with ML-DSA-65 — the same NIST-standardized post-quantum signature algorithm that secures every transaction on the chain.

### What you can build

The social namespace gives you everything you need:

**Posts & Threading**
- Create posts up to 4000 characters
- Reply to any post with `replyToId` for threaded conversations
- Delete your own posts
- Fetch any user's post history

**Discovery**
- Global timeline — all posts, newest first
- Following feed — posts from people you follow, personalized
- Post stats — likes, reposts, reply counts with viewer state

**Engagement**
- Like/unlike any post or track (toggle)
- Repost/unrepost (toggle)
- Follow/unfollow any user
- Comment on tracks with pagination

**Monetization**
- Tips settle on L1 as real XRGE transfers via `rc.transfer()`
- No engagement tokens. No points system. Real value transfer.

### Every action is cryptographically signed

This is the key difference from centralized social platforms: every post, like, follow, and repost is signed with your ML-DSA-65 private key. The server verifies the signature, checks the timestamp, and rejects replay attacks.

This means:
- **No impersonation** — nobody can post as you without your private key
- **Provable authorship** — every post has a cryptographic proof of who wrote it
- **Quantum-resistant** — these signatures are safe from future quantum computers

## Beyond social: what else is in v1.0.0

The SDK is a complete toolkit for building on RougeChain:

- **Wallet** — ML-DSA-65 keypair generation, BIP-39 mnemonics, client-side signing
- **DeFi** — AMM pools, swaps, liquidity provision, multi-hop routing
- **NFTs** — RC-721 collections, minting, royalties, batch operations
- **Privacy** — Shielded transactions with zk-STARK proofs
- **Communication** — E2E encrypted messenger and mail (ML-KEM-768)
- **Bridge** — ETH/USDC/XRGE between Base and RougeChain
- **AI** — 29 MCP tools for AI agent integration

## Real-world example: qRougee

We built [qRougee](https://github.com/cyberdreadx/qRougee) — a music streaming dApp — entirely on RougeChain's social layer. It demonstrates:

- Play counts tracked via `rc.social.recordPlay()`
- Like buttons via `rc.social.toggleLike()`
- Tip buttons that send XRGE to artists via `rc.transfer()`
- Comment sections via `rc.social.postComment()`
- Follow buttons via `rc.social.toggleFollow()`
- Artist profiles with follower counts via `rc.social.getArtistStats()`
- "Liked" library tab via `rc.social.getUserLikes()`
- Discovery sorted by popularity (plays + likes)

All of this works with a single SDK import. No separate social protocol deployment. No subgraph. No indexer configuration.

## CLI support

The RougeChain CLI also ships social commands:

```bash
# Post from your terminal
rougechain post "Building on RougeChain"

# Browse the timeline
rougechain timeline --limit 20

# Like a post
rougechain like <post-id>

# Repost
rougechain repost <post-id>

# Your personalized feed
rougechain feed
```

## Get started

```bash
npm install @rougechain/sdk
```

```typescript
import { RougeChain, Wallet } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");
const wallet = Wallet.generate();

// Get testnet tokens
await rc.faucet(wallet);

// Create a post
await rc.social.createPost(wallet, "First post on a quantum-safe social network!");

// Follow someone
await rc.social.toggleFollow(wallet, somePubKey);

// Browse your feed
const feed = await rc.social.getFollowingFeed(wallet);
```

The testnet is live at [testnet.rougechain.io](https://testnet.rougechain.io). Full documentation at [rougechain.io/docs](https://rougechain.io/docs).

## What's next

- Social UI in the RougeChain website and browser extension
- Search and hashtags
- On-chain governance tied to the social feed
- Media posts (images, video)

The social layer is just the beginning. RougeChain is building the infrastructure for a post-quantum internet — where your identity, your money, your messages, and your social graph are all owned by you and secured by math that quantum computers can't break.

---

*RougeChain SDK v1.0.0 is available now on npm. MIT licensed. Works in browser, Node.js 18+, and React Native.*

*Every signature uses ML-DSA-65 (FIPS 204). Every encryption uses ML-KEM-768 (FIPS 203). Private keys never leave your application.*
