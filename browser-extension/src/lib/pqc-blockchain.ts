/**
 * PQC Blockchain — ML-DSA-65 key generation and signing
 * Adapted from quantum-vault/src/lib/pqc-blockchain.ts
 */
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

export interface Block {
    index: number;
    timestamp: number;
    data: string;
    previousHash: string;
    hash: string;
    nonce: number;
    signature: string;
    signerPublicKey: string;
}

export interface Keypair {
    publicKey: string;
    privateKey: string;
}

export interface CryptoInfo {
    algorithm: string;
    standard: string;
    publicKeySize: string;
    signatureSize: string;
    securityLevel: string;
}

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

async function hashBlock(block: { index: number; timestamp: number; data: string; previousHash: string; nonce: number }): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(
        `${block.index}${block.timestamp}${block.data}${block.previousHash}${block.nonce}`
    );
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

export async function generateKeypair(): Promise<{ keypair: Keypair; info: CryptoInfo }> {
    const keypair = ml_dsa65.keygen();
    return {
        keypair: {
            publicKey: bytesToHex(keypair.publicKey),
            privateKey: bytesToHex(keypair.secretKey),
        },
        info: {
            algorithm: "ML-DSA-65 (CRYSTALS-Dilithium)",
            standard: "FIPS 204",
            publicKeySize: `${keypair.publicKey.length} bytes`,
            signatureSize: "~3300 bytes",
            securityLevel: "NIST Level 3",
        },
    };
}

export async function mineBlock(
    index: number,
    blockData: string,
    previousHash: string,
    privateKey: string,
    publicKey: string,
    difficulty: number = 2
): Promise<Block> {
    let nonce = 0;
    let hash = "";
    const timestamp = Date.now();
    const target = "0".repeat(difficulty);

    while (!hash.startsWith(target)) {
        nonce++;
        hash = await hashBlock({ index, timestamp, data: blockData, previousHash, nonce });
        if (nonce > 1_000_000) break;
    }

    const messageBytes = new TextEncoder().encode(hash);
    const signature = ml_dsa65.sign(messageBytes, hexToBytes(privateKey));

    return {
        index,
        timestamp,
        data: blockData,
        previousHash,
        hash,
        nonce,
        signature: bytesToHex(signature),
        signerPublicKey: publicKey,
    };
}

export async function verifyBlockSignature(block: Block): Promise<boolean> {
    try {
        const messageBytes = new TextEncoder().encode(block.hash);
        const signatureBytes = hexToBytes(block.signature);
        const publicKeyBytes = hexToBytes(block.signerPublicKey);
        return ml_dsa65.verify(signatureBytes, messageBytes, publicKeyBytes);
    } catch {
        return false;
    }
}
