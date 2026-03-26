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

**CRITICAL:** Your private key is only stored locally. If you clear browser data or lose your device, you lose access to your funds.

### Encrypted Backup (`.pqcbackup`)

All RougeChain wallets use **password-protected encrypted backups**. Plaintext key exports are disabled across all platforms.

#### How to Export

| Platform | Steps |
|----------|-------|
| **Web** (rougechain.io) | Wallet → Settings → Backup → Enter password → Download `.pqcbackup` file |
| **Browser Extension** (qRougee) | Settings → Export Encrypted Backup → Enter password → Download |
| **Mobile** (Qwalla) | Settings → Export Encrypted Backup → Enter password → Share/Save |

#### How to Restore

1. Go to **Wallet** page (or Settings in the extension)
2. Click **Restore** or **Import Wallet**
3. Select your `.pqcbackup` file
4. Enter the password you used when exporting
5. Your wallet keys are decrypted and restored

### Seed Phrase (Mnemonic)

Wallets also support **12-word BIP-39 mnemonic** backup:

1. Go to **Settings** → **Reveal Seed Phrase**
2. Write down all 12 words in order
3. Store securely — anyone with your seed phrase has full access to your wallet

> **Tip:** Use the seed phrase as your primary backup method. The `.pqcbackup` file is best for transferring between devices.

## `.pqcbackup` File Format

The encrypted backup file uses industry-standard cryptography:

| Component | Algorithm | Details |
|-----------|-----------|---------|
| Key Derivation | **PBKDF2-SHA256** | 600,000 iterations |
| Encryption | **AES-256-GCM** | 256-bit key, 96-bit IV |
| Salt | Random | 16 bytes per export |
| IV | Random | 12 bytes per export |

### File Structure

```json
{
  "version": 1,
  "salt": "<hex-encoded 16-byte random salt>",
  "iv": "<hex-encoded 12-byte random IV>",
  "ciphertext": "<hex-encoded AES-256-GCM encrypted wallet data>",
  "algorithm": "PBKDF2-SHA256-AES-256-GCM"
}
```

### How It Works

1. Your password is stretched with **PBKDF2-SHA256** (600,000 rounds) using a random salt
2. The derived 256-bit key encrypts your wallet data with **AES-256-GCM**
3. The salt, IV, and ciphertext are bundled into a `.pqcbackup` JSON file
4. Without the correct password, the file cannot be decrypted

> **Warning:** There is no password recovery. If you forget your backup password, use your seed phrase to restore instead.

## Security Best Practices

1. **Never share your private key or seed phrase**
2. **Backup your wallet immediately** after creation
3. **Use a strong, unique password** for your `.pqcbackup` file
4. **Store backups in multiple locations** (password manager, USB, etc.)
5. **Never screenshot** your seed phrase or keys
6. **Verify addresses** before sending

## Technical Details

### Key Generation

```typescript
// 12-word mnemonic (128-bit entropy)
const mnemonic = bip39.generateMnemonic(128);

// Derive 32-byte seed via HKDF-SHA256
const seed = hkdf(mnemonicToSeed(mnemonic), "rougechain-pqc-v1");

// Signing keypair (ML-DSA-65 / FIPS 204)
const signingKeypair = ml_dsa65.keygen(seed);

// Encryption keypair (ML-KEM-768 / FIPS 203)
const encryptionKeypair = ml_kem768.keygen(seed);
```

### Key Storage

| Platform | Storage |
|----------|---------|
| Web (rougechain.io) | `localStorage` → encrypted via vault password |
| Browser Extension (qRougee) | `chrome.storage.local` → AES-256-GCM vault |
| Mobile (Qwalla) | `expo-secure-store` → device keychain |
