/**
 * Unified Wallet System for Extension
 * Combines messenger and blockchain wallet with encrypted storage
 * Adapted from quantum-vault/src/lib/unified-wallet.ts
 */
import * as storage from "./storage";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

// Expected key sizes (bytes) for FIPS 204 / FIPS 203
const ML_DSA65_SECRET_KEY_BYTES = 4032;
const ML_DSA65_PUBLIC_KEY_BYTES = 1952;
const ML_KEM768_SECRET_KEY_BYTES = 2400;

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export interface UnifiedWallet {
    id: string;
    displayName: string;
    createdAt: number;
    signingPublicKey: string;
    signingPrivateKey: string;
    encryptionPublicKey: string;
    encryptionPrivateKey: string;
    version: number;
    mnemonic?: string;
}

export interface VaultSettings {
    autoLockMinutes: number;
}

const UNIFIED_WALLET_KEY = "pqc-unified-wallet";       // decrypted ACTIVE wallet (session-only)
const VAULT_SESSION_KEY = "pqc-unified-vault";         // decrypted vault: ALL wallets (session-only)
const WALLET_METADATA_KEY = "pqc-unified-wallet-metadata";
const VAULT_SETTINGS_KEY = "pqc-unified-wallet-vault-settings";
const ENCRYPTED_WALLET_KEY = "pqc-unified-wallet-encrypted";
const ACTIVE_WALLET_ID_KEY = "pqc-unified-active-id";  // active wallet id (NOT sensitive), persisted

/**
 * The decrypted vault: one or more wallets under a single password, plus which is
 * active. Stored encrypted (ENCRYPTED_WALLET_KEY) as JSON with a `vault` marker.
 * A legacy single-wallet blob (no marker) is migrated into a one-entry vault.
 */
export interface WalletVault {
    vault: 1;
    wallets: UnifiedWallet[];
    activeId: string;
}

function isVault(obj: unknown): obj is WalletVault {
    return !!obj && typeof obj === "object" && (obj as WalletVault).vault === 1 && Array.isArray((obj as WalletVault).wallets);
}

