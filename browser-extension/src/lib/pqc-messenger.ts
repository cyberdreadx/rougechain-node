/**
 * PQC Messenger — E2E encryption with ML-KEM-768 + ML-DSA-65
 * Adapted from quantum-vault/src/lib/pqc-messenger.ts
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import { ml_kem768 } from "@noble/post-quantum/ml-kem";

export interface Wallet {
    id: string;
    displayName: string;
    signingPublicKey: string;
    encryptionPublicKey: string;
    createdAt?: string;
}

export interface WalletWithPrivateKeys extends Wallet {
    signingPrivateKey: string;
    encryptionPrivateKey: string;
}

export interface Message {
    id: string;
    conversationId: string;
    senderWalletId: string;
    encryptedContent: string;
    signature: string;
    selfDestruct: boolean;
    destructAfterSeconds?: number;
    readAt?: string;
    createdAt: string;
    plaintext?: string;
    signatureValid?: boolean;
    senderDisplayName?: string;
}

export interface Conversation {
    id: string;
    name?: string;
    isGroup: boolean;
    createdBy?: string;
    createdAt: string;
    participantIds?: string[];
    participants?: Wallet[];
    lastMessage?: Message;
}

const MESSENGER_API_PREFIX = "/messenger";

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function getMessengerApiBase(): string | null {
    const base = getCoreApiBaseUrl();
    return base ? `${base}${MESSENGER_API_PREFIX}` : null;
}

export async function registerWalletOnNode(wallet: Wallet): Promise<void> {
    const apiBase = getMessengerApiBase();
    if (!apiBase) throw new Error("Node not configured");

    const res = await fetch(`${apiBase}/wallets`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            id: wallet.id,
            display_name: wallet.displayName,
            signing_public_key: wallet.signingPublicKey,
            encryption_public_key: wallet.encryptionPublicKey,
        }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${await res.text()}`);
}

export async function encryptMessage(
    plaintext: string,
    recipientEncryptionPublicKey: string,
    senderSigningPrivateKey: string
): Promise<{ encryptedPackage: string; signature: string }> {
    const recipientPubKeyBytes = hexToBytes(recipientEncryptionPublicKey);
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(recipientPubKeyBytes);

    const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
    const aesKey = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("pqc-msg") },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        aesKey,
        new TextEncoder().encode(plaintext)
    );

    const encryptedPackage = JSON.stringify({
        kemCipherText: bytesToHex(cipherText),
        iv: bytesToHex(iv),
        encryptedContent: bytesToHex(new Uint8Array(encrypted)),
    });

    const signerPrivKey = hexToBytes(senderSigningPrivateKey);
    const signature = ml_dsa65.sign(new TextEncoder().encode(encryptedPackage), signerPrivKey);

    return {
        encryptedPackage,
        signature: bytesToHex(signature),
    };
}

export async function decryptMessage(
    encryptedPackage: string,
    recipientEncryptionPrivateKey: string,
    senderSigningPublicKey: string,
    signature: string
): Promise<{ plaintext: string; signatureValid: boolean }> {
    let signatureValid = false;
    try {
        const sigBytes = hexToBytes(signature);
        const pubKeyBytes = hexToBytes(senderSigningPublicKey);
        signatureValid = ml_dsa65.verify(sigBytes, new TextEncoder().encode(encryptedPackage), pubKeyBytes);
    } catch { /* noop */ }

    const parsed = JSON.parse(encryptedPackage);
    const cipherTextBytes = hexToBytes(parsed.kemCipherText);
    const privKeyBytes = hexToBytes(recipientEncryptionPrivateKey);
    const sharedSecret = ml_kem768.decapsulate(cipherTextBytes, privKeyBytes);

    const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
    const aesKey = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("pqc-msg") },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: hexToBytes(parsed.iv) },
        aesKey,
        hexToBytes(parsed.encryptedContent)
    );

    return {
        plaintext: new TextDecoder().decode(decrypted),
        signatureValid,
    };
}

export function generateEncryptionKeypair(): { publicKey: string; privateKey: string } {
    const keypair = ml_kem768.keygen();
    return {
        publicKey: bytesToHex(keypair.publicKey),
        privateKey: bytesToHex(keypair.secretKey),
    };
}

export async function createWallet(displayName: string): Promise<WalletWithPrivateKeys> {
    const { generateKeypair } = await import("./pqc-blockchain");
    const { keypair: signingKeypair } = await generateKeypair();
    const encKeypair = generateEncryptionKeypair();
    const id = crypto.randomUUID();

    const wallet: WalletWithPrivateKeys = {
        id,
        displayName,
        signingPublicKey: signingKeypair.publicKey,
        signingPrivateKey: signingKeypair.privateKey,
        encryptionPublicKey: encKeypair.publicKey,
        encryptionPrivateKey: encKeypair.privateKey,
        createdAt: new Date().toISOString(),
    };

    await registerWalletOnNode(wallet);
    return wallet;
}

export async function getWallets(): Promise<Wallet[]> {
    const apiBase = getMessengerApiBase();
    if (!apiBase) return [];
    try {
        const res = await fetch(`${apiBase}/wallets`, { headers: getCoreApiHeaders() });
        if (!res.ok) return [];
        const data = await res.json();
        const wallets = data.wallets || data || [];
        return wallets.map((w: any) => ({
            id: w.id,
            displayName: w.display_name || w.displayName || "Unknown",
            signingPublicKey: w.signing_public_key || w.signingPublicKey || "",
            encryptionPublicKey: w.encryption_public_key || w.encryptionPublicKey || "",
            createdAt: w.created_at || w.createdAt,
        }));
    } catch { return []; }
}

