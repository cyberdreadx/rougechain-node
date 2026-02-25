import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
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
  // Decrypted content (client-side only)
  plaintext?: string;
  signatureValid?: boolean;
  senderDisplayName?: string;
  // Media support
  messageType?: MessageType;
  mediaUrl?: string;       // data URL for rendering (client-side only)
  mediaFileName?: string;  // original filename (client-side only)
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

const WALLET_STORAGE_KEY = "pqc_messenger_wallet";
const DEMO_BOT_STORAGE_KEY = "pqc_demo_bot_wallet";
const SENT_MESSAGES_KEY = "pqc_sent_messages";
const PRIVACY_SETTINGS_KEY = "pqc_privacy_settings";
const MESSENGER_API_PREFIX = "/messenger";

// Media support constants
export const MAX_MEDIA_SIZE = 10 * 1024 * 1024; // 10 MB limit

// Media payload envelope (stored as encrypted plaintext)
interface MediaPayload {
  type: "image" | "video";
  fileName: string;
  mimeType: string;
  data: string; // base64 encoded
}

// Convert a File to a media payload string for encryption
export async function fileToMediaPayload(file: File): Promise<{ payload: string; messageType: MessageType }> {
  if (file.size > MAX_MEDIA_SIZE) {
    throw new Error(`File too large. Maximum size is ${MAX_MEDIA_SIZE / (1024 * 1024)} MB.`);
  }

  const messageType: MessageType = file.type.startsWith("video/") ? "video" : "image";
  const buffer = await file.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
  );

  const envelope: MediaPayload = {
    type: messageType,
    fileName: file.name,
    mimeType: file.type,
    data: base64,
  };

  return {
    payload: JSON.stringify(envelope),
    messageType,
  };
}

// Extract media data URL from a decrypted media payload
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
  } catch {
    // Not a media payload
  }
  return null;
}

// Privacy settings interface
export interface PrivacySettings {
  storeSentMessages: boolean;
}