function ensureCorrectKeys(wallet: UnifiedWallet): UnifiedWallet {
    let updated = { ...wallet };
    let changed = false;

    // Check signing key sizes match FIPS 204 ML-DSA-65
    const sigPrivBytes = updated.signingPrivateKey ? updated.signingPrivateKey.length / 2 : 0;
    const sigPubBytes = updated.signingPublicKey ? updated.signingPublicKey.length / 2 : 0;
    const signingNeedsRegen = sigPrivBytes !== ML_DSA65_SECRET_KEY_BYTES ||
        sigPubBytes !== ML_DSA65_PUBLIC_KEY_BYTES;

    if (signingNeedsRegen) {
        console.warn(`[Vault] Signing key size mismatch (got ${sigPrivBytes}/${sigPubBytes}, expected ${ML_DSA65_SECRET_KEY_BYTES}/${ML_DSA65_PUBLIC_KEY_BYTES}). Regenerating FIPS 204 keys.`);
        const sigKeypair = ml_dsa65.keygen();
        updated.signingPublicKey = bytesToHex(sigKeypair.publicKey);
        updated.signingPrivateKey = bytesToHex(sigKeypair.secretKey);
        changed = true;
    }

    // Check encryption key sizes match FIPS 203 ML-KEM-768
    const encPrivBytes = updated.encryptionPrivateKey ? updated.encryptionPrivateKey.length / 2 : 0;
    const needsEncRegen = !updated.encryptionPublicKey || !updated.encryptionPrivateKey ||
        encPrivBytes !== ML_KEM768_SECRET_KEY_BYTES;

    if (needsEncRegen) {
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

// PBKDF2 key derivation
async function deriveKey(password: string, salt: Uint8Array, iterations = 600_000): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

export async function encryptWallet(wallet: UnifiedWallet, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(wallet));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
    const result = {
        salt: bytesToHex(salt),
        iv: bytesToHex(iv),
        data: bytesToHex(new Uint8Array(encrypted)),
    };
    return JSON.stringify(result);
}

/**
 * Export a wallet as the portable, ENCRYPTED `.pqcbackup` envelope used by rougechain.io:
 * base64( salt(16) | iv(12) | ciphertext ), PBKDF2-600k + AES-256-GCM. This is what
 * `decryptWallet` reads back (the `else` branch), and it round-trips to the website and
 * Qwalla — unlike the internal { salt, iv, data } at-rest blob. Use this for user-facing
 * backup export; never write the plaintext wallet (mnemonic + private keys) to a file.
 */
export async function exportWalletBackup(wallet: UnifiedWallet, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const data = new TextEncoder().encode(JSON.stringify(wallet));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
    const combined = new Uint8Array(salt.length + iv.length + encrypted.length);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(encrypted, salt.length + iv.length);
    let bin = "";
    for (let i = 0; i < combined.length; i++) bin += String.fromCharCode(combined[i]);
    return btoa(bin);
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

export async function decryptWallet(encryptedData: string, password: string): Promise<UnifiedWallet> {
    // Accept BOTH backup formats so a backup made on rougechain.io imports here
    // (and vice-versa):
    //   - extension format:  JSON { salt, iv, data } (hex fields)
    //   - site .pqcbackup:    base64( salt(16) | iv(12) | ciphertext )
    let salt: Uint8Array, iv: Uint8Array, cipher: Uint8Array;
    const trimmed = encryptedData.trim();
    if (trimmed.startsWith("{")) {
        const parsed = JSON.parse(trimmed);
        salt = hexToBytes(parsed.salt); iv = hexToBytes(parsed.iv); cipher = hexToBytes(parsed.data);
    } else {
        const combined = Uint8Array.from(atob(trimmed), c => c.charCodeAt(0));
        salt = combined.slice(0, 16); iv = combined.slice(16, 28); cipher = combined.slice(28);
    }
    // Try current (600k) then legacy (100k) PBKDF2 iteration counts.
    for (const iterations of [600_000, 100_000]) {
        try {
            const key = await deriveKey(password, salt, iterations);
            const decrypted = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
                key,
                cipher.buffer as ArrayBuffer
            );
            return JSON.parse(new TextDecoder().decode(decrypted)) as UnifiedWallet;
        } catch { /* wrong iteration count — try the next */ }
    }
    throw new Error("Decryption failed — wrong password or unsupported backup file");
}

export function getVaultSettings(): VaultSettings {
    const raw = storage.getItem(VAULT_SETTINGS_KEY);
    if (raw) {
        try { return JSON.parse(raw); } catch { /* fallthrough */ }
    }
    return { autoLockMinutes: 5 };
}

export function saveVaultSettings(settings: VaultSettings): void {
    storage.setItem(VAULT_SETTINGS_KEY, JSON.stringify(settings));
}

export function isWalletLocked(): boolean {
    return !storage.getItem(UNIFIED_WALLET_KEY) && !!storage.getItem(ENCRYPTED_WALLET_KEY);
}

export function hasEncryptedWallet(): boolean {
    return !!storage.getItem(ENCRYPTED_WALLET_KEY);
}

export function getLockedWalletMetadata(): { displayName?: string; signingPublicKey?: string } | null {
    const raw = storage.getItem(WALLET_METADATA_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

export async function lockUnifiedWallet(_password?: string): Promise<void> {
    // The encrypted vault is already persisted (unlock/add/remove/rename all write
    // it, and active-wallet changes persist the id), so locking just drops the
    // decrypted copies from memory. Re-encrypting a single wallet here would clobber
    // the multi-wallet vault, so we don't.
    storage.removeItem(UNIFIED_WALLET_KEY);
    storage.removeItem(VAULT_SESSION_KEY);
}

export async function unlockUnifiedWallet(password: string): Promise<UnifiedWallet> {
    const encrypted = storage.getItem(ENCRYPTED_WALLET_KEY);
    if (!encrypted) throw new Error("No encrypted wallet found");
    // decryptWallet returns the plaintext object: either a single wallet (legacy)
    // or a vault { vault, wallets, activeId }.
    const decrypted = (await decryptWallet(encrypted, password)) as unknown;
    let vault: WalletVault;
    if (isVault(decrypted)) {
        vault = decrypted;
    } else {
        // Legacy single-wallet blob → migrate into a one-entry vault and re-persist
        // (non-destructive: same wallet, now vault-wrapped, same password).
        const w = ensureCorrectKeys(decrypted as UnifiedWallet);
        vault = { vault: 1, wallets: [w], activeId: w.id };
        await persistVault(vault, password);
    }
    // Restore the last-selected active wallet if it still exists.
    const savedActive = storage.getItem(ACTIVE_WALLET_ID_KEY);
    if (savedActive && vault.wallets.some(w => w.id === savedActive)) vault.activeId = savedActive;
    loadVaultIntoSession(vault);
    return getActiveWallet()!;
}

// ── Multi-wallet vault layer ────────────────────────────────────────────────
// The decrypted vault (all wallets) lives in session storage; UNIFIED_WALLET_KEY
// (session) mirrors the ACTIVE wallet so existing consumers keep working.

function loadVaultIntoSession(vault: WalletVault): void {
    storage.setItem(VAULT_SESSION_KEY, JSON.stringify(vault));
    const active = vault.wallets.find(w => w.id === vault.activeId) ?? vault.wallets[0];
    if (active) {
        storage.setItem(ACTIVE_WALLET_ID_KEY, active.id);
        saveUnifiedWallet(active);
    }
}

async function persistVault(vault: WalletVault, password: string): Promise<void> {
    const clean: WalletVault = { vault: 1, wallets: vault.wallets.map(ensureCorrectKeys), activeId: vault.activeId };
    // encryptWallet just JSON-stringifies + AES-GCM encrypts its argument, so it
    // serializes the whole vault object fine.
    const encrypted = await encryptWallet(clean as unknown as UnifiedWallet, password);
    storage.setItem(ENCRYPTED_WALLET_KEY, encrypted);
    const active = clean.wallets.find(w => w.id === clean.activeId) ?? clean.wallets[0];
    if (active) storage.setItem(WALLET_METADATA_KEY, JSON.stringify({ displayName: active.displayName, signingPublicKey: active.signingPublicKey }));
}

/** The decrypted vault for this session, or null if locked. */
export function getVaultSession(): WalletVault | null {
    const raw = storage.getItem(VAULT_SESSION_KEY);
    if (!raw) return null;
    try { const v = JSON.parse(raw); return isVault(v) ? v : null; } catch { return null; }
}

/** The active wallet (from the vault, or the legacy single session wallet). */
export function getActiveWallet(): UnifiedWallet | null {
    const v = getVaultSession();
    if (v) return v.wallets.find(w => w.id === v.activeId) ?? v.wallets[0] ?? null;
    return loadUnifiedWallet();
}

/** Lightweight list for a switcher UI (no private keys). */
export function listVaultWallets(): { id: string; displayName: string; signingPublicKey: string; active: boolean }[] {
    const v = getVaultSession();
    if (!v) {
        const w = loadUnifiedWallet();
        return w ? [{ id: w.id, displayName: w.displayName, signingPublicKey: w.signingPublicKey, active: true }] : [];
    }
    return v.wallets.map(w => ({ id: w.id, displayName: w.displayName, signingPublicKey: w.signingPublicKey, active: w.id === v.activeId }));
}

/** Switch the active wallet. No password needed — the active id isn't sensitive,
 *  and the wallet set is unchanged, so nothing is re-encrypted. */
export function setActiveWallet(id: string): UnifiedWallet | null {
    const v = getVaultSession();
    if (!v || !v.wallets.some(w => w.id === id)) return null;
    v.activeId = id;
    storage.setItem(VAULT_SESSION_KEY, JSON.stringify(v));
    storage.setItem(ACTIVE_WALLET_ID_KEY, id);
    const active = v.wallets.find(w => w.id === id)!;
    saveUnifiedWallet(active);
    return active;
}

/** Add a wallet to the vault. `password` must be the CURRENT vault password
 *  (the whole vault is re-encrypted under it). Becomes the active wallet. */
export async function addWalletToVault(wallet: UnifiedWallet, password: string): Promise<WalletVault> {
    const v = getVaultSession() ?? { vault: 1 as const, wallets: [], activeId: "" };
    const w = ensureCorrectKeys(wallet);
    if (!v.wallets.some(x => x.signingPublicKey === w.signingPublicKey)) v.wallets.push(w);
    v.activeId = w.id;
    await persistVault(v, password);
    loadVaultIntoSession(v);
    return v;
}

/** Remove a wallet (can't remove the last one). Requires the current password. */
export async function removeWalletFromVault(id: string, password: string): Promise<WalletVault> {
    const v = getVaultSession();
    if (!v) throw new Error("Vault is locked");
    if (v.wallets.length <= 1) throw new Error("Can't remove your only wallet");
    v.wallets = v.wallets.filter(w => w.id !== id);
    if (v.activeId === id) v.activeId = v.wallets[0].id;
    await persistVault(v, password);
    loadVaultIntoSession(v);
    return v;
}

/** Rename a wallet in the vault. Requires the current password. */
export async function renameWalletInVault(id: string, name: string, password: string): Promise<void> {
    const v = getVaultSession();
    if (!v) throw new Error("Vault is locked");
    const w = v.wallets.find(x => x.id === id);
    if (!w) throw new Error("Wallet not found");
    w.displayName = name;
    await persistVault(v, password);
    loadVaultIntoSession(v);
}

export function autoLockWallet(): void {
    storage.removeItem(UNIFIED_WALLET_KEY);
    storage.removeItem(VAULT_SESSION_KEY);
}

/**
 * Persist a newly created/imported wallet with mandatory encryption at rest.
 * Stores ONLY the AES-256-GCM–encrypted blob to disk (chrome.storage.local) plus public
 * metadata; the decrypted wallet is kept in memory-only session storage for the active
 * session. Plaintext keys therefore never touch disk. Requires a password.
 */
export async function persistNewWallet(wallet: UnifiedWallet, password: string): Promise<void> {
    if (!password || password.length < 8) throw new Error("Password must be at least 8 characters");
    const upgraded = ensureCorrectKeys(wallet);
    // If a vault is already unlocked this session, ADD to it (don't drop existing wallets).
    if (getVaultSession()) {
        await addWalletToVault(upgraded, password);
        return;
    }
    // First wallet on this device → create a new one-entry vault.
    const vault: WalletVault = { vault: 1, wallets: [upgraded], activeId: upgraded.id };
    await persistVault(vault, password);
    loadVaultIntoSession(vault);
}

/**
 * True when a decrypted wallet is present but there is NO encrypted backup — i.e. a legacy
 * plaintext-only wallet created before mandatory encryption. Such wallets must be migrated
 * (prompt the user to set a password) before use.
 */
export function needsEncryptionMigration(): boolean {
    return !hasEncryptedWallet() && loadUnifiedWallet() !== null;
}

/**
 * Migrate a legacy plaintext wallet to encrypted-at-rest: encrypt it under the given
 * password, then purge the plaintext copy that a previous version wrote to disk.
 */
export async function migrateToEncrypted(password: string): Promise<UnifiedWallet> {
    const wallet = loadUnifiedWallet();
    if (!wallet) throw new Error("No wallet to migrate");
    await persistNewWallet(wallet, password);
    // Remove the legacy plaintext that older builds persisted to chrome.storage.local.
    storage.purgeLocalKey(UNIFIED_WALLET_KEY);
    return wallet;
}

export function saveUnifiedWallet(wallet: UnifiedWallet): void {
    const upgraded = ensureCorrectKeys(wallet);
    storage.setItem(UNIFIED_WALLET_KEY, JSON.stringify(upgraded));
}

export function loadUnifiedWallet(): UnifiedWallet | null {
    const raw = storage.getItem(UNIFIED_WALLET_KEY);
    if (!raw) return null;
    try {
        const wallet = JSON.parse(raw) as UnifiedWallet;
        const upgraded = ensureCorrectKeys(wallet);
        // Persist upgraded keys back to storage if they changed
        if (upgraded.version !== wallet.version ||
            upgraded.signingPublicKey !== wallet.signingPublicKey ||
            upgraded.encryptionPublicKey !== wallet.encryptionPublicKey) {
            storage.setItem(UNIFIED_WALLET_KEY, JSON.stringify(upgraded));
            console.warn("[Vault] Keys upgraded and persisted to storage (v" + upgraded.version + ")");
        }
        return upgraded;
    } catch { return null; }
}

export function clearUnifiedWallet(): void {
    storage.removeItem(UNIFIED_WALLET_KEY);
    storage.removeItem(WALLET_METADATA_KEY);
    storage.removeItem(ENCRYPTED_WALLET_KEY);
}

export function hasWallet(): boolean {
    return !!storage.getItem(UNIFIED_WALLET_KEY) || !!storage.getItem(ENCRYPTED_WALLET_KEY);
}

export function getBlockchainWallet(): { publicKey: string; privateKey: string } | null {
    const wallet = loadUnifiedWallet();
    if (!wallet) return null;
    return { publicKey: wallet.signingPublicKey, privateKey: wallet.signingPrivateKey };
}

export function toMessengerWallet(wallet: UnifiedWallet) {
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
