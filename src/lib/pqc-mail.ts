/**
 * PQC Mail — On-chain encrypted email with @rouge.quant addressing
 * Reuses ML-KEM-768 + ML-DSA-65 encryption from pqc-messenger.ts
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { encryptMessage, buildSignedRequest, type WalletWithPrivateKeys, type Wallet, getWallets } from "@/lib/pqc-messenger";

export const MAIL_DOMAIN = "rouge.quant";
export const MAIL_DOMAIN_ALT = "qwalla.mail";
export const MAIL_DOMAINS = [MAIL_DOMAIN, MAIL_DOMAIN_ALT];

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
  signatureValid?: boolean | null;
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
  return await res.json();
}

// --- Multi-recipient CEK encryption ---

async function encryptForMultipleRecipients(
  plaintext: string,
  recipientEncPubKeys: string[],
  senderEncPubKey: string,
): Promise<string> {
  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");

  // Generate random AES-256 CEK
  const cek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(plaintext),
  );

  // KEM-wrap CEK for each recipient
  const wrappedKeys: Record<string, { kemCipherText: string; wrappedCek: string; wrappedIv: string }> = {};
  const allKeys = [...new Set([...recipientEncPubKeys, senderEncPubKey])];

  for (const encPubKey of allKeys) {
    if (!encPubKey) continue;
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(hexToBytes(encPubKey));
    const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret.buffer.slice(sharedSecret.byteOffset, sharedSecret.byteOffset + sharedSecret.byteLength) as ArrayBuffer, "HKDF", false, ["deriveKey"]);
    const wrapKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("pqc-cek-wrap") },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedCek = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, wrapKey, cek);

    wrappedKeys[encPubKey] = {
      kemCipherText: bytesToHex(cipherText),
      wrappedCek: bytesToHex(new Uint8Array(wrappedCek)),
      wrappedIv: bytesToHex(wrapIv),
    };
  }

  return JSON.stringify({
    version: 2,
    iv: bytesToHex(iv),
    encryptedContent: bytesToHex(new Uint8Array(encrypted)),
    wrappedKeys,
  });
}

async function decryptMailContent(
  encryptedPackage: string,
  recipientEncPrivKey: string,
  recipientEncPubKey: string,
): Promise<string> {
  const parsed = JSON.parse(encryptedPackage);

  // New v2 format with per-recipient wrapped keys
  if (parsed.version === 2 && parsed.wrappedKeys) {
    const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
    const myWrappedKey = parsed.wrappedKeys[recipientEncPubKey];
    if (!myWrappedKey) throw new Error("No wrapped key for this recipient");

    const privKeyBytes = hexToBytes(recipientEncPrivKey);
    const sharedSecret = ml_kem768.decapsulate(hexToBytes(myWrappedKey.kemCipherText), privKeyBytes);
    const ssArr = sharedSecret;
    const ssBuf = ssArr.buffer.slice(ssArr.byteOffset, ssArr.byteOffset + ssArr.byteLength) as ArrayBuffer;
    const keyMaterial = await crypto.subtle.importKey("raw", ssBuf, "HKDF", false, ["deriveKey"]);
    const unwrapKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("pqc-cek-wrap") },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const cekBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(myWrappedKey.wrappedIv) },
      unwrapKey,
      hexToBytes(myWrappedKey.wrappedCek),
    );
    const cek = await crypto.subtle.importKey("raw", cekBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(parsed.iv) },
      cek,
      hexToBytes(parsed.encryptedContent),
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

  const subjectEncrypted = await encryptForMultipleRecipients(subject, recipientEncPubKeys, wallet.encryptionPublicKey);
  const bodyEncrypted = await encryptForMultipleRecipients(body, recipientEncPubKeys, wallet.encryptionPublicKey);

  let attachmentEncrypted: string | undefined;
  if (attachment) {
    const attachmentPayload = JSON.stringify({
      name: attachment.name,
      type: attachment.type,
      data: attachment.data,
      size: attachment.size,
    });
    attachmentEncrypted = await encryptForMultipleRecipients(attachmentPayload, recipientEncPubKeys, wallet.encryptionPublicKey);
  }

  // Unified signature over all encrypted parts
  const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa.js");
  const signPayload = subjectEncrypted + "|" + bodyEncrypted + (attachmentEncrypted ? "|" + attachmentEncrypted : "");
  const sigBytes = ml_dsa65.sign(
    new TextEncoder().encode(signPayload),
    hexToBytes(wallet.signingPrivateKey),
  );
  const unifiedSignature = bytesToHex(sigBytes);

  const signed = buildSignedRequest(
    {
      fromWalletId: wallet.id,
      toWalletIds,
      subjectEncrypted,
      bodyEncrypted,
      attachmentEncrypted,
      contentSignature: unifiedSignature,
      replyToId,
      hasAttachment: !!attachment,
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
      let signatureValid: boolean | null = null;

      try {
        subject = await decryptMailContent(msg.subjectEncrypted, wallet.encryptionPrivateKey, wallet.encryptionPublicKey);
      } catch { /* */ }

      try {
        body = await decryptMailContent(msg.bodyEncrypted, wallet.encryptionPrivateKey, wallet.encryptionPublicKey);
      } catch { /* */ }

      let attachmentData: MailAttachment | undefined;
      if (msg.hasAttachment && msg.attachmentEncrypted) {
        try {
          const attachPlain = await decryptMailContent(msg.attachmentEncrypted, wallet.encryptionPrivateKey, wallet.encryptionPublicKey);
          attachmentData = JSON.parse(attachPlain) as MailAttachment;
        } catch { /* */ }
      }

      // Verify unified signature over all encrypted parts
      if (msg.signature && senderSigningKey) {
        try {
          const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa.js");
          const sigPayload = msg.subjectEncrypted + "|" + msg.bodyEncrypted + (msg.attachmentEncrypted ? "|" + msg.attachmentEncrypted : "");
          signatureValid = ml_dsa65.verify(
            hexToBytes(msg.signature),
            new TextEncoder().encode(sigPayload),
            hexToBytes(senderSigningKey),
          );
        } catch {
          signatureValid = false;
        }
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
