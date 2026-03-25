/**
 * PQC Mail — On-chain encrypted email with @rouge.quant addressing
 * Reuses ML-KEM-768 + ML-DSA-65 encryption from pqc-messenger.ts
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { encryptMessage, decryptMessage, type WalletWithPrivateKeys, type Wallet, getWallets } from "@/lib/pqc-messenger";

export const MAIL_DOMAIN = "qwalla.mail";
export const MAIL_DOMAIN_LEGACY = "rouge.quant";
export const MAIL_DOMAINS = [MAIL_DOMAIN, MAIL_DOMAIN_LEGACY];

export interface MailAttachment {
  name: string;
  type: string; // MIME type
  data: string; // base64
  size: number;
}

export interface MailMessage {
  id: string;
  fromWalletId: string;
  toWalletIds: string[];
  subjectEncrypted: string;
  bodyEncrypted: string;
  attachmentEncrypted?: string;
  signature: string;
  createdAt: string;
  replyToId?: string;
  hasAttachment: boolean;
  attachmentHash?: string;
  subject?: string;
  body?: string;
  attachmentData?: MailAttachment;
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
  return await res.json();
}

export async function resolveName(name: string): Promise<{ entry?: NameEntry; wallet?: Wallet } | null> {
  const base = getMailApiBase();
  if (!base) return null;

  let cleanName = name;
  for (const domain of MAIL_DOMAINS) {
    cleanName = cleanName.replace(`@${domain}`, "");
  }
  cleanName = cleanName.toLowerCase();
  const res = await fetch(`${base}/names/resolve/${encodeURIComponent(cleanName)}`, {
    headers: getCoreApiHeaders(),
  });
  const data = await res.json();
  if (!data.success) return null;
  return {
    entry: data.entry,
    wallet: data.wallet ? normalizeWallet(data.wallet) : undefined,
  };
}

export async function reverseLookup(walletId: string): Promise<string | null> {
  const base = getMailApiBase();
  if (!base) return null;

  try {
    const res = await fetch(`${base}/names/reverse/${encodeURIComponent(walletId)}`, {
      headers: getCoreApiHeaders(),
    });
    const data = await res.json();
    return data.name || null;
  } catch {
    return null;
  }
}

export async function releaseName(name: string, walletId: string): Promise<{ success: boolean; error?: string }> {
  const base = getMailApiBase();
  if (!base) throw new Error("Node not configured");

  const res = await fetch(`${base}/names/release`, {
    method: "DELETE",
    headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name, walletId }),
  });
  return await res.json();
}

// --- Mail ---

export async function sendMail(
  wallet: WalletWithPrivateKeys,
  toWalletIds: string[],
  subject: string,
  body: string,
  replyToId?: string,
  attachment?: MailAttachment,
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
    // Fallback: resolve via name registry (the toId might be a stale wallet ID
    // that the name registry still maps, but resolveName returns the current wallet)
    if (!w?.encryptionPublicKey) {
      try {
        const nameResult = await resolveName(toId);
        if (nameResult?.wallet?.encryptionPublicKey) {
          w = nameResult.wallet;
        }
      } catch { /* ignore */ }
    }
    // Last resort: try reverse lookup → name → resolve to get current wallet
    if (!w?.encryptionPublicKey) {
      try {
        const name = await reverseLookup(toId);
        if (name) {
          const nameResult = await resolveName(name);
          if (nameResult?.wallet?.encryptionPublicKey) {
            w = nameResult.wallet;
          }
        }
      } catch { /* ignore */ }
    }
    if (!w?.encryptionPublicKey) throw new Error(`Recipient ${toId.substring(0, 16)}... encryption key not found. They may need to re-register their wallet.`);
    recipientEncPubKeys.push(w.encryptionPublicKey);
  }

  const primaryRecipientKey = recipientEncPubKeys[0];

  const subjectEnc = await encryptMessage(
    subject, primaryRecipientKey, wallet.signingPrivateKey, wallet.encryptionPublicKey,
  );
  const bodyEnc = await encryptMessage(
    body, primaryRecipientKey, wallet.signingPrivateKey, wallet.encryptionPublicKey,
  );

  // Encrypt attachment if present
  let attachmentEncrypted: string | undefined;
  if (attachment) {
    const attachmentPayload = JSON.stringify({
      name: attachment.name,
      type: attachment.type,
      data: attachment.data,
      size: attachment.size,
    });
    const attachEnc = await encryptMessage(
      attachmentPayload, primaryRecipientKey, wallet.signingPrivateKey, wallet.encryptionPublicKey,
    );
    attachmentEncrypted = attachEnc.encryptedPackage;
  }

  const res = await fetch(`${base}/mail/send`, {
    method: "POST",
    headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      fromWalletId: wallet.id,
      toWalletIds,
      subjectEncrypted: subjectEnc.encryptedPackage,
      bodyEncrypted: bodyEnc.encryptedPackage,
      attachmentEncrypted,
      signature: subjectEnc.signature,
      replyToId,
      hasAttachment: !!attachment,
    }),
  });

  if (!res.ok) throw new Error(`Send failed: ${await res.text()}`);
  const data = await res.json();
  return {
    ...normalizeMailMessage(data.message || data),
    subject,
    body,
    attachmentData: attachment,
    signatureValid: true,
    senderName: wallet.displayName,
  };
}

