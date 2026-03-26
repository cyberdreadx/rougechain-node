/**
 * PQC Mail — On-chain encrypted email with @rouge.quant addressing
 * Reuses ML-KEM-768 + ML-DSA-65 encryption from pqc-messenger.ts
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";
import { cachedFetch, invalidate, type CacheCategory } from "./api-cache";
import { encryptMessage, buildSignedRequest, type WalletWithPrivateKeys, type Wallet, getWallets } from "./pqc-messenger";

export const MAIL_DOMAIN = "rouge.quant";
export const MAIL_DOMAIN_ALT = "qwalla.mail";
export const MAIL_DOMAINS = [MAIL_DOMAIN, MAIL_DOMAIN_ALT];

export interface MailMessage {
    id: string;
    fromWalletId: string;
    toWalletIds: string[];
    subjectEncrypted: string;
    bodyEncrypted: string;
    signature: string;
    createdAt: string;
    replyToId?: string;
    hasAttachment: boolean;
    attachmentHash?: string;
    // Decrypted client-side fields
    subject?: string;
    body?: string;
    signatureValid?: boolean;
    senderName?: string;
}

export interface MailLabel {
    messageId: string;
    walletId: string;
    folder: string;
    isRead: boolean;
}

export interface MailItem {
    message: MailMessage;
    label: MailLabel;
}

export interface NameEntry {
    name: string;
    wallet_id: string;
    registered_at: string;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function getMailApiBase(): string | null {
    const base = getCoreApiBaseUrl();
    return base ? base : null;
}

// --- Name Registry ---

export async function registerName(wallet: WalletWithPrivateKeys, name: string, walletId: string): Promise<{ success: boolean; error?: string; entry?: NameEntry }> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    const signed = buildSignedRequest(
        { name, walletId },
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
    );
    const res = await fetch(`${base}/v2/names/register`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(signed),
    });
    const data = await res.json();
    if (data.success) invalidate("nameRegistry" as CacheCategory);
    return data;
}

export async function resolveName(name: string): Promise<{ entry?: NameEntry; wallet?: Wallet } | null> {
    const base = getMailApiBase();
    if (!base) return null;

    let cleanName = name;
    for (const domain of MAIL_DOMAINS) {
        cleanName = cleanName.replace(`@${domain}`, "");
    }
    cleanName = cleanName.toLowerCase();

    return cachedFetch("nameRegistry" as CacheCategory, cleanName, async () => {
        const res = await fetch(`${base}/names/resolve/${encodeURIComponent(cleanName)}`, {
            headers: getCoreApiHeaders(),
        });
        const data = await res.json();
        if (!data.success) return null;
        return {
            entry: data.entry,
            wallet: data.wallet ? normalizeWallet(data.wallet) : undefined,
        };
    });
}

export async function reverseLookup(walletId: string): Promise<string | null> {
    const base = getMailApiBase();
    if (!base) return null;

    return cachedFetch("nameRegistry" as CacheCategory, `rev:${walletId}`, async () => {
        const res = await fetch(`${base}/names/reverse/${encodeURIComponent(walletId)}`, {
            headers: getCoreApiHeaders(),
        });
        const data = await res.json();
        return data.name || null;
    });
}

export async function releaseName(wallet: WalletWithPrivateKeys, name: string): Promise<{ success: boolean; error?: string }> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    const signed = buildSignedRequest(
        { name },
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
    );
    const res = await fetch(`${base}/v2/names/release`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(signed),
    });
    const data = await res.json();
    if (data.success) invalidate("nameRegistry" as CacheCategory);
    return data;
}

// --- Multi-recipient CEK encryption ---

async function encryptForMultipleRecipients(
    plaintext: string,
    recipientEncPubKeys: string[],
    senderEncPubKey: string,
): Promise<string> {
    const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");

    const cek = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(plaintext),
    );

    const wrappedKeys: Record<string, { kemCipherText: string; wrappedCek: string; wrappedIv: string }> = {};
    const allKeys = [...new Set([...recipientEncPubKeys, senderEncPubKey])];

    for (const encPubKey of allKeys) {
        if (!encPubKey) continue;
        const { cipherText, sharedSecret } = ml_kem768.encapsulate(hexToBytes(encPubKey));
        const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]);
        const wrapKey = await crypto.subtle.deriveKey(
            { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("pqc-cek-wrap") },
            keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
        );
        const wrapIv = crypto.getRandomValues(new Uint8Array(12));
        const wrappedCek = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, wrapKey, cek);
        wrappedKeys[encPubKey] = {
            kemCipherText: bytesToHex(cipherText),
            wrappedCek: bytesToHex(new Uint8Array(wrappedCek)),
            wrappedIv: bytesToHex(wrapIv),
        };
    }

    return JSON.stringify({ version: 2, iv: bytesToHex(iv), encryptedContent: bytesToHex(new Uint8Array(encrypted)), wrappedKeys });
}

async function decryptMailContent(
    encryptedPackage: string,
    recipientEncPrivKey: string,
    recipientEncPubKey: string,
): Promise<string> {
    const parsed = JSON.parse(encryptedPackage);
    if (parsed.version === 2 && parsed.wrappedKeys) {
        const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
        const myWrappedKey = parsed.wrappedKeys[recipientEncPubKey];
        if (!myWrappedKey) throw new Error("No wrapped key for this recipient");
        const privKeyBytes = hexToBytes(recipientEncPrivKey);
        const sharedSecret = ml_kem768.decapsulate(hexToBytes(myWrappedKey.kemCipherText), privKeyBytes);
        const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]);
        const unwrapKey = await crypto.subtle.deriveKey(
            { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("pqc-cek-wrap") },
            keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
        );
        const wrapIvBuf = hexToBytes(myWrappedKey.wrappedIv);
        const wrappedCekBuf = hexToBytes(myWrappedKey.wrappedCek);
        const cekBytes = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: wrapIvBuf.buffer.slice(wrapIvBuf.byteOffset, wrapIvBuf.byteOffset + wrapIvBuf.byteLength) as ArrayBuffer },
            unwrapKey,
            wrappedCekBuf.buffer.slice(wrappedCekBuf.byteOffset, wrappedCekBuf.byteOffset + wrappedCekBuf.byteLength) as ArrayBuffer,
        );
        const cek = await crypto.subtle.importKey("raw", cekBytes, { name: "AES-GCM" }, false, ["decrypt"]);
        const ivBuf = hexToBytes(parsed.iv);
        const contentBuf = hexToBytes(parsed.encryptedContent);
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: ivBuf.buffer.slice(ivBuf.byteOffset, ivBuf.byteOffset + ivBuf.byteLength) as ArrayBuffer },
            cek,
            contentBuf.buffer.slice(contentBuf.byteOffset, contentBuf.byteOffset + contentBuf.byteLength) as ArrayBuffer,
        );
        return new TextDecoder().decode(decrypted);
    }
    throw new Error("Unsupported encryption format (pre-v2 messages are no longer supported)");
}

// --- Mail ---

export async function sendMail(
    wallet: WalletWithPrivateKeys,
    toWalletIds: string[],
    subject: string,
    body: string,
    replyToId?: string,
): Promise<MailMessage> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    const allWallets = await getWallets();

    const recipientEncPubKeys: string[] = [];
    for (const toId of toWalletIds) {
        let w = allWallets.find(w =>
            w.id === toId ||
            w.signingPublicKey === toId ||
            w.encryptionPublicKey === toId
        );
        if (!w?.encryptionPublicKey) {
            try {
                const nameResult = await resolveName(toId);
                if (nameResult?.wallet?.encryptionPublicKey) w = nameResult.wallet;
            } catch { /* ignore */ }
        }
        if (!w?.encryptionPublicKey) {
            try {
                const name = await reverseLookup(toId);
                if (name) {
                    const nameResult = await resolveName(name);
                    if (nameResult?.wallet?.encryptionPublicKey) w = nameResult.wallet;
                }
            } catch { /* ignore */ }
        }
        if (!w?.encryptionPublicKey) throw new Error(`Recipient ${toId.substring(0, 16)}... encryption key not found. They may need to re-register their wallet.`);
        recipientEncPubKeys.push(w.encryptionPublicKey);
    }

    const subjectEncrypted = await encryptForMultipleRecipients(subject, recipientEncPubKeys, wallet.encryptionPublicKey);
    const bodyEncrypted = await encryptForMultipleRecipients(body, recipientEncPubKeys, wallet.encryptionPublicKey);

    // Unified signature over all encrypted parts
    const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa.js");
    const sigPayload = subjectEncrypted + "|" + bodyEncrypted;
    const sigBytes = ml_dsa65.sign(
        new TextEncoder().encode(sigPayload),
        hexToBytes(wallet.signingPrivateKey),
    );
    const unifiedSignature = bytesToHex(sigBytes);

    const signed = buildSignedRequest(
        {
            fromWalletId: wallet.id,
            toWalletIds,
            subjectEncrypted,
            bodyEncrypted,
            contentSignature: unifiedSignature,
            replyToId,
            hasAttachment: false,
        },
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
    );

    const res = await fetch(`${base}/v2/mail/send`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(signed),
    });

    if (!res.ok) throw new Error(`Send failed: ${await res.text()}`);
    invalidate("mailInbox" as CacheCategory);
    invalidate("mailSent" as CacheCategory);

    const data = await res.json();
    return {
        ...normalizeMailMessage(data.message || data),
        subject,
        body,
        signatureValid: true,
        senderName: wallet.displayName,
    };
}

