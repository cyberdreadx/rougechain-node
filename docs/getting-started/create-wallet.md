# Create a Wallet

You explicitly create (or import) your RougeChain wallet, and onboarding then asks you to set a password (at least 8 characters). The password is **required**: on the web, the wallet is saved in your browser only once it's encrypted with it. Here's what you need to know about your wallet.

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

> **Note:** Some API endpoints still require the raw hex public key (see [Address Format](../api-reference/README.md#address-format)). The `rouge1` address is for display, sharing, and QR codes.

## Backup Your Wallet

**CRITICAL:** Your private key is only stored locally. If you clear browser data or lose your device, you lose access to your funds.

### Encrypted Backup (`.pqcbackup`)

All RougeChain wallets use **password-protected encrypted backups**. Plaintext key exports are disabled across all platforms.

#### How to Export

| Platform | Steps |
|----------|-------|
| **Web** (rougechain.io) | Wallet → Settings → Backup → Enter password → Download `.pqcbackup` file |
| **Browser Extension** (RougeChain Wallet) | Settings → Export Encrypted Backup → Enter password → Download |
| **Mobile** (Qwalla) | Settings → Export Encrypted Backup → Enter password → Share/Save |

#### How to Restore

1. Go to **Wallet** page (or Settings in the extension)
2. Click **Restore** or **Import Wallet**
3. Select your `.pqcbackup` file
4. Enter the password you used when exporting
5. Your wallet keys are decrypted and restored

### Seed Phrase (Mnemonic)

Wallets also support **24-word BIP-39 mnemonic** backup (256-bit entropy for post-quantum security):

1. Go to **Settings** → **Reveal Seed Phrase**
2. Write down all 24 words in order
3. Store securely — anyone with your seed phrase has full access to your wallet

> **Important:** The seed phrase restores your **signing key and address** (and so your funds), but **not** your messaging/mail encryption key — that key is generated randomly, not derived from the phrase. A wallet restored from the phrase alone gets a new encryption key and cannot read your earlier messages or mail. Keep a `.pqcbackup` file as well: it contains both keys.

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

> **Warning:** There is no password recovery. If you forget your backup password, you can restore your address and funds from your seed phrase, but not your old messages or mail.

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
// 24-word mnemonic (256-bit entropy — post-quantum safe)
const mnemonic = bip39.generateMnemonic(256);

// Derive 32-byte seed via HKDF-SHA256
const seed = hkdf(sha256, mnemonicToSeed(mnemonic), undefined, "rougechain-ml-dsa-65-v1", 32);

// Signing keypair (ML-DSA-65 / FIPS 204)
const signingKeypair = ml_dsa65.keygen(seed);

// Encryption keypair (ML-KEM-768 / FIPS 203) — random, NOT derived from the seed
const encryptionKeypair = ml_kem768.keygen();
```

### Key Storage

Once you set a password, keys are encrypted at rest with **AES-256-GCM** (PBKDF2, 600,000 iterations).

On the web, a new or imported wallet is held only in the tab's `sessionStorage` until you set its password; nothing is written to `localStorage` before that, so if you close the tab during the recovery-phrase or password step the wallet is not kept (restore it from the recovery phrase). Setting the password stores the encrypted blob in `localStorage`. While the wallet is unlocked, the decrypted wallet is kept in `sessionStorage`, which the browser clears when the tab closes. Keep a `.pqcbackup` as well.

Older versions of the site saved a wallet without a password to `localStorage` **unencrypted**. If you still have such a wallet, rougechain.io asks you to set a password before you can keep using it (you can back it up first); the wallet is then encrypted and the unencrypted copy is deleted.

| Platform | Storage |
|----------|---------|
| Web (rougechain.io) | encrypted blob in `localStorage`; decrypted wallet in `sessionStorage` while unlocked (and before the password is set during create / import). Private keys are never written to `localStorage` unencrypted |
| Browser Extension (RougeChain Wallet) | encrypted AES-256-GCM vault in `chrome.storage.local`; decrypted key in `chrome.storage.session`, never written to disk |
| Mobile (Qwalla) | `expo-secure-store` → device keychain |

### Terminal EVM Wallet (`tools/evm-cli`)

For Base/EVM operations there's a companion terminal wallet, `rougechain-evm` (`tools/evm-cli`). It derives your Base account from the same 24-word mnemonic (read from the `ROUGECHAIN_MNEMONIC` env var) and supports `new`, `address`, `balance`, `send-eth`, and `send-token`.
