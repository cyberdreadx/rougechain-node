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
| Backend (Rust) | `pqcrypto` crate |
| Frontend (JS) | `@noble/post-quantum` |

All cryptographic operations happen locally - private keys never leave your device.

## Key Generation

```rust
// Rust example
use pqcrypto_dilithium::dilithium3::*;

let (pk, sk) = keypair();
let signature = sign(message, &sk);
let valid = verify(message, &signature, &pk);
```

```typescript
// TypeScript example
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa';

const { publicKey, secretKey } = ml_dsa65.keygen();
const signature = ml_dsa65.sign(message, secretKey);
const valid = ml_dsa65.verify(signature, message, publicKey);
```

## Security Considerations

1. **Key storage** - Private keys are stored in browser localStorage (encrypted in production)
2. **Entropy** - Keys use cryptographically secure random number generators
3. **Side channels** - Library implementations are designed to be constant-time
4. **Hybrid approach** - Consider adding classical signatures for defense-in-depth

## Future Roadmap

- [ ] SLH-DSA (SPHINCS+) as alternative signature scheme
- [ ] Hybrid classical+PQC mode
- [ ] Hardware wallet support
- [ ] Threshold signatures for multi-sig