export async function getInbox(wallet: WalletWithPrivateKeys): Promise<MailItem[]> {
  return getFolder(wallet, "inbox");
}

export async function getSent(wallet: WalletWithPrivateKeys): Promise<MailItem[]> {
  return getFolder(wallet, "sent");
}

export async function getTrash(wallet: WalletWithPrivateKeys): Promise<MailItem[]> {
  return getFolder(wallet, "trash");
}

async function getFolder(wallet: WalletWithPrivateKeys, folder: string): Promise<MailItem[]> {
  const base = getMailApiBase();
  if (!base) return [];

  try {
    const res = await fetch(`${base}/mail/${folder}?walletId=${encodeURIComponent(wallet.id)}`, {
      headers: getCoreApiHeaders(),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const rawItems = data.messages || [];

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

      let attachmentData: MailAttachment | undefined;
      if (msg.hasAttachment && msg.attachmentEncrypted) {
        try {
          const attachResult = await decryptMessage(
            msg.attachmentEncrypted, wallet.encryptionPrivateKey, senderSigningKey,
            msg.signature, isSender,
          );
          attachmentData = JSON.parse(attachResult.plaintext) as MailAttachment;
        } catch { /* */ }
      }

      const senderName = await getSenderDisplayName(msg.fromWalletId, allWallets);

      items.push({
        message: { ...msg, subject, body, attachmentData, signatureValid, senderName },
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
}

export async function resolveRecipient(input: string): Promise<string | null> {
  const trimmed = input.trim();

  if (MAIL_DOMAINS.some(d => trimmed.includes(`@${d}`))) {
    let name = trimmed;
    for (const d of MAIL_DOMAINS) {
      name = name.replace(`@${d}`, "");
    }
    name = name.toLowerCase();
    const result = await resolveName(name);
    // Prefer the resolved wallet's current ID over the potentially stale registry ID
    return result?.wallet?.id || result?.entry?.wallet_id || null;
  }

  if (trimmed.length > 20) return trimmed;

  const result = await resolveName(trimmed);
  return result?.wallet?.id || result?.entry?.wallet_id || null;
}

// --- Helpers ---

function normalizeWallet(raw: Record<string, unknown>): Wallet {
  return {
    id: (raw.id as string) || "",
    displayName: (raw.display_name as string) || (raw.displayName as string) || "Unknown",
    signingPublicKey: (raw.signing_public_key as string) || (raw.signingPublicKey as string) || "",
    encryptionPublicKey: (raw.encryption_public_key as string) || (raw.encryptionPublicKey as string) || "",
  };
}

function normalizeMailMessage(raw: Record<string, unknown>): MailMessage {
  return {
    id: (raw.id as string) || "",
    fromWalletId: (raw.from_wallet_id as string) || (raw.fromWalletId as string) || "",
    toWalletIds: (raw.to_wallet_ids as string[]) || (raw.toWalletIds as string[]) || [],
    subjectEncrypted: (raw.subject_encrypted as string) || (raw.subjectEncrypted as string) || "",
    bodyEncrypted: (raw.body_encrypted as string) || (raw.bodyEncrypted as string) || "",
    signature: (raw.signature as string) || "",
    createdAt: (raw.created_at as string) || (raw.createdAt as string) || "",
    replyToId: (raw.reply_to_id as string) || (raw.replyToId as string),
    hasAttachment: (raw.has_attachment as boolean) || (raw.hasAttachment as boolean) || false,
    attachmentHash: (raw.attachment_hash as string) || (raw.attachmentHash as string),
    attachmentEncrypted: (raw.attachment_encrypted as string) || (raw.attachmentEncrypted as string),
  };
}

function normalizeMailLabel(raw: Record<string, unknown>): MailLabel {
  return {
    messageId: (raw.message_id as string) || (raw.messageId as string) || "",
    walletId: (raw.wallet_id as string) || (raw.walletId as string) || "",
    folder: (raw.folder as string) || "inbox",
    isRead: (raw.is_read as boolean) ?? (raw.isRead as boolean) ?? false,
  };
}
