# @rougechain/sdk v1.0.0

## The first production-ready SDK for building quantum-safe dApps

After months of iteration across 9 pre-release versions, the RougeChain SDK hits v1.0.0 — a milestone release that makes RougeChain the most feature-complete post-quantum blockchain for developers.

### What's in the box

`npm install @rougechain/sdk`

One package. Every feature. Works in the browser, Node.js 18+, and React Native.

| Namespace | What it does |
|-----------|-------------|
| `rc` | Transfers, token creation, staking, governance, fees, WebSocket |
| `rc.dex` | AMM pools, swaps with slippage protection, liquidity, price history |
| `rc.nft` | RC-721 collections, minting, batch mint, royalties, transfers |
| `rc.social` | **NEW** — Posts, timeline, reposts, likes, follows, comments, tips |
| `rc.shielded` | Private transfers with zk-STARK proofs, shield/unshield |
| `rc.bridge` | ETH/USDC/XRGE bridge (Base ↔ RougeChain) |
| `rc.mail` | Encrypted email with `@rouge.quant` / `@qwalla.mail` addresses |
| `rc.messenger` | E2E encrypted messaging with self-destruct and spoiler tags |

### Headline feature: Social layer

v1.0.0 introduces `rc.social` — a full social layer built into every RougeChain node:

- **Posts** — Create text posts (up to 4000 chars) with threaded replies
- **Timeline** — Global timeline and personalized following feed
- **Reposts** — Toggle reposts on any post with aggregate counts
- **Likes** — Toggle likes on posts or tracks (unified system)
- **Follows** — Follow/unfollow any user with follower counts
- **Comments** — Track-level comments with pagination
- **Play counts** — Record and query play counts for media tracks
- **Tips** — Send XRGE tips that settle on L1 via `rc.transfer()`

All writes are signed with ML-DSA-65 (NIST FIPS 204). Data is stored server-side in sled. Tips are real on-chain transfers.

```typescript
import { RougeChain, Wallet } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");
const wallet = Wallet.generate();

// Create a post
const { post } = await rc.social.createPost(wallet, "Hello RougeChain!");

// Like it
await rc.social.toggleLike(wallet, post.id);

// Repost it
await rc.social.toggleRepost(wallet, post.id);

// Reply
await rc.social.createPost(wallet, "Great post!", post.id);

// Browse the timeline
const timeline = await rc.social.getGlobalTimeline();

// Get your personalized feed
const feed = await rc.social.getFollowingFeed(wallet);
```

### What else shipped in this release cycle

**Security & Infrastructure:**
- WASM STARK prover — client-side zk-STARK proof generation in the browser
- All messenger/mail endpoints migrated to ML-DSA-65 signed v2 API
- Multi-recipient CEK mail encryption (ML-KEM-768 + AES-256-GCM)
- Anti-replay nonce protection on all write endpoints
- TOFU key fingerprint verification in messenger

**User Experience:**
- Unread badges and tooltips on Chat/Mail tabs (browser extension + QWalla + website)
- Native browser notifications for messages, mail, transfers, staking events
- Gmail-style mail threading with collapsible thread groups
- Mail reply auto-fill (recipient, subject, quoted body)
- Mail attachments with upload, preview, and download
- Spoiler messages (QWalla) and self-destruct messages (browser extension)

**Developer Experience:**
- 29 MCP tools for AI agent integration (up from 23)
- CLI v1.0.0 with social commands (`post`, `timeline`, `like`, `repost`, `feed`)
- Full TypeScript declarations for all 40+ interfaces
- Browser, Node.js 18+, and React Native support

**Economics:**
- Validator economics tuned: 50% base fee burn, 0.1 XRGE/block minimum tip floor
- 10,000 XRGE minimum stake enforced
- Background entropy prefetch eliminates block production stalls

### Breaking changes

None. v1.0.0 is backwards-compatible with v0.9.x. All existing `rc.dex`, `rc.nft`, `rc.mail`, `rc.messenger`, `rc.shielded`, and `rc.bridge` methods work unchanged. The `rc.social` namespace is purely additive.

### Migration from v0.9.x

```bash
npm install @rougechain/sdk@latest
```

That's it. No code changes required.

### Links

- **npm:** [npmjs.com/package/@rougechain/sdk](https://www.npmjs.com/package/@rougechain/sdk)
- **Docs:** [rougechain.io/docs](https://rougechain.io/docs)
- **Website:** [rougechain.io](https://rougechain.io)
- **Testnet:** [testnet.rougechain.io](https://testnet.rougechain.io)
- **Chrome Extension:** [RougeChain Wallet](https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj)
- **GitHub:** [github.com/cyberdreadx/rougechain-node](https://github.com/cyberdreadx/rougechain-node)

### What's next

- Social UI in the browser extension and website
- Search and hashtags for the social layer
- On-chain governance integration with the social feed
- Municipal utility tracking (water/electricity on-chain) — future prototype

---

Built with post-quantum cryptography. Private keys never leave your app. Every signature uses ML-DSA-65 (CRYSTALS-Dilithium, FIPS 204). Every encryption uses ML-KEM-768 (CRYSTALS-Kyber, FIPS 203). Quantum-safe from block zero.
