/**
 * Unified Wallet System
 * Combines messenger and blockchain wallet functionality with shared backup
 */
import { getActiveNetwork } from "./network";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { generateMnemonic, keypairFromMnemonic } from "./mnemonic";

// Expected key sizes (bytes) for FIPS 204 / FIPS 203
const ML_DSA65_SECRET_KEY_BYTES = 4032;
const ML_DSA65_PUBLIC_KEY_BYTES = 1952;
const ML_KEM768_SECRET_KEY_BYTES = 2400;

// Helper to convert bytes to hex
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}


// Validate and regenerate keys if sizes don't match FIPS standards.
// Extension wallets have empty private keys — skip regeneration for those.
function ensureCorrectKeys(wallet: UnifiedWallet): UnifiedWallet {
  const isExtensionWallet = !wallet.signingPrivateKey && wallet.signingPublicKey;
  if (isExtensionWallet) return wallet;

  let updated = { ...wallet };
  let changed = false;

  // Check signing key sizes match FIPS 204 ML-DSA-65
  const sigPrivBytes = updated.signingPrivateKey ? updated.signingPrivateKey.length / 2 : 0;
  const sigPubBytes = updated.signingPublicKey ? updated.signingPublicKey.length / 2 : 0;
  if (sigPrivBytes !== ML_DSA65_SECRET_KEY_BYTES || sigPubBytes !== ML_DSA65_PUBLIC_KEY_BYTES) {
    console.warn(`[Vault] Signing key size mismatch (${sigPrivBytes}/${sigPubBytes}). Regenerating FIPS 204 keys.`);
    const sigKeypair = ml_dsa65.keygen();
    updated.signingPublicKey = bytesToHex(sigKeypair.publicKey);
    updated.signingPrivateKey = bytesToHex(sigKeypair.secretKey);
    changed = true;
  }

  // Check encryption key sizes match FIPS 203 ML-KEM-768
  const encPrivBytes = updated.encryptionPrivateKey ? updated.encryptionPrivateKey.length / 2 : 0;
  if (!updated.encryptionPublicKey || !updated.encryptionPrivateKey || encPrivBytes !== ML_KEM768_SECRET_KEY_BYTES) {
    console.warn(`[Vault] Encryption key size mismatch or missing. Regenerating FIPS 203 keys.`);
    const encKeypair = ml_kem768.keygen();
    updated.encryptionPublicKey = bytesToHex(encKeypair.publicKey);
    updated.encryptionPrivateKey = bytesToHex(encKeypair.secretKey);
    changed = true;
  }

  if (changed) {
    updated.version = 4;
  }

  return updated;
}

// Storage keys
export const UNIFIED_WALLET_KEY = "pqc-unified-wallet";
export const MESSENGER_WALLET_KEY = "pqc_messenger_wallet";
export const BLOCKCHAIN_WALLET_KEY = "pqc-blockchain-wallet";
export const ENCRYPTED_WALLET_KEY = "pqc-unified-wallet-encrypted";
export const WALLET_LOCKED_KEY = "pqc-unified-wallet-locked";
export const WALLET_METADATA_KEY = "pqc-unified-wallet-metadata";
export const VAULT_SETTINGS_KEY = "pqc-unified-wallet-vault-settings";

// Unified wallet structure that works for both messenger and blockchain
export interface UnifiedWallet {
  // Core identity
  id: string;
  displayName: string;
  createdAt: number;
  
  // Signing keys (ML-DSA-65) - used for blockchain transactions
  signingPublicKey: string;
  signingPrivateKey: string;
  
  // Encryption keys (ML-KEM-768) - used for messenger E2EE
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
  
  // Metadata
  version: number;
  
  // Mnemonic seed phrase (optional — legacy wallets won't have this)
  mnemonic?: string;
}

export interface VaultSettings {
  autoLockMinutes: number;
}

// Legacy wallet types for migration
interface LegacyMessengerWallet {
  id: string;
  displayName: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
  createdAt?: string;
}

