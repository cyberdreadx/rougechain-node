# RougeChain: A Post-Quantum Layer 1 Blockchain

**Version 2.4 -- 6 October 2026**

> **RougeChain is a post-quantum Layer 1 blockchain where every signature, every transaction, and every encrypted message is secured by NIST-approved lattice cryptography — not as a future upgrade, but as the foundation.**

---

## Abstract

RougeChain is a Layer 1 blockchain built on NIST-standardized post-quantum cryptographic primitives for signatures and encryption, with hash-based systems for proofs and commitments. Every transaction signature, block proposal, and encrypted message on the network uses ML-DSA-65 (FIPS 204) and ML-KEM-768 (FIPS 203), providing NIST Level 3 security -- equivalent to 192-bit classical strength -- against both classical and quantum adversaries. A hash-based STARK shielded pool is part of the design, but its first version is suspended and its redesign is not yet deployed (Section 3.9); signatures and encryption are the post-quantum guarantees the chain delivers today. RougeChain combines a Proof-of-Stake consensus protocol with an application layer built into the node: an automated market maker, bridges to Base and Bitcoin, an NFT standard with protocol-level royalties, custom token issuance with optional creator minting, WASM smart contracts, an end-to-end encrypted messenger and mail system, and a node-hosted social layer with signed posts and engagement.

Mainnet (`rougechain-mainnet-1`) is live. Since height 150 every block must carry a verified commit certificate -- precommits from at least two-thirds of stake -- for its parent, so finality is enforced by the protocol rather than reported by the producer. It is still an early-stage network: three validators are staked but one of them produces every block and there is no fallback proposer, the bridges depend on operator-run relayers, several transaction types are suspended pending a rebuild, and no external security audit has been completed. Section 11.10 lists these limitations in full.

---

## Changes in v2.4

Version 2.4 (6 October 2026) brings the paper in line with mainnet after the upgrades at heights 235 and 245:

- **Protocol upgrades (3.1.3, 12):** the upgrade table gains **235** (mintable custom tokens with creator-only minting and an optional supply cap; contracts can read NFT royalties) and **245** (MONETARY_INTEGRITY: blocks may not carry a non-finite or negative fee, a `slash` transaction, a faucet-flagged transaction on mainnet, or any of fifteen suspended transaction types). Node releases 1.6.2 (consensus) and 1.6.3 (messenger and mail hardening, not consensus) are recorded.
- **Suspended features (3.1.1, 3.3, 3.9, 4.2, 12):** shielded transfers, token locking, token staking pools, on-chain governance and voting, vote delegation and the legacy `token_approve` / `token_transfer_from` types are **suspended from height 245**. Earlier versions presented them as working features; none of them was ever used on mainnet except the shielded pool, which is empty. The paper now says what each one was, why it is off, and what replaces it.
- **Zero-knowledge proofs (2.4, 3.9, 11.1, 11.9):** the `winterfell` 0.13 STARKs in the code have **no zero-knowledge mode** -- they prove integrity but do not hide the witness -- so the privacy claims of v2.3 and earlier were wrong. The V1 shielded pool proved value balance only and did not bind a withdrawal to a specific note. A redesigned pool (V2, Plonky3-based with a hiding mode) is specified and in development; the rollup batch circuit and the browser prover are described as unused research code.
- **Staking (3.1, 11.3):** the 10,000 XRGE minimum is an API rule, not a consensus rule; mainnet has three staked validators; the legacy `slash` type is rejected from height 245; the 0.1 XRGE minimum-tip floor pays nothing on mainnet because its reserve is empty.
- **Bridges (6, 11.6):** ETH and USDC deposits reopened on 5 October 2026 through the RougeBridge contract's deposit functions with automatic claiming; the manual claim route is closed at the public endpoint; Bitcoin deposits are live and withdrawals are switched off in the site.
- **Messenger and mail (8, 11.7):** release 1.6.3 rules -- a directory entry can be replaced only by the wallet that owns it, an encryption key already registered to another wallet is refused, and the unauthenticated legacy read routes return 410.
- **Roadmap (12):** a consensus redesign (Tendermint-style rounds with ML-DSA-65 votes, rotating proposers, a capped validator set, a consensus-enforced minimum stake and evidence-based slashing) was decided on 6 October 2026. It is **planned, not built**, and is gated on a simulator and an independent review.
- The PDF copy of this paper shipped with the web applications still reflects v2.3; this Markdown file is the current version until the PDF is regenerated.

---

## Changes in v2.3

- **Payable contract calls (3.1.3, 10.5, 12):** from height 190 a contract call can carry a signed
  payment in XRGE or any token, which moves to the contract only if the call succeeds. This lets games
  charge entry fees and run shops; the `loot_roll` example now charges 0.5 XRGE per roll.

## Changes in v2.2

- **Contract randomness (3.1.3, 10.5, 11.10):** v2.1 said a player "cannot re-roll a transaction once
  sent". That was misleading: `host_random` can be ground by the sender, who signs many variants of a
  transaction offline and sends only a winning one. Height 170 (GAME_READY 3) adds `host_block_hash`,
  and games settle rolls from the hash of a block created after the player committed.

## Changes in v2.1

Version 2.1 (28 September 2026) records the two protocol upgrades activated after v2.0:

- **Finality (3.1, 3.1.3, 11.5):** FINALITY_V2 is active from height 150 (Release 2a). Every block from 151 carries `parent_commit`, a verified precommit certificate for its parent, and `finalized_height` tracks verified certificates. Release 2b (fallback proposer, skip certificates and slashing tied to them, spreading stake across validators) is not done; slashing on equivocation evidence is planned as Release 3.
- **Contracts (3.1.3, 10.5):** GAME_READY (height 150) makes contract deployments and calls player-signed. GAME_READY 2 (height 160) lets contracts hold and move custom tokens and NFTs, create NFT collections and mint to players, and draw per-transaction randomness; cross-contract calls now apply their asset moves. Section 10.5 corrects v2.0's statement that sub-call balance changes were already applied.
- **State root (2.4, 3.2, 3.8):** from height 160 the header state root (v2) also covers NFT collections and ownership, contract code and contract storage.
- **DEX (5.4):** liquidity providers can withdraw accrued swap fees with "Collect fees", backed by a per-position fee ledger on each node.
- **Developer ecosystem (10):** SDK 1.9 (`rc.contracts`), browser extension 1.4 (contract signing), contract events over WebSocket, the contract query endpoint and the `loot_roll` example contract.
- **Limitations and roadmap (11.10, 12):** finality and both GAME_READY releases move to Shipped; the remaining limitations are restated.

---

## Changes Since v1.8

Version 2.0 brings this paper in line with the network as deployed in September 2026:

- **Consensus (3.1, 3.1.3, 11.3-11.5):** documents the four mainnet protocol upgrades (heights 18, 49, 90 and 100), Release 1 proposer selection, the actual block cadence, and the real status of finality and slashing. The QRNG-weighted proposer selection and BFT finality described in v1.8 are not what mainnet runs.
- **Transactions (3.3):** replay protection by transaction identity and signed-payload binding replaces the per-account nonce description; the transaction-type count is corrected to 44.
- **Tokenomics (4):** balances are integer quanta (1 XRGE = 10^9 quanta); base-fee bounds and the bridge fee are stated.
- **Bridges (6, 11.6):** custody contracts and trust assumptions are stated plainly; the Bitcoin bridge is added.
- **Messenger (8):** real-time delivery events, deterministic direct-message IDs, recoverable delete, group management, avatars, and push notifications.
- **Social (9):** described as a node-hosted service rather than on-chain state.
- **Developer ecosystem (10):** current SDK, extension, MCP server, CLI and applications; mainnet routes that are not yet publicly open.
- **Security (11.10):** new Current Limitations subsection.
- **Roadmap (12):** split into Shipped, In Progress and Planned; BFT finality and STARK bridge verification are no longer marked complete.

---

## Table of Contents

