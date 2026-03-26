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
    lastMessageAt?: string;
    lastSenderId?: string;
    lastMessagePreview?: string;
    unreadCount?: number;
}

const MESSENGER_API_PREFIX = "/messenger";
const BLOCKED_WALLETS_KEY = "pqc_blocked_wallets";
const TOFU_STORE_KEY = "pqc_tofu_fingerprints";

// --- Key fingerprint & TOFU helpers ---

export async function keyFingerprint(publicKeyHex: string): Promise<string> {
    if (!publicKeyHex) return "";
    const hash = await crypto.subtle.digest("SHA-256", hexToBytes(publicKeyHex));
    const hex = bytesToHex(new Uint8Array(hash));
    return hex.substring(0, 32).replace(/(.{4})/g, "$1 ").trim().toUpperCase();
}

interface TofuEntry {
    walletId: string;
    signingFingerprint: string;
    encryptionFingerprint: string;
    firstSeen: number;
}

function loadTofuStore(): Record<string, TofuEntry> {
    try { const raw = localStorage.getItem(TOFU_STORE_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function saveTofuStore(store: Record<string, TofuEntry>): void {
    localStorage.setItem(TOFU_STORE_KEY, JSON.stringify(store));
}

export async function checkTofu(wallet: Wallet): Promise<{ trusted: boolean; changed: boolean; firstSeen: number }> {
    const store = loadTofuStore();
    const sigFp = await keyFingerprint(wallet.signingPublicKey);
    const encFp = await keyFingerprint(wallet.encryptionPublicKey);
    const key = wallet.id;
    const existing = store[key];
    if (!existing) {
        store[key] = { walletId: wallet.id, signingFingerprint: sigFp, encryptionFingerprint: encFp, firstSeen: Date.now() };
        saveTofuStore(store);
        return { trusted: true, changed: false, firstSeen: Date.now() };
    }
    const changed = existing.signingFingerprint !== sigFp || existing.encryptionFingerprint !== encFp;
    if (changed) { store[key] = { ...existing, signingFingerprint: sigFp, encryptionFingerprint: encFp }; saveTofuStore(store); }
    return { trusted: !changed, changed, firstSeen: existing.firstSeen };
}

// --- Block list helpers ---

export function getBlockedWalletIds(): string[] {
    try {
        const raw = localStorage.getItem(BLOCKED_WALLETS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

export function blockWallet(walletId: string): void {
    const list = new Set(getBlockedWalletIds());
    list.add(walletId);
    localStorage.setItem(BLOCKED_WALLETS_KEY, JSON.stringify([...list]));
}

export function unblockWallet(walletId: string): void {
    const list = new Set(getBlockedWalletIds());
    list.delete(walletId);
    localStorage.setItem(BLOCKED_WALLETS_KEY, JSON.stringify([...list]));
}

export function isWalletBlocked(walletId: string): boolean {
    return getBlockedWalletIds().includes(walletId);
}

// Media support
export const MAX_MEDIA_SIZE = 50 * 1024 * 1024; // 50 MB input (will be compressed)
const TARGET_PAYLOAD_BYTES = 1.5 * 1024 * 1024;
const IMAGE_MAX_DIM = 1600;
const VIDEO_MAX_DIM = 640;
const VIDEO_MAX_DURATION_S = 30;

interface MediaPayload {
    type: "image" | "video";
    fileName: string;
    mimeType: string;
    data: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

async function compressImage(file: File): Promise<{ blob: Blob; mimeType: string }> {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;

    if (width > IMAGE_MAX_DIM || height > IMAGE_MAX_DIM) {
        const scale = IMAGE_MAX_DIM / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    for (const quality of [0.8, 0.6, 0.4, 0.25]) {
        const blob = await canvas.convertToBlob({ type: "image/webp", quality });
        if (blob.size <= TARGET_PAYLOAD_BYTES) return { blob, mimeType: "image/webp" };
    }

    const dim2 = Math.round(IMAGE_MAX_DIM * 0.5);
    const scale2 = dim2 / Math.max(width, height);
    const w2 = Math.round(width * scale2);
    const h2 = Math.round(height * scale2);
    const canvas2 = new OffscreenCanvas(w2, h2);
    const ctx2 = canvas2.getContext("2d")!;
    const bmp2 = await createImageBitmap(file);
    ctx2.drawImage(bmp2, 0, 0, w2, h2);
    bmp2.close();
    const blob = await canvas2.convertToBlob({ type: "image/webp", quality: 0.5 });
    return { blob, mimeType: "image/webp" };
}

async function compressVideo(file: File): Promise<{ blob: Blob; mimeType: string }> {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;

    const url = URL.createObjectURL(file);
    video.src = url;

    await new Promise<void>((res, rej) => {
        video.onloadedmetadata = () => res();
        video.onerror = () => rej(new Error("Cannot load video"));
    });

    const duration = Math.min(video.duration, VIDEO_MAX_DURATION_S);
    let { videoWidth: w, videoHeight: h } = video;
    if (w > VIDEO_MAX_DIM || h > VIDEO_MAX_DIM) {
        const scale = VIDEO_MAX_DIM / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;

    const targetBitsPerSec = Math.floor((TARGET_PAYLOAD_BYTES * 8) / duration * 0.85);
    const stream = canvas.captureStream(15);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm";

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: targetBitsPerSec });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const done = new Promise<Blob>((res) => {
        recorder.onstop = () => res(new Blob(chunks, { type: "video/webm" }));
    });

    video.currentTime = 0;
    await new Promise<void>((r) => { video.onseeked = () => r(); });
    video.play();
    recorder.start();

    await new Promise<void>((res) => {
        const draw = () => {
            if (video.ended || video.currentTime >= duration) {
                recorder.stop();
                video.pause();
                res();
                return;
            }
            ctx.drawImage(video, 0, 0, w, h);
            requestAnimationFrame(draw);
        };
        draw();
    });

    URL.revokeObjectURL(url);
    return { blob: await done, mimeType: "video/webm" };
}

export async function fileToMediaPayload(file: File): Promise<{ payload: string; messageType: MessageType }> {
    if (file.size > MAX_MEDIA_SIZE) {
        throw new Error(`File too large. Maximum size is ${MAX_MEDIA_SIZE / (1024 * 1024)} MB.`);
    }
    const messageType: MessageType = file.type.startsWith("video/") ? "video" : "image";

    let blob: Blob;
    let mimeType: string;

    if (messageType === "image") {
        ({ blob, mimeType } = await compressImage(file));
    } else {
        ({ blob, mimeType } = await compressVideo(file));
    }

    const base64 = arrayBufferToBase64(await blob.arrayBuffer());
    const envelope: MediaPayload = {
        type: messageType,
        fileName: file.name.replace(/\.[^.]+$/, messageType === "image" ? ".webp" : ".webm"),
        mimeType,
        data: base64,
    };
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

function sortKeysDeep(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(sortKeysDeep);
    if (obj !== null && typeof obj === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
            sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return obj;
}

export function buildSignedRequest(
    payload: Record<string, unknown>,
    signingPrivateKey: string,
    signingPublicKey: string,
): { payload: Record<string, unknown>; signature: string; public_key: string } {
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const fullPayload: Record<string, unknown> = {
        ...payload,
        from: signingPublicKey,
        timestamp: Date.now(),
        nonce,
    };
    const sorted = sortKeysDeep(fullPayload) as Record<string, unknown>;
    const json = JSON.stringify(sorted);
    const bytes = new TextEncoder().encode(json);
    const sig = ml_dsa65.sign(bytes, hexToBytes(signingPrivateKey));
    return {
        payload: sorted,
        signature: bytesToHex(sig),
        public_key: signingPublicKey,
    };
}

export async function registerWalletOnNode(wallet: Wallet | WalletWithPrivateKeys): Promise<void> {
    const base = getCoreApiBaseUrl();
    if (!base) throw new Error("Node not configured");

    const priv = (wallet as WalletWithPrivateKeys).signingPrivateKey;
    if (priv) {
        const signed = buildSignedRequest(
            {
                id: wallet.id,
                displayName: wallet.displayName,
                signingPublicKey: wallet.signingPublicKey,
                encryptionPublicKey: wallet.encryptionPublicKey,
            },
            priv,
            wallet.signingPublicKey,
        );
        const res = await fetch(`${base}/v2/messenger/wallets/register`, {
            method: "POST",
            headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(signed),
        });
        if (!res.ok) throw new Error(`Registration failed: ${await res.text()}`);
        const data = await res.json();
        if (data.success === false) throw new Error(data.error || "Registration failed");
    } else {
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
}

async function kemEncryptPlaintext(
    plaintext: string,
    encryptionPublicKey: Uint8Array
): Promise<{ kemCipherText: string; iv: string; encryptedContent: string }> {
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(encryptionPublicKey);

    const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]);
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
    const signature = ml_dsa65.sign(new TextEncoder().encode(encryptedPackage), signerPrivKey);

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

    const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]);
    const aesKey = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("pqc-msg") },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: hexToBytes(ivHex).buffer as ArrayBuffer },
        aesKey,
        hexToBytes(encryptedContentHex).buffer as ArrayBuffer
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
    if (senderSigningPublicKey && signature) {
        try {
            const sigBytes = hexToBytes(signature);
            const pubKeyBytes = hexToBytes(senderSigningPublicKey);
            signatureValid = ml_dsa65.verify(sigBytes, new TextEncoder().encode(encryptedPackage), pubKeyBytes);
        } catch { /* noop */ }
    }

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
    wallet: WalletWithPrivateKeys,
    participantIds: string[],
    name?: string
): Promise<Conversation> {
    const base = getCoreApiBaseUrl();
    if (!base) throw new Error("Node not configured");

    const signed = buildSignedRequest(
        { participantIds, name, isGroup: participantIds.length > 2 },
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
    );
    const res = await fetch(`${base}/v2/messenger/conversations`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(signed),
    });
    if (!res.ok) throw new Error(`Failed to create conversation: ${await res.text()}`);
    invalidate("messengerConversations");
    const data = await res.json();
    return normalizeConversation(data.conversation || data);
}

export async function getConversations(walletId: string, currentWallet?: Wallet | WalletWithPrivateKeys): Promise<Conversation[]> {
    const base = getCoreApiBaseUrl();
    if (!base) return [];
    try {
        const all = await cachedFetch("messengerConversations", walletId, async () => {
            const privKey = (currentWallet as WalletWithPrivateKeys)?.signingPrivateKey;
            let convos: any[];
            if (privKey && currentWallet?.signingPublicKey) {
                const signed = buildSignedRequest({}, privKey, currentWallet.signingPublicKey);
                const res = await fetch(`${base}/v2/messenger/conversations/list`, {
                    method: "POST",
                    headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
                    body: JSON.stringify(signed),
                });
                if (!res.ok) return [];
                const data = await res.json();
                convos = data.conversations || data || [];
            } else {
                const apiBase = getMessengerApiBase();
                if (!apiBase) return [];
                const params = new URLSearchParams({ walletId });
                if (currentWallet?.signingPublicKey) params.set("signingPublicKey", currentWallet.signingPublicKey);
                if (currentWallet?.encryptionPublicKey) params.set("encryptionPublicKey", currentWallet.encryptionPublicKey);
                const res = await fetch(`${apiBase}/conversations?${params.toString()}`, {
                    headers: getCoreApiHeaders(),
                });
                if (!res.ok) return [];
                const data = await res.json();
                convos = data.conversations || data || [];
            }

            const allWallets = await getWallets();
            const walletMap = new Map<string, Wallet>();
            for (const w of allWallets) {
                if (w.id) walletMap.set(w.id, w);
                if (w.signingPublicKey) walletMap.set(w.signingPublicKey, w);
                if (w.encryptionPublicKey) walletMap.set(w.encryptionPublicKey, w);
            }

            const currentIds = currentWallet
                ? new Set([currentWallet.id, currentWallet.signingPublicKey, currentWallet.encryptionPublicKey].filter(Boolean))
                : new Set<string>();

            return convos.map((raw: any) => {
                const conv = normalizeConversation(raw);
                if ((!conv.participants || conv.participants.length === 0) && conv.participantIds?.length) {
                    conv.participants = conv.participantIds
                        .map((id: any) => {
                            if (currentWallet && currentIds.has(id)) return currentWallet;
                            const w = walletMap.get(id);
                            if (w) return w;
                            return allWallets.find(aw =>
                                aw.id === id || aw.signingPublicKey === id || aw.encryptionPublicKey === id
                            );
                        })
                        .filter((w): w is Wallet => w !== undefined);
                }
                return conv;
            });
        });
        const blocked = new Set(getBlockedWalletIds());
        if (blocked.size === 0) return all;
        return all.filter((conv: any) => {
            const hasBlocked = conv.participants?.some((p: any) =>
                blocked.has(p.id) || blocked.has(p.signingPublicKey) || blocked.has(p.encryptionPublicKey)
            ) || conv.participantIds?.some((id: any) => blocked.has(id));
            return !hasBlocked;
        });
    } catch { return []; }
}

export async function deleteConversation(wallet: WalletWithPrivateKeys, conversationId: string): Promise<void> {
    const base = getCoreApiBaseUrl();
    if (!base) throw new Error("Node not configured");
    const signed = buildSignedRequest(
        { conversationId },
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
    );
    const res = await fetch(`${base}/v2/messenger/conversations/delete`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(signed),
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

    const base = getCoreApiBaseUrl();
    const signed = buildSignedRequest(
        {
            conversationId,
            encryptedContent: encryptedPackage,
            contentSignature: signature,
            selfDestruct,
            destructAfterSeconds,
            messageType,
            spoiler,
        },
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
    );
    const res = await fetch(`${base}/v2/messenger/messages`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(signed),
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

async function fetchRawMessages(conversationId: string, wallet: WalletWithPrivateKeys): Promise<unknown[]> {
    const base = getCoreApiBaseUrl();
    if (!base) return [];
    return cachedFetch("messengerMessages", conversationId, async () => {
        const signed = buildSignedRequest(
            { conversationId },
            wallet.signingPrivateKey,
            wallet.signingPublicKey,
        );
        const res = await fetch(`${base}/v2/messenger/messages/list`, {
            method: "POST",
            headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(signed),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return data.messages || data || [];
    });
}

function findParticipant(participants: Wallet[], senderWalletId: string): Wallet | undefined {
    return participants.find(p =>
        p.id === senderWalletId ||
        p.signingPublicKey === senderWalletId ||
        p.encryptionPublicKey === senderWalletId
    );
}

export async function getMessages(
    conversationId: string,
    wallet: WalletWithPrivateKeys,
    participants: Wallet[]
): Promise<Message[]> {
    try {
        const rawMessages = await fetchRawMessages(conversationId, wallet);

        let allParticipants = participants;
        if (!allParticipants.length) {
            try {
                const wallets = await getWallets();
                allParticipants = wallets;
            } catch { /* use empty */ }
        }

        const messages: Message[] = [];
        for (const raw of rawMessages) {
            const msg = normalizeMessage(raw);
            const isOwn = msg.senderWalletId === wallet.id ||
                msg.senderWalletId === wallet.signingPublicKey ||
                msg.senderWalletId === wallet.encryptionPublicKey;

            let plaintext = "[Unable to decrypt]";
            let signatureValid = false;

            let sender = findParticipant(allParticipants, msg.senderWalletId);
            if (!sender && msg.senderWalletId) {
                try {
                    const wallets = await getWallets();
                    sender = findParticipant(wallets, msg.senderWalletId);
                } catch { /* ignore */ }
            }
            // Last resort: in 1:1 chats, use the other participant
            if (!sender && allParticipants.length >= 2) {
                sender = allParticipants.find(p =>
                    p.id !== wallet.id && p.signingPublicKey !== wallet.signingPublicKey
                );
            }

            try {
                const senderSigningKey = sender?.signingPublicKey || wallet.signingPublicKey;

                const result = await decryptMessage(
                    msg.encryptedContent,
                    wallet.encryptionPrivateKey,
                    senderSigningKey,
                    msg.signature,
                    isOwn
                );
                plaintext = result.plaintext;
                signatureValid = result.signatureValid;

                if (!isOwn && msg.selfDestruct && !msg.readAt) {
                    const readBase = getCoreApiBaseUrl();
                    if (readBase) {
                        const readSigned = buildSignedRequest(
                            { messageId: msg.id, conversationId },
                            wallet.signingPrivateKey,
                            wallet.signingPublicKey,
                        );
                        fetch(`${readBase}/v2/messenger/messages/read`, {
                            method: "POST",
                            headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
                            body: JSON.stringify(readSigned),
                        }).catch(() => {});
                    }
                }
            } catch {
                plaintext = "[Unable to decrypt]";
            }

            if (plaintext !== "[Unable to decrypt]" && plaintext.length > 20) {
                const nonPrintable = [...plaintext].filter(c => {
                    const code = c.charCodeAt(0);
                    return code < 32 && code !== 10 && code !== 13 && code !== 9;
                }).length;
                if (nonPrintable / plaintext.length > 0.1) {
                    plaintext = "[Unable to decrypt]";
                }
            }

            const rawMsgType = ((raw as any).message_type || (raw as any).messageType || "text") as MessageType;

            const mediaInfo = plaintext !== "[Unable to decrypt]"
                ? parseMediaPayload(plaintext)
                : null;

            let displayPlaintext = plaintext;
            if (plaintext === "[Unable to decrypt]" && rawMsgType !== "text") {
                displayPlaintext = `[${rawMsgType === "image" ? "Image" : "Video"} — unable to decrypt]`;
            }

            messages.push({
                ...msg,
                plaintext: mediaInfo?.mediaFileName || displayPlaintext,
                signatureValid,
                senderDisplayName: sender?.displayName || (isOwn ? "You" : "Unknown"),
                messageType: mediaInfo?.messageType || rawMsgType,
                mediaUrl: mediaInfo?.mediaUrl,
                mediaFileName: mediaInfo?.mediaFileName,
                spoiler: (raw as any).spoiler ?? false,
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
        lastMessageAt: raw.last_message_at || raw.lastMessageAt,
        lastSenderId: raw.last_sender_id || raw.lastSenderId,
        lastMessagePreview: raw.last_message_preview || raw.lastMessagePreview,
        unreadCount: raw.unread_count ?? raw.unreadCount,
    };
}
