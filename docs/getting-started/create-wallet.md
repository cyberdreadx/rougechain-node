# Create a Wallet

Your RougeChain wallet is automatically created when you first visit the app. Here's what you need to know about it.

## Wallet Components

| Component | Algorithm | Purpose |
|-----------|-----------|---------|
| Signing Key | ML-DSA-65 | Sign transactions, prove ownership |
| Encryption Key | ML-KEM-768 | Encrypt/decrypt messages |

## Your Address

RougeChain uses compact **Bech32m addresses** with the `rouge1` prefix, derived from your ML-DSA-65 public key:

```
address = bech32m("rouge", SHA-256(signing_public_key))
```

Example address:
```
rouge1q8f3x7k2m4n9pvj5dz6ywl2cg8hs0kw9...
```

Addresses are ~63 characters — much shorter than the raw 3,904-char hex public key. The wallet, extension, and explorer all display this format.

> **Note:** API endpoints still use the raw hex public key internally. The `rouge1` address is for display, sharing, and QR codes.

## Backup Your Wallet

**CRITICAL:** Your private key is only stored in your browser. If you clear browser data, you lose access to your funds.

### Export Backup

1. Go to **Wallet** page
2. Click **Backup** or the key icon
3. Save the backup file securely

### Restore from Backup

1. Go to **Wallet** page
2. Click **Restore** 
3. Upload your backup file

## Security Best Practices

1. **Never share your private key**
2. **Backup your wallet immediately**
3. **Use a password manager** to store your backup
4. **Don't screenshot** your keys
5. **Verify addresses** before sending

## Technical Details

### Key Generation

```typescript
// Signing keypair (ML-DSA-65)
const signingSeed = crypto.getRandomValues(new Uint8Array(32));
const signingKeypair = ml_dsa65.keygen(signingSeed);

// Encryption keypair (ML-KEM-768)
const encryptionSeed = crypto.getRandomValues(new Uint8Array(32));
const encryptionKeypair = ml_kem768.keygen(encryptionSeed);
```

### Storage

Keys are stored in browser `localStorage`:

```javascript
localStorage.getItem('pqc-wallet-keys')
```

For production, consider:
- IndexedDB with encryption
- Hardware wallet integration
- Server-side encrypted backup