interface LegacyBlockchainWallet {
  publicKey: string;
  privateKey: string;
  createdAt: number;
  linkedToMessenger?: boolean;
}

// Derive encryption key from password using PBKDF2
const PBKDF2_ITERATIONS = 600_000; // Aligned with browser extension

async function deriveKey(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Encrypt wallet data
export async function encryptWallet(wallet: UnifiedWallet, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(wallet));
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  
  // Combine salt + iv + encrypted data
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);
  
  // Convert to base64
  return btoa(String.fromCharCode(...combined));
}

// Decrypt wallet data (tries current 600K iterations, falls back to legacy 100K)
export async function decryptWallet(encryptedData: string, password: string): Promise<UnifiedWallet> {
  // Decode base64
  const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));
  
  // Extract salt, iv, and encrypted data
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const encrypted = combined.slice(28);

  // Try current iteration count first
  try {
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      encrypted
    );
    const walletData = JSON.parse(new TextDecoder().decode(decrypted));
    if (!walletData.version || walletData.version === 1) {
      return migrateFromV1(walletData);
    }
    return walletData as UnifiedWallet;
  } catch {
    // Fall through to legacy iteration count
  }

  // Legacy fallback: try 100K iterations (pre-alignment vaults)
  const legacyKey = await deriveKey(password, salt, 100_000);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    legacyKey,
    encrypted
  );
  const walletData = JSON.parse(new TextDecoder().decode(decrypted));
  
  // Handle legacy format (v1)
  if (!walletData.version || walletData.version === 1) {
    return migrateFromV1(walletData);
  }
  
  return walletData as UnifiedWallet;
}

export function getVaultSettings(): VaultSettings {
  const raw = localStorage.getItem(getScopedKey(VAULT_SETTINGS_KEY));
  if (!raw) {
    return { autoLockMinutes: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as VaultSettings;
    return {
      autoLockMinutes: Number(parsed.autoLockMinutes || 0),
    };
  } catch {
    return { autoLockMinutes: 0 };
  }
}

export function saveVaultSettings(settings: VaultSettings): void {
  localStorage.setItem(getScopedKey(VAULT_SETTINGS_KEY), JSON.stringify(settings));
}

export function isWalletLocked(): boolean {
  return localStorage.getItem(getScopedKey(WALLET_LOCKED_KEY)) === "true";
}

export function hasEncryptedWallet(): boolean {
  return !!localStorage.getItem(getScopedKey(ENCRYPTED_WALLET_KEY));
}

export function getLockedWalletMetadata(): { displayName?: string; signingPublicKey?: string } | null {
  const raw = localStorage.getItem(getScopedKey(WALLET_METADATA_KEY));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { displayName?: string; signingPublicKey?: string };
  } catch {
    return null;
  }
}

export async function lockUnifiedWallet(password: string): Promise<void> {
  const wallet = loadUnifiedWallet();
  if (!wallet) {
    throw new Error("No wallet to lock");
  }
  const encrypted = await encryptWallet(wallet, password);
  localStorage.setItem(getScopedKey(ENCRYPTED_WALLET_KEY), encrypted);
  localStorage.setItem(getScopedKey(WALLET_LOCKED_KEY), "true");
  localStorage.setItem(getScopedKey(WALLET_METADATA_KEY), JSON.stringify({
    displayName: wallet.displayName,
    signingPublicKey: wallet.signingPublicKey,
  }));
  // Clear private keys from both session and local storage
  sessionStorage.removeItem(getScopedKey(UNIFIED_WALLET_KEY));
  localStorage.removeItem(getScopedKey(UNIFIED_WALLET_KEY));
  localStorage.removeItem(getScopedKey(MESSENGER_WALLET_KEY));
  localStorage.removeItem(getScopedKey(BLOCKCHAIN_WALLET_KEY));
}

