/**
 * PQC Mail — On-chain encrypted email with @rouge.quant addressing
 * Reuses ML-KEM-768 + ML-DSA-65 encryption from pqc-messenger.ts
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";
import { cachedFetch, invalidate, type CacheCategory } from "./api-cache";
import { encryptMessage, decryptMessage, type WalletWithPrivateKeys, type Wallet, getWallets } from "./pqc-messenger";

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

function getMailApiBase(): string | null {
    const base = getCoreApiBaseUrl();
    return base ? base : null;
}

// --- Name Registry ---

export async function registerName(name: string, walletId: string): Promise<{ success: boolean; error?: string; entry?: NameEntry }> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    const res = await fetch(`${base}/names/register`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name, walletId }),
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

export async function releaseName(name: string, walletId: string): Promise<{ success: boolean; error?: string }> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    const res = await fetch(`${base}/names/release`, {
        method: "DELETE",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name, walletId }),
    });
    const data = await res.json();
    if (data.success) invalidate("nameRegistry" as CacheCategory);
    return data;
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

    // Encrypt subject and body for each recipient (using first recipient's key for the shared package)
    const primaryRecipientKey = recipientEncPubKeys[0];

    const subjectEnc = await encryptMessage(
        subject, primaryRecipientKey, wallet.signingPrivateKey, wallet.encryptionPublicKey,
    );
    const bodyEnc = await encryptMessage(
        body, primaryRecipientKey, wallet.signingPrivateKey, wallet.encryptionPublicKey,
    );

    const res = await fetch(`${base}/mail/send`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            fromWalletId: wallet.id,
            toWalletIds,
            subjectEncrypted: subjectEnc.encryptedPackage,
            bodyEncrypted: bodyEnc.encryptedPackage,
            signature: subjectEnc.signature,
            replyToId,
            hasAttachment: false,
        }),
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
            const res = await fetch(`${base}/mail/${folder}?walletId=${encodeURIComponent(wallet.id)}`, {
                headers: getCoreApiHeaders(),
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
                const subjectResult = await decryptMessage(
                    msg.subjectEncrypted, wallet.encryptionPrivateKey, senderSigningKey,
                    msg.signature, isSender,
                );
                subject = subjectResult.plaintext;
                signatureValid = subjectResult.signatureValid;
            } catch { /* */ }

            try {
                const bodyResult = await decryptMessage(
                    msg.bodyEncrypted, wallet.encryptionPrivateKey, senderSigningKey,
                    msg.signature, isSender,
                );
                body = bodyResult.plaintext;
            } catch { /* */ }

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

export async function moveMail(walletId: string, messageId: string, folder: string): Promise<void> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    const res = await fetch(`${base}/mail/move`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ walletId, messageId, folder }),
    });
    if (!res.ok) throw new Error(`Move failed: ${await res.text()}`);
    invalidate("mailInbox" as CacheCategory);
    invalidate("mailSent" as CacheCategory);
    invalidate("mailTrash" as CacheCategory);
}

export async function markMailRead(walletId: string, messageId: string): Promise<void> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    await fetch(`${base}/mail/read`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ walletId, messageId }),
    });
}

export async function deleteMail(walletId: string, messageId: string): Promise<void> {
    const base = getMailApiBase();
    if (!base) throw new Error("Node not configured");

    const res = await fetch(`${base}/mail/${encodeURIComponent(messageId)}?walletId=${encodeURIComponent(walletId)}`, {
        method: "DELETE",
        headers: getCoreApiHeaders(),
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