export async function getInbox(wallet: WalletWithPrivateKeys): Promise<MailItem[]> {
    return getFolder(wallet, "inbox", "mailInbox" as CacheCategory);
}

export async function getSent(wallet: WalletWithPrivateKeys): Promise<MailItem[]> {
    return getFolder(wallet, "sent", "mailSent" as CacheCategory);
}

export async function getTrash(wallet: WalletWithPrivateKeys): Promise<MailItem[]> {
    return getFolder(wallet, "trash", "mailTrash" as CacheCategory);
}

async function getFolder(wallet: WalletWithPrivateKeys, folder: string, cacheCategory: CacheCategory): Promise<MailItem[]> {
    const base = getMailApiBase();
    if (!base) return [];

    try {
        const rawItems = await cachedFetch(cacheCategory, wallet.id, async () => {
            const signed = buildSignedRequest(
                { folder },
                wallet.signingPrivateKey,
                wallet.signingPublicKey,
            );
            const res = await fetch(`${base}/v2/mail/folder`, {
                method: "POST",
                headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify(signed),
            });
            if (!res.ok) return [];
            const data = await res.json();
            return data.messages || [];
        });

        const allWallets = await getWallets();
        const items: MailItem[] = [];

        for (const raw of rawItems) {
            const msg = normalizeMailMessage(raw.message || raw);
            const label = normalizeMailLabel(raw.label || {});
            const isSender = msg.fromWalletId === wallet.id ||
                msg.fromWalletId === wallet.signingPublicKey ||
                msg.fromWalletId === wallet.encryptionPublicKey;

            const senderWallet = allWallets.find(w =>
                w.id === msg.fromWalletId ||
                w.signingPublicKey === msg.fromWalletId ||
                w.encryptionPublicKey === msg.fromWalletId
            );
            const senderSigningKey = senderWallet?.signingPublicKey || wallet.signingPublicKey;

            let subject = "[Unable to decrypt]";
            let body = "[Unable to decrypt]";
            let signatureValid = false;

            try {
                subject = await decryptMailContent(msg.subjectEncrypted, wallet.encryptionPrivateKey, wallet.encryptionPublicKey);
            } catch { /* */ }

            try {
                body = await decryptMailContent(msg.bodyEncrypted, wallet.encryptionPrivateKey, wallet.encryptionPublicKey);
            } catch { /* */ }

            // Verify unified signature
            if (msg.signature && senderSigningKey) {
                try {
                    const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa.js");
                    const sigPayload = msg.subjectEncrypted + "|" + msg.bodyEncrypted;
                    signatureValid = ml_dsa65.verify(hexToBytes(msg.signature), new TextEncoder().encode(sigPayload), hexToBytes(senderSigningKey));
                } catch { /* */ }
            }

            const senderName = await getSenderDisplayName(msg.fromWalletId, allWallets);

            items.push({
                message: { ...msg, subject, body, signatureValid, senderName },
                label,
            });
        }

        return items;
    } catch {
        return [];
    }
}