// Get privacy settings
export function getPrivacySettings(): PrivacySettings {
  try {
    const stored = localStorage.getItem(PRIVACY_SETTINGS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  // Default: store sent messages (better UX)
  return { storeSentMessages: true };
}

// Save privacy settings
export function savePrivacySettings(settings: PrivacySettings): void {
  localStorage.setItem(PRIVACY_SETTINGS_KEY, JSON.stringify(settings));
}

// Clear stored sent messages (for privacy)
export function clearStoredSentMessages(): void {
  localStorage.removeItem(SENT_MESSAGES_KEY);
}

// Helper to store sent message plaintext locally (respects privacy settings)
function storeSentMessage(messageId: string, plaintext: string): void {
  const settings = getPrivacySettings();
  if (!settings.storeSentMessages) return;

  try {
    const stored = localStorage.getItem(SENT_MESSAGES_KEY);
    const messages: Record<string, string> = stored ? JSON.parse(stored) : {};
    messages[messageId] = plaintext;
    // Keep only last 500 messages to avoid storage bloat
    const keys = Object.keys(messages);
    if (keys.length > 500) {
      const toRemove = keys.slice(0, keys.length - 500);
      toRemove.forEach(k => delete messages[k]);
    }
    localStorage.setItem(SENT_MESSAGES_KEY, JSON.stringify(messages));
  } catch (e) {
    console.error("Failed to store sent message:", e);
  }
}

// Helper to retrieve sent message plaintext
function getSentMessage(messageId: string): string | null {
  const settings = getPrivacySettings();
  if (!settings.storeSentMessages) return null;

  try {
    const stored = localStorage.getItem(SENT_MESSAGES_KEY);
    if (!stored) return null;
    const messages: Record<string, string> = JSON.parse(stored);
    return messages[messageId] || null;
  } catch {
    return null;
  }
}

// Demo bot responses
const DEMO_BOT_RESPONSES = [
  "🔐 Your message was encrypted with ML-KEM-768 and I decrypted it successfully!",
  "✅ Signature verified using ML-DSA-65. I know it's really you!",
  "🛡️ This message traveled encrypted - even quantum computers can't break it!",
  "🔑 I used my private key to decrypt your message. Only I could read it!",
  "📝 Message received and verified. The future of secure communication is here!",
  "🌐 End-to-end encrypted with post-quantum cryptography. We're quantum-safe!",
  "💬 Echo: I received your quantum-encrypted message loud and clear!",
];

const DEFAULT_LLM_URL = "http://localhost:1234";
const DEFAULT_LLM_MODEL = "local-model";

function getLocalLlmUrl(): string {
  return (import.meta.env.VITE_LOCAL_LLM_URL as string | undefined) || DEFAULT_LLM_URL;
}

function getLocalLlmModel(): string {
  return (import.meta.env.VITE_LOCAL_LLM_MODEL as string | undefined) || DEFAULT_LLM_MODEL;
}

// Store wallet in localStorage (private keys stay local)
export function saveWalletLocally(wallet: WalletWithPrivateKeys): void {
  localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(wallet));
}

// Load wallet from localStorage
export function loadLocalWallet(): WalletWithPrivateKeys | null {
  const stored = localStorage.getItem(WALLET_STORAGE_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

// Clear local wallet
export function clearLocalWallet(): void {
  localStorage.removeItem(WALLET_STORAGE_KEY);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function getMessengerApiBase(): string | null {
  const apiBase = getCoreApiBaseUrl();
  return apiBase || null;
}

export async function registerWalletOnNode(wallet: Wallet): Promise<void> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) return;
  await fetch(`${apiBase}${MESSENGER_API_PREFIX}/wallets/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify({
      id: wallet.id,
      displayName: wallet.displayName,
      signingPublicKey: wallet.signingPublicKey,
      encryptionPublicKey: wallet.encryptionPublicKey,
    }),
  });
}

async function encryptMessage(
  plaintext: string,
  recipientEncryptionPublicKey: string,
  senderSigningPrivateKey: string
): Promise<{ encryptedPackage: string; signature: string }> {
  const recipientPubKeyBytes = hexToBytes(recipientEncryptionPublicKey);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(recipientPubKeyBytes);

  const keyBuffer = new ArrayBuffer(32);
  new Uint8Array(keyBuffer).set(sharedSecret.slice(0, 32));

  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const encryptedBytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    plaintextBytes
  );

  const senderPrivKeyBytes = hexToBytes(senderSigningPrivateKey);
  const signature = ml_dsa65.sign(plaintextBytes, senderPrivKeyBytes);

  const encryptedData = {
    kemCipherText: bytesToHex(cipherText),
    iv: bytesToHex(iv),
    encryptedContent: bytesToHex(new Uint8Array(encryptedBytes)),
  };

  return {
    encryptedPackage: JSON.stringify(encryptedData),
    signature: bytesToHex(signature),
  };
}

async function decryptMessage(
  encryptedPackage: string,
  recipientEncryptionPrivateKey: string,
  senderSigningPublicKey: string,
  signature: string
): Promise<{ plaintext: string; signatureValid: boolean }> {
  const encryptedData = JSON.parse(encryptedPackage) as {
    kemCipherText: string;
    iv: string;
    encryptedContent: string;
  };

  const recipientPrivKeyBytes = hexToBytes(recipientEncryptionPrivateKey);
  const kemCipherTextBytes = hexToBytes(encryptedData.kemCipherText);
  const sharedSecret = ml_kem768.decapsulate(kemCipherTextBytes, recipientPrivKeyBytes);

  const keyBuffer = new ArrayBuffer(32);
  new Uint8Array(keyBuffer).set(sharedSecret.slice(0, 32));

  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const ivBytes = hexToBytes(encryptedData.iv);
  const contentBytes = hexToBytes(encryptedData.encryptedContent);

  const decryptedBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(ivBytes.buffer.slice(ivBytes.byteOffset, ivBytes.byteOffset + ivBytes.byteLength)) as BufferSource },
    aesKey,
    new Uint8Array(contentBytes.buffer.slice(contentBytes.byteOffset, contentBytes.byteOffset + contentBytes.byteLength)) as BufferSource
  );

  const plaintext = new TextDecoder().decode(decryptedBytes);
  const senderPubKeyBytes = hexToBytes(senderSigningPublicKey);
  const signatureBytes = hexToBytes(signature);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const signatureValid = ml_dsa65.verify(signatureBytes, plaintextBytes, senderPubKeyBytes);

  return { plaintext, signatureValid };
}

// Generate only encryption keypair (ML-KEM-768)
export function generateEncryptionKeypair(): { publicKey: string; privateKey: string } {
  // Let the library generate its own secure random seed
  const encryptionKeypair = ml_kem768.keygen();
  return {
    publicKey: bytesToHex(encryptionKeypair.publicKey),
    privateKey: bytesToHex(encryptionKeypair.secretKey),
  };
}

// Create a new wallet with ML-DSA-65 + ML-KEM-768 keypairs
export async function createWallet(displayName: string): Promise<WalletWithPrivateKeys> {
  // Let the libraries generate their own secure random seeds
  const signingKeypair = ml_dsa65.keygen();
  const encryptionKeypair = ml_kem768.keygen();

  const wallet: WalletWithPrivateKeys = {
    id: crypto.randomUUID(),
    displayName,
    signingPublicKey: bytesToHex(signingKeypair.publicKey),
    encryptionPublicKey: bytesToHex(encryptionKeypair.publicKey),
    signingPrivateKey: bytesToHex(signingKeypair.secretKey),
    encryptionPrivateKey: bytesToHex(encryptionKeypair.secretKey),
  };

  // Save locally
  saveWalletLocally(wallet);
  try {
    await registerWalletOnNode(wallet);
  } catch (error) {
    console.warn("Failed to register wallet with node:", error);
  }

  return wallet;
}

// Get all wallets (for finding contacts)
export async function getWallets(): Promise<Wallet[]> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) return [];
  const response = await fetch(`${apiBase}${MESSENGER_API_PREFIX}/wallets`, {
    headers: getCoreApiHeaders(),
  });
  if (!response.ok) return [];
  const data = await response.json().catch(() => null);
  const rawWallets = data?.wallets || [];

  // Convert snake_case from server to camelCase
  return rawWallets.map((w: {
    id?: string;
    display_name?: string;
    displayName?: string;
    signing_public_key?: string;
    signingPublicKey?: string;
    encryption_public_key?: string;
    encryptionPublicKey?: string;
    created_at?: string;
    createdAt?: string;
  }): Wallet => ({
    id: w.id || "",
    displayName: w.display_name || w.displayName || "",
    signingPublicKey: w.signing_public_key || w.signingPublicKey || "",
    encryptionPublicKey: w.encryption_public_key || w.encryptionPublicKey || "",
  }));
}

// Create or get demo bot wallet
export async function getOrCreateDemoBot(): Promise<WalletWithPrivateKeys> {
  // Check if we already have a demo bot stored
  const stored = localStorage.getItem(DEMO_BOT_STORAGE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      // Continue to create new one
    }
  }

  // Let the libraries generate their own secure random seeds
  const signingKeypair = ml_dsa65.keygen();
  const encryptionKeypair = ml_kem768.keygen();

  const saved: WalletWithPrivateKeys = {
    id: "demo-bot",
    displayName: "🤖 Quantum Bot",
    signingPublicKey: bytesToHex(signingKeypair.publicKey),
    encryptionPublicKey: bytesToHex(encryptionKeypair.publicKey),
    signingPrivateKey: bytesToHex(signingKeypair.secretKey),
    encryptionPrivateKey: bytesToHex(encryptionKeypair.secretKey),
  };

  // Store the bot wallet locally so it can respond
  localStorage.setItem(DEMO_BOT_STORAGE_KEY, JSON.stringify(saved));
  try {
    await registerWalletOnNode(saved);
  } catch (error) {
    console.warn("Failed to register demo bot with node:", error);
  }
  return saved;
}

// Load demo bot wallet
export function loadDemoBotWallet(): WalletWithPrivateKeys | null {
  const stored = localStorage.getItem(DEMO_BOT_STORAGE_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

// Check if a wallet is the demo bot
export function isDemoBot(walletId: string): boolean {
  const botWallet = loadDemoBotWallet();
  return botWallet?.id === walletId;
}

// Get a random demo bot response
export function getDemoBotResponse(): string {
  return DEMO_BOT_RESPONSES[Math.floor(Math.random() * DEMO_BOT_RESPONSES.length)];
}

export async function getBotReply(userMessage: string): Promise<string> {
  try {
    const baseUrl = getLocalLlmUrl().replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: getLocalLlmModel(),
        messages: [
          {
            role: "system",
            content:
              "You are Quantum Bot, a friendly assistant inside a post-quantum messenger. Reply briefly.",
          },
          { role: "user", content: userMessage },
        ],
        temperature: 0.7,
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM error: ${res.status}`);
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (content) {
      return content;
    }
  } catch (error) {
    console.warn("[Messenger] Local LLM unavailable, using fallback:", error);
  }
  return getDemoBotResponse();
}

// Create a 1:1 conversation
export async function createConversation(
  myWalletId: string,
  recipientWalletId: string
): Promise<Conversation> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) {
    throw new Error("Node API is not configured");
  }
  const response = await fetch(`${apiBase}${MESSENGER_API_PREFIX}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify({
      createdBy: myWalletId,
      participantIds: [myWalletId, recipientWalletId],
      isGroup: false,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("Create conversation failed:", response.status, errorText);
    throw new Error(`Failed to create conversation: ${response.status} ${errorText}`);
  }
  const data = await response.json().catch(() => null);
  return data?.conversation as Conversation;
}

// Delete a conversation
export async function deleteConversation(conversationId: string): Promise<void> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) {
    throw new Error("Node API is not configured");
  }
  const response = await fetch(`${apiBase}${MESSENGER_API_PREFIX}/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
    headers: getCoreApiHeaders(),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("Delete conversation failed:", response.status, errorText);
    throw new Error(`Failed to delete conversation: ${response.status}`);
  }
}

