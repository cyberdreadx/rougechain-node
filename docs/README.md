# RougeChain Documentation

Welcome to **RougeChain** — a post-quantum secure Layer 1 blockchain built with real NIST-approved cryptography.

## Current Status

| Component | Status |
|---|---|
| RougeChain mainnet | **LIVE** |
| Consensus Release 1 (tx-integrity @90, proposer selection @100) | **LIVE — mandatory upgrade**, see [Mandatory upgrade](running-a-node/mandatory-upgrade-2026-09.md) |
| R1 production bridge | **LIVE** |
| XRGE / qETH / qUSDC bridge paths | **TESTED / USABLE** |
| V3 XRGE bridge | **AUDIT CANDIDATE / NOT ACTIVATED** |
| FINALITY_V2 | **BUILT / NOT ACTIVATED** |

RougeChain is post-quantum-secured at the L1 level. The current production XRGE bridge remains on
the hardened R1 architecture, which still relies on classical authorization on the Base side. A V3
XRGE bridge using ML-DSA-65 post-quantum authorization has been built and is undergoing final
rehearsal before production activation. It is not live. Details: [Status & Roadmap](status.md) ·
[Security Overview](security.md).

## What is RougeChain?

RougeChain is among the first blockchains designed from the ground up to be resistant to quantum computer attacks. It uses:

- **ML-DSA-65** (CRYSTALS-Dilithium) for digital signatures
- **ML-KEM-768** (CRYSTALS-Kyber) for key encapsulation
- **SHA-256** for hashing

All cryptographic primitives are NIST FIPS 204/203 compliant.

## Key Features