async function getSenderDisplayName(walletId: string, allWallets: Wallet[]): Promise<string> {
    const name = await reverseLookup(walletId);
    if (name) return `${name}@${MAIL_DOMAIN}`;
    const w = allWallets.find(w =>
        w.id === walletId ||
        w.signingPublicKey === walletId ||
        w.encryptionPublicKey === walletId
    );
    return w?.displayName || walletId.substring(0, 12) + "...";
}

export async function moveMail(wallet: WalletWithPrivateKeys, messageId: string, folder: string): Promise<void> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    const signed = buildSignedRequest(
        { messageId, folder },
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
    );
    const res = await fetch(`${base}/v2/mail/move`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(signed),
    });
    if (!res.ok) throw new Error(`Move failed: ${await res.text()}`);
    invalidate("mailInbox" as CacheCategory);
    invalidate("mailSent" as CacheCategory);
    invalidate("mailTrash" as CacheCategory);
}

export async function markMailRead(wallet: WalletWithPrivateKeys, messageId: string): Promise<void> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    const signed = buildSignedRequest(
        { messageId },
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
    );
    await fetch(`${base}/v2/mail/read`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(signed),
    });
}

export async function deleteMail(wallet: WalletWithPrivateKeys, messageId: string): Promise<void> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    const signed = buildSignedRequest(
        { messageId },
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
    );
    const res = await fetch(`${base}/v2/mail/delete`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(signed),
    });
    if (!res.ok) throw new Error(`Delete failed: ${await res.text()}`);
    invalidate("mailInbox" as CacheCategory);
    invalidate("mailSent" as CacheCategory);
    invalidate("mailTrash" as CacheCategory);
}