// Get conversations for a wallet
export async function getConversations(walletId: string): Promise<Conversation[]> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) return [];
  const response = await fetch(`${apiBase}${MESSENGER_API_PREFIX}/conversations?walletId=${encodeURIComponent(walletId)}`, {
    headers: getCoreApiHeaders(),
  });
  if (!response.ok) return [];
  const data = await response.json().catch(() => null);
  const rawConversations = data?.conversations || [];

  // Fetch all wallets to populate participant details
  const allWallets = await getWallets();
  const walletMap = new Map<string, Wallet>();
  for (const w of allWallets) {
    if (w.id) walletMap.set(w.id, w);
    if (w.signingPublicKey) walletMap.set(w.signingPublicKey, w);
    if (w.encryptionPublicKey) walletMap.set(w.encryptionPublicKey, w);
  }

  // Populate participants with full wallet data
  // Server returns participant_ids (snake_case), convert to participants array
  const conversations: Conversation[] = rawConversations.map((conv: {
    id: string;
    name?: string;
    is_group?: boolean;
    isGroup?: boolean;
    created_by?: string;
    createdBy?: string;
    created_at?: string;
    createdAt?: string;
    participant_ids?: string[];
    participantIds?: string[];
  }) => {
    const participantIds = conv.participant_ids || conv.participantIds || [];
    const participants = participantIds
      .map((id: string) => walletMap.get(id))
      .filter((w): w is Wallet => w !== undefined);

    return {
      id: conv.id,
      name: conv.name,
      isGroup: conv.is_group ?? conv.isGroup ?? false,
      createdBy: conv.created_by || conv.createdBy,
      createdAt: conv.created_at || conv.createdAt || new Date().toISOString(),
      participantIds,
      participants,
    };
  });

  return conversations;
}

