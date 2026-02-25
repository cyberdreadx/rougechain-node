/**
 * Unified Wallet System for Extension
 * Combines messenger and blockchain wallet with encrypted storage
 * Adapted from quantum-vault/src/lib/unified-wallet.ts
 */
import * as storage from "./storage";
import { ml_kem768 } from "@noble/post-quantum/ml-kem";

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
}

export interface VaultSettings {
    autoLockMinutes: number;
}

const UNIFIED_WALLET_KEY = "pqc-unified-wallet";
const WALLET_METADATA_KEY = "pqc-unified-wallet-metadata";
const VAULT_SETTINGS_KEY = "pqc-unified-wallet-vault-settings";
const ENCRYPTED_WALLET_KEY = "pqc-unified-wallet-encrypted";

function ensureEncryptionKeys(wallet: UnifiedWallet): UnifiedWallet {
    if (wallet.encryptionPublicKey && wallet.encryptionPrivateKey) return wallet;
    const keypair = ml_kem768.keygen();
    return {
        ...wallet,
        encryptionPublicKey: wallet.encryptionPublicKey || bytesToHex(keypair.publicKey),
        encryptionPrivateKey: wallet.encryptionPrivateKey || bytesToHex(keypair.secretKey),
        version: 2,
    };
}

// PBKDF2 key derivation
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" },
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

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

export async function decryptWallet(encryptedData: string, password: string): Promise<UnifiedWallet> {
    const { salt, iv, data } = JSON.parse(encryptedData);
    const key = await deriveKey(password, hexToBytes(salt));
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: hexToBytes(iv) },
        key,
        hexToBytes(data)
    );
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(decrypted));
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

export async function lockUnifiedWallet(password: string): Promise<void> {
    const wallet = loadUnifiedWallet();
    if (!wallet) throw new Error("No wallet to lock");
    const encrypted = await encryptWallet(wallet, password);
    storage.setItem(ENCRYPTED_WALLET_KEY, encrypted);
    storage.setItem(WALLET_METADATA_KEY, JSON.stringify({
        displayName: wallet.displayName,
        signingPublicKey: wallet.signingPublicKey,
    }));
    storage.removeItem(UNIFIED_WALLET_KEY);
}

export async function unlockUnifiedWallet(password: string): Promise<UnifiedWallet> {
    const encrypted = storage.getItem(ENCRYPTED_WALLET_KEY);
    if (!encrypted) throw new Error("No encrypted wallet found");
    const wallet = await decryptWallet(encrypted, password);
    saveUnifiedWallet(wallet);
    return wallet;
}

export function autoLockWallet(): void {
    storage.removeItem(UNIFIED_WALLET_KEY);
}

export function saveUnifiedWallet(wallet: UnifiedWallet): void {
    const upgraded = ensureEncryptionKeys(wallet);
    storage.setItem(UNIFIED_WALLET_KEY, JSON.stringify(upgraded));
}

export function loadUnifiedWallet(): UnifiedWallet | null {
    const raw = storage.getItem(UNIFIED_WALLET_KEY);
    if (!raw) return null;
    try {
        const wallet = JSON.parse(raw) as UnifiedWallet;
        return ensureEncryptionKeys(wallet);
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
