# RougeChain Documentation

Welcome to **RougeChain** — a post-quantum secure Layer 1 blockchain built with real NIST-approved cryptography.

## What is RougeChain?

RougeChain is the first blockchain designed from the ground up to be resistant to quantum computer attacks. It uses:

- **ML-DSA-65** (CRYSTALS-Dilithium) for digital signatures
- **ML-KEM-768** (CRYSTALS-Kyber) for key encapsulation
- **SHA-256** for hashing

All cryptographic primitives are NIST FIPS 204/203 compliant.

## Key Features

| Feature | Description |
|---------|-------------|
| **Post-Quantum Security** | Protected against both classical and quantum attacks |
| **Proof of Stake** | Energy-efficient consensus with validator staking |
| **P2P Network** | Decentralized peer-to-peer block and transaction propagation |
| **Custom Tokens** | Create your own tokens on the network |
| **Encrypted Messenger** | End-to-end encrypted messaging with PQC |
| **Open Source** | Fully open source Rust backend and React frontend |

## Quick Links

- [Getting Started](getting-started/README.md)
- [Running a Node](running-a-node/README.md)
- [API Reference](api-reference/README.md)
- [P2P Networking](p2p-networking/README.md)
- [Staking & Validators](staking/README.md)

## Network Info

| Network | API Endpoint |
|---------|--------------|
| Testnet | `https://testnet.rougechain.io/api` |
| Devnet (local) | `http://127.0.0.1:5100/api` |

## Token: XRGE

The native token of RougeChain is **XRGE** (pronounced "rouge").

- **Transfer Fee**: 0.1 XRGE
- **Token Creation Fee**: 100 XRGE
- **Minimum Stake**: 1,000 XRGE