export async function unlockUnifiedWallet(password: string): Promise<UnifiedWallet> {
  const encrypted = localStorage.getItem(getScopedKey(ENCRYPTED_WALLET_KEY));
  if (!encrypted) {
    throw new Error("No encrypted wallet found");
  }
  const rawWallet = await decryptWallet(encrypted, password);
  const wallet = ensureCorrectKeys(rawWallet);
  saveUnifiedWallet(wallet);
  localStorage.setItem(getScopedKey(WALLET_LOCKED_KEY), "false");
  return wallet;
}

export function autoLockWallet(): void {
  if (!hasEncryptedWallet()) return;
  sessionStorage.removeItem(getScopedKey(UNIFIED_WALLET_KEY));
  localStorage.removeItem(getScopedKey(UNIFIED_WALLET_KEY));
  localStorage.removeItem(getScopedKey(MESSENGER_WALLET_KEY));
  localStorage.removeItem(getScopedKey(BLOCKCHAIN_WALLET_KEY));
  localStorage.setItem(getScopedKey(WALLET_LOCKED_KEY), "true");
}

// Migrate from v1 (messenger-only) format
function migrateFromV1(data: any): UnifiedWallet {
  return {
    id: data.id,
    displayName: data.displayName || "My Wallet",
    createdAt: data.createdAt ? new Date(data.createdAt).getTime() : Date.now(),
    signingPublicKey: data.signingPublicKey,
    signingPrivateKey: data.signingPrivateKey,
    encryptionPublicKey: data.encryptionPublicKey,
    encryptionPrivateKey: data.encryptionPrivateKey,
    version: 2,
  };
}

// Save unified wallet: private keys go to sessionStorage (ephemeral)
// AND localStorage when no password vault exists (so PWA survives restarts).
// When the user sets a password, the localStorage copy is removed and only
// the encrypted blob + sessionStorage are used.
export function saveUnifiedWallet(wallet: UnifiedWallet): void {
  const validated = ensureCorrectKeys(wallet);

  // Full wallet with private keys -> sessionStorage
  const sessionKey = getScopedKey(UNIFIED_WALLET_KEY);
  sessionStorage.setItem(sessionKey, JSON.stringify(validated));

  // If no password vault exists, also persist to localStorage so the wallet
  // survives PWA / tab restarts.  Once the user sets a password, lockUnifiedWallet()
  // removes this key and relies on the encrypted blob instead.
  if (!hasEncryptedWallet()) {
    localStorage.setItem(getScopedKey(UNIFIED_WALLET_KEY), JSON.stringify(validated));
  }

  // Public-only metadata -> localStorage for display while locked
  localStorage.setItem(getScopedKey(WALLET_METADATA_KEY), JSON.stringify({
    id: validated.id,
    displayName: validated.displayName,
    signingPublicKey: validated.signingPublicKey,
    encryptionPublicKey: validated.encryptionPublicKey,
    createdAt: validated.createdAt,
  }));

  // Keep legacy localStorage keys for backward compatibility (public data only)
  const messengerKey = getScopedKey(MESSENGER_WALLET_KEY);
  localStorage.setItem(messengerKey, JSON.stringify({
    id: validated.id,
    displayName: validated.displayName,
    signingPublicKey: validated.signingPublicKey,
    signingPrivateKey: "",
    encryptionPublicKey: validated.encryptionPublicKey,
    encryptionPrivateKey: "",
    createdAt: new Date(validated.createdAt).toISOString(),
  }));

  const blockchainKey = getScopedKey(BLOCKCHAIN_WALLET_KEY);
  localStorage.setItem(blockchainKey, JSON.stringify({
    publicKey: validated.signingPublicKey,
    privateKey: "",
    createdAt: validated.createdAt,
    linkedToMessenger: true,
  }));
}