// Send an encrypted message (text or media)
export async function sendMessage(
  conversationId: string,
  plaintext: string,
  senderWallet: WalletWithPrivateKeys,
  recipientEncryptionPublicKey: string,
  selfDestruct: boolean = false,
  destructAfterSeconds?: number,
  messageType: MessageType = "text",
  spoiler: boolean = false
): Promise<Message> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) {
    throw new Error("Node API is not configured");
  }

  const encryptData = await encryptMessage(
    plaintext,
    recipientEncryptionPublicKey,
    senderWallet.signingPrivateKey
  );

  const response = await fetch(`${apiBase}${MESSENGER_API_PREFIX}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify({
      conversationId,
      senderWalletId: senderWallet.id,
      encryptedContent: encryptData.encryptedPackage,
      signature: encryptData.signature,
      selfDestruct,
      destructAfterSeconds,
      messageType,
      spoiler,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to send message");
  }

  const data = await response.json().catch(() => null);
  const msg = data?.message;
  if (!msg) {
    throw new Error("Message was not stored");
  }

  // Server returns snake_case, normalize to camelCase
  const msgId = msg.id;
  const msgConversationId = msg.conversation_id || msg.conversationId || conversationId;
  const msgSenderWalletId = msg.sender_wallet_id || msg.senderWalletId || senderWallet.id;
  const msgEncryptedContent = msg.encrypted_content || msg.encryptedContent || "";
  const msgSignature = msg.signature || "";
  const msgSelfDestruct = msg.self_destruct ?? msg.selfDestruct ?? selfDestruct;
  const msgDestructAfterSeconds = msg.destruct_after_seconds ?? msg.destructAfterSeconds ?? destructAfterSeconds;
  const msgCreatedAt = msg.created_at || msg.createdAt || new Date().toISOString();
  const msgMessageType = (msg.message_type || msg.messageType || messageType) as MessageType;
  const msgSpoiler = msg.spoiler ?? spoiler ?? false;

  storeSentMessage(msgId, plaintext);

  // Parse media payload for client-side rendering
  const mediaInfo = msgMessageType !== "text" ? parseMediaPayload(plaintext) : null;

  return {
    id: msgId,
    conversationId: msgConversationId,
    senderWalletId: msgSenderWalletId,
    encryptedContent: msgEncryptedContent,
    signature: msgSignature,
    selfDestruct: msgSelfDestruct,
    destructAfterSeconds: msgDestructAfterSeconds,
    readAt: msg.read_at || msg.readAt,
    createdAt: msgCreatedAt,
    plaintext: mediaInfo ? mediaInfo.mediaFileName : plaintext,
    signatureValid: true,
    messageType: msgMessageType,
    mediaUrl: mediaInfo?.mediaUrl,
    mediaFileName: mediaInfo?.mediaFileName,
    spoiler: msgSpoiler,
  };
}

// Get and decrypt messages for a conversation
export async function getMessages(
  conversationId: string,
  recipientWallet: WalletWithPrivateKeys,
  participants: Wallet[]
): Promise<Message[]> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) return [];
  const response = await fetch(`${apiBase}${MESSENGER_API_PREFIX}/messages?conversationId=${encodeURIComponent(conversationId)}`, {
    headers: getCoreApiHeaders(),
  });
  if (!response.ok) return [];

  const data = await response.json().catch(() => null);
  const rawMessages = Array.isArray(data?.messages) ? data.messages : [];
  const decryptedMessages: Message[] = [];

  for (const raw of rawMessages) {
    // Normalize snake_case from server to camelCase
    const msg = {
      id: raw.id,
      conversationId: raw.conversation_id || raw.conversationId || "",
      senderWalletId: raw.sender_wallet_id || raw.senderWalletId || "",
      encryptedContent: raw.encrypted_content || raw.encryptedContent || "",
      signature: raw.signature || "",
      selfDestruct: raw.self_destruct ?? raw.selfDestruct ?? false,
      destructAfterSeconds: raw.destruct_after_seconds ?? raw.destructAfterSeconds,
      readAt: raw.read_at || raw.readAt,
      createdAt: raw.created_at || raw.createdAt || "",
      isRead: raw.is_read ?? raw.isRead ?? false,
    };

    // Try multiple ways to find sender (handles old wallet-XXX format and new key-based IDs)
    let sender = participants.find(p =>
      p.id === msg.senderWalletId ||
      p.signingPublicKey === msg.senderWalletId ||
      p.encryptionPublicKey === msg.senderWalletId
    );

    // If not found in participants, try fetching from server
    if (!sender && msg.senderWalletId) {
      try {
        const allWallets = await getWallets();
        sender = allWallets.find(w =>
          w.id === msg.senderWalletId ||
          w.signingPublicKey === msg.senderWalletId
        );
      } catch {
        // Ignore fetch errors
      }
    }

    let plaintext = "[Unable to decrypt]";
    let signatureValid = false;
    const senderSigningPublicKey = sender?.signingPublicKey;

    // Check if this is our own message (check all possible ID formats)
    const isOwnMessage = msg.senderWalletId === recipientWallet.id ||
      msg.senderWalletId === recipientWallet.signingPublicKey ||
      msg.senderWalletId === recipientWallet.encryptionPublicKey ||
      // Also check if sender starts with recipient's key prefix
      (recipientWallet.signingPublicKey &&
        msg.senderWalletId?.startsWith(recipientWallet.signingPublicKey.substring(0, 20)));

    if (isOwnMessage) {
      const storedPlaintext = getSentMessage(msg.id);
      plaintext = storedPlaintext || "[Your encrypted message]";
      signatureValid = true;
    } else if (senderSigningPublicKey && msg.encryptedContent) {
      try {
        const decryptData = await decryptMessage(
          msg.encryptedContent,
          recipientWallet.encryptionPrivateKey,
          senderSigningPublicKey,
          msg.signature
        );
        plaintext = decryptData.plaintext;
        signatureValid = decryptData.signatureValid;

        if (msg.selfDestruct && !msg.readAt) {
          await fetch(`${apiBase}${MESSENGER_API_PREFIX}/messages/read`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
            body: JSON.stringify({ messageId: msg.id }),
          });
        }
      } catch (e) {
        console.error("Decryption error:", e);
      }
    }

    // Detect media messages and extract media data
    const rawMessageType = (raw.message_type || raw.messageType || "text") as MessageType;
    const mediaInfo = rawMessageType !== "text" ? parseMediaPayload(plaintext) : null;
    // For own media messages, try to parse the stored plaintext
    const ownMediaInfo = isOwnMessage && rawMessageType !== "text" ? parseMediaPayload(plaintext) : null;

    decryptedMessages.push({
      id: msg.id,
      conversationId: msg.conversationId,
      senderWalletId: msg.senderWalletId,
      encryptedContent: msg.encryptedContent,
      signature: msg.signature,
      selfDestruct: msg.selfDestruct,
      destructAfterSeconds: msg.destructAfterSeconds,
      readAt: msg.readAt,
      createdAt: msg.createdAt,
      plaintext: mediaInfo?.mediaFileName || ownMediaInfo?.mediaFileName || plaintext,
      signatureValid,
      senderDisplayName: sender?.displayName || (isOwnMessage ? "You" : "Unknown"),
      messageType: mediaInfo?.messageType || ownMediaInfo?.messageType || rawMessageType,
      mediaUrl: mediaInfo?.mediaUrl || ownMediaInfo?.mediaUrl,
      mediaFileName: mediaInfo?.mediaFileName || ownMediaInfo?.mediaFileName,
      spoiler: raw.spoiler ?? false,
    });
  }

  return decryptedMessages;
}