/**
 * Resolve a recipient string — accepts either `alice@rouge.quant` or a raw wallet ID
 */
export async function resolveRecipient(input: string): Promise<string | null> {
    const trimmed = input.trim();

    if (MAIL_DOMAINS.some(d => trimmed.includes(`@${d}`))) {
        let name = trimmed;
        for (const d of MAIL_DOMAINS) {
            name = name.replace(`@${d}`, "");
        }
        name = name.toLowerCase();
        const result = await resolveName(name);
        return result?.wallet?.id || result?.entry?.wallet_id || null;
    }

    if (trimmed.length > 20) return trimmed;

    const result = await resolveName(trimmed);
    return result?.wallet?.id || result?.entry?.wallet_id || null;
}

// --- Helpers ---

function normalizeWallet(raw: any): Wallet {
    return {
        id: raw.id,
        displayName: raw.display_name || raw.displayName || "Unknown",
        signingPublicKey: raw.signing_public_key || raw.signingPublicKey || "",
        encryptionPublicKey: raw.encryption_public_key || raw.encryptionPublicKey || "",
        createdAt: raw.created_at || raw.createdAt,
    };
}

function normalizeMailMessage(raw: any): MailMessage {
    return {
        id: raw.id,
        fromWalletId: raw.from_wallet_id || raw.fromWalletId || "",
        toWalletIds: raw.to_wallet_ids || raw.toWalletIds || [],
        subjectEncrypted: raw.subject_encrypted || raw.subjectEncrypted || "",
        bodyEncrypted: raw.body_encrypted || raw.bodyEncrypted || "",
        signature: raw.signature || "",
        createdAt: raw.created_at || raw.createdAt || "",
        replyToId: raw.reply_to_id || raw.replyToId,
        hasAttachment: raw.has_attachment || raw.hasAttachment || false,
        attachmentHash: raw.attachment_hash || raw.attachmentHash,
    };
}

function normalizeMailLabel(raw: any): MailLabel {
    return {
        messageId: raw.message_id || raw.messageId || "",
        walletId: raw.wallet_id || raw.walletId || "",
        folder: raw.folder || "inbox",
        isRead: raw.is_read ?? raw.isRead ?? false,
    };
}