// Load unified wallet: checks sessionStorage first (unlocked wallet with private keys),
// then falls back to localStorage for legacy migration.
export function loadUnifiedWallet(): UnifiedWallet | null {
  const upgradeAndSave = (wallet: UnifiedWallet): UnifiedWallet => {
    const upgraded = ensureCorrectKeys(wallet);
    if (upgraded.version !== wallet.version ||
        upgraded.signingPublicKey !== wallet.signingPublicKey ||
        upgraded.encryptionPublicKey !== wallet.encryptionPublicKey) {
      saveUnifiedWallet(upgraded);
    }
    return upgraded;
  };

  // 1. sessionStorage: contains full wallet (current session)
  const sessionData = sessionStorage.getItem(getScopedKey(UNIFIED_WALLET_KEY));
  if (sessionData) {
    try {
      const wallet = JSON.parse(sessionData) as UnifiedWallet;
      if (wallet.signingPublicKey) {
        return upgradeAndSave(wallet);
      }
    } catch { /* continue */ }
  }

  // 2. localStorage unified key (legacy plaintext — migrate to sessionStorage)
  const unifiedKey = getScopedKey(UNIFIED_WALLET_KEY);
  const unified = localStorage.getItem(unifiedKey);
  if (unified) {
    try {
      const wallet = JSON.parse(unified) as UnifiedWallet;
      if (wallet.signingPublicKey) {
        const upgraded = upgradeAndSave(wallet);
        saveUnifiedWallet(upgraded);
        return upgraded;
      }
    } catch { /* continue */ }
  }

  // 3. Legacy messenger format with private keys
  const messengerKey = getScopedKey(MESSENGER_WALLET_KEY);
  const messenger = localStorage.getItem(messengerKey);
  if (messenger) {
    try {
      const parsed: LegacyMessengerWallet = JSON.parse(messenger);
      if (parsed.signingPrivateKey) {
        const wallet: UnifiedWallet = {
          id: parsed.id,
          displayName: parsed.displayName,
          createdAt: parsed.createdAt ? new Date(parsed.createdAt).getTime() : Date.now(),
          signingPublicKey: parsed.signingPublicKey,
          signingPrivateKey: parsed.signingPrivateKey,
          encryptionPublicKey: parsed.encryptionPublicKey || "",
          encryptionPrivateKey: parsed.encryptionPrivateKey || "",
          version: 2,
        };
        return upgradeAndSave(wallet);
      }
    } catch { /* continue */ }
  }

  // 4. Legacy blockchain format
  const blockchainKey = getScopedKey(BLOCKCHAIN_WALLET_KEY);
  const blockchain = localStorage.getItem(blockchainKey);
  if (blockchain) {
    try {
      const parsed: LegacyBlockchainWallet = JSON.parse(blockchain);
      if (parsed.privateKey) {
        const wallet: UnifiedWallet = {
          id: `wallet-${Date.now()}`,
          displayName: "My Wallet",
          createdAt: parsed.createdAt || Date.now(),
          signingPublicKey: parsed.publicKey,
          signingPrivateKey: parsed.privateKey,
          encryptionPublicKey: "",
          encryptionPrivateKey: "",
          version: 2,
        };
        return upgradeAndSave(wallet);
      }
    } catch { return null; }
  }

  // 5. Pre-network-scoping legacy fallback
  const legacyUnified = localStorage.getItem(UNIFIED_WALLET_KEY);
  if (legacyUnified) {
    try {
      const parsed = JSON.parse(legacyUnified) as UnifiedWallet;
      if (parsed.signingPrivateKey) {
        saveUnifiedWallet(parsed);
        clearLegacyWallets();
        return parsed;
      }
    } catch { /* continue */ }
  }

  const legacyMessenger = localStorage.getItem(MESSENGER_WALLET_KEY);
  if (legacyMessenger) {
    try {
      const parsed: LegacyMessengerWallet = JSON.parse(legacyMessenger);
      if (parsed.signingPrivateKey) {
        const unifiedWallet: UnifiedWallet = {
          id: parsed.id,
          displayName: parsed.displayName,
          createdAt: parsed.createdAt ? new Date(parsed.createdAt).getTime() : Date.now(),
          signingPublicKey: parsed.signingPublicKey,
          signingPrivateKey: parsed.signingPrivateKey,
          encryptionPublicKey: parsed.encryptionPublicKey,
          encryptionPrivateKey: parsed.encryptionPrivateKey,
          version: 2,
        };
        saveUnifiedWallet(unifiedWallet);
        clearLegacyWallets();
        return unifiedWallet;
      }
    } catch { /* continue */ }
  }

  return null;
}

