# Post-Quantum Cryptography

RougeChain uses NIST-approved post-quantum cryptographic algorithms to protect against both classical and quantum computer attacks.

## Why Post-Quantum?

Quantum computers threaten current cryptography:

| Algorithm | Quantum Threat |
|-----------|----------------|
| RSA | Broken by Shor's algorithm |
| ECDSA | Broken by Shor's algorithm |
| SHA-256 | Weakened (Grover's algorithm) |
| **ML-DSA** | **Secure** |
| **ML-KEM** | **Secure** |

## Algorithms Used

### ML-DSA-65 (Digital Signatures)

**Formerly:** CRYSTALS-Dilithium  
**Standard:** FIPS 204  
**Security Level:** NIST Level 3 (192-bit classical equivalent)

Used for:
- Transaction signatures
- Block proposal signatures
- Validator attestations

Key sizes:
| Component | Size |
|-----------|------|
| Public key | ~1,952 bytes |
| Private key | ~4,032 bytes |
| Signature | ~3,309 bytes |

### ML-KEM-768 (Key Encapsulation)

**Formerly:** CRYSTALS-Kyber  
**Standard:** FIPS 203  
**Security Level:** NIST Level 3

Used for:
- Messenger encryption
- PQC Mail encryption
- Future: Encrypted transactions

Key sizes:
| Component | Size |
|-----------|------|
| Public key | ~1,184 bytes |
| Private key | ~2,400 bytes |
| Ciphertext | ~1,088 bytes |

### SHA-256 (Hashing)

Used for:
- Block hashes
- Transaction hashes
- Merkle trees

While Grover's algorithm reduces SHA-256 security to ~128-bit equivalent against quantum computers, this is still considered secure.

## Implementation

RougeChain uses the following libraries:

| Component | Library |
|-----------|---------|
| Backend (Rust) | `fips204` crate (`ml_dsa_65`) |
| Frontend (JS) | `@noble/post-quantum` |

All cryptographic operations happen locally - private keys never leave your device.

## Key Generation

```rust
// Rust example — fips204 ml_dsa_65 (FIPS 204)
use fips204::ml_dsa_65;
use fips204::traits::{Signer, Verifier};

// Generate an ML-DSA-65 keypair
let (pk, sk) = ml_dsa_65::try_keygen().unwrap();

// Sign a message (second arg is an optional context string)
let signature = sk.try_sign(message, &[]).unwrap();

// Verify
let valid = pk.verify(message, &signature, &[]);
```

```typescript
// TypeScript example
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa';

const { publicKey, secretKey } = ml_dsa65.keygen();
const signature = ml_dsa65.sign(message, secretKey);
const valid = ml_dsa65.verify(signature, message, publicKey);
```

## Security Considerations

1. **Key storage** - Private keys are persisted only encrypted with AES-256-GCM (PBKDF2, 600K iterations) under a required vault password (min 8 characters); they are never written to `localStorage` in plaintext. Active session keys (and a new wallet before its password is set) are held in `sessionStorage`. Wallets that older versions stored in plaintext must be secured with a password before further use, which deletes the plaintext copy.
2. **Entropy** - Keys use cryptographically secure random number generators
3. **Side channels** - Library implementations are designed to be constant-time
4. **Hybrid approach** - Consider adding classical signatures for defense-in-depth

## STARKs (hash-based proofs)

RougeChain's crypto crate includes a STARK proof module. STARKs are **quantum-resistant by design** —
they rely only on hash functions, not elliptic curves.

> **Status (2026-10-06).** The circuits below are built on `winterfell` 0.13, which has **no
> zero-knowledge mode**: a proof shows the computation was done correctly but does not hide its
> inputs. They are integrity proofs, not privacy proofs, and **no live feature uses them**: the V1
> shielded pool that did is suspended since block 245 (its proof established value balance only and
> did not bind a withdrawal to a specific note; the mainnet pool was empty), and the rollup below is
> a prototype that is not connected to consensus. A redesigned shielded pool (V2) is specified and in
> development on a Plonky3-based STARK with a hiding mode (proofs about 190 KB, verify about 6 ms,
> prove about 3 s on a phone), to launch under a 1,000,000 XRGE pool cap before the external audit.
> It is **not audited**; nothing may claim audited privacy until it is.

### How It Works

The STARK module proves that a balance transfer is consistent (value is conserved, sender has
sufficient funds). The public inputs are the final balances; because the prover has no hiding mode,
the other values are not kept private by the proof.

| Property | Value |
|----------|-------|
| Library | [winterfell](https://github.com/facebook/winterfell) 0.13 (Meta) — no zero-knowledge mode |
| Hash function | Blake3-256 |
| Quantum resistance | ✅ Hash-based (no EC) |
| Proof type | Balance transfer (value conservation) — integrity only |

### Usage

```rust
use quantum_vault_crypto::stark::{
    prove_balance_transfer, verify_balance_transfer, BalanceTransferInputs,
};
use winterfell::math::{fields::f128::BaseElement, FieldElement};

// Prover (knows private balances)
let proof = prove_balance_transfer(1000, 500, 250).unwrap();

// Verifier (only sees final balances)
let public_inputs = BalanceTransferInputs {
    total_value: BaseElement::from(1500u64),
    final_sender_balance: BaseElement::from(750u64),
    final_receiver_balance: BaseElement::from(750u64),
};
verify_balance_transfer(proof, public_inputs).unwrap();
```

## STARK Rollup Batch Proofs (Phase 3) — research prototype

The rollup accumulator batches multiple transfers into a single STARK proof. It is **not connected to
consensus**: a batch submitted through the API moves no funds and enters no block. It is kept as
research code.

### Rollup AIR (5-Column Trace)

```
sender_before | sender_after | receiver_after | amount | running_hash
```

**Constraints:**
1. Value conservation: `sender_after = sender_before - amount`
2. Running hash accumulation: `hash[i+1] = hash[i] + sender_before[i] * amount[i]`
3. Cross-check redundancy

**Boundary Assertions:** `running_hash` transitions from `pre_state_root` to `post_state_root`

### State Root

SHA-256 Merkle tree from sorted account balances with domain separation:
- Leaf: `SHA-256("ROUGECHAIN_STATE_V1" || address || balance_le_bytes)`
- Node: `SHA-256("ROUGECHAIN_NODE_V1" || left || right)`

### Rollup API

```bash
# Check rollup status
curl https://testnet.rougechain.io/api/v2/rollup/status

# Submit transfer to rollup batch
curl -X POST https://testnet.rougechain.io/api/v2/rollup/submit \
  -H "Content-Type: application/json" \
  -d '{"sender":"pubkey1","receiver":"pubkey2","amount":100,"fee":1}'

# Get completed batch result
curl https://testnet.rougechain.io/api/v2/rollup/batch/1
```

## Bridge Deposit Verification (not STARK-based)

> This section covers **deposit verification** on the RougeChain side. Releases on Base are still
> authorized with classical keys in production. The ML-DSA-65 on-chain authorization for XRGE (V3)
> is built but not activated — see [Bridge Security Model](../bridge/security-model.md).

Deposits from Base are cryptographically verified before minting:

1. **EVM Receipt Verification** — tx status, recipient, sender, confirmations
2. **SHA-256 Commitment Nullifiers** — `SHA-256("ROUGECHAIN_BRIDGE_V1" || tx_hash || address || amount)` prevents double-claims
3. **BridgeDeposit Event Verification** — for XRGE vault deposits (log parsing)

## Future Roadmap

- [x] STARK proof system (Phase 1: balance transfer AIR) — integrity proofs, no zero-knowledge mode; unused by any live feature
- [ ] Shielded transactions: V1 **suspended since block 245**; V2 (Plonky3, hiding mode, 1,000,000 XRGE cap) in development, unaudited
- [ ] STARK rollup layer: prototype only, not connected to consensus
- [x] Bridge deposit verification on the RougeChain side (EVM receipts + SHA-256 commitment nullifiers — not STARK proofs)
- [ ] V3 XRGE bridge with on-chain ML-DSA-65 authorization — built, audit pending, **not activated** ([status](../status.md))
- [ ] Fully trustless STARK bridge (Base light client)
- [ ] SLH-DSA (SPHINCS+) as alternative signature scheme
- [ ] Hybrid classical+PQC mode
- [ ] Hardware wallet support
- [ ] Threshold signatures for multi-sig
- [x] WASM-compiled STARK prover for browser (`core/wasm-prover/`) — built; used by no live feature