1. [The Quantum Threat](#1-the-quantum-threat)
2. [Post-Quantum Cryptography](#2-post-quantum-cryptography)
3. [Protocol Architecture](#3-protocol-architecture)
4. [Tokenomics](#4-tokenomics)
5. [Decentralized Exchange](#5-decentralized-exchange)
6. [Cross-Chain Bridges](#6-cross-chain-bridges)
7. [NFT Standard](#7-nft-standard)
8. [Encrypted Messenger and Mail](#8-encrypted-messenger-and-mail)
9. [Social Layer](#9-social-layer)
10. [Developer Ecosystem](#10-developer-ecosystem)
11. [Security Considerations](#11-security-considerations)
12. [Roadmap](#12-roadmap)

---

## 1. The Quantum Threat

### 1.1 The Problem

Every major blockchain in production today -- Bitcoin, Ethereum, Solana, and others -- relies on elliptic curve cryptography (ECDSA or Ed25519) for transaction signing and address derivation. These schemes derive their security from the hardness of the elliptic curve discrete logarithm problem. In 1994, Peter Shor demonstrated a quantum algorithm that solves this problem in polynomial time, meaning a sufficiently large quantum computer would be able to forge any ECDSA or Ed25519 signature and spend any funds on any existing chain.

### 1.2 Timeline

Quantum computing is advancing rapidly. IBM, Google, and other organizations have demonstrated systems exceeding 1,000 qubits. While fault-tolerant quantum computers capable of breaking ECDSA remain years away, the cryptographic community has reached consensus that migration must begin now for two reasons:

1. **Harvest now, decrypt later.** Adversaries can record blockchain transactions today and retroactively forge signatures once quantum hardware matures. Public keys exposed on-chain become permanent attack surfaces.

2. **Migration inertia.** Transitioning a live blockchain's signature scheme is extraordinarily difficult. Chains that wait until quantum computers arrive will face emergency hard forks under adversarial conditions -- upgrading core cryptography while an attacker is actively exploiting the vulnerability they are trying to patch. Migration under attack is not an engineering challenge; it is a catastrophic failure scenario.

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
- Transaction signing (all transaction types)
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

### 2.4 STARKs -- Hash-Based Proofs

RougeChain's design uses STARKs (Scalable Transparent Arguments of Knowledge) for its shielded pool. Unlike zk-SNARKs, which rely on elliptic curve pairings vulnerable to Shor's algorithm, STARKs are built entirely on collision-resistant hash functions and are therefore **quantum-resistant by design**.

| Property | zk-SNARKs | STARKs |
|---|---|---|
| Underlying math | Elliptic curve pairings | Hash functions + Reed-Solomon |
| Trusted setup | Required | Not required (transparent) |
| Quantum resistance | No | **Yes** |
| Post-quantum safe | No | **Yes** |

**Status (6 October 2026).** Earlier versions of this paper described the STARK circuits below as privacy-preserving and said they powered shielded transfers in production. That was wrong on both counts:

- The circuits are built on Meta's `winterfell` library (version 0.13), which has **no zero-knowledge mode**: its proofs establish that a computation was carried out correctly, but they do not hide the witness. The "private" inputs of these circuits are therefore not private. The proofs are integrity proofs, not zero-knowledge proofs.
- The V1 shielded pool that used them (Section 3.9) proved value balance only and did not bind a withdrawal to a specific note. It is **suspended from height 245**; the mainnet pool was empty when it was suspended.

A redesigned shielded pool, **V2**, is specified and in development. It uses a Plonky3-based STARK with a hiding mode, so the proof reveals nothing about the notes beyond the public commitments and nullifiers. Measured on the full two-input, two-output circuit, a proof is about 190 KB, verifies in about 6 ms on a validator and is produced in about 3 s on a phone. It is planned to launch under a **1,000,000 XRGE cap** on the pool total before the external audit. Until that audit has covered the hiding mode, the proof system is **not audited and product text must not claim audited privacy**.

**Implementation in the code today.** The `winterfell` circuits use Blake3-256 as the commitment hash. A WASM build of the prover exists (`core/wasm-prover/`) but is used by no live feature. Nodes carry the native verifier; from height 245 no block may contain a transaction that would exercise it.

**Balance Transfer AIR.** The first Algebraic Intermediate Representation (AIR) encodes a balance-transfer circuit over a 128-bit prime field with a 3-column execution trace and the transition constraints:

```
sender[next]   = sender[current]   - per_step_amount
receiver[next] = receiver[current] + per_step_amount
amount[next]   = amount[current]
```

The public inputs are the final balances. Because the prover has no hiding mode, the initial balances and the amount are not kept private by the proof itself.

**Security Parameters:**

| Parameter | Value |
|---|---|
| Field | 128-bit prime (Goldilocks extension) |
| Hash function | Blake3-256 |
| FRI queries | 28 |
| Blowup factor | 8 |
| Security level | ~100 bits (conjectured soundness; no zero-knowledge) |

**Quantum Alignment.** Because STARKs rely only on hash-based commitments (Merkle trees via Blake3), they share the same quantum-resistance profile as SHA-256: Grover's algorithm provides at most a quadratic speedup, reducing 256-bit hash security to ~128 bits -- still far beyond practical attack thresholds. The pillars of the stack and their status:

| Cryptographic Pillar | Algorithm | Quantum-Safe | In production |
|---|---|---|---|
| Signatures | ML-DSA-65 | Yes | Yes |
| Key exchange | ML-KEM-768 | Yes | Yes |
| Hashing | SHA-256 / Blake3 | Yes | Yes |
| Shielded-pool proofs | STARK (V2, hiding mode) | Yes | No -- in development, unaudited |

#### Rollup Batch AIR (Phase 3) -- research code, unused

The second AIR encodes a **batch transfer circuit** for STARK rollups. It proves that N balance transfers executed off-chain are valid -- value is conserved for each transfer, no account is overdrafted, and the state root transitions correctly -- using a single proof. It is research code: nothing in consensus reads or verifies a rollup batch (see "Rollup Accumulator" below).

The rollup AIR uses a 5-column execution trace:

```
sender_before | sender_after | receiver_after | amount | running_hash
```

**Transition Constraints:**

1. **Value conservation:** `sender_after = sender_before - amount`
2. **Running hash accumulation:** `running_hash[i+1] = running_hash[i] + sender_before[i] * amount[i]` (degree 2)
3. **Cross-check redundancy:** Additional constraint for proof soundness

**Boundary Assertions:**

| Column | Step | Value |
|---|---|---|
| running_hash | First | pre_state_root |
| running_hash | Last | post_state_root |

The rollup's state root is a SHA-256 Merkle tree computed from the sorted set of all account balances, using domain-separated hashing (`ROUGECHAIN_STATE_V1` for leaf nodes, `ROUGECHAIN_NODE_V1` for internal nodes).

This rollup root is separate from the **ledger state root** committed in every block header (Section 3.2). From height 18 the header root is a domain-separated SHA-256 over the sorted native XRGE, token and LP balances. From height 160 (GAME_READY 2) it is **state root v2**: `SHA-256("rougechain.stateroot.v2" ‖ balance root ‖ NFT collections ‖ NFT ownership ‖ contract code hashes ‖ contract storage)`, where NFT collections contribute id, creator, minted count, maximum supply and frozen flag, and tokens contribute collection, id, owner and locked flag. A node that disagrees on any NFT owner or contract storage value therefore computes a different root and rejects the block at import, exactly as for a balance divergence. The root is a flat hash over sorted entries, not yet an incremental Merkle tree.

**Rollup Accumulator.** The daemon includes a `RollupAccumulator` that batches up to 32 transfers (or flushes after 5 seconds), executes them in memory, computes the state root transition, generates a STARK proof and self-verifies it. It is reachable through the `/api/v2/rollup/*` routes, but it is **not connected to consensus**: a batch moves no funds, is not included in any block and is not part of the chain's state. It is a research prototype; a rollup that settles on RougeChain would need its own protocol upgrade.

### 2.5 Comparison with Classical Schemes

| Property | ECDSA (secp256k1) | Ed25519 | ML-DSA-65 |
|---|---|---|---|
| Quantum-safe | No | No | Yes |
| NIST Standardized | No | No | Yes (FIPS 204) |
| Security Level | ~128-bit classical | ~128-bit classical | 192-bit classical |
| Public Key Size | 33 bytes | 32 bytes | 1,952 bytes |
| Signature Size | 64 bytes | 64 bytes | 3,309 bytes |
| Signing Speed | ~0.1 ms | ~0.05 ms | ~1 ms |
| Verification Speed | ~0.3 ms | ~0.1 ms | ~0.5 ms |

The trade-off is size: ML-DSA-65 signatures and keys are significantly larger than their classical counterparts. This is an inherent property of all lattice-based post-quantum schemes, not a flaw in RougeChain's design. Section 3.7 details the concrete impact and mitigation strategy.

---

## 3. Protocol Architecture

### 3.1 Consensus: Proof of Stake

RougeChain uses a Proof-of-Stake consensus protocol. Any account whose `stake` transaction is applied in a block is in the validator set; the staking key is the validator's identity, and a node proposes blocks with the key stored in its `node-keys.json`.

**Minimum stake.** The **10,000 XRGE** minimum is enforced by the node's API when it builds or accepts a stake request (`/api/v2/stake` and the CLI path), **not by consensus**. Block application requires only a positive amount and a sufficient balance, so a smaller stake that reaches a block is valid; one mainnet validator holds 9,000 XRGE. Mainnet has **three** staked validators on 6 October 2026: the operator's validator with about 100.09 million XRGE, a second with 10,000 XRGE and a third with 9,000 XRGE. A consensus-enforced minimum is part of the planned consensus redesign (Section 12.2).

**Block Cadence.** There is no fixed block slot. The producer polls its mempool every `--block-time-ms` (command-line default **400 ms**; mainnet nodes run with the default) and is woken early when a new transaction arrives. The `block_time_ms` value in the genesis file (1,000 ms on mainnet) is recorded in the chain configuration but is not used for timing. A block is produced only when the mempool holds at least one transaction -- the chain does not produce empty blocks -- so 400 ms is a ceiling on how long a pending transaction waits for the designated proposer to try to seal it, not a block interval. Block height therefore tracks network activity rather than wall-clock time (mainnet passed height 250 in early October 2026), and every protocol timer -- unbonding, jailing, missed-block thresholds -- is measured in blocks, not seconds.

**Proposer Selection (Release 1).** From height 100, each height has exactly one designated proposer:

```
eligible(H) = validators in the state after block H-1 with stake > 0 and jailed_until <= H
proposer(H) = the eligible validator with the largest stake
              (ties broken by the lowest raw public-key bytes)
```

A block signed by any other key is rejected at import before any state is modified, and a node refuses to seal a block for a height at which it is not the designated proposer. The producer records every proposal in a local proposal journal (`proposal-journal-db`) keyed by height and parent hash, so it never signs two different blocks for the same slot. `/api/stats` reports the activation height and the designated proposer for the next height.

Release 1 has **no fallback**: if the designated proposer is offline, no blocks are produced until it returns. Release 2 is split in two: Release 2a (verified finality) has been active since height 150, and Release 2b (skip certificates and a deterministic fallback proposer) is planned; see Section 12.

Earlier versions of this paper described a stake-weighted random selection seeded by the ANU Quantum Random Number Generator. That function exists in the codebase, but it was never enforced on mainnet -- before height 100 a block from any staked validator was accepted -- and it is not part of the Release 1 rule.

**Finality (FINALITY_V2, active from height 150).** Validators sign prevotes and precommits with their own ML-DSA-65 staking keys over a message that commits to a domain tag (`ROUGECHAIN_FINALITY_VOTE_V2`), the chain ID, the vote type, the height, the round and the block hash. A **finality proof** for a block is a set of such precommits whose stake reaches the quorum `floor(2 × total stake / 3) + 1` of that block's validator set. Nothing in a proof is taken on trust: a node verifies every signature and recomputes the voting stake, total stake and quorum from its own validator-set snapshot for that height. Each validator keeps a durable signing journal, so it can never sign two different blocks for the same slot, and votes and proofs travel between nodes over the peer layer.

This is **Release 2a** of the Release 2 design. From height 151 every block header carries `parent_commit`, the finality proof for its parent. A node refuses to import a block whose certificate is missing, is for a different parent, falls short of quorum or fails verification, and the producer does not seal a block until it holds a verified certificate for the previous one; importing block H therefore finalizes block H-1. `finalized_height` in the API now tracks the highest height with a verified certificate, rather than a value the producer sets for itself as it did before height 150 (the legacy vote path, which did not verify votes, applies only below height 150).

What finality does not yet add is liveness. Only one validator produces blocks, and the operator's validator holds more than 99.9% of the stake, so its own precommit reaches quorum on its own: a block is finalized as soon as it is produced, without waiting for the other two validators. **Release 2b** -- rounds, skip certificates, a deterministic fallback proposer, validator-admission hardening, and spreading stake across more independently run validators -- was designed but not implemented. On 6 October 2026 it was superseded by a broader consensus redesign (Section 12.2), which is also not implemented; until one of them ships, an outage of the designated proposer still halts the chain.

**Slashing.** The code carries slashing parameters -- **10%** of a validator's stake per violation and a **20-block** jail, during which the validator is not eligible to propose -- but no slashing is active. Before height 100, a validator that missed 50 block proposals was slashed automatically; this happened once on mainnet, at height 69. Release 1 **froze missed-block accounting from height 100**, because with a single designated proposer every other validator would otherwise accumulate misses by design. From height 245 (MONETARY_INTEGRITY) a block that carries the legacy `slash` transaction type is **invalid**, so that type is retired. Slashing based on evidence of misbehavior (for example, signing two blocks at one height) is part of the planned consensus redesign and is not active.

**Unbonding Period.** When a validator unstakes, the amount enters an **unbonding queue** for **500 blocks**. Because blocks are produced only when there are transactions, this is a block count, not a fixed duration; its wall-clock length depends on network activity. During the unbonding period:
- Funds remain locked and cannot be transferred.
- The unbonding entry includes the delegator address, amount, and release height.
- At each new block, the node processes the unbonding queue and releases matured entries to the delegator's balance.
- This prevents stake-and-run attacks and ensures validators remain accountable for the blocks they participated in.

**Fee Distribution.** Transaction fees follow an EIP-1559-inspired dynamic fee model. A transaction's full signed fee is debited from the sender. Of a block's collected fees, half of the current base fee per transaction is burned (`burned = min(total fees, base fee × tx count / 2)`); everything else forms the distributable tip pool. The tip pool is split:
- **20%** to the block proposer.
- **70%** distributed to all active validators, weighted by their stake.
- **10%** to the protocol treasury account `__treasury__`. The validator share is paid to every validator in the set by stake, with no check that the validator took part in finality.

The code enforces a **minimum tip floor** of 0.1 XRGE per block: if fees alone do not reach it, the shortfall is drawn from the `__staking_rewards__` reserve account. On mainnet that account holds **0 XRGE** (6 October 2026) and nothing has ever funded it, so **the floor pays nothing**; validators earn only the fees actually collected. The treasury account held about 52 XRGE on the same date. No active transaction type can spend from it (Section 3.1.1).

The base fee starts at 0.1 XRGE, adjusts by at most ±12.5% per block toward a target of 10 transactions per block, and never falls below **0.001 XRGE**, which is where it has stood on mainnet since September 2026.

### 3.1.1 Governance

**Status: the on-chain governance transaction types are suspended from height 245 and are not available.** `create_proposal`, `cast_vote`, `execute_proposal`, `delegate` and `undelegate` were never used on mainnet. Their ledger effects were applied without the state checks they depend on (the Web3 state-effects path has had no call site since the F49 upgrade), so MONETARY_INTEGRITY makes a block carrying any of them invalid until a later upgrade restores them. The design below is kept as a record of the intended mechanism; it is being rebuilt rather than switched back on as is.

**Interim arrangement.** Treasury decisions for the Regenerate programme are made through node-hosted proposals and wallet-signed votes (`/api/regen/*`), outside consensus, with every vote stored with its signature so anyone can recount. Protocol upgrades are coordinated binary releases (Section 3.1.3). The `__treasury__` fee account accumulates its 10% share and has no spending path today.

**Intended design (suspended).** Any staked validator could create a proposal specifying a description, action type (`treasury_spend` or `parameter_change`), quorum requirement, pass threshold and timelock delay. Voting was balance-weighted with one-to-one delegation: a voter's weight was their own XRGE balance plus the balances delegated to them, a delegator who voted directly was excluded from the delegate's weight, and a proposal had to meet both quorum and threshold. Passed proposals entered a timelock measured in blocks before execution, and treasury spending was to be controlled exclusively through passed proposals.

### 3.1.2 Multi-Signature Wallets

RougeChain supports M-of-N threshold multi-signature wallets at the protocol layer. Multi-sig wallets require M approvals from N designated signers before executing a transaction. All signatures use ML-DSA-65, making RougeChain multi-sig wallets quantum-resistant by default.

### 3.1.3 Protocol Upgrades

Protocol rules change through coordinated hard forks. Each upgrade is activated at a height compiled into the node software (`core/daemon/src/upgrades.rs`, reported by `/api/stats` as `upgrade_schedule`), and every validator must run the new release before that height. Releases are published as signed binaries with a signed manifest; nodes installed with the one-line installer update themselves from them. There is no on-chain upgrade governance. Mainnet has activated **ten** upgrades; testnet (`rougechain-devnet-1`) runs the same code on its own, later schedule (1200 … 1390).

| Height | Upgrade | What changed |
|---|---|---|
| 18 | v2 ledger | Balances moved from floating-point values to integer quanta (1 XRGE = 10^9 quanta); block headers commit to a SHA-256 state root of the ledger; WASM contracts can hold and move XRGE. |
| 49 | F49 | The ledger was migrated to its canonical state at height 48, with blocks 18-48 pinned by hash; bridge withdrawal records are created only when the burn actually succeeds; stake is registered only if its debit succeeds; block production commits atomically; matured unbonding is released before the state root is computed; peers sync only through verified block import, never by replacing the chain. |
| 90 | Transaction integrity | A transaction may be included only once (canonical-identity uniqueness), and V2 transactions must match the payload that was actually signed (Section 3.3). |
| 100 | Proposer selection, Release 1 | One designated proposer per height (the largest eligible stake); missed-block accounting frozen; producer proposal journal (Section 3.1). |
| 150 | FINALITY_V2 (Release 2a) + GAME_READY | Verified finality: from block 151 each header carries `parent_commit`, a verified precommit certificate from at least two-thirds of stake for its parent, and blocks without one are refused (Section 3.1). Contract transactions become player-signed: `contract_deploy` and `contract_call` are valid only when signed by the deployer or caller, who pays the fee, and node-signed contract transactions are invalid. A deployed contract's address is the first 20 bytes of `SHA-256("rougechain/contract/v2" ‖ from ‖ 0 ‖ nonce ‖ 0 ‖ SHA-256(wasm))`. Deployment costs 10 XRGE; a call costs gasLimit × 0.000001 XRGE (Section 10.5). |
| 160 | GAME_READY 2 | Contracts can hold and move custom tokens and NFTs, create their own NFT collections and mint to players, and draw per-transaction randomness (`host_random`, seeded by the parent block hash and the transaction hash). Addresses a contract supplies are canonicalised, and NFT owner checks compare canonical addresses. Cross-contract (multi-hop) calls have their XRGE, token and NFT moves applied. State root v2 commits to balances plus NFT collections and ownership, contract code hashes and contract storage (Section 2.4). |
| 170 | GAME_READY 3 | `host_block_hash(height)`: contracts can read the hash of a finished block up to 256 back, so games commit in one call and settle from a block that did not exist when the player committed. Fixes the sender-grinding weakness of one-step `host_random` rolls. |
| 190 | Payable calls | A `contract_call` may carry a signed `attach` (a symbol and an integer amount: quanta for XRGE, raw units for tokens). The payment is credited to the contract for the duration of the call and becomes final only if the call succeeds; a failed call leaves it with the caller. Contracts read it with `host_get_attached_amount` and `host_get_attached_symbol`. Before height 190 a call carrying `attach` is invalid. |
| 235 | TOKEN_MINTING + CONTRACT_NFT_ROYALTY (node release 1.6.0) | A token may be created `mintable` with an optional integer `max_supply`; only its creator can `mint_tokens`, only for tokens created mintable at or after 235, and never past the cap. The header state root also commits the mint ledger of every mintable token. Tokens created before 235 stay fixed-supply. Contracts gain two read-only host functions, `host_nft_royalty_bps` and `host_nft_royalty_recipient`, so a marketplace contract can pay a collection's royalty itself; an `nft_create_collection` whose royalty is above 10,000 basis points or not an integer is invalid. |
| 245 | MONETARY_INTEGRITY (node release 1.6.2) | A block is invalid if it carries a transaction whose fee is not a finite number ≥ 0, a `slash` transaction, a transaction with the faucet flag (mainnet has no faucet), or a transaction of a **suspended type**: `shield`, `shielded_transfer`, `unshield`, `token_lock`, `token_unlock`, `create_staking_pool`, `token_stake`, `token_unstake`, `create_proposal`, `cast_vote`, `execute_proposal`, `delegate`, `undelegate`, `token_approve`, `token_transfer_from`. Execution is unchanged, so history below 245 replays identically. |

Node release **1.6.3** (5 October 2026) followed 245 without an activation height: it is not a consensus change. It hardens the messenger directory (Section 8.2), retires the unauthenticated legacy mail and messenger read routes with `410 Gone`, and makes the shielded API routes refuse a suspended type before reading request data.

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
| state_root | Option\<String\> | SHA-256 commitment to the balance ledger (present from height 18); from height 160, state root v2 also covers NFTs and contract state |
| parent_commit | Option\<FinalityProof\> | Verified precommit certificate for the parent block (required from height 151; absent before) |

**BlockV1:**

| Field | Type | Description |
|---|---|---|
| version | u32 | Protocol version |
| header | BlockHeaderV1 | Block metadata |
| txs | Vec\<TxV1\> | Ordered list of transactions |
| proposer_sig | String | ML-DSA-65 signature over header |
| hash | String | SHA-256(header_bytes \|\| proposer_sig) |

### 3.3 Transaction Model

RougeChain defines 44 transaction types within a unified transaction structure:

**TxV1:**

| Field | Type | Description |
|---|---|---|
| version | u32 | Transaction version |
| tx_type | String | One of the 44 transaction types |
| from_pub_key | String | Sender's ML-DSA-65 public key |
| nonce | u64 | Sender counter (replay protection comes from transaction identity; see below) |
| payload | TxPayload | Type-specific data |
| fee | f64 | Fee in decimal XRGE as signed; converted to integer quanta when applied (Section 4.1) |
| sig | String | ML-DSA-65 signature |
| signed_payload | Option\<String\> | V2 canonical signed payload |

**Supported Transaction Types.** Types marked † are **suspended from height 245** (a block carrying one is invalid); `slash` is likewise rejected from 245.

| Category | Types |
|---|---|
| Transfers | `transfer` |
| Tokens | `create_token`, `mint_tokens` (creator-only, from height 235) |
| Staking | `stake`, `unstake`, `slash` (rejected from 245) |
| AMM / DEX | `create_pool`, `add_liquidity`, `remove_liquidity`, `swap` |
| Bridge | `bridge_mint`, `bridge_withdraw` |
| NFTs | `nft_create_collection`, `nft_mint`, `nft_batch_mint`, `nft_transfer`, `nft_burn`, `nft_lock`, `nft_freeze_collection` |
| Shielded | `shield` †, `shielded_transfer` †, `unshield` † |
| Governance | `create_proposal` †, `cast_vote` †, `execute_proposal` †, `delegate` †, `undelegate` † |
| Multi-Sig | `multisig_create`, `multisig_approve`, `multisig_submit` |
| Allowances | `approve`, `transfer_from` (active); `token_approve` †, `token_transfer_from` † (older duplicates no client sends) |
| Tokens (extended) | `token_airdrop`; `token_lock` †, `token_unlock` † |
| Token Staking | `create_staking_pool` †, `token_stake` †, `token_unstake` † |
| Contracts | `contract_deploy`, `contract_call` |
| Orders | `place_limit_order`, `cancel_limit_order` |

> **Note:** The faucet is implemented as a `transfer` transaction with a `faucet: true` flag in the payload, signed by a genesis validator key. It is not a separate transaction type. Mainnet has no faucet, and from height 245 a mainnet block carrying a faucet-flagged transaction is invalid; testnet keeps its faucet.

**Client-Side Signing.** All transactions are signed on the user's device using their ML-DSA-65 private key. The signed transaction is then submitted to any node via the REST API. At no point does a private key leave the client. The v2 transaction endpoints enforce this by design -- they accept only pre-signed payloads and reject empty or invalid signatures.

**V2 Signed Payload Format.** V2 transactions carry `signed_payload`: the sorted-key JSON that the user actually signed. Since height 90 the node derives the transaction's security-relevant fields (recipient, amount, fee, token, and so on) from that signed payload and rejects any transaction whose top-level fields differ from it, both at API ingress and at block import. Two signed formats are bound this way: the flat format used by the REST API and SDK, and the envelope format used by the CLI. Before height 90 only the signature over `signed_payload` was checked.

**Transaction Uniqueness.** Since height 90 every transaction has a canonical identity hash, and a transaction whose identity is already included in an earlier block is rejected at mempool admission, when a block is produced, and at block import. The index of included identities (`tx-seen-db`) is rebuilt from the chain at startup. This replaced an earlier per-account nonce check that was not enforced at block import; the `nonce` field is not required to be sequential.

### 3.4 Storage

RougeChain uses the Sled embedded database for persistent state, providing:
- **O(1) block lookups** by height
- **O(1) transaction lookups** by hash via a dedicated `tx_index` tree
- **Range queries** for block scanning and pagination
- **Persistent state** for shielded supply, faucet cooldowns, and chain metadata
- **Atomic writes** for consistency during block import

The following stores are maintained independently:

| Store | Database | Contents |
|---|---|---|
| Chain | chain-db | Blocks indexed by height |
| Tx Index | chain-db (tx_index tree) | O(1) transaction hash → block height lookup |
| State | chain-db (state tree) | Persistent chain state (shielded supply, faucet cooldowns) |
| Nonce | nonce-db | Per-account nonce tracking |
| Included Transactions | tx-seen-db | Canonical identities of included transactions (replay protection, from height 90) |
| Proposal Journal | proposal-journal-db | The producer's signed proposals by height and parent (from height 100) |
| Validators | validators-db | Stake, slash count, jail status, entropy contributions |
| Pools | pools-db | AMM liquidity pool state |
| NFT Collections | nft-collections-db | Collection metadata and configuration |
| NFT Tokens | nft-tokens-db | Individual token ownership and attributes |
| Token Metadata | token-metadata-db | Custom token metadata (name, image, socials) |
| Finality Records | finality-db | Verified FINALITY_V2 proofs by block height (from height 150; earlier records are legacy and informational) |
| Event Index | indexer-db | Multi-index event store (by address, type, token, block) |
| Transaction Receipts | receipts-db | Post-inclusion status, logs, and gas used |
| Contracts | contracts-db | WASM bytecode, metadata, and contract storage |
| Messenger | messenger-db | Wallets, conversations, messages with participant and conversation-message indexes |
| Mail | mail-db | Mail messages and per-recipient folder labels |
| Name Registry | name-registry-db | Bidirectional name↔wallet mappings with atomic registration (compare-and-swap) |
| Social | social-db | Posts, likes, reposts, follows, comments, play counts, timeline indexes |

Additional off-chain stores (JSON-backed) handle bridge claims and withdrawal requests.

### 3.4.1 Event Indexer

RougeChain includes a built-in event indexer that maintains secondary indexes over all on-chain transactions. The indexer supports paginated queries by:
- **Address** — all transactions involving a given public key (as sender or recipient)
- **Transaction type** — filter by protocol transaction type
- **Token symbol** — activity feed for a specific token
- **Block height** — all events within a given block

The indexer automatically backfills from the chain store on startup and indexes new blocks in real-time during block production and peer import. API endpoints are exposed at `/api/indexer/{address|type|token|block}/:param`.

### 3.4.2 Observability

The node exposes a `/metrics` endpoint in Prometheus text exposition format, providing real-time gauges for:
- Block height, finalized height, and base fee
- Validator count, total staked, and mempool size
- Peer count, WebSocket client count, and indexed event count
- Lifetime fees collected and burned

A `docker-compose.yml` with an optional `monitoring` profile provisions a Prometheus instance pre-configured to scrape the node.

### 3.5 Networking

Nodes communicate over HTTP with the following mechanisms:

**Peer Discovery.** Nodes register with known peers via `POST /api/peers/register` and periodically fetch the peer list via `GET /api/peers`. New peers discovered transitively are added automatically.

**Block Synchronization.** Nodes poll peers for new blocks with adaptive frequency (10-60 seconds). On initial sync, blocks are fetched in batches of 1,000. Failed syncs trigger exponential backoff up to 10 minutes.

**Block Propagation.** When a node produces or imports a new block, it broadcasts asynchronously to all known peers via `POST /api/blocks/import` with a 5-second timeout per peer.

**Transaction Broadcast.** Submitted transactions are propagated to peers via `POST /api/tx/broadcast`.

**Current Mainnet Topology.** The operator runs two mainnet nodes: the producing validator and a second node, itself a staked validator with 10,000 XRGE, that follows the chain without producing blocks. A third validator key with 9,000 XRGE is in the set and has proposed no blocks. On the public mainnet endpoint (`api.rougechain.io`), the unauthenticated peer-write routes `POST /api/blocks/import`, `POST /api/peers/register` and `POST /api/tx/broadcast` are closed at the reverse proxy; other nodes sync by pulling blocks. Node-to-node communication is HTTP polling; a dedicated peer-to-peer transport is not yet implemented.

**Rate Limiting.** The REST API supports three-tier rate limiting. Each tier's limit is an operator flag that defaults to 0 (unlimited), and clients are identified by the connecting socket address (forwarded-for headers are not used), so behind a reverse proxy all clients share one limit:
- **Tier 1 (Validators):** Elevated throughput for staked validators. Authentication requires three headers: `X-Validator-Key` (public key), `X-Validator-Sig` (ML-DSA-65 signature over the timestamp), and `X-Validator-Ts` (Unix millisecond timestamp). The signature is verified via `pqc_verify`, and the timestamp must be within a 30-second drift window. This prevents spoofing of validator status.
- **Tier 2 (Peers):** Moderate limits for registered peer nodes, identified by socket address.
- **Tier 3 (General):** Configurable rate limits for public API consumers, with separate limits for read (GET) and write (all other methods) requests.

### 3.6 Mempool

The mempool holds up to **2,000 pending transactions** in a hash map keyed by transaction hash. When the mempool is full, the **lowest-fee transaction is evicted** — new transactions must have a higher fee than the current minimum to be admitted. This fee-priority eviction prevents an attacker from flooding the mempool with low-fee spam to displace legitimate transactions. Duplicate transactions are rejected. P2P broadcast transactions undergo full ML-DSA-65 signature verification before admission.

All transactions in the mempool are verified (including parallel signature checks via Rayon) and included in the next block produced by the local node, then drained.

### 3.7 Signature Size and Scaling

Post-quantum signatures are larger than classical signatures. This is an inherent property of lattice-based cryptography and applies to every NIST-standardized PQ signature scheme. RougeChain confronts this tradeoff directly.

**Size Reality:**

| Scheme | Public Key | Signature | Per-Tx Overhead |
|---|---|---|---|
| ECDSA (Ethereum) | 33 bytes | 64 bytes | ~97 bytes |
| Ed25519 (Solana) | 32 bytes | 64 bytes | ~96 bytes |
| ML-DSA-65 (RougeChain) | 1,952 bytes | 3,309 bytes | ~5,261 bytes |

A RougeChain transaction carries approximately **54× more signature data** than an Ethereum transaction. This directly impacts block size, storage growth, and network bandwidth.

**Impact Analysis:**

| Metric | Classical Chain | RougeChain | Factor |
|---|---|---|---|
| Per-transaction overhead | ~100 bytes | ~5.3 KB | ~54× |
| 1,000-tx block (signatures only) | ~100 KB | ~5.3 MB | ~54× |
| Annual storage (1 tx/sec) | ~3 GB | ~162 GB | ~54× |

This is significant but manageable. Modern consumer hardware handles these volumes, and the numbers are comparable to chains with high-throughput blocks (Solana averages 100+ MB/min).

**Mitigation Strategy:**

1. **Transaction batching.** Multiple operations can share a single signature by bundling them into a single transaction payload, amortizing the 3.3 KB cost across many operations.
2. **Network-layer compression.** Block data is compressible at the transport layer. Signature bytes exhibit low entropy and compress well with standard algorithms (zstd/lz4), reducing actual bandwidth by 30-50%.
3. **Pruning and archival.** Full signature data is required only for verification. Fully validated blocks can be pruned to headers + state roots for archival nodes.
4. **STARK rollups (Phase 3).** The intended long-term scaling path: off-chain transactions batched and verified via a single STARK proof posted on-chain, so that one proof of ~100 KB attests to many transactions. Only a research prototype exists today (Section 2.4); nothing in consensus verifies a rollup batch.

**Context.** This size increase is the cost of quantum resistance. Every post-quantum signature scheme — including SLH-DSA (SPHINCS+), which produces even larger signatures at ~17 KB — faces this tradeoff. Chains that defer PQ migration will eventually pay the same cost, but under adversarial conditions during an emergency hard fork. RougeChain pays it now, by design.

### 3.8 Design Philosophy: Vertically Integrated L1

RougeChain intentionally adopts a vertically integrated L1 design, building a DEX, NFT standard, bridges, messenger, name service, mail system and social layer into the node itself. A new chain with no dApps has no users, and no users means no dApps -- by shipping core primitives with the node, RougeChain offers usable applications without waiting for third parties to build them.

These components are not all on-chain. The DEX, NFTs, tokens, validator staking, contracts and bridge mints and burns are transactions in blocks (governance and shielded transfers were designed as transactions too, but their types are suspended from height 245). Token, LP and XRGE balances are covered by the state root from height 18; NFT collections and ownership and contract code and storage are covered from height 160 (state root v2, Section 2.4). The messenger, mail, name registry and social layer are **node-hosted services**: every write is authenticated with an ML-DSA-65 signature, but the data is stored by the node in its own databases and is not part of consensus state.

This increases protocol complexity but enables immediate usability without reliance on external smart contract layers or third-party infrastructure. Future iterations may modularize components as the ecosystem matures and developer tooling enables permissionless application deployment.

### 3.9 Shielded Transactions

**Status: suspended.** The V1 shielded pool described in this section is **switched off from height 245**: a block carrying `shield`, `shielded_transfer` or `unshield` is invalid. Its STARK proof established that the values in a transfer balanced, but it did not bind a withdrawal to a specific note, and the `winterfell` prover it used has no zero-knowledge mode (Section 2.4), so it did not deliver the privacy this section once claimed. The mainnet pool was empty when it was suspended (`shielded_supply` is 0), so no funds are affected. The description below is kept as the record of the V1 design.

**What replaces it.** A redesigned pool, **V2**, is specified and in development: a Plonky3-based STARK with a hiding mode, proofs of about 190 KB that verify in about 6 ms and are produced in about 3 s on a phone, and a proof that binds each spend to a specific note. It is planned to launch under a **1,000,000 XRGE cap** on the pool total before the external audit, and it is **not audited**; until the audit has covered the hiding mode, product text must not claim audited privacy.

#### V1 design (suspended)

V1 was a note-based system intended to hide transfer amounts and balances behind cryptographic commitments.

**Commitment Scheme.** A shielded note is represented as a SHA-256 commitment:

```
commitment = SHA-256("ROUGECHAIN_COMMITMENT_V1" || value || owner_pubkey || randomness)
```

The `value` and `randomness` are private — only the commitment hash is stored on-chain. Two notes with the same value produce different commitments due to the random blinding factor.

**Double-Spend Prevention.** Each note has a unique nullifier derived from its randomness:

```
nullifier = SHA-256("ROUGECHAIN_NULLIFIER_V1" || randomness || commitment)
```

When a note is consumed, its nullifier is published on-chain. If a nullifier already exists in the nullifier set, the transaction is rejected as a double-spend. The nullifier does not reveal which commitment it corresponds to.

**STARK Proof of Value Conservation.** Every V1 shielded transfer carried a STARK proof that the sum of input note values equals the sum of output note values plus the fee -- and nothing more; in particular, the proof did not tie the spend to a specific existing note:

```
input_value = output_value_1 + output_value_2 + fee
```

The proof uses a 5-column, 64-row arithmetic execution trace:

| Column | Purpose |
|---|---|
| input_value | Value of consumed note (constant) |
| output_1 | Recipient value (constant) |
| output_2 | Change value (constant) |
| fee | Transaction fee (public) |
| bit_accumulator | Bit-decomposition range check |

The 64-row trace performs MSB-first bit decomposition of the input value, proving it fits within 64 bits. This prevents overflow attacks where an adversary could create notes with astronomical values by exploiting finite field arithmetic.

**Transaction Lifecycle (V1):**

1. **Shield** (`shield`): deducted XRGE from the sender's public balance and stored a commitment on-chain. The note details (value, randomness) were kept by the sender.
2. **Shielded Transfer** (`shielded_transfer`): published nullifiers for the input notes, created new output commitments, and carried the value-conservation proof.
3. **Unshield** (`unshield`): published a nullifier and credited XRGE to the sender's public balance. The proof established value conservation only; it was not a proof of ownership of a specific note.

**Supply Tracking.** The total shielded supply is tracked persistently in the `state` sled tree. The API exposes a supply breakdown, in which the shielded pool is 0 on mainnet:

| Metric | Source |
|---|---|
| Circulating Supply | Total supply − burned − shielded |
| Shielded Pool | Cumulative shield minus unshield amounts (0 on mainnet) |
| Burned Supply | Balance of the burn address |

**Proof Size Tradeoff.** V1 proofs were approximately 50–100 KB; V2 proofs are about 190 KB, compared to ~5.3 KB for a standard transfer (including the 3.3 KB ML-DSA signature). This is an inherent characteristic of STARKs -- transparency and quantum resistance come at the cost of larger proofs -- and is why V2 will cap the number of shielded transactions per block and the pool total.

---

## 4. Tokenomics

### 4.1 XRGE (RougeCoin)

XRGE is the native token of RougeChain. Every fee paid, every stake deposited, and every trade executed on RougeChain is denominated in XRGE, and every XRGE transfer is authorized with an ML-DSA-65 signature.

XRGE serves four functions on the network:
- **Transaction fees.** Every operation on RougeChain requires XRGE, creating baseline demand proportional to network activity.
- **Validator staking.** XRGE is staked to participate in consensus. Validators earn fee revenue proportional to their stake, aligning economic incentive with network security.
- **Base trading pair.** XRGE is the default routing token in the DEX's multi-hop swap engine, making it the liquidity backbone of on-chain trading.
- **Governance weight (not active).** The suspended on-chain governance weighted votes by XRGE balance (Section 3.1.1); the interim Regenerate votes use a balance snapshot the same way. Nothing on-chain gives XRGE a vote today.

| Property | Value |
|---|---|
| Name | RougeCoin |
| Symbol | XRGE |
| Maximum Supply | 36,000,000,000 (genesis `max_supply`) |
| Issued on mainnet | about 315 million XRGE on 6 October 2026 (`/api/token/XRGE/holders`), most of it in operator-controlled protocol accounts |
| Smallest Unit | 1 quantum = 10^-9 XRGE |

**Integer Quanta.** Since the v2 ledger upgrade at height 18 (Section 3.1.3), balances are stored as integers in **quanta**, where 1 XRGE = 1,000,000,000 quanta. Amounts and fees are written in decimal XRGE in signed transactions and are converted to quanta when a transaction is applied, so ledger arithmetic is exact.

### 4.2 Fee Schedule

All operations on RougeChain require an XRGE fee. The fee schedule is designed to be accessible for common operations while discouraging spam on higher-impact actions.

| Operation | Fee (XRGE) |
|---|---|
| Transfer | 1 |
| Token creation | 100 |
| Liquidity pool creation | 10 |
| Token swap | 1 |
| NFT collection creation | 50 |
| NFT mint | 5 |
| NFT batch mint | 5 per token |
| NFT transfer | 1 |
| NFT lock / unlock | 0.1 |
| NFT collection freeze | 0.1 |
| Token mint (creator of a mintable token, from height 235) | 1 |
| Bridge withdrawal (any asset) | 0.1 (exactly) |
| Shield / shielded transfer / unshield | suspended from height 245 (were 1 each) |

> **Note:** These are the fees bound to wallet- and API-signed (v2) transactions: a transaction whose fee differs from the fee bound to its signed payload is rejected. A transaction signed as a CLI envelope carries whatever fee its signer chose (the CLI defaults to 1 XRGE). Either way the full signed fee is debited; the base fee (Section 4.3) only determines how much of it is burned.

### 4.3 Fee Distribution

RougeChain uses an **EIP-1559-inspired dynamic fee model**. The sender pays the full signed fee; the protocol's **base fee** decides how much of it is burned:

- Half of the current base fee per transaction is **burned** (`burned = min(total fees, base fee × tx count / 2)`), permanently reducing the circulating supply. This makes XRGE deflationary under sustained network activity. The rest of the collected fees forms the tip pool.
- The **tip pool** is distributed as follows:
  - **20%** to the block proposer as a direct reward for block production.
  - **70%** to all validators in the set, distributed proportionally to their staked XRGE, whether or not they took part in finality.
  - **10%** to the protocol treasury account `__treasury__` (about 52 XRGE on 6 October 2026). The governance that was to control it is suspended (Section 3.1.1), so it has no spending path today.
- The code enforces a **minimum tip floor** of 0.1 XRGE per block, drawn from the `__staking_rewards__` reserve when fees fall short. On mainnet that reserve is **empty** (0 XRGE; it was never funded), so the floor pays nothing and validators receive only the fees actually collected.

The base fee adjusts dynamically based on block utilization. If a block holds more than the target of 10 transactions, the base fee increases by up to 12.5%; if it holds fewer, it decreases by up to 12.5%. The base fee starts at 0.1 XRGE and never falls below a floor of 0.001 XRGE, where it has stood on mainnet since September 2026; about 0.2 XRGE had been burned through base fees by 6 October 2026 (a further 356 XRGE were sent to the burn address by users).

Fee income is therefore proportional to network activity, and with today's volume it is small; there is no block subsidy.

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
- **Collecting fees:** the 0.3% swap fee accrues to liquidity providers inside the pool, and a provider can withdraw what it has earned with **Collect fees** without touching its deposit. Collecting is an ordinary `remove_liquidity` of exactly the LP tokens that represent the position's fee growth; there is no separate fee transaction and no consensus change. To size it, each node keeps an off-consensus fee ledger per LP position: the deposit is recorded as a basis in share-value units, where one LP token is worth `√(reserveA · reserveB) / LP supply` (a value that swap fees raise and adding or removing liquidity does not), and withdrawals are counted against earnings first, so collecting fees leaves the deposit's basis intact. A position's earnings are exposed at `GET /api/pool/:id/earnings/:owner`. The ledger is maintained from pool events (and rebuilt from them once on nodes that predate it) and is not part of the state root; it only informs the client how much to withdraw.

There is no protocol fee: the whole 0.3% stays with liquidity providers.

### 5.5 Pool Creation

Any user may create a pool by specifying two tokens and initial deposit amounts. The pool ID is derived from the sorted token pair (e.g., `TOKENA-TOKENB`). A 10 XRGE fee is charged.

---

## 6. Cross-Chain Bridges

RougeChain operates two bridges: one to **Base** (Ethereum L2) for ETH, USDC and XRGE, and one to **Bitcoin** for BTC. Deposits are verified against the source chain before wrapped assets are minted on RougeChain; withdrawals burn the wrapped asset on RougeChain and are paid out on the destination chain by an operator-run relayer. Both bridges rely on operator trust, which Section 6.7 sets out.

### 6.1 Multi-Network Support

The bridge dynamically selects the correct chain configuration based on the daemon's `/bridge/config` response:

| Network | Chain ID | XRGE Contract | USDC Contract |
|---|---|---|---|
| Base Mainnet | 8453 | 0x147120...24317 | 0x833589...02913 |
| Base Sepolia | 84532 | 0xF9e744...Efa27E | 0x036CbD...3dCF7e |

### 6.2 Bridge In (Base → RougeChain)

1. The user deposits on Base. For ETH and USDC the site calls the RougeBridge contract's `depositETH(recipient)` or `depositERC20(token, amount, recipient)`, which emits a deposit event carrying the user's RougeChain key; for XRGE the user transfers to the BridgeVaultV2 contract. ETH and USDC deposits through the site were paused in late September 2026 and **reopened on 5 October 2026** on this contract-deposit path.
2. The operator's deposit watcher detects the deposit event and claims it automatically. The manual claim route (`/api/bridge/claim`, which needs an ECDSA signature from the depositing wallet) still exists in the node but is **closed at the public endpoint**; it is not part of the user journey.
3. The RougeChain node performs **two-layer verification**:
   - **Layer 1 (Receipt Verification):** Queries the Base RPC for the transaction receipt, verifying tx status (`0x1`), recipient matches the bridge contract, sender matches the claimed address, and the minimum confirmation depth is met (`QV_BRIDGE_MIN_CONFIRMATIONS`, default **6**).
   - **Layer 2 (Commitment Nullifier):** Computes a SHA-256 commitment hash of the deposit (`SHA-256("ROUGECHAIN_BRIDGE_V1" || tx_hash || evm_address || amount)`) and checks it against the nullifier set. Duplicate commitments are rejected.
4. For contract deposits, the node additionally verifies the deposit event in the transaction logs, matching the indexed sender address.
5. Upon verification, the node creates a `bridge_mint` transaction, minting the wrapped asset to the user's RougeChain address. `bridge_mint` is authorized by the node operator's key (Section 6.7).

**Replay protection:** Each deposit commitment hash is stored persistently. A deposit can only be claimed once, even across node restarts.

**EVM Signature Verification.** Manual bridge claims require an ECDSA signature from the wallet that sent the deposit transaction. The claim message follows a canonical format (`RougeChain bridge claim\nTx: {hash}\nRecipient: {pubkey}`), and the signature is verified via `ecrecover` to ensure the claimant is the original depositor.

### 6.3 Multi-Asset Bridge

| Asset | Base Chain | RougeChain Wrapped | Custody Contract |
|---|---|---|---|
| ETH | Native ETH | qETH | RougeBridge (`0x0c09C7...35d83`) |
| USDC | ERC-20 | qUSDC | RougeBridge (`0x0c09C7...35d83`) |
| XRGE | ERC-20 (Base) | XRGE (L1) | BridgeVaultV2 (`0x7BB107...35Cd2D`) |

For ERC-20 tokens, the bridge parses `Transfer` event logs from the transaction receipt to determine the deposited amount, rather than relying on the transaction's ETH value field. qETH and qUSDC use 6 decimals on RougeChain; USDC is bridged 1:1, and ETH amounts are scaled by 10^12 from its 18 decimals.

### 6.4 Bridge Out (RougeChain → Base)

1. The user signs a `bridge_withdraw` request with ML-DSA-65. The signature covers the operation type, amount, fee, token symbol, destination EVM address, sender, timestamp and nonce, and the node executes only these signed values; unsigned request fields must match them or the request is rejected. The fee must be exactly **0.1 XRGE** for every asset.
2. The node burns the wrapped asset. A withdrawal record is created only if the burn succeeded in an accepted block; a withdrawal whose burn fails produces no payout record.
3. The relayer pays out on Base: XRGE through BridgeVaultV2 `release()`, qETH through RougeBridge `releaseETH`, and qUSDC through RougeBridge `releaseERC20`. Each payout carries a canonical ID (`keccak256` of the RougeChain withdrawal ID), and the contracts' `processedL1Txs` record prevents a second payout for the same withdrawal.
4. The node marks the withdrawal fulfilled only after verifying the matching release event on Base at the required confirmation depth.

RougeBridge can hold large withdrawals in an on-chain timelock; a queued withdrawal is fulfilled when the timelock executes. Automatic refunds are disabled: a withdrawal is never refunded while its payout status is paid, queued or ambiguous.

### 6.5 Hardened Relayer

The bridge relayer implements the following safeguards for withdrawal processing:

- **Payout-state check first:** Before any release, the relayer checks the contract's `processedL1Txs` record and fails closed if the state cannot be read; an already-processed withdrawal is reconciled, never paid again.
- **Asset routing:** Each wrapped asset has an explicit payout route; unsupported assets are not paid.
- **Nonce management:** Manual nonce tracking prevents stuck transactions from blocking the queue.
- **Retry with exponential backoff:** Failed RPC calls are retried up to 3 times (1s → 2s → 4s delays).
- **Gas estimation:** Uses `estimateGas` with a 10% buffer instead of hardcoded gas limits.
- **Preflight checks:** On start, the relayer checks chain ID, contract code, ownership, pause state and token configuration.
- **Graceful shutdown:** SIGTERM/SIGINT handlers wait for in-flight transactions before exiting.
- **Confirmation depth:** Waits for the greater of its own setting and the node's minimum (default 6 confirmations) before asking the node to mark a withdrawal fulfilled.

### 6.6 Security Model

The Base bridge uses two custody contracts with different trust properties:

- **BridgeVaultV2 (XRGE).** Roles are split. The owner is a Safe multisig, which alone can change the relayer, adjust caps, pause the vault, or start an emergency withdrawal (subject to a 48-hour timelock). The relayer is a hot key that can only call `release()`, bounded by an on-chain per-transaction cap and a rolling 24-hour limit, and is blocked while the vault is paused. A compromised relayer key can therefore release at most the remaining 24-hour limit before the owner rotates or pauses it.
- **RougeBridge (ETH and USDC).** The owner is a single hot key held by the operator, and the same key signs releases. A 2-of-3 Safe acts as guardian and can cancel timelocked withdrawals, but below the timelock threshold the owner key can move the contract's funds. Moving RougeBridge ownership to a multisig is pending.

Deposit and withdrawal verification layers:

- **EVM receipt verification** against Base RPC (tx status, recipient, sender, confirmations).
- **SHA-256 commitment nullifiers** prevent double-claiming deposits.
- **Deposit event verification** for contract deposits (log parsing + sender matching).
- **ECDSA signature verification** (ecrecover) to authenticate depositors on manual claims.
- **Chain ID validation** to prevent cross-chain replay.
- **Signed withdrawal intent** (ML-DSA-65) bound to the executed amount, fee, asset and destination.
- **Burn-gated payout records** and **on-chain payout verification** before fulfillment.
- **Relayer authentication** via shared secret for withdrawal fulfillment.

### 6.7 Trust Assumptions

The bridges' trust model is explicit. The following table documents what is verified cryptographically versus what requires operational trust:

| Component | Verification Method | Trust Assumption |
|---|---|---|
| Deposit occurred on Base | EVM receipt verification via RPC | Relies on Base RPC endpoint returning honest data |
| Depositor identity | ECDSA ecrecover of signed claim | Cryptographic — no trust required |
| Double-claim prevention | SHA-256 commitment nullifier set | Cryptographic — no trust required |
| Contract deposits | Deposit event log parsing | Relies on correct contract deployment |
| Minting on RougeChain | `bridge_mint` signed by the node operator's key | Trusted operator: this key can mint wrapped assets |
| XRGE custody | BridgeVaultV2: Safe owner, capped hot relayer | Relayer compromise bounded by on-chain caps |
| ETH/USDC custody | RougeBridge: single hot EOA owner | Trusted operator: owner key compromise could drain the contract |
| Withdrawal fulfillment | Relayer executes on Base; node verifies the release event | Requires the operator-run relayer to be online and honest |
| Cross-chain consistency | Chain ID validation | Cryptographic — no trust required |

**Current model:** The Base bridge is an **operator-trusted custody bridge**. Deposits are verified against Base before minting, but minting authority, the relayers and the RougeBridge owner key are all held by the operator; the ETH/USDC path in particular rests on a single hot key. None of the bridge code or contracts has been externally audited.

**Target model:** The next step is BridgeVaultV3 (Section 12), in which releases on Base require **2-of-3** ML-DSA-65 authorization of withdrawal data derived from RougeChain, removing the single hot key from the XRGE release path. It depends on FINALITY_V2, which has been active on mainnet since height 150 (Section 3.1). V3 is built, frozen as an audit candidate and rehearsed end to end (including an authority rotation) on a throwaway OP-stack network; a genesis authority set has been assembled; it is **not deployed** and is waiting on an external audit. Fully trustless operation through STARK proofs of Base block headers was researched in October 2026 and found to need a header-commitment upgrade on RougeChain first; it remains a longer-term goal.

### 6.8 Bitcoin Bridge (BTC ⇄ qBTC)

qBTC is wrapped Bitcoin on RougeChain with 8 decimals (one unit is one satoshi).

- **Deposits.** Each user can request a unique Bitcoin deposit address and pay it from any wallet. Alternatively, a deposit can carry the recipient's RougeChain address in an `OP_RETURN` output. The node verifies each deposit against two independent Esplora providers and a minimum confirmation depth (default 2) before minting qBTC, and each output can be credited only once. The node watches deposit addresses but holds no Bitcoin private key.
- **Withdrawals.** The user burns qBTC. An operator-run relayer holding the custody key broadcasts the Bitcoin payout, capped per withdrawal, and the node re-verifies the payout on the Bitcoin chain before marking the withdrawal fulfilled.

**Status.** The Bitcoin bridge went live on mainnet on 15 September 2026. **Deposits are live**: BTC sent to a user's deposit address is verified and credited as qBTC. **Withdrawals are switched off** in the site, because the Bitcoin relayer has been stopped since the F49 upgrade (Section 3.1.3) while a hardening of its payout path awaits deployment; a qBTC withdrawal submitted directly to the API would wait unpaid until the relayer is reopened.

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

## 8. Encrypted Messenger and Mail

RougeChain includes end-to-end encrypted messenger and mail systems that leverage the same post-quantum primitives used by the blockchain, with comprehensive security hardening across authentication, encryption, and storage layers.

### 8.1 Encryption Protocol

Each messenger wallet generates two key pairs:
- **ML-DSA-65** for message signing, authentication, and request signing.
- **ML-KEM-768** for key encapsulation and encryption.

**Messenger Encryption.** When a user sends a message, the following process occurs:

1. **Key Encapsulation.** The sender encapsulates a shared secret using the recipient's ML-KEM-768 public key, producing a ciphertext and a 32-byte shared secret.
2. **Key Derivation.** The shared secret is passed through HKDF-SHA-256 to derive an AES-256-GCM key.
3. **Encryption.** The plaintext message is encrypted with AES-256-GCM using a random 12-byte IV.
4. **Dual Encryption.** The same process is repeated with the sender's own ML-KEM-768 public key, producing a second encrypted copy. This allows the sender to decrypt their own messages when re-fetched from the server.
5. **Signing.** The entire encrypted package is signed with the sender's ML-DSA-65 private key.

**Mail Encryption (CEK Pattern).** Mail uses a Content Encryption Key (CEK) pattern for multi-recipient support:

1. **CEK Generation.** A random 256-bit AES key (the CEK) is generated.
2. **Content Encryption.** The mail content (subject, body, and attachment) is encrypted once using the CEK with AES-256-GCM.
3. **Key Wrapping.** For each recipient (and the sender), the CEK is wrapped using ML-KEM-768: a shared secret is encapsulated, an AES-GCM wrapping key is derived via HKDF, and the CEK is encrypted with this wrapping key.
4. **Unified Signature.** A single ML-DSA-65 signature is computed over the concatenation of all encrypted parts (subject + body + attachment), ensuring integrity of the complete message.

This design encrypts the message body only once regardless of recipient count, making multi-recipient mail efficient while preserving per-recipient key isolation.

### 8.2 Authenticated API Requests

All mail, messenger, and name registry operations require ML-DSA-65 signed requests. Each API call includes:

- **Payload** — The operation parameters plus a `from` field (sender's public key), a `timestamp` (millisecond precision, valid within a 5-minute window), and a unique `nonce` (16 bytes of random hex).
- **Signature** — ML-DSA-65 signature over the canonical (sorted-key) JSON serialization of the payload.
- **Public Key** — The signer's ML-DSA-65 public key for verification.

The server verifies the signature, checks the timestamp window, confirms the `from` field matches the signing key, and rejects duplicate nonces to prevent replay attacks. Unsigned legacy endpoints return HTTP 410 (Gone) in production; since node release 1.6.3 (5 October 2026) this includes the legacy **read** routes (`/api/mail/inbox`, `/sent`, `/trash`, `/api/mail/message/:id`, `/api/messenger/conversations`, `/api/messenger/messages`), which were unauthenticated.

**Identity and the directory (release 1.6.3).** A messenger wallet's identity is its ML-DSA-65 **signing key**. A directory entry -- display name, signing key, encryption key -- can be replaced only by a request signed with the key that owns it, and an encryption key that is already registered to another wallet is refused (`This encryption key is already registered to another wallet`). Mail names and mail folders follow the owning wallet only. Before 1.6.3 a registration could overwrite another wallet's entry.

Messenger and mail are **node-hosted services**, not chain state: every write is signed, but the data lives in the node's own databases and is not replicated by consensus (Section 3.8).

### 8.3 Anti-Replay Protection

Beyond timestamp validation, each signed request includes a cryptographically random nonce. The server maintains an in-memory nonce store with automatic expiry. Duplicate nonces within the validity window are rejected, preventing captured requests from being replayed even within the 5-minute timestamp tolerance.

### 8.4 Message Verification and TOFU

Recipients verify the ML-DSA-65 signature before decryption, ensuring message authenticity and integrity. Invalid signatures are flagged in the UI.

**Trust-on-First-Use (TOFU).** The messenger implements a TOFU model for key verification:

1. When a user first communicates with a contact, the contact's public key fingerprint (SHA-256 hash) is recorded in local storage.
2. On subsequent interactions, the current key fingerprint is compared against the stored value.
3. If the key has changed, a visible "Key Changed" warning is displayed in the chat header, alerting the user to potential key compromise or re-registration.
4. The shortened fingerprint is displayed in the chat header for manual out-of-band verification.

### 8.5 Features

- **Self-destructing messages** with configurable timers.
- **Spoiler tags** for content that should be hidden until explicitly revealed.
- **Media support** for images and video (up to 10 MB), encrypted identically to text.
- **1-on-1 and group conversations.** Direct-message conversations have deterministic IDs (`dm_` followed by a SHA-256 over the two participants' canonical wallet IDs), so both sides always open the same thread and creating a conversation twice returns the existing one.
- **Group management.** Any participant can rename a group (up to 100 characters) or add members, up to 50 participants. New members can read messages sent after they join; earlier messages were never encrypted to them.
- **Recoverable delete.** Deleting a conversation or message hides it for the deleting participant only and moves it to a trash folder. It can be restored for 30 days or purged immediately; after 30 days the node removes it.
- **Avatars.** Messenger profiles can carry an avatar image (up to 256 KB).
- **Mail folders** — Inbox, Sent, Trash, Starred, Drafts.
- **Mail threading** — Reply chains via `replyToId`.
- **Name registry** — Human-readable `@rouge.quant` / `@qwalla.mail` addresses with atomic registration.
- **Attachments** — Encrypted file attachments up to 3 MB.

### 8.6 Privacy by Design

Messenger and mail data is stored off-chain in a sled embedded database. The nodes store encrypted message blobs but cannot decrypt them. Only the sender and recipient, possessing the correct ML-KEM-768 private keys, can read message contents.

### 8.7 Client-Side Key Protection

Private keys are stored in both `sessionStorage` and `localStorage` when no password vault is configured, ensuring PWA and mobile browser sessions survive app restarts. Once the user sets a vault passphrase, plaintext keys are removed from persistent storage and only the encrypted blob (AES-256-GCM with a PBKDF2-derived key, 600,000 iterations) remains in `localStorage`. On unlock, keys are restored to `sessionStorage` for the active session. When the vault is locked or auto-locked, all plaintext key material is cleared from both `sessionStorage` and `localStorage`.

### 8.8 Real-Time Delivery and Push Notifications

**Real-Time Events.** Clients can hold a WebSocket connection to the node and subscribe to their own inbox by sending an ML-DSA-65 signed `messenger_ws_subscribe` request. The node then pushes a `new_message` event -- conversation ID, message ID, timestamp, sender and participant IDs, but no message content -- to that caller's authenticated sockets only; an unauthenticated subscription cannot join another user's inbox topic. The client fetches and decrypts the message as usual.

**Push Notifications.** Mobile clients register an Expo push token with an ML-DSA-65 signed request. The node sends notifications for incoming transfers, messages, mail and group changes through Expo's push service. Because the node cannot read encrypted content, message and mail notifications carry a generic text (for example, "You received a new encrypted message"). Node operators can disable push delivery.

---

## 9. Social Layer

RougeChain includes a node-hosted social layer that provides social primitives — posts, likes, reposts, follows, comments, and play tracking — without requiring a separate protocol, token, or infrastructure deployment.

The social layer is **not on-chain**. Posts and engagement are signed with ML-DSA-65 and stored by the node in its `social-db` database; they are not included in blocks and are not covered by the state root. Only tips (Section 9.6) are on-chain transactions.

### 9.1 Design Rationale

Centralized social platforms control users' identity, content, and social graphs. Existing decentralized social protocols (Farcaster, Lens) address this but introduce separate infrastructure (hubs, L2 deployments) and distinct token economies. RougeChain embeds social features directly into the L1 node, following the same vertically integrated design philosophy applied to the DEX, messenger, and mail systems.

All social writes are authenticated via ML-DSA-65 signed requests using the same v2 signed API format as all other write operations on the chain. This means every post, like, follow, and repost is cryptographically attributable to the signer's public key and protected against replay attacks.

### 9.2 Data Model

Social data is stored in a dedicated sled embedded database (`social-db`) with the following trees:

| Tree | Key Format | Value | Purpose |
|---|---|---|---|
| `social_posts` | post_id (UUID) | JSON `SocialPost` | Post content and metadata |
| `social_user_posts_idx` | `pubkey:reverse_timestamp` | post_id | User post index (newest first) |
| `social_post_counts` | pubkey | u64 BE | Per-user post count |
| `social_global_timeline` | `reverse_timestamp:post_id` | post_id | Global timeline (newest first) |
| `social_play_counts` | track_id | u64 BE | Per-track play count |
| `social_likes` | `target_id:pubkey` | "1" | Like membership |
| `social_like_counts` | target_id | u64 BE | Per-target like count |
| `social_user_likes` | `pubkey:target_id` | "1" | Reverse index for user's likes |
| `social_comments` | comment_id (UUID) | JSON `SocialComment` | Comment content |
| `social_track_comments_idx` | `track_id:timestamp` | comment_id | Track comment index |
| `social_comment_counts` | track_id | u64 BE | Per-track comment count |
| `social_followers` | `artist:follower` | "1" | Follow membership |
| `social_follower_counts` | pubkey | u64 BE | Per-user follower count |
| `social_following` | `follower:artist` | "1" | Reverse follow index |
| `social_following_counts` | pubkey | u64 BE | Per-user following count |
| `social_reposts` | `post_id:pubkey` | "1" | Repost membership |
| `social_repost_counts` | post_id | u64 BE | Per-post repost count |
| `social_reply_counts` | post_id | u64 BE | Per-post reply count |
| `social_reply_idx` | `parent_id:timestamp` | child_post_id | Reply threading index |

Reverse timestamps (`u64::MAX - millis`) are used for index keys so that lexicographic sled iteration naturally yields newest-first ordering without explicit sorting.

### 9.3 Posts and Threading

Posts are standalone text entries (max 4000 characters) identified by UUID. A post optionally references a `reply_to_id`, forming a threaded reply tree. Replies increment the parent's reply count and are indexed for efficient retrieval.

```
SocialPost {
    id: String,          // UUID
    author_pubkey: String,  // ML-DSA-65 public key
    body: String,        // max 4000 chars
    reply_to_id: Option<String>,  // parent post for threading
    created_at: String,  // RFC 3339 timestamp
}
```

### 9.4 Timeline Feeds

Two timeline modes are supported:

- **Global timeline** — All posts ordered by creation time (newest first). Implemented as a sequential sled scan over the `social_global_timeline` tree.
- **Following feed** — Posts from users the viewer follows, merged and sorted newest-first. Implemented by scanning each followed user's post index and merging results client-side.

Both support pagination via `limit` and `offset` parameters.

### 9.5 Engagement Primitives

All engagement actions are toggle operations — calling the same endpoint twice reverses the action:

| Action | Endpoint | Effect |
|---|---|---|
| Like | `POST /api/v2/social/like` | Toggles like on any post or track |
| Repost | `POST /api/v2/social/repost` | Toggles repost on any post |
| Follow | `POST /api/v2/social/follow` | Toggles follow on any user |

Like counts, repost counts, and follower counts are maintained as atomic counters in dedicated sled trees.

### 9.6 Tips

Tips are not stored in the social layer — they settle directly on L1 as standard XRGE transfer transactions via `rc.transfer()`. This means tips have the same settlement, fee model, and quantum-resistant signing as any other on-chain transfer.

### 9.7 Security Properties

| Property | Mechanism |
|---|---|
| **Authenticated writes** | Every social write requires an ML-DSA-65 signed request |
| **Anti-replay** | Timestamp + nonce protection (same as all v2 endpoints) |
| **Provable authorship** | Posts are cryptographically linked to the signer's public key |
| **No impersonation** | Cannot post, like, or follow as another user without their private key |
| **Quantum-resistant** | All signatures use ML-DSA-65 (FIPS 204) |
| **Deletion authorization** | Only the original author can delete their posts or comments |

---

## 10. Developer Ecosystem

### 10.1 TypeScript SDK

The `@rougechain/sdk` package (version 1.12.0 on npm, 1 October 2026) provides a TypeScript SDK for building on RougeChain.

**Installation:**
```
npm install @rougechain/sdk
```

**Capabilities:**
- Wallet generation and management (ML-DSA-65 key pairs)
- Transaction construction and client-side signing
- Token, NFT, DEX, bridge, and staking operations
- Social layer (posts, timeline, reposts, likes, follows, comments) via `rc.social`
- Encrypted mail and messenger via `rc.mail` and `rc.messenger`, including real-time subscriptions, group management (`updateConversation`, `addParticipants`), and trash/restore/purge
- Balance and state queries, including a one-call validator status check (`getValidatorStatus`)
- Player-signed contract deployment, calls, read-only queries and events via `rc.contracts` (Section 10.5)

**Environment support:** Browser, Node.js, and React Native. The SDK uses `@noble/post-quantum` for all cryptographic operations, with no native dependencies.

### 10.2 Browser Extension

The RougeChain browser extension (Manifest V3, version 1.7 in the repository; the store listing may lag) provides:

- **Wallet management** with password-encrypted storage (PBKDF2 + AES-256-GCM).
- **Five integrated tabs:** Wallet, Tokens, NFTs, Chat (messenger), and Settings.
- **Encrypted backups:** wallet export produces a password-encrypted `.pqcbackup` file (PBKDF2 with 600,000 iterations + AES-256-GCM) that the web wallet and Qwalla can import.
- **Real-time messenger** notifications over the node's authenticated WebSocket (Section 8.8).
- **Contract signing:** dApps can ask the extension to sign contract deployments and calls, which it signs locally after user approval (Section 10.5).
- **Smart API caching** with TTL-based deduplication to minimize network overhead.

**dApp Provider.** The extension injects `window.rougechain` into web pages, enabling dApps to interact with the user's wallet:

```javascript
const { publicKey } = await window.rougechain.connect();
const { balance } = await window.rougechain.getBalance();
const { txId } = await window.rougechain.sendTransaction(payload);
```

Connected sites are tracked and require explicit user approval via a popup window. All transactions submitted through the provider are signed client-side using `ml_dsa65.sign()` before being sent to the node.

**Provider Authenticity.** The injected provider object carries a `Symbol.for("rougechain:authentic")` token that dApps can check to verify they are communicating with the genuine extension, not a malicious imitation. The provider is defined with `Object.defineProperty` (non-writable, non-configurable) and unconditionally overwrites any pre-existing definitions to prevent injection attacks.

### 10.3 REST API

Every node exposes a comprehensive HTTP API supporting all chain operations:

| Category | Endpoints |
|---|---|
| Chain | `/api/stats`, `/api/blocks`, `/api/blocks/:height` |
| Wallet | `/api/balance/:pubkey`, `/api/faucet` |
| Transactions | `/api/tx/submit`, `/api/v2/tx/submit`, `/api/tx/broadcast` |
| Tokens | `/api/tokens`, `/api/token/create`, `/api/token/metadata` |
| DEX | `/api/pools`, `/api/swap`, `/api/pool/create`, `/api/pool/:id/earnings/:owner` |
| NFTs | `/api/nft/collections`, `/api/nft/owner/:pubkey`, `/api/v2/nft/*` |
| Bridge | `/api/bridge/withdraw`, `/api/bridge/activity` (`/api/bridge/claim` exists but is closed at the public endpoint; deposits are claimed automatically) |
| Contracts | `/api/v2/contract/publish`, `/api/v2/contract/execute`, `/api/contract/:addr/query`, `/api/contract/:addr/events` |
| Rollup (research, not consensus) | `/api/v2/rollup/status`, `/api/v2/rollup/submit`, `/api/v2/rollup/batch/:id` -- in-memory prototype; batches move no funds |
| Shielded (suspended) | `/api/v2/shielded/*` refuse with `this transaction type is suspended` |
| Messenger | `/api/v2/messenger/wallets/register`, `/api/v2/messenger/conversations`, `/api/v2/messenger/messages` |
| Names | `/api/v2/names/register`, `/api/v2/names/release`, `/api/names/resolve/:name`, `/api/names/reverse/:walletId` |
| Mail | `/api/v2/mail/send`, `/api/v2/mail/folder`, `/api/v2/mail/message`, `/api/v2/mail/read`, `/api/v2/mail/move`, `/api/v2/mail/delete` |
| Social | `/api/social/timeline`, `/api/social/post/:id`, `/api/social/user/:pubkey/posts`, `/api/v2/social/post`, `/api/v2/social/like`, `/api/v2/social/repost`, `/api/v2/social/follow`, `/api/v2/social/feed` |
| P2P | `/api/peers`, `/api/peers/register`, `/api/blocks/import` |

**Mainnet availability.** On the public mainnet endpoint (`api.rougechain.io`), the unauthenticated write routes `POST /api/tx/broadcast`, `POST /api/blocks/import`, `POST /api/peers/register`, `/api/v2/contract/deploy` and `/api/v2/contract/call` are not publicly open. Transactions are submitted through the signed `/api/v2/*` routes.

### 10.4 gRPC

A gRPC interface is available for high-performance node-to-node communication and advanced integrations, supporting the same operations as the REST API with protocol buffer serialization.

### 10.5 WASM Smart Contracts

RougeChain includes a fuel-metered WebAssembly (WASM) smart contract runtime built on the `wasmi` pure-Rust interpreter (used by Parity/Substrate).

**Execution Model:**

| Parameter | Value |
|---|---|
| Runtime | wasmi (pure Rust, no JIT) |
| Fuel limit (per call) | 10,000,000 instructions |
| Fuel limit (per block) | 100,000,000 instructions |
| Max WASM module size | 1 MB |
| Max call depth | 8 (cross-contract) |

**Contract Lifecycle:**
1. **Deploy** — Compile and validate WASM bytecode, compute contract address as `SHA-256(deployer ‖ nonce)[0..20]`, store metadata and bytecode in `contracts-db`.
2. **Execute** — Call a contract method with fuel metering. State changes are committed atomically on success; rolled back entirely on failure.
3. **Query** — Read-only contract calls that do not commit state changes.

**Player-Signed Transactions (GAME_READY, height 150).** A contract deployment or call is valid only if the deployer or caller signed it; the signer is the caller the contract sees (`host_get_caller`) and pays the fee. Node-signed contract transactions -- whose "caller" was an unsigned field -- are invalid from height 150. A deployment costs a flat **10 XRGE**, and a call costs its signed gas limit × **0.000001 XRGE**, paid up front. The contract address is the first 20 bytes of `SHA-256("rougechain/contract/v2" ‖ from ‖ 0 ‖ nonce ‖ 0 ‖ SHA-256(wasm))`, all of which is inside the deployer's signature, so nobody else can claim or pre-empt it. (The address rule in the lifecycle above applies to earlier, node-signed deployments.)

**Host API.** Contracts interact with chain state through imported host functions:

- **Core:** `host_log`, `host_get_caller`, `host_get_self_addr`, `host_get_block_height`, `host_get_block_time`, `host_get_balance`, `host_transfer` (XRGE), `host_storage_read`, `host_storage_write`, `host_storage_delete`, `host_emit_event`, `host_set_return`, `host_call_contract`, `host_get_call_result`, and the ML-DSA-65 helpers `host_pqc_verify`, `host_pqc_pubkey_to_address` and `host_pqc_hash_pubkey`.
- **Call arguments (GAME_READY, height 150):** `host_get_args_len` and `host_read_args` return the call's JSON arguments.
- **Assets and randomness (GAME_READY 2, height 160):** `host_token_balance` and `host_token_transfer` (custom tokens the contract holds), `host_nft_owner` and `host_nft_transfer` (NFTs the contract owns), `host_nft_create_collection` (a collection `col:<contract address prefix>:<SYMBOL>` owned by the contract) and `host_nft_mint` (the contract mints from its own collections to players), and `host_random`. Before height 160 these functions are not linked, so a module importing them fails to run.

From height 160, addresses a contract passes to these functions are canonicalised -- paying `host_get_caller()`, a public key, credits the player's `rouge1` ledger entry -- and NFT owner checks compare canonical addresses. The VM reads token balances and NFTs from a snapshot, records each accepted operation, and the node applies the operations in order only when the call succeeds; invalid operations make the block invalid.

**Randomness.** `host_random` returns 32 bytes derived from `SHA-256("rougechain/rand/v1" ‖ parent block hash ‖ tx hash)` and a per-call counter. The sender knows the parent hash before sending and controls the transaction's bytes, so a one-step roll can be ground: the sender signs many variants offline, computes each result with the public VM, and sends only a winner. `host_random` must therefore never decide anything of value on its own. From height 170, `host_block_hash(height)` returns the hash of a finished block up to 256 back; games commit in one call (recording height *H*) and settle in a later call from the hash of block *H*+1 mixed with the player and *H*. That hash covers the producer's ML-DSA-65 signature and the validators' finality signatures, which the player cannot predict or choose. The single block producer could still bias an outcome by withholding a block; validator-generated (VRF) randomness is planned (Section 12). The `loot_roll` example uses this commit-then-settle pattern.

**Payable Calls.** From height 190 a player can attach a payment to a contract call: `attach: {symbol, amount}` inside the signed payload, with the amount as an integer (quanta for XRGE, raw units for tokens) so it survives JSON relay between nodes exactly. The node checks the caller can cover the gas fee plus the payment, shows the payment to the contract as already credited, and moves it for real only if the call succeeds -- so a contract refuses a payment simply by failing the call, and the player keeps it. `host_get_attached_amount()` and `host_get_attached_symbol()` expose it to the contract; cross-contract sub-calls see no attachment. The endpoints preview a paid call before it is signed, and SDK 1.10, extension 1.5 and MCP server 1.3 support it. The `loot_roll` example charges 0.5 XRGE per roll this way, so its prize treasury cannot be drained by free rolls.

**Cross-Contract Calls.** Contracts can invoke other contracts up to 8 levels deep. Before height 160, when a call made cross-contract calls, none of its XRGE moves were applied (only single-hop calls moved XRGE); earlier versions of this paper wrongly said sub-call balance changes were propagated. From height 160, cross-contract calls are multi-hop: each sub-call sees every move made before it (by its caller and by earlier sub-calls), the XRGE, token and NFT moves of successful sub-calls are merged into the top-level result and applied with it, and a failed sub-call's moves are dropped. Each sub-call draws its own randomness.

**Receipts, Events and Queries.** A contract-call receipt reports `Failed` with the error when the call reverted; a failed call moves no assets. Contract events are delivered live over the node's WebSocket on the topic `contract:<addr>` after a block is accepted, and can be paged with `GET /api/contract/:addr/events`. `POST /api/contract/:addr/query` runs a read-only dry run against the live ledger without a signature or a transaction.

**Development Workflow:** Contracts are written in Rust, compiled to WASM via `wasm32-unknown-unknown`, and deployed with a signed transaction. The SDK's `rc.contracts` (since SDK 1.9) and the browser extension (since 1.4) sign deployments and calls. The repository's `loot_roll` example contract pays prizes from its own treasury using token transfers, NFT minting and `host_random`.

**Mainnet Status.** Contracts can hold and move XRGE since height 18, and custom tokens and NFTs since height 160. Signed deployments and calls are submitted through `/api/v2/contract/publish` and `/api/v2/contract/execute`. The older unsigned `/api/v2/contract/deploy` and `/api/v2/contract/call` routes remain closed on the public mainnet endpoint. Storage is loaded eagerly and there is no storage fee yet.

### 10.6 MCP Server

`@rougechain/mcp-server` (version 1.4.0 on npm) exposes RougeChain to AI agents over the Model Context Protocol. By default it is read-only (32 tools), including free contract queries (`POST /api/contract/:addr/query`), contract events and transaction receipts. When a wallet is supplied through environment variables, it also registers 31 write tools -- transfers, staking, tokens, DEX, NFTs, names, social, bridge withdrawals, and player-signed contract deployment and calls (`/api/v2/contract/publish` and `/execute`, Section 10.5) -- and signs each one locally with ML-DSA-65; the key never leaves the process. Governance voting (suspended on-chain in any case) and messenger/mail sending are not exposed.

### 10.7 Command-Line Interface

The `rougechain` CLI signs transactions locally with ML-DSA-65 and supports key generation, transfers, staking and messenger operations. For validator operators it can sign directly with a node's `node-keys.json` (`--node-keys`) and provides `rougechain validator-status`, a one-shot check that a key is funded, staked, in the active set and producing blocks.

### 10.8 Applications

- **rougechain.io** -- web wallet, explorer, DEX, bridges, messenger and mail, a swap for buying XRGE on Base, and a network status page. The interface is available in English, Spanish, Chinese and Japanese.
- **Qwalla** -- a wallet suite built from one Expo/React Native codebase: the **iOS app** (App Store), the **web app** at qwalla.io, **desktop apps** for macOS and Windows, and **Qwalla Browser**, a standalone desktop browser for on-chain apps. All share the same tokens, messenger, mail and dApp access; the iOS app adds push notifications.
- **rougee.app (qRougee)** -- a decentralized music dApp that connects to the browser extension through the `window.rougechain` provider.
- **rougecoin.io** -- information site for XRGE, linked from rougechain.io.

---

## 11. Security Considerations

### 11.1 Cryptographic Security

RougeChain targets NIST Level 3 security for signatures and encryption (~192-bit classical, ~128-bit quantum), which remains well beyond practical attack feasibility. The lattice-based problems underlying ML-DSA-65 and ML-KEM-768 have been studied extensively and are considered resistant to all known quantum and classical attacks. The STARK circuits in the code have ~100-bit conjectured soundness but no zero-knowledge mode (Section 2.4); the V2 shielded pool's proof system is in development and unaudited. Blake3, used for STARK commitments, is not itself NIST-standardized but provides equivalent collision resistance; a STARK's security reduces to hash collision resistance, which is unaffected by Shor's algorithm.

### 11.2 Client-Side Key Management

Private keys are generated and stored exclusively on the user's device. The browser extension encrypts keys at rest using PBKDF2 (600,000 iterations) with AES-256-GCM. Transaction signing occurs locally; only the signed transaction is transmitted to the network.

Legacy API endpoints that previously accepted raw private keys for server-side signing are disabled in production and return HTTP 410 (Gone). They are accessible only in local development mode via the `--dev` flag.

### 11.3 Validator Accountability

The 10,000 XRGE minimum stake is enforced by the API, not by consensus (Section 3.1); the slash count and jail status of each validator are recorded in validator state. The slashing parameters in the code -- 10% of stake and a 20-block jail -- are not applied by anything today: automatic slashing for missed blocks ran until height 100 and is frozen under Release 1 proposer selection, and from height 245 the legacy `slash` transaction type is rejected outright. Slashing for provable misbehavior, such as equivocation, is part of the planned consensus redesign (Section 12.2) and is not active; until then, the proposal journal prevents an honest producer from equivocating, but a dishonest one is not penalized automatically. Mainnet has three staked validators, of which one holds more than 99.9% of the stake and produces every block.

### 11.4 Network Resilience

- **Mempool limits** (2,000 transactions) prevent memory exhaustion.
- **Three-tier rate limiting** with cryptographic validator authentication is available to node operators (off by default).
- **Block pagination** caps API responses to prevent unbounded data dumps.
- **Exponential backoff** on peer sync failures prevents cascade overloads.
- **Adaptive polling** reduces unnecessary network traffic during quiet periods.
- **Transaction-identity uniqueness** (from height 90) prevents a signed transaction from being included twice, at mempool admission, block production and block import.

### 11.5 Block Import Verification

When importing blocks from peers, the node performs the following verification:

1. **Height continuity** -- The block must extend the current tip by exactly one.
2. **Hash chain** -- The block's `prev_hash` must match the current tip hash.
3. **Proposer signature** -- The `proposer_sig` is verified against `proposer_pub_key` using `pqc_verify`, and the block hash is recomputed to ensure integrity.
4. **Proposer eligibility** -- Before height 100, the proposer had to be an actively staked validator. From height 100, the proposer must be the designated proposer for that height (Section 3.1); any other block is rejected before state is touched.
5. **Transaction signatures** -- All transactions are verified in parallel (using Rayon) across three signature formats (V2 signed payload, V1 new format, V1 legacy format). If any transaction fails all three verification methods, the entire block is rejected. From height 90, V2 transactions must also match their signed payload.
6. **Transaction uniqueness** -- From height 90, a block containing a transaction that is already included in an earlier block is rejected.
7. **State root** -- From height 18, the node executes the block and rejects it if the resulting ledger state root does not match the header. From height 160 the root is state root v2, which also covers NFT collections and ownership, contract code and contract storage.
8. **Pinned history** -- Blocks 18-48 must match the hashes pinned by the F49 upgrade.
9. **Parent commit certificate** -- From height 151, the block must carry `parent_commit`, a FINALITY_V2 proof for exactly its parent; the node verifies every precommit signature and recomputes the quorum from the parent's validator set, and rejects the block without storing anything if the certificate is missing, mismatched or insufficient. A verified certificate is persisted, finalizing the parent.
10. **Contract signatures** -- From height 150, `contract_deploy` and `contract_call` must be signed by the deployer or caller; node-signed contract transactions are rejected.

### 11.6 Bridge Security

- **Two-layer deposit verification:** EVM receipt validation (tx status, recipient, sender, confirmations) combined with SHA-256 commitment nullifiers to prevent double-claiming.
- **Deposit event verification** for contract deposits via transaction log parsing.
- **ECDSA signature verification** (ecrecover) authenticates that the claimant is the original depositor on manual claims; the manual claim route is closed at the public endpoint, and deposits are claimed automatically from the contract's deposit events.
- **Chain ID validation** ensures claims target the correct network (Base Mainnet 8453 or Sepolia 84532).
- **Confirmation requirements** prevent claims against unconfirmed transactions (default: 6 confirmations on Base, 2 on Bitcoin).
- **Replay protection** via persistent commitment nullifier tracking ensures each deposit can only be claimed once.
- **Signed withdrawal intent:** the node executes only the ML-DSA-65 signed amount, fee, asset and destination; the fee must be exactly 0.1 XRGE.
- **Burn-gated payouts:** a payout record exists only if the burn succeeded in an accepted block; the node verifies the payout on the destination chain before marking it fulfilled; automatic refunds are disabled.
- **On-chain limits:** XRGE releases from BridgeVaultV2 are bounded by per-transaction and 24-hour caps set by a Safe multisig owner.
- **Hardened relayer** with payout-state checks, explicit asset routing, nonce management, exponential retry, gas estimation, preflight checks and graceful shutdown.
- **Relayer authentication** via shared secret restricts withdrawal fulfillment to authorized operators.

These measures do not remove operator trust. `bridge_mint` is authorized by the operator's key, the relayers are operator-run, RougeBridge (ETH and USDC) is owned by a single hot key, and none of it has been externally audited; see Section 6.7. The post-quantum BridgeVaultV3 (2-of-3 ML-DSA-65 authority) is built and rehearsed but not deployed.

### 11.7 Messenger and Mail Security

Messages and mail are encrypted end-to-end using post-quantum key encapsulation. The server stores only ciphertext and cannot decrypt message contents. The following security measures protect the communication layer:

- **Signed API requests.** All 16 mail/messenger/name registry endpoints require ML-DSA-65 signed requests with timestamp validation and nonce-based anti-replay protection.
- **Authorization checks.** The server verifies that the signing key belongs to a registered wallet and that the caller is authorized for the requested operation (e.g., sender owns the mailbox, caller is a conversation participant).
- **Directory ownership (release 1.6.3).** A wallet's directory entry can be replaced only by the signing key that owns it; an encryption key already registered to another wallet is refused; mail names and folders follow the owning wallet. The unauthenticated legacy read routes return 410 (Section 8.2).
- **Unified mail signatures.** Mail messages are signed over the concatenation of all encrypted parts (subject, body, and attachment), preventing partial content substitution.
- **Multi-recipient CEK pattern.** Mail content is encrypted once with a random CEK, which is then KEM-wrapped individually for each recipient, ensuring efficient multi-recipient delivery without re-encrypting the content.
- **TOFU key verification.** Public key fingerprints (SHA-256) are recorded on first use and compared on subsequent interactions, with visible warnings when a contact's key changes.
- **Atomic name registration.** The name registry uses sled's compare-and-swap operation to prevent race conditions during name claims.
- **Input validation.** Server-side length limits are enforced on all fields (display names: 50 chars, message content: 2 MB, mail subject: 10 KB, mail body: 512 KB, attachment: 3 MB, max 50 recipients).
- **Sled-backed storage.** Messenger data is stored in a sled embedded database with per-record atomic operations, replacing the previous JSON file storage which was susceptible to race conditions under concurrent access.

### 11.8 dApp Provider Security

The browser extension's injected provider (`window.rougechain`) defends against page-level tampering:
- **Unconditional injection** overwrites any malicious pre-definitions.
- **Non-writable, non-configurable** property descriptor prevents post-injection modification.
- **Authenticity token** (`Symbol.for("rougechain:authentic")`) allows dApps to verify they are communicating with the genuine extension.
- **Approval popups** require explicit user consent for connect, sign, and send operations.

### 11.9 STARK Proof Security

Earlier versions of this section claimed zero-knowledge for the STARK circuits in the code. That claim is withdrawn (Section 2.4). What the circuits provide, and what the V2 pool is designed to add:

- **Soundness.** A malicious prover cannot construct a valid proof for an invalid statement that the circuit actually checks. The FRI protocol ensures that forging a proof requires finding collisions in the commitment hash, which is computationally infeasible. The V1 shielded circuit checked value conservation only; it did not check that a spent note existed, which is one reason V1 is suspended.
- **Zero-knowledge.** The `winterfell` 0.13 circuits have **no hiding mode**: the verifier can learn the witness. The V2 pool uses a prover with a zero-knowledge mode so that a proof reveals nothing beyond the public commitments, nullifiers and amounts entering or leaving the pool. That hiding mode has not been audited.
- **Transparency.** STARKs require no trusted setup ceremony. There is no "toxic waste" -- the system's security does not depend on any party honestly destroying secret parameters.
- **Post-quantum safety.** A STARK's security reduces to the collision resistance of its hash function, which is unaffected by Shor's algorithm and only quadratically weakened by Grover's algorithm.

### 11.10 Current Limitations

RougeChain is an early-stage network. As of 6 October 2026:

- **One producing validator.** Three validators are staked (about 100.09 million, 10,000 and 9,000 XRGE), but only the operator's validator (the largest stake) produces blocks, and under Release 1 it is the designated proposer at every height; the operator's second node follows the chain without producing blocks. If the producer is offline, the chain stops until it returns.
- **Finality without liveness.** FINALITY_V2 has been active since height 150, but the operator's validator holds more than 99.9% of the stake and finalizes each block with its own vote. Release 2b was not implemented and has been superseded by a consensus redesign (Section 12.2) that is decided but not built.
- **No active slashing.** Missed-block slashing is frozen; the legacy `slash` type is rejected from height 245; evidence-based slashing does not exist yet. The 10,000 XRGE minimum stake is an API rule, not a consensus rule.
- **Suspended features.** Shielded transfers, token locking, token staking pools, on-chain governance and voting, and vote delegation are suspended from height 245 and are being rebuilt (Sections 3.1.1, 3.9). The shielded pool V2 is in development and unaudited.
- **Contract randomness.** One-step `host_random` rolls can be ground by the sender; games must commit and settle with `host_block_hash` (height 170). The single producer can still bias a settlement by withholding a block; validator VRF randomness is planned, not built (Section 10.5).
- **Operator authority.** The operator's key authorizes bridge mints, the bridge relayers are operator-run, protocol upgrades are coordinated binary releases without on-chain governance, and most of the XRGE supply is held in operator-controlled protocol accounts.
- **Bridges are operator-trusted and unaudited.** RougeBridge (ETH and USDC) is owned by a single hot key. Bitcoin deposits are live; Bitcoin withdrawals are switched off in the site (Section 6.8).
- **Post-quantum bridge not deployed.** BridgeVaultV3 is an audit candidate only; its FINALITY_V2 prerequisite is active, but it awaits an external audit.
- **No external audit.** Security reviews to date have been internal.
- **Networking.** Nodes communicate by HTTP polling; peer-write routes are closed on the public endpoint, and a peer-to-peer transport is not yet implemented.
- **Fee income is small.** The minimum-tip reserve is empty, so validator income is exactly the fees collected (about 541 XRGE over the whole chain to date), which tracks network activity.

---

## 12. Roadmap

### 12.1 Shipped

| Feature | Notes |
|---|---|
| STARK balance transfer circuit (`winterfell`) | Integrity proof only, no zero-knowledge mode; not used by any live feature |
| Shielded pool V1 (notes, nullifiers, value-conservation proof) | **Suspended at height 245**; proved value balance only and did not bind a spend to a note; replaced by V2 (In Progress) |
| Rollup batch circuit and accumulator | Research prototype; not connected to consensus |
| WASM smart contract runtime (wasmi, fuel-metered) | |
| WASM-compiled STARK prover for browser | Built; unused |
| On-chain governance with delegation and treasury | **Suspended at height 245**; never used on mainnet; interim node-hosted Regenerate votes |
| Multi-signature wallets (M-of-N) | |
| Unbonding period and slashing machinery | Missed-block auto-slashing frozen from height 100; `slash` type rejected from 245; no slashing active |
| JSON-RPC 2.0 (eth_*/rouge_* dual namespace) | |
| WebSocket real-time event subscriptions | Including authenticated private messenger events |
| Genesis configuration and mainnet bootstrapping | `rougechain-mainnet-1` |
| Event indexer (sled-backed, multi-index) | |
| CLI wallet (ML-DSA-65 signed transactions) | Including `validator-status` |
| Prometheus metrics and Docker containerization | |
| Mail/Messenger/Names security hardening (signed requests, anti-replay, CEK, TOFU, sled) | |
| Social layer (posts, timeline, reposts, likes, follows, comments, tips) | Node-hosted |
| Native limit orders | |
| v2 integer ledger and state root | Height 18 |
| F49 ledger and bridge-withdrawal hardening | Height 49 |
| Transaction integrity (identity uniqueness + signed-payload binding) | Height 90 |
| Proposer selection, Release 1 | Height 100 |
| FINALITY_V2 verified finality (Release 2a: parent commit certificates) | Height 150 |
| GAME_READY: player-signed contract deployment and calls | Height 150 |
| GAME_READY 2: contracts hold/move tokens and NFTs, mint NFTs, `host_random`, multi-hop cross-contract moves, state root v2 | Height 160 |
| GAME_READY 3: `host_block_hash` for commit-then-settle randomness | Height 170 |
| Payable contract calls (`attach`, pay only on success) | Height 190 |
| Mintable custom tokens (creator-only, optional cap) and contract royalty reads | Height 235 (node 1.6.0); testnet 1360 |
| MONETARY_INTEGRITY (fee range, no `slash`, no faucet on mainnet, suspended types) | Height 245 (node 1.6.2); testnet 1390 |
| Messenger directory hardening, legacy read routes retired | Node 1.6.3 (not consensus) |
| Signed releases with a signed manifest, one-line installer, automatic updates | Node 1.6.1 |
| Contract events over WebSocket, contract query endpoint, `loot_roll` and `nft_marketplace` examples | |
| LP fee collection ("Collect fees") | Node-side fee ledger; no protocol fee |
| Base bridge with BridgeVaultV2 (Safe owner, capped relayer) for XRGE | ETH/USDC still on RougeBridge (hot-key owner); ETH/USDC contract deposits with auto-claim reopened 5 October 2026 |
| BTC ⇄ qBTC bridge | Live 15 September 2026; deposits live, withdrawals switched off in the site |
| Messenger groups, avatars, deterministic DMs, recoverable delete | |
| Push notifications | |
| TypeScript SDK 1.12 (`rc.contracts`, payable calls, mintable tokens), browser extension 1.7, MCP server 1.4 | |

### 12.2 In Progress

| Feature | Status |
|---|---|
| **Consensus redesign** (decided 6 October 2026) | **Planned, not implemented.** Tendermint-style rounds with ML-DSA-65 prevotes and precommits; rotating stake-weighted proposers in place of the fixed largest-stake proposer; an active set capped at **32** validators; a **consensus-enforced minimum stake of 100,000 XRGE** with a 30-day grace period for existing validators; **21-day unbonding**; evidence-based slashing (double-signing: 100% of stake; downtime: jail only); hourly heartbeat blocks so the chain advances without transactions; a per-time reserve subsidy for validators; temporary approval of validator admission with a written exit condition; validator key separation and delegation later. Gated on a consensus simulator and an independent review, and delivered as staged forks A–E whose heights will be announced in advance. It supersedes Release 2b and Release 3. |
| **Shielded pool V2** | Specified and in development: Plonky3-based STARK with a hiding mode (~190 KB proofs, ~6 ms verify, ~3 s prove on a phone), each spend bound to a specific note, launching under a 1,000,000 XRGE pool cap before the external audit. Unaudited; product text must not claim audited privacy. |
| Restoring the other suspended types (token lock, token staking pools, on-chain governance and delegation) | Being rebuilt with state checks in consensus; no height |
| BridgeVaultV3 post-quantum bridge (2-of-3 ML-DSA-65 authorization on Base) | Audit candidate frozen and rehearsed end to end on a test network; genesis authority set assembled; external audit next; not deployed |
| External security audit | Not yet started |
| Decentralization: independent validators and a peer-to-peer transport | Three staked validators, one producing; outside validators are asked to run the current signed release |
| RougeBridge ownership moved to a multisig | Pending |
| Bitcoin withdrawals reopening | Relayer stopped since the F49 upgrade; payout-path hardening awaits deployment |

### 12.3 Planned

| Feature |
|---|
| Consensus redesign forks A–E (above), heights to be announced |
| Validator VRF randomness for contracts (after the consensus redesign) |
| Contract storage fees and lazy storage loading; incremental (Merkle) state root |
| Block-header commitments (prerequisite for any light-client or trustless bridge) |
| On-chain protocol upgrade governance |
| Concentrated liquidity (range-based positions) |
| Yield farming (LP staking rewards) |
| On-chain NFT marketplace |
| Fully trustless STARK bridge (Base light client) |
| SLH-DSA (SPHINCS+) as alternative signature scheme |
| Hybrid classical + PQC mode |
| Hardware wallet support |
| Threshold signatures for multi-sig |

v2.0 removed two items that v1.8 had marked complete: **BFT finality** (the legacy implementation did not verify votes) and **STARK bridge deposit verification** (Base deposits are verified through RPC receipts, not STARK proofs). Verified finality returned to the Shipped list with FINALITY_V2 at height 150; STARK bridge verification remains a planned item. v2.4 reclassified **shielded transactions** and **on-chain governance** from working features to suspended ones, and the **STARK circuits** from zero-knowledge proofs to integrity proofs, after the review that led to the height-245 upgrade.

---

## References

1. NIST. *FIPS 204: Module-Lattice-Based Digital Signature Standard (ML-DSA).* August 2024.
2. NIST. *FIPS 203: Module-Lattice-Based Key-Encapsulation Mechanism Standard (ML-KEM).* August 2024.
3. Shor, P.W. *Polynomial-Time Algorithms for Prime Factorization and Discrete Logarithms on a Quantum Computer.* SIAM Journal on Computing, 1997.
4. Grover, L.K. *A Fast Quantum Mechanical Algorithm for Database Search.* Proceedings of the 28th Annual ACM Symposium on Theory of Computing, 1996.
5. Adams, J., et al. *Uniswap V2 Core.* Uniswap, 2020.
6. Ben-Sasson, E., et al. *Scalable, transparent, and post-quantum secure computational integrity.* IACR Cryptology ePrint Archive, 2018.
7. Facebook/Meta. *winterfell: A STARK prover and verifier library.* GitHub, 2024. https://github.com/facebook/winterfell
8. Ben-Sasson, E., et al. *Fast Reed-Solomon Interactive Oracle Proofs of Proximity (FRI).* ICALP 2018.

---

*RougeChain is open-source software. The complete codebase, including the Rust core daemon, TypeScript SDK, browser extension, and web frontend, is publicly available.*
