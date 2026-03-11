# RougeChain: A Post-Quantum Layer 1 Blockchain

**Version 1.1 -- March 2026**

---

## Abstract

RougeChain is a Layer 1 blockchain secured entirely by NIST-approved post-quantum cryptographic primitives. Every transaction signature, block proposal, validator attestation, and encrypted message on the network uses ML-DSA-65 (FIPS 204) and ML-KEM-768 (FIPS 203), providing NIST Level 3 security -- equivalent to 192-bit classical strength -- against both classical and quantum adversaries. RougeChain combines a Proof-of-Stake consensus protocol with a full-featured application layer: an automated market maker, cross-chain ETH bridge, NFT standard with on-chain royalties, custom token issuance, and an end-to-end encrypted messenger. The result is a quantum-resistant blockchain that is ready for production use today, not as a future migration target.

---

## Table of Contents

1. [The Quantum Threat](#1-the-quantum-threat)
2. [Post-Quantum Cryptography](#2-post-quantum-cryptography)
3. [Protocol Architecture](#3-protocol-architecture)
4. [Tokenomics](#4-tokenomics)
5. [Decentralized Exchange](#5-decentralized-exchange)
6. [ETH Bridge](#6-eth-bridge)
7. [NFT Standard](#7-nft-standard)
8. [Encrypted Messenger](#8-encrypted-messenger)
9. [Developer Ecosystem](#9-developer-ecosystem)
10. [Security Considerations](#10-security-considerations)

---

## 1. The Quantum Threat

### 1.1 The Problem

Every major blockchain in production today -- Bitcoin, Ethereum, Solana, and others -- relies on elliptic curve cryptography (ECDSA or Ed25519) for transaction signing and address derivation. These schemes derive their security from the hardness of the elliptic curve discrete logarithm problem. In 1994, Peter Shor demonstrated a quantum algorithm that solves this problem in polynomial time, meaning a sufficiently large quantum computer would be able to forge any ECDSA or Ed25519 signature and spend any funds on any existing chain.

### 1.2 Timeline

Quantum computing is advancing rapidly. IBM, Google, and other organizations have demonstrated systems exceeding 1,000 qubits. While fault-tolerant quantum computers capable of breaking ECDSA remain years away, the cryptographic community has reached consensus that migration must begin now for two reasons:

1. **Harvest now, decrypt later.** Adversaries can record blockchain transactions today and retroactively forge signatures once quantum hardware matures. Public keys exposed on-chain become permanent attack surfaces.

2. **Migration inertia.** Transitioning a live blockchain's signature scheme is extraordinarily difficult. Chains that wait until quantum computers arrive will face emergency hard forks under adversarial conditions.

### 1.3 The Solution

RougeChain eliminates this risk class entirely. Rather than retrofitting post-quantum signatures onto a chain designed around elliptic curves, RougeChain is built from the ground up on NIST-standardized post-quantum primitives. There is no legacy cryptography to migrate away from.

---

## 2. Post-Quantum Cryptography

RougeChain uses two NIST-standardized algorithms, both operating at Security Level 3 (192-bit classical equivalent, 128-bit quantum equivalent).

### 2.1 ML-DSA-65 -- Digital Signatures (FIPS 204)

ML-DSA-65, derived from the CRYSTALS-Dilithium family, is used for all signature operations on RougeChain.

| Parameter | Value |
|---|---|
| Standard | FIPS 204 |
| Security Level | NIST Level 3 |
| Public Key | 1,952 bytes |
| Private Key | 4,032 bytes |
| Signature | 3,309 bytes |
| Underlying Problem | Module Lattice (Module-LWE) |

**Usage on RougeChain:**
- Transaction signing (all 19 transaction types)
- Block proposal signatures
- Validator vote attestations (prevote and precommit)
- Messenger message authentication

All signing is performed client-side. Private keys never leave the user's device.

### 2.2 ML-KEM-768 -- Key Encapsulation (FIPS 203)

ML-KEM-768, derived from the CRYSTALS-Kyber family, is used for key exchange in the encrypted messenger.

| Parameter | Value |
|---|---|
| Standard | FIPS 203 |
| Security Level | NIST Level 3 |
| Public Key | 1,184 bytes |
| Private Key | 2,400 bytes |
| Ciphertext | 1,088 bytes |
| Shared Secret | 32 bytes |
| Underlying Problem | Module Lattice (Module-LWE) |

**Usage on RougeChain:**
- E2E messenger key encapsulation
- Deriving AES-256-GCM session keys via HKDF

### 2.3 SHA-256 -- Hashing

SHA-256 is used for block hashes, transaction hashes, and Merkle computation. Grover's algorithm reduces SHA-256 to approximately 128-bit equivalent security against quantum adversaries, which remains well above the threshold for practical attacks.

### 2.4 Comparison with Classical Schemes

| Property | ECDSA (secp256k1) | Ed25519 | ML-DSA-65 |
|---|---|---|---|
| Quantum-safe | No | No | Yes |
| NIST Standardized | No | No | Yes (FIPS 204) |
| Security Level | ~128-bit classical | ~128-bit classical | 192-bit classical |
| Public Key Size | 33 bytes | 32 bytes | 1,952 bytes |
| Signature Size | 64 bytes | 64 bytes | 3,309 bytes |
| Signing Speed | ~0.1 ms | ~0.05 ms | ~1 ms |
| Verification Speed | ~0.3 ms | ~0.1 ms | ~0.5 ms |

The trade-off is size: ML-DSA-65 signatures and keys are larger than their classical counterparts. RougeChain's protocol and storage layer are designed to handle this overhead efficiently.

---

## 3. Protocol Architecture

### 3.1 Consensus: Proof of Stake

RougeChain uses a Proof-of-Stake consensus mechanism with weighted proposer selection.

**Proposer Selection.** For each block height, a proposer is selected from the active validator set using a deterministic weighted random function:

```
seed = SHA-256(entropy || prev_block_hash || height)
index = seed[0..16] mod total_stake
proposer = validator at cumulative stake index
```

Validators contribute entropy to the selection process, and the combination of local entropy, the previous block hash, and the current height ensures unpredictability while remaining deterministic and verifiable.

**Voting.** Consensus proceeds in two rounds:
1. **Prevote** -- Validators sign a prevote for the proposed block.
2. **Precommit** -- Upon receiving prevotes from a quorum, validators sign a precommit.

A block is finalized when precommits representing at least **2/3 + 1** of total stake are collected.

**Slashing.** Validators that act maliciously or fail to meet protocol obligations are subject to:
- **Stake reduction**: 10% of the validator's stake is slashed per violation.
- **Jailing**: The validator is excluded from proposer selection for 20 blocks.
- Repeated offenses accumulate, with the slash count permanently recorded.

**Fee Distribution.** Transaction fees are split between the block proposer and the validator set:
- 25% to the block proposer.
- 75% distributed to all active validators, weighted by their stake.

### 3.2 Block Structure

Each block consists of a versioned header, a list of transactions, the proposer's ML-DSA-65 signature, and a SHA-256 hash.

**BlockHeaderV1:**

| Field | Type | Description |
|---|---|---|
| version | u32 | Protocol version (currently 1) |
| chain_id | String | Network identifier |
| height | u64 | Block number |
| time | u64 | Timestamp in milliseconds |
| prev_hash | String | SHA-256 hash of the previous block |
| tx_hash | String | SHA-256 hash of all transactions |
| proposer_pub_key | String | ML-DSA-65 public key of the proposer |

**BlockV1:**

| Field | Type | Description |
|---|---|---|
| version | u32 | Protocol version |
| header | BlockHeaderV1 | Block metadata |
| txs | Vec\<TxV1\> | Ordered list of transactions |
| proposer_sig | String | ML-DSA-65 signature over header |
| hash | String | SHA-256(header_bytes \|\| proposer_sig) |

### 3.3 Transaction Model

RougeChain supports 19 transaction types within a unified transaction structure:

**TxV1:**

| Field | Type | Description |
|---|---|---|
| version | u32 | Transaction version |
| tx_type | String | One of the 19 supported types |
| from_pub_key | String | Sender's ML-DSA-65 public key |
| nonce | u64 | Replay protection counter |
| payload | TxPayload | Type-specific data |
| fee | f64 | Fee in XRGE |
| sig | String | ML-DSA-65 signature |
| signed_payload | Option\<String\> | V2 canonical signed payload |

**Supported Transaction Types:**

| Category | Types |
|---|---|
| Transfers | `transfer`, `faucet` |
| Tokens | `create_token` |
| Staking | `stake`, `unstake`, `slash` |
| AMM / DEX | `create_pool`, `add_liquidity`, `remove_liquidity`, `swap` |
| Bridge | `bridge_mint`, `bridge_withdraw` |
| NFTs | `nft_create_collection`, `nft_mint`, `nft_batch_mint`, `nft_transfer`, `nft_burn`, `nft_lock`, `nft_freeze_collection` |

**Client-Side Signing.** All transactions are signed on the user's device using their ML-DSA-65 private key. The signed transaction is then submitted to any node via the REST API. At no point does a private key leave the client. The v2 transaction endpoints enforce this by design -- they accept only pre-signed payloads and reject empty or invalid signatures.

**V2 Signed Payload Format.** An enhanced signing format serializes the payload as sorted-key JSON before signing, producing a canonical representation that prevents signature malleability.

**Nonce Deduplication.** Each node maintains a per-account set of recently seen nonces. Duplicate nonces are rejected at both the mempool admission and block import layers, preventing transaction replay even when timestamps collide.

### 3.4 Storage

RougeChain uses the Sled embedded database for persistent state, providing:
- **O(1) block lookups** by height
- **Range queries** for block scanning and pagination
- **Atomic writes** for consistency during block import

The following stores are maintained independently:

| Store | Database | Contents |
|---|---|---|
| Chain | chain-db | Blocks indexed by height |
| Validators | validators-db | Stake, slash count, jail status, entropy contributions |
| Pools | pools-db | AMM liquidity pool state |
| NFT Collections | nft-collections-db | Collection metadata and configuration |
| NFT Tokens | nft-tokens-db | Individual token ownership and attributes |
| Token Metadata | token-metadata-db | Custom token metadata (name, image, socials) |

Additional off-chain stores (JSON-backed) handle bridge claims, withdrawal requests, and messenger data.

### 3.5 Networking

Nodes communicate over HTTP with the following mechanisms:

**Peer Discovery.** Nodes register with known peers via `POST /api/peers/register` and periodically fetch the peer list via `GET /api/peers`. New peers discovered transitively are added automatically.

**Block Synchronization.** Nodes poll peers for new blocks with adaptive frequency (10-60 seconds). On initial sync, blocks are fetched in batches of 1,000. Failed syncs trigger exponential backoff up to 10 minutes.

**Block Propagation.** When a node produces or imports a new block, it broadcasts asynchronously to all known peers via `POST /api/blocks/import` with a 5-second timeout per peer.

**Transaction Broadcast.** Submitted transactions are propagated to peers via `POST /api/tx/broadcast`.

**Rate Limiting.** The API implements three-tier rate limiting applied to all endpoints:
- **Tier 1 (Validators):** Elevated throughput for staked validators. Authentication requires three headers: `X-Validator-Key` (public key), `X-Validator-Sig` (ML-DSA-65 signature over the timestamp), and `X-Validator-Ts` (Unix millisecond timestamp). The signature is verified via `pqc_verify`, and the timestamp must be within a 30-second drift window. This prevents spoofing of validator status.
- **Tier 2 (Peers):** Moderate limits for registered peer nodes, identified by socket address.
- **Tier 3 (General):** Configurable rate limits for public API consumers, with separate limits for read (GET) and write (POST) operations.

### 3.6 Mempool

The mempool holds up to **2,000 pending transactions** in a hash map keyed by transaction hash. When the mempool is full, the oldest transactions are evicted (FIFO). Duplicate transactions are rejected. All transactions in the mempool are included in the next block produced by the local node, then drained.

---

## 4. Tokenomics

### 4.1 XRGE (RougeCoin)

XRGE is the native token of RougeChain, used for transaction fees, staking, governance weight, and as the base trading pair in the DEX.

| Property | Value |
|---|---|
| Name | RougeCoin |
| Symbol | XRGE |
| Total Supply | 36,000,000,000 |
| Smallest Unit | 1 XRGE |

### 4.2 Fee Schedule

All operations on RougeChain require an XRGE fee. The fee schedule is designed to be accessible for common operations while discouraging spam on higher-impact actions.

| Operation | Fee (XRGE) |
|---|---|
| Transfer | 0.1 |
| Token creation | 100 |
| Liquidity pool creation | 10 |
| Token swap | 0.1 |
| NFT collection creation | 50 |
| NFT mint | 5 |
| NFT batch mint | 5 per token |
| NFT transfer | 1 |
| NFT lock / unlock | 0.1 |
| NFT collection freeze | 0.1 |

### 4.3 Fee Distribution

Transaction fees are not burned. They are distributed to the network's validators:

- **25%** to the block proposer as a direct reward for block production.
- **75%** to all active validators, distributed proportionally to their staked XRGE.

This model incentivizes both block production and passive staking.

### 4.4 Deflationary Mechanism

RougeChain defines a permanent burn address:

```
XRGE_BURN_0x0000000000000000000000000000000000000000000000000000000000DEAD
```

Tokens sent to this address are irreversibly destroyed and tracked on-chain. Any user or smart contract may burn tokens, permanently reducing the circulating supply.

---

## 5. Decentralized Exchange

RougeChain includes a native automated market maker (AMM) built directly into the protocol layer, requiring no smart contracts.

### 5.1 Constant Product Formula

The AMM uses the constant product invariant popularized by Uniswap V2:

```
x * y = k
```

Where `x` and `y` are the reserves of the two tokens in a pool, and `k` is a constant that increases only when liquidity is added.

### 5.2 Swap Mechanics

Each swap incurs a **0.3% fee** applied to the input amount:

```
amount_out = (amount_in * 997 * reserve_out) / (reserve_in * 1000 + amount_in * 997)
```

The fee remains in the pool, increasing `k` and benefiting liquidity providers.

**Slippage protection** is enforced via a `min_amount_out` parameter. If the calculated output falls below this threshold, the swap is rejected.

**Price impact** is calculated as the percentage difference between the spot price and the effective execution price, giving users visibility into large-order effects.

### 5.3 Multi-Hop Routing

When a direct pool does not exist between two tokens, the AMM performs breadth-first search (BFS) across all pools to find a valid route. Multi-hop swaps execute atomically -- either all legs succeed or the entire swap reverts.

### 5.4 Liquidity Provision

Liquidity providers deposit paired tokens into a pool and receive LP tokens representing their share.

- **Minimum liquidity:** The first 1,000 LP tokens are permanently locked to prevent share manipulation.
- **Adding liquidity:** Amounts must be proportional to existing reserves. LP tokens minted: `min(amount_a / reserve_a, amount_b / reserve_b) * total_lp_supply`.
- **Removing liquidity:** LP tokens are burned and the proportional share of both reserves is returned.

### 5.5 Pool Creation

Any user may create a pool by specifying two tokens and initial deposit amounts. The pool ID is derived from the sorted token pair (e.g., `TOKENA-TOKENB`). A 10 XRGE fee is charged.

---

## 6. ETH Bridge

RougeChain provides a trustless bridge between Ethereum (Base Sepolia) and RougeChain via a wrapped token called **qETH**.

### 6.1 Bridge In (ETH to qETH)

1. The user sends ETH to the bridge custody address on Base Sepolia.
2. The user submits the Ethereum transaction hash to RougeChain's bridge API.
3. The RougeChain node verifies the transaction on-chain by querying the Base Sepolia RPC endpoint.
4. Upon verification, the node creates a `bridge_mint` transaction, minting qETH to the user's RougeChain address at a 1:1 ratio.

**Replay protection:** Each Ethereum transaction hash is recorded in a persistent `BridgeClaimStore`. A hash can only be claimed once.

**EVM Signature Verification.** Bridge claims require an ECDSA signature from the wallet that sent the deposit transaction. The claim message follows a canonical format (`RougeChain bridge claim\nTx: {hash}\nRecipient: {pubkey}`), and the signature is verified via `ecrecover` to ensure the claimant is the original depositor.

**Confirmation Requirement.** The node queries the Base Sepolia block number and requires at least 1 confirmation before processing the claim, preventing front-running of unconfirmed transactions.

### 6.2 Multi-Asset Bridge

RougeChain supports bridging multiple asset types:

| Asset | Base Chain | RougeChain Wrapped | Mechanism |
|---|---|---|---|
| ETH | Native ETH | qETH | ETH value in tx |
| USDC | ERC-20 | qUSDC | ERC-20 Transfer event parsing |
| XRGE | ERC-20 (Base) | XRGE (L1) | BridgeVault lock/release |

For ERC-20 tokens, the bridge parses `Transfer` event logs from the transaction receipt to determine the deposited amount, rather than relying on the transaction's ETH value field.

### 6.3 Bridge Out (Wrapped to Native)

1. The user submits a `bridge_withdraw` transaction, burning their wrapped tokens and specifying an EVM withdrawal address.
2. The withdrawal request is recorded in the `BridgeWithdrawStore` with a unique transaction ID, the target EVM address, the amount, and a timestamp.
3. The bridge relayer (authenticated via a shared secret) fulfills the withdrawal by releasing tokens on Base and then marking the withdrawal as complete.

### 6.4 Security Model

The bridge operates under a custody model where a designated operator address holds the collateral. Security layers include:
- **On-chain verification** of Ethereum transactions against Base Sepolia RPC.
- **ECDSA signature verification** (ecrecover) to authenticate depositors.
- **Replay protection** via persistent claim tracking.
- **Chain ID validation** to prevent cross-chain replay.
- **Confirmation requirements** to prevent unconfirmed-tx attacks.
- **Relayer authentication** via shared secret for withdrawal fulfillment.

---

## 7. NFT Standard

RougeChain implements a native NFT standard at the protocol level with collection-based organization and on-chain royalty enforcement.

### 7.1 Collections

An NFT collection defines the metadata and rules for a group of tokens:

| Field | Description |
|---|---|
| collection_id | Unique identifier: `col:{creator_prefix}:{SYMBOL}` |
| symbol | Short identifier (e.g., "ART") |
| name | Human-readable name |
| creator | ML-DSA-65 public key of the creator |
| max_supply | Optional cap on total tokens |
| royalty_bps | Royalty percentage in basis points (0-10,000) |
| royalty_recipient | Address receiving royalty payments |
| frozen | Whether the collection is permanently frozen |

### 7.2 Tokens

Each token within a collection has:

| Field | Description |
|---|---|
| token_id | Sequential ID within the collection |
| owner | Current owner's public key |
| name | Token name |
| metadata_uri | URI pointing to off-chain metadata |
| attributes | On-chain JSON attributes |
| locked | Whether the token is transfer-locked |

### 7.3 Operations

| Operation | Description | Fee |
|---|---|---|
| Create Collection | Define a new NFT collection | 50 XRGE |
| Mint | Create a new token in a collection | 5 XRGE |
| Batch Mint | Mint multiple tokens in one transaction | 5 XRGE each |
| Transfer | Transfer ownership to another address | 1 XRGE |
| Burn | Permanently destroy a token | 0.1 XRGE |
| Lock / Unlock | Prevent or allow transfers | 0.1 XRGE |
| Freeze Collection | Permanently prevent all operations | 0.1 XRGE |

### 7.4 Royalties

Royalties are enforced at the protocol level. When a transfer includes a `salePrice`, the royalty percentage (defined in basis points during collection creation) is automatically calculated and credited to the `royalty_recipient`. This cannot be circumvented because transfers are processed by the node, not by external contracts.

---

## 8. Encrypted Messenger

RougeChain includes an end-to-end encrypted messenger that leverages the same post-quantum primitives used by the blockchain.

### 8.1 Encryption Protocol

Each messenger wallet generates two key pairs:
- **ML-DSA-65** for message signing and authentication.
- **ML-KEM-768** for key encapsulation and encryption.

When a user sends a message, the following process occurs:

1. **Key Encapsulation.** The sender encapsulates a shared secret using the recipient's ML-KEM-768 public key, producing a ciphertext and a 32-byte shared secret.
2. **Key Derivation.** The shared secret is passed through HKDF-SHA-256 to derive an AES-256-GCM key.
3. **Encryption.** The plaintext message is encrypted with AES-256-GCM using a random 12-byte IV.
4. **Dual Encryption.** The same process is repeated with the sender's own ML-KEM-768 public key, producing a second encrypted copy. This allows the sender to decrypt their own messages when re-fetched from the server.
5. **Signing.** The entire encrypted package is signed with the sender's ML-DSA-65 private key.

### 8.2 Message Verification

Recipients verify the ML-DSA-65 signature before decryption, ensuring message authenticity and integrity. Invalid signatures are flagged in the UI.

### 8.3 Features

- **Self-destructing messages** with configurable timers.
- **Spoiler tags** for content that should be hidden until explicitly revealed.
- **Media support** for images and video (up to 10 MB), encrypted identically to text.
- **1-on-1 and group conversations.**

### 8.4 Privacy by Design

Messenger data is stored off-chain. The blockchain nodes store encrypted message blobs but cannot decrypt them. Only the sender and recipient, possessing the correct ML-KEM-768 private keys, can read message contents.

---

## 9. Developer Ecosystem

### 9.1 TypeScript SDK

The `@rougechain/sdk` package provides a complete TypeScript SDK for building on RougeChain.

**Installation:**
```
npm install @rougechain/sdk
```

**Capabilities:**
- Wallet generation and management (ML-DSA-65 key pairs)
- Transaction construction and client-side signing
- Token, NFT, DEX, bridge, and staking operations
- Balance and state queries

**Environment support:** Browser, Node.js, and React Native. The SDK uses `@noble/post-quantum` for all cryptographic operations, with no native dependencies.

### 9.2 Browser Extension

The RougeChain browser extension (Manifest V3) provides:

- **Wallet management** with password-encrypted storage (PBKDF2 + AES-256-GCM).
- **Five integrated tabs:** Wallet, Tokens, NFTs, Chat (messenger), and Settings.
- **Smart API caching** with TTL-based deduplication to minimize network overhead.

**dApp Provider.** The extension injects `window.rougechain` into web pages, enabling dApps to interact with the user's wallet:

```javascript
const { publicKey } = await window.rougechain.connect();
const { balance } = await window.rougechain.getBalance();
const { txId } = await window.rougechain.sendTransaction(payload);
```

Connected sites are tracked and require explicit user approval via a popup window. All transactions submitted through the provider are signed client-side using `ml_dsa65.sign()` before being sent to the node.

**Provider Authenticity.** The injected provider object carries a `Symbol.for("rougechain:authentic")` token that dApps can check to verify they are communicating with the genuine extension, not a malicious imitation. The provider is defined with `Object.defineProperty` (non-writable, non-configurable) and unconditionally overwrites any pre-existing definitions to prevent injection attacks.

### 9.3 REST API

Every node exposes a comprehensive HTTP API supporting all chain operations:

| Category | Endpoints |
|---|---|
| Chain | `/api/stats`, `/api/blocks`, `/api/blocks/:height` |
| Wallet | `/api/balance/:pubkey`, `/api/faucet` |
| Transactions | `/api/tx/submit`, `/api/v2/tx/submit`, `/api/tx/broadcast` |
| Tokens | `/api/tokens`, `/api/token/create`, `/api/token/metadata` |
| DEX | `/api/pools`, `/api/swap`, `/api/pool/create` |
| NFTs | `/api/nft/collections`, `/api/nft/owner/:pubkey`, `/api/v2/nft/*` |
| Bridge | `/api/bridge/claim`, `/api/bridge/withdraw` |
| Messenger | `/api/messenger/wallets`, `/api/messenger/conversations`, `/api/messenger/messages` |
| P2P | `/api/peers`, `/api/peers/register`, `/api/blocks/import` |

### 9.4 gRPC

A gRPC interface is available for high-performance node-to-node communication and advanced integrations, supporting the same operations as the REST API with protocol buffer serialization.

---

## 10. Security Considerations

### 10.1 Cryptographic Security

All cryptographic primitives used by RougeChain are standardized by NIST at Security Level 3, providing 192-bit classical security and at least 128-bit quantum security. The lattice-based problems underlying ML-DSA-65 and ML-KEM-768 have been studied extensively and are considered resistant to all known quantum and classical attacks.

### 10.2 Client-Side Key Management

Private keys are generated and stored exclusively on the user's device. The browser extension encrypts keys at rest using PBKDF2 (600,000 iterations) with AES-256-GCM. Transaction signing occurs locally; only the signed transaction is transmitted to the network.

Legacy API endpoints that previously accepted raw private keys for server-side signing are disabled in production and return HTTP 410 (Gone). They are accessible only in local development mode via the `--dev` flag.

### 10.3 Validator Accountability

The slashing mechanism penalizes validators for protocol violations by confiscating 10% of their stake and jailing them for 20 blocks. The slash count is permanently recorded, providing a public accountability record. Jailed validators are excluded from proposer selection until their jail period expires.

### 10.4 Network Resilience

- **Mempool limits** (2,000 transactions) prevent memory exhaustion.
- **Three-tier rate limiting** with cryptographic validator authentication protects all endpoints.
- **Block pagination** caps API responses to prevent unbounded data dumps.
- **Exponential backoff** on peer sync failures prevents cascade overloads.
- **Adaptive polling** reduces unnecessary network traffic during quiet periods.
- **Nonce deduplication** prevents transaction replay at both mempool and block import layers.

### 10.5 Block Import Verification

When importing blocks from peers, the node performs the following verification:

1. **Height continuity** -- The block must extend the current tip by exactly one.
2. **Hash chain** -- The block's `prev_hash` must match the current tip hash.
3. **Proposer signature** -- The `proposer_sig` is verified against `proposer_pub_key` using `pqc_verify`, and the block hash is recomputed to ensure integrity.
4. **Active validator check** -- The `proposer_pub_key` must belong to an actively staked validator.
5. **Transaction signatures** -- All transactions are verified in parallel (using Rayon) across three signature formats (V2 signed payload, V1 new format, V1 legacy format). If any transaction fails all three verification methods, the entire block is rejected.

### 10.6 Bridge Security

- **On-chain verification** of Ethereum transactions via Base Sepolia RPC prevents fraudulent minting.
- **ECDSA signature verification** (ecrecover) authenticates that the claimant is the original depositor.
- **Chain ID validation** ensures claims target the correct network.
- **Confirmation requirements** prevent claims against unconfirmed transactions.
- **Replay protection** via persistent claim tracking ensures each deposit can only be claimed once.
- **Relayer authentication** via shared secret restricts withdrawal fulfillment to authorized operators.

### 10.7 Messenger Privacy

Messages are encrypted end-to-end using post-quantum key encapsulation. The server stores only ciphertext and cannot decrypt message contents. Message signatures provide authentication without exposing plaintext to intermediaries.

### 10.8 dApp Provider Security

The browser extension's injected provider (`window.rougechain`) defends against page-level tampering:
- **Unconditional injection** overwrites any malicious pre-definitions.
- **Non-writable, non-configurable** property descriptor prevents post-injection modification.
- **Authenticity token** (`Symbol.for("rougechain:authentic")`) allows dApps to verify they are communicating with the genuine extension.
- **Approval popups** require explicit user consent for connect, sign, and send operations.

---

## References

1. NIST. *FIPS 204: Module-Lattice-Based Digital Signature Standard (ML-DSA).* August 2024.
2. NIST. *FIPS 203: Module-Lattice-Based Key-Encapsulation Mechanism Standard (ML-KEM).* August 2024.
3. Shor, P.W. *Polynomial-Time Algorithms for Prime Factorization and Discrete Logarithms on a Quantum Computer.* SIAM Journal on Computing, 1997.
4. Grover, L.K. *A Fast Quantum Mechanical Algorithm for Database Search.* Proceedings of the 28th Annual ACM Symposium on Theory of Computing, 1996.
5. Adams, J., et al. *Uniswap V2 Core.* Uniswap, 2020.

---

*RougeChain is open-source software. The complete codebase, including the Rust core daemon, TypeScript SDK, browser extension, and web frontend, is publicly available.*