| Feature | Description |
|---------|-------------|
| **Post-Quantum L1** | Accounts, transactions and block signatures use quantum-resistant ML-DSA-65 |
| **Client-Side Signing** | Private keys never leave your browser |
| **AMM/DEX** | Uniswap V2-style liquidity pools and token swaps |
| **Token Burning** | Official burn address with on-chain tracking |
| **Proof of Stake** | Energy-efficient consensus with validator staking |
| **P2P Network** | Decentralized peer-to-peer block and transaction propagation |
| **Base Bridge (R1)** | Bridge XRGE, ETH (qETH) and USDC (qUSDC) between Base mainnet and RougeChain — classical authorization on the Base side |
| **Custom Tokens** | Create your own tokens on the network |
| **RC-721 NFTs** | NFT collections with royalties, batch minting, and freezing |
| **Encrypted Messenger** | E2E encrypted messaging with PQC, media support, self-destruct |
| **PQC Mail** | Encrypted email with `@rouge.quant` addresses and threading |
| **Browser Extensions** | Chrome/Firefox wallet extensions with vault lock |
| **PWA Support** | Installable progressive web app for mobile and desktop |
| **Social Layer** | Posts, timeline, reposts, likes, follows, comments, tips |
| **CLI Wallet** | Command-line wallet with full chain access and social commands |
| **SDK** | `@rougechain/sdk` npm package for building dApps |
| **EIP-1559 Dynamic Fees** | Base fee auto-adjusts per block, fee burning for deflationary pressure |
| **Token Mint Authority** | Ongoing minting for custom tokens with supply cap enforcement |
| **Validator Slashing** | Slash penalties for misbehavior, unbonding queue with 500-block delay |
| **Finality** | Legacy finality indicator is live; verified BFT finality (FINALITY_V2) is built but not activated — see [Finality](staking/finality.md) |
| **WebSocket Subscriptions** | Topic-based real-time event streaming (blocks, txs, accounts, tokens) |
| **HD Wallet Derivation** | BIP-44-like PQC key derivation from master seed (HMAC-SHA256) |
| **Open Source** | [Apache 2.0 licensed](https://github.com/cyberdreadx/rougechain-node) node software |

## Quick Links

- [Status & Roadmap](status.md)
- [Security Overview](security.md)
- [Getting Started](getting-started/README.md)
- [Running a Node](running-a-node/README.md)
- [API Reference](api-reference/README.md)
- [P2P Networking](p2p-networking/README.md)
- [Staking & Validators](staking/README.md)
- [Browser Extensions](advanced/browser-extensions.md)
- [CLI Wallet](advanced/cli.md)
- [SDK](advanced/sdk.md)
- [Architecture](advanced/architecture.md)
- [GitHub (Node Source)](https://github.com/cyberdreadx/rougechain-node)

## Network Info

**Mainnet is live** (chain-id `rougechain-mainnet-1`) alongside the public testnet.

| Network | Chain ID | API Endpoint |
|---------|----------|--------------|
| Mainnet | `rougechain-mainnet-1` | `https://api.rougechain.io/api` |
| Testnet | — | `https://testnet.rougechain.io/api` |
| Devnet (local) | — | `http://127.0.0.1:5101/api` |

> A local node's default `--api-port` is **5101**.

## Tokens

### XRGE

**XRGE is the native token that powers transactions, secures the network through staking, and fuels the post-quantum economy.**

| Role | How it works |
|------|-------------|
| **Gas Token** | Every transaction pays fees in XRGE. 50% of the base fee is burned; the remaining tip pool is split proposer 20% / validators 70% (stake-weighted) / treasury 10%. |
| **Staking Primitive** | Validators must stake XRGE to propose blocks. More stake = more proposals = more rewards. |
| **DeFi Base Pair** | AMM liquidity pools trade against XRGE. It's the default quote currency on the built-in DEX. |
| **Bridge Asset** | XRGE exists on both RougeChain (native) and Base (ERC-20) via the cross-chain bridge. |

**XRGE on Base:** ERC-20 at `0x147120faEC9277ec02d957584CFCD92B56A24317` (Base mainnet, chain id `8453`).
XRGE trades on Base DEXs (for example Aerodrome), so it can be swapped from any Base-compatible
wallet, including Coinbase Wallet / the Base app. Always verify the contract address above. XRGE
bought on Base is an ERC-20 until you move it to RougeChain through the [XRGE Bridge](bridge/xrge-bridge.md).

The XRGE bridge in production is the hardened **R1** bridge (`BridgeVaultV2`), with classical
authorization on the Base side. The post-quantum **V3** XRGE bridge is built but
[not activated](status.md).

### qETH

**qETH** is a bridged representation of ETH on RougeChain. It uses 6 decimal places and can be bridged in from **Base mainnet** or withdrawn back.

| Property | Value |
|----------|-------|
| Decimals | 6 |
| Bridge Source | Base mainnet (chain id `8453`) |
| Bridge Contract | `RougeBridge` at `0x0c09C764AdC024497729cd452ECfeE8869d35d83` |

### qUSDC

**qUSDC** is a bridged representation of USDC (Base mainnet) on RougeChain, using the same
`RougeBridge` contract. See [USDC Bridge](bridge/usdc-bridge.md).

> qETH and qUSDC use classical Base-side authorization and are **outside the scope of the V3
> post-quantum XRGE bridge**.

### Fees

| Action | Fee |
|--------|-----|
| Transfer | ~0.1 XRGE (base fee, adjusts per block) |
| Token Creation | 100 XRGE |
| Pool Creation | 10 XRGE |
| Swap | 0.3% (to LPs) |
| Minimum Stake | 10,000 XRGE |
| Unbonding Period | 500 blocks |

> **EIP-1559 Fee Model:** The base fee adjusts ±12.5% per block based on transaction volume (target: 10 txs/block). **50% of the base fee is burned**; the remaining tip pool is split proposer 20% / validators 70% (stake-weighted) / treasury 10%. Check current fees via `GET /api/fee`.

### Burn Address

Tokens can be permanently burned by sending to the official burn address:

```
XRGE_BURN_0x000000000000000000000000000000000000000000000000000000000000DEAD
```

Burned tokens are tracked on-chain and can be queried via the `/api/burned` endpoint.

## Security

### Client-Side Signing

RougeChain uses a secure v2 API where all transactions are signed client-side:

1. Your wallet creates a transaction payload
2. The payload is signed locally using ML-DSA-65
3. Only the signature and public key are sent to the server
4. **Your private key never leaves your browser**

This ensures maximum security even when interacting with untrusted nodes.