// Clear all wallet storage (both persistent and ephemeral)
export function clearUnifiedWallet(): void {
  sessionStorage.removeItem(getScopedKey(UNIFIED_WALLET_KEY));
  localStorage.removeItem(getScopedKey(UNIFIED_WALLET_KEY));
  localStorage.removeItem(getScopedKey(MESSENGER_WALLET_KEY));
  localStorage.removeItem(getScopedKey(BLOCKCHAIN_WALLET_KEY));
  localStorage.removeItem(getScopedKey(ENCRYPTED_WALLET_KEY));
  localStorage.removeItem(getScopedKey(WALLET_LOCKED_KEY));
  localStorage.removeItem(getScopedKey(WALLET_METADATA_KEY));
  clearLegacyWallets();
}

// Check if any wallet exists (session, persistent, or encrypted)
export function hasWallet(): boolean {
  return !!(
    sessionStorage.getItem(getScopedKey(UNIFIED_WALLET_KEY)) ||
    localStorage.getItem(getScopedKey(UNIFIED_WALLET_KEY)) ||
    localStorage.getItem(getScopedKey(MESSENGER_WALLET_KEY)) ||
    localStorage.getItem(getScopedKey(BLOCKCHAIN_WALLET_KEY)) ||
    localStorage.getItem(getScopedKey(ENCRYPTED_WALLET_KEY)) ||
    localStorage.getItem(UNIFIED_WALLET_KEY) ||
    localStorage.getItem(MESSENGER_WALLET_KEY) ||
    localStorage.getItem(BLOCKCHAIN_WALLET_KEY)
  );
}

function getScopedKey(baseKey: string): string {
  return `${baseKey}:${getActiveNetwork()}`;
}

function clearLegacyWallets(): void {
  localStorage.removeItem(UNIFIED_WALLET_KEY);
  localStorage.removeItem(MESSENGER_WALLET_KEY);
  localStorage.removeItem(BLOCKCHAIN_WALLET_KEY);
}

// Get wallet for blockchain operations (signing key only)
export function getBlockchainWallet(): { publicKey: string; privateKey: string } | null {
  const wallet = loadUnifiedWallet();
  if (!wallet) return null;
  
  return {
    publicKey: wallet.signingPublicKey,
    privateKey: wallet.signingPrivateKey,
  };
}

// Get wallet for messenger operations
export function getMessengerWallet(): UnifiedWallet | null {
  return loadUnifiedWallet();
}

// Convert UnifiedWallet to WalletWithPrivateKeys format (for messenger compatibility)
export function toMessengerWallet(wallet: UnifiedWallet): {
  id: string;
  displayName: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
  createdAt?: string;
} {
  return {
    id: wallet.id,
    displayName: wallet.displayName,
    signingPublicKey: wallet.signingPublicKey,
    signingPrivateKey: wallet.signingPrivateKey,
    encryptionPublicKey: wallet.encryptionPublicKey,
    encryptionPrivateKey: wallet.encryptionPrivateKey,
    createdAt: new Date(wallet.createdAt).toISOString(),
  };
}

// Convert WalletWithPrivateKeys to UnifiedWallet format
export function fromMessengerWallet(wallet: {
  id: string;
  displayName: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
  createdAt?: string;
}): UnifiedWallet {
  return {
    id: wallet.id,
    displayName: wallet.displayName,
    createdAt: wallet.createdAt ? new Date(wallet.createdAt).getTime() : Date.now(),
    signingPublicKey: wallet.signingPublicKey,
    signingPrivateKey: wallet.signingPrivateKey,
    encryptionPublicKey: wallet.encryptionPublicKey,
    encryptionPrivateKey: wallet.encryptionPrivateKey,
    version: 2,
  };
}