export async function createConversation(
    walletId: string,
    participantIds: string[],
    name?: string
): Promise<Conversation> {
    const apiBase = getMessengerApiBase();
    if (!apiBase) throw new Error("Node not configured");

    const res = await fetch(`${apiBase}/conversations`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            created_by: walletId,
            participant_ids: participantIds,
            name,
            is_group: participantIds.length > 2,
        }),
    });
    if (!res.ok) throw new Error(`Failed to create conversation: ${await res.text()}`);
    const data = await res.json();
    return normalizeConversation(data);
}

export async function getConversations(walletId: string): Promise<Conversation[]> {
    const apiBase = getMessengerApiBase();
    if (!apiBase) return [];
    try {
        const res = await fetch(`${apiBase}/conversations?wallet_id=${walletId}`, {
            headers: getCoreApiHeaders(),
        });
        if (!res.ok) return [];
        const data = await res.json();
        const convos = data.conversations || data || [];
        return convos.map(normalizeConversation);
    } catch { return []; }
}

export async function sendMessage(
    conversationId: string,
    plaintext: string,
    wallet: WalletWithPrivateKeys,
    recipientEncryptionPublicKey: string,
    selfDestruct: boolean = false,
    destructAfterSeconds?: number
): Promise<Message> {
    const apiBase = getMessengerApiBase();
    if (!apiBase) throw new Error("Node not configured");

    const { encryptedPackage, signature } = await encryptMessage(
        plaintext, recipientEncryptionPublicKey, wallet.signingPrivateKey
    );

    const res = await fetch(`${apiBase}/messages`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            conversation_id: conversationId,
            sender_wallet_id: wallet.id,
            encrypted_content: encryptedPackage,
            signature,
            self_destruct: selfDestruct,
            destruct_after_seconds: destructAfterSeconds,
        }),
    });
    if (!res.ok) throw new Error(`Send failed: ${await res.text()}`);
    const data = await res.json();

    return {
        id: data.id || crypto.randomUUID(),
        conversationId,
        senderWalletId: wallet.id,
        encryptedContent: encryptedPackage,
        signature,
        selfDestruct,
        destructAfterSeconds,
        createdAt: data.created_at || new Date().toISOString(),
        plaintext,
        signatureValid: true,
        senderDisplayName: wallet.displayName,
    };
}

export async function getMessages(
    conversationId: string,
    wallet: WalletWithPrivateKeys,
    participants: Wallet[]
): Promise<Message[]> {
    const apiBase = getMessengerApiBase();
    if (!apiBase) return [];

    try {
        const res = await fetch(
            `${apiBase}/conversations/${conversationId}/messages`,
            { headers: getCoreApiHeaders() }
        );
        if (!res.ok) return [];
        const data = await res.json();
        const rawMessages = data.messages || data || [];

        const messages: Message[] = [];
        for (const raw of rawMessages) {
            const msg = normalizeMessage(raw);
            const isOwn = msg.senderWalletId === wallet.id ||
                msg.senderWalletId === wallet.signingPublicKey;

            let plaintext = "[Unable to decrypt]";
            let signatureValid = false;

            try {
                const senderParticipant = participants.find(p =>
                    p.id === msg.senderWalletId ||
                    p.signingPublicKey === msg.senderWalletId
                );
                const senderSigningKey = senderParticipant?.signingPublicKey || "";

                if (isOwn) {
                    // Try to decrypt own messages with recipient's key
                    const recipient = participants.find(p => p.id !== wallet.id);
                    if (recipient) {
                        const result = await decryptMessage(
                            msg.encryptedContent,
                            wallet.encryptionPrivateKey,
                            senderSigningKey || wallet.signingPublicKey,
                            msg.signature
                        );
                        plaintext = result.plaintext;
                        signatureValid = result.signatureValid;
                    }
                } else {
                    const result = await decryptMessage(
                        msg.encryptedContent,
                        wallet.encryptionPrivateKey,
                        senderSigningKey,
                        msg.signature
                    );
                    plaintext = result.plaintext;
                    signatureValid = result.signatureValid;
                }
            } catch {
                plaintext = "[Unable to decrypt]";
            }

            messages.push({
                ...msg,
                plaintext,
                signatureValid,
                senderDisplayName: participants.find(p =>
                    p.id === msg.senderWalletId || p.signingPublicKey === msg.senderWalletId
                )?.displayName || "Unknown",
            });
        }
        return messages;
    } catch { return []; }
}

function normalizeMessage(raw: any): Message {
    return {
        id: raw.id,
        conversationId: raw.conversation_id || raw.conversationId,
        senderWalletId: raw.sender_wallet_id || raw.senderWalletId,
        encryptedContent: raw.encrypted_content || raw.encryptedContent,
        signature: raw.signature,
        selfDestruct: raw.self_destruct || raw.selfDestruct || false,
        destructAfterSeconds: raw.destruct_after_seconds || raw.destructAfterSeconds,
        readAt: raw.read_at || raw.readAt,
        createdAt: raw.created_at || raw.createdAt,
    };
}

function normalizeConversation(raw: any): Conversation {
    return {
        id: raw.id,
        name: raw.name,
        isGroup: raw.is_group || raw.isGroup || false,
        createdBy: raw.created_by || raw.createdBy,
        createdAt: raw.created_at || raw.createdAt,
        participantIds: raw.participant_ids || raw.participantIds,
        participants: (raw.participants || []).map((p: any) => ({
            id: p.id,
            displayName: p.display_name || p.displayName || "Unknown",
            signingPublicKey: p.signing_public_key || p.signingPublicKey || "",
            encryptionPublicKey: p.encryption_public_key || p.encryptionPublicKey || "",
        })),
    };
}
