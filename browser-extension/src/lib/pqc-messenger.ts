/**
 * PQC Messenger — E2E encryption with ML-KEM-768 + ML-DSA-65
 * Adapted from quantum-vault/src/lib/pqc-messenger.ts
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";
import { cachedFetch, invalidate } from "./api-cache";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

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

export type MessageType = "text" | "image" | "video";

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
    // Media support
    messageType?: MessageType;
    mediaUrl?: string;
    mediaFileName?: string;
    // Spoiler support
    spoiler?: boolean;
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

// Media support
export const MAX_MEDIA_SIZE = 10 * 1024 * 1024; // 10 MB

interface MediaPayload {
    type: "image" | "video";
    fileName: string;
    mimeType: string;
    data: string;
}

export async function fileToMediaPayload(file: File): Promise<{ payload: string; messageType: MessageType }> {
    if (file.size > MAX_MEDIA_SIZE) {
        throw new Error(`File too large. Maximum size is ${MAX_MEDIA_SIZE / (1024 * 1024)} MB.`);
    }
    const messageType: MessageType = file.type.startsWith("video/") ? "video" : "image";
    const buffer = await file.arrayBuffer();
    const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
    );
    const envelope: MediaPayload = { type: messageType, fileName: file.name, mimeType: file.type, data: base64 };
    return { payload: JSON.stringify(envelope), messageType };
}

function parseMediaPayload(plaintext: string): { mediaUrl: string; mediaFileName: string; messageType: MessageType } | null {
    try {
        const envelope = JSON.parse(plaintext) as MediaPayload;
        if (envelope.type && envelope.data && (envelope.type === "image" || envelope.type === "video")) {
            return {
                mediaUrl: `data:${envelope.mimeType};base64,${envelope.data}`,
                mediaFileName: envelope.fileName || "media",
                messageType: envelope.type,
            };
        }
    } catch { /* not media */ }
    return null;
}

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

    const res = await fetch(`${apiBase}/wallets/register`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            id: wallet.id,
            displayName: wallet.displayName,
            signingPublicKey: wallet.signingPublicKey,
            encryptionPublicKey: wallet.encryptionPublicKey,
        }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${await res.text()}`);
    const data = await res.json();
    if (data.success === false) throw new Error(data.error || "Registration failed");
}

async function kemEncryptPlaintext(
    plaintext: string,
    encryptionPublicKey: Uint8Array
): Promise<{ kemCipherText: string; iv: string; encryptedContent: string }> {
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(encryptionPublicKey);

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

    return {
        kemCipherText: bytesToHex(cipherText),
        iv: bytesToHex(iv),
        encryptedContent: bytesToHex(new Uint8Array(encrypted)),
    };
}

export async function encryptMessage(
    plaintext: string,
    recipientEncryptionPublicKey: string,
    senderSigningPrivateKey: string,
    senderEncryptionPublicKey?: string
): Promise<{ encryptedPackage: string; signature: string }> {
    const recipientPubKeyBytes = hexToBytes(recipientEncryptionPublicKey);
    const recipientEnc = await kemEncryptPlaintext(plaintext, recipientPubKeyBytes);

    const pkg: Record<string, string> = { ...recipientEnc };

    if (senderEncryptionPublicKey) {
        const senderPubKeyBytes = hexToBytes(senderEncryptionPublicKey);
        const senderEnc = await kemEncryptPlaintext(plaintext, senderPubKeyBytes);
        pkg.senderKemCipherText = senderEnc.kemCipherText;
        pkg.senderIv = senderEnc.iv;
        pkg.senderEncryptedContent = senderEnc.encryptedContent;
    }

    const encryptedPackage = JSON.stringify(pkg);

    const signerPrivKey = hexToBytes(senderSigningPrivateKey);
    if (signerPrivKey.length !== 4032) {
        throw new Error(
            `Signing key invalid (${signerPrivKey.length} bytes, expected 4032). ` +
            `Please go to Settings and create a new wallet to regenerate FIPS 204 keys.`
        );
    }
    const signature = ml_dsa65.sign(signerPrivKey, new TextEncoder().encode(encryptedPackage));

    return {
        encryptedPackage,
        signature: bytesToHex(signature),
    };
}

async function kemDecryptContent(
    kemCipherTextHex: string,
    ivHex: string,
    encryptedContentHex: string,
    encryptionPrivateKey: Uint8Array
): Promise<string> {
    const sharedSecret = ml_kem768.decapsulate(hexToBytes(kemCipherTextHex), encryptionPrivateKey);

    const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
    const aesKey = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("pqc-msg") },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: hexToBytes(ivHex) },
        aesKey,
        hexToBytes(encryptedContentHex)
    );

    return new TextDecoder().decode(decrypted);
}

export async function decryptMessage(
    encryptedPackage: string,
    recipientEncryptionPrivateKey: string,
    senderSigningPublicKey: string,
    signature: string,
    isSender: boolean = false
): Promise<{ plaintext: string; signatureValid: boolean }> {
    let signatureValid = false;
    try {
        const sigBytes = hexToBytes(signature);
        const pubKeyBytes = hexToBytes(senderSigningPublicKey);
        signatureValid = ml_dsa65.verify(pubKeyBytes, new TextEncoder().encode(encryptedPackage), sigBytes);
    } catch { /* noop */ }

    const parsed = JSON.parse(encryptedPackage);
    const privKeyBytes = hexToBytes(recipientEncryptionPrivateKey);

    let plaintext: string;

    if (isSender && parsed.senderKemCipherText) {
        plaintext = await kemDecryptContent(
            parsed.senderKemCipherText,
            parsed.senderIv,
            parsed.senderEncryptedContent,
            privKeyBytes
        );
    } else {
        plaintext = await kemDecryptContent(
            parsed.kemCipherText,
            parsed.iv,
            parsed.encryptedContent,
            privKeyBytes
        );
    }

    return { plaintext, signatureValid };
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
        return await cachedFetch("messengerWallets", "all", async () => {
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
        });
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
            createdBy: walletId,
            participantIds,
            name,
            isGroup: participantIds.length > 2,
        }),
    });
    if (!res.ok) throw new Error(`Failed to create conversation: ${await res.text()}`);
    invalidate("messengerConversations");
    const data = await res.json();
    return normalizeConversation(data.conversation || data);
}

export async function getConversations(walletId: string): Promise<Conversation[]> {
    const apiBase = getMessengerApiBase();
    if (!apiBase) return [];
    try {
        return await cachedFetch("messengerConversations", walletId, async () => {
            const res = await fetch(`${apiBase}/conversations?walletId=${walletId}`, {
                headers: getCoreApiHeaders(),
            });
            if (!res.ok) return [];
            const data = await res.json();
            const convos = data.conversations || data || [];
            return convos.map(normalizeConversation);
        });
    } catch { return []; }
}

export async function deleteConversation(conversationId: string): Promise<void> {
    const apiBase = getMessengerApiBase();
    if (!apiBase) throw new Error("Node not configured");
    const res = await fetch(`${apiBase}/conversations/${encodeURIComponent(conversationId)}`, {
        method: "DELETE",
        headers: getCoreApiHeaders(),
    });
    if (!res.ok) throw new Error(`Delete failed: ${await res.text()}`);
    invalidate("messengerConversations");
    invalidate("messengerMessages", conversationId);
}

export async function sendMessage(
    conversationId: string,
    plaintext: string,
    wallet: WalletWithPrivateKeys,
    recipientEncryptionPublicKey: string,
    selfDestruct: boolean = false,
    destructAfterSeconds?: number,
    messageType: MessageType = "text",
    spoiler: boolean = false
): Promise<Message> {
    const apiBase = getMessengerApiBase();
    if (!apiBase) throw new Error("Node not configured");

    const { encryptedPackage, signature } = await encryptMessage(
        plaintext, recipientEncryptionPublicKey, wallet.signingPrivateKey,
        wallet.encryptionPublicKey
    );

    const res = await fetch(`${apiBase}/messages`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            conversationId,
            senderWalletId: wallet.id,
            encryptedContent: encryptedPackage,
            signature,
            selfDestruct,
            destructAfterSeconds,
            messageType,
            spoiler,
        }),
    });
    if (!res.ok) throw new Error(`Send failed: ${await res.text()}`);
    invalidate("messengerMessages", conversationId);
    const data = await res.json();

    const mediaInfo = messageType !== "text" ? parseMediaPayload(plaintext) : null;

    return {
        id: data.id || crypto.randomUUID(),
        conversationId,
        senderWalletId: wallet.id,
        encryptedContent: encryptedPackage,
        signature,
        selfDestruct,
        destructAfterSeconds,
        createdAt: data.created_at || new Date().toISOString(),
        plaintext: mediaInfo ? mediaInfo.mediaFileName : plaintext,
        signatureValid: true,
        senderDisplayName: wallet.displayName,
        messageType,
        mediaUrl: mediaInfo?.mediaUrl,
        mediaFileName: mediaInfo?.mediaFileName,
        spoiler,
    };
}

async function fetchRawMessages(conversationId: string): Promise<unknown[]> {
    const apiBase = getMessengerApiBase();
    if (!apiBase) return [];
    return cachedFetch("messengerMessages", conversationId, async () => {
        const res = await fetch(
            `${apiBase}/messages?conversationId=${encodeURIComponent(conversationId)}`,
            { headers: getCoreApiHeaders() }
        );
        if (!res.ok) return [];
        const data = await res.json();
        return data.messages || data || [];
    });
}

export async function getMessages(
    conversationId: string,
    wallet: WalletWithPrivateKeys,
    participants: Wallet[]
): Promise<Message[]> {
    try {
        const rawMessages = await fetchRawMessages(conversationId);

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
                const senderSigningKey = senderParticipant?.signingPublicKey || wallet.signingPublicKey;

                const result = await decryptMessage(
                    msg.encryptedContent,
                    wallet.encryptionPrivateKey,
                    senderSigningKey,
                    msg.signature,
                    isOwn
                );
                plaintext = result.plaintext;
                signatureValid = result.signatureValid;
            } catch {
                plaintext = "[Unable to decrypt]";
            }

            // Detect garbage decryption output — if most chars are non-printable,
            // the wrong key was used and decryption produced nonsense
            if (plaintext !== "[Unable to decrypt]" && plaintext.length > 20) {
                const nonPrintable = [...plaintext].filter(c => {
                    const code = c.charCodeAt(0);
                    return code < 32 && code !== 10 && code !== 13 && code !== 9;
                }).length;
                if (nonPrintable / plaintext.length > 0.1) {
                    plaintext = "[Unable to decrypt]";
                }
            }

            const rawMsgType = (raw.message_type || raw.messageType || "text") as MessageType;

            // Always try to parse media from decrypted plaintext —
            // backend may default messageType to "text" even for images
            const mediaInfo = plaintext !== "[Unable to decrypt]"
                ? parseMediaPayload(plaintext)
                : null;

            // If decryption failed and this is supposed to be a media message,
            // show a clean placeholder instead of garbled bytecode
            let displayPlaintext = plaintext;
            if (plaintext === "[Unable to decrypt]" && rawMsgType !== "text") {
                displayPlaintext = `[${rawMsgType === "image" ? "Image" : "Video"} — unable to decrypt]`;
            }

            messages.push({
                ...msg,
                plaintext: mediaInfo?.mediaFileName || displayPlaintext,
                signatureValid,
                senderDisplayName: participants.find(p =>
                    p.id === msg.senderWalletId || p.signingPublicKey === msg.senderWalletId
                )?.displayName || "Unknown",
                messageType: mediaInfo?.messageType || rawMsgType,
                mediaUrl: mediaInfo?.mediaUrl,
                mediaFileName: mediaInfo?.mediaFileName,
                spoiler: raw.spoiler ?? false,
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
        messageType: (raw.message_type || raw.messageType || "text") as MessageType,
        spoiler: raw.spoiler ?? false,
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
