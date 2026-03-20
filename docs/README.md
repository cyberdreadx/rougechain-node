# RougeChain Documentation

Welcome to **RougeChain** — a post-quantum secure Layer 1 blockchain built with real NIST-approved cryptography.

## What is RougeChain?

RougeChain is among the first blockchains designed from the ground up to be resistant to quantum computer attacks. It uses:

- **ML-DSA-65** (CRYSTALS-Dilithium) for digital signatures
- **ML-KEM-768** (CRYSTALS-Kyber) for key encapsulation
- **SHA-256** for hashing

All cryptographic primitives are NIST FIPS 204/203 compliant.

## Key Features

| Feature | Description |
|---------|-------------|
| **Post-Quantum Security** | Protected against both classical and quantum attacks |
| **Client-Side Signing** | Private keys never leave your browser |
| **AMM/DEX** | Uniswap V2-style liquidity pools and token swaps |
| **Token Burning** | Official burn address with on-chain tracking |
| **Proof of Stake** | Energy-efficient consensus with validator staking |
| **P2P Network** | Decentralized peer-to-peer block and transaction propagation |
| **qETH Bridge** | Bridge ETH from Base Sepolia to qETH on RougeChain |
| **Custom Tokens** | Create your own tokens on the network |
| **RC-721 NFTs** | NFT collections with royalties, batch minting, and freezing |
| **Encrypted Messenger** | E2E encrypted messaging with PQC, media support, self-destruct |
| **PQC Mail** | Encrypted email with `@rouge.quant` addresses and threading |
| **Browser Extensions** | Chrome/Firefox wallet extensions with vault lock |
| **PWA Support** | Installable progressive web app for mobile and desktop |
| **SDK** | `@rougechain/sdk` npm package for building dApps |
| **Open Source** | [Apache 2.0 licensed](https://github.com/cyberdreadx/rougechain-node) node software |

## Quick Links

- [Getting Started](getting-started/README.md)
- [Running a Node](running-a-node/README.md)
- [API Reference](api-reference/README.md)
- [P2P Networking](p2p-networking/README.md)
- [Staking & Validators](staking/README.md)
- [Browser Extensions](advanced/browser-extensions.md)
- [SDK](advanced/sdk.md)
- [Architecture](advanced/architecture.md)
- [GitHub (Node Source)](https://github.com/cyberdreadx/rougechain-node)

## Network Info

| Network | API Endpoint |
|---------|--------------|
| Testnet | `https://testnet.rougechain.io/api` |
| Devnet (local) | `http://127.0.0.1:5100/api` |

## Tokens

### XRGE

**XRGE is the native token that powers transactions, secures the network through staking, and fuels the post-quantum economy.**

| Role | How it works |
|------|-------------|
| **Gas Token** | Every transaction pays fees in XRGE. Fees go to the block proposer. |
| **Staking Primitive** | Validators must stake XRGE to propose blocks. More stake = more proposals = more rewards. |
| **DeFi Base Pair** | AMM liquidity pools trade against XRGE. It's the default quote currency on the built-in DEX. |
| **Bridge Asset** | XRGE exists on both RougeChain (native) and Base (ERC-20) via the cross-chain bridge. |

### qETH

**qETH** is a bridged representation of ETH on RougeChain. It uses 6 decimal places and can be bridged in from Base Sepolia or withdrawn back.

| Property | Value |
|----------|-------|
| Decimals | 6 |
| Bridge Source | Base Sepolia |
| Bridge Contract | Configured per-node via `--bridge-custody-address` |

### Fees

| Action | Fee |
|--------|-----|
| Transfer | 0.1 XRGE |
| Token Creation | 100 XRGE |
| Pool Creation | 10 XRGE |
| Swap | 0.3% (to LPs) |
| Minimum Stake | 1,000 XRGE |

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
