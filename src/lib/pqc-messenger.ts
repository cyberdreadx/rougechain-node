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
    { name: "AES-GCM", iv: ivBytes },
    aesKey,
    contentBytes
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
  const encryptionSeed = crypto.getRandomValues(new Uint8Array(32));
  const encryptionKeypair = ml_kem768.keygen(encryptionSeed);
  return {
    publicKey: bytesToHex(encryptionKeypair.publicKey),
    privateKey: bytesToHex(encryptionKeypair.secretKey),
  };
}

// Create a new wallet with ML-DSA-65 + ML-KEM-768 keypairs
export async function createWallet(displayName: string): Promise<WalletWithPrivateKeys> {
  // ML-DSA-65 requires 64-byte seed, ML-KEM-768 uses 64-byte seed
  const signingSeed = crypto.getRandomValues(new Uint8Array(64));
  const signingKeypair = ml_dsa65.keygen(signingSeed);
  const encryptionSeed = crypto.getRandomValues(new Uint8Array(64));
  const encryptionKeypair = ml_kem768.keygen(encryptionSeed);

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

  const signingSeed = crypto.getRandomValues(new Uint8Array(64));
  const signingKeypair = ml_dsa65.keygen(signingSeed);
  const encryptionSeed = crypto.getRandomValues(new Uint8Array(64));
  const encryptionKeypair = ml_kem768.keygen(encryptionSeed);

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
  const walletMap = new Map(allWallets.map(w => [w.id, w]));
  
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

// Send an encrypted message
export async function sendMessage(
  conversationId: string,
  plaintext: string,
  senderWallet: WalletWithPrivateKeys,
  recipientEncryptionPublicKey: string,
  selfDestruct: boolean = false,
  destructAfterSeconds?: number
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

  storeSentMessage(msg.id, plaintext);

  return {
    id: msg.id,
    conversationId: msg.conversationId,
    senderWalletId: msg.senderWalletId,
    encryptedContent: msg.encryptedContent,
    signature: msg.signature,
    selfDestruct: msg.selfDestruct,
    destructAfterSeconds: msg.destructAfterSeconds,
    readAt: msg.readAt,
    createdAt: msg.createdAt,
    plaintext,
    signatureValid: true,
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
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const decryptedMessages: Message[] = [];

  for (const msg of messages) {
    const sender = participants.find(p => p.id === msg.senderWalletId);

    let plaintext = "[Unable to decrypt]";
    let signatureValid = false;

    if (msg.senderWalletId === recipientWallet.id) {
      const storedPlaintext = getSentMessage(msg.id);
      plaintext = storedPlaintext || "[Your encrypted message]";
      signatureValid = true;
    } else if (sender) {
      try {
        const decryptData = await decryptMessage(
          msg.encryptedContent,
          recipientWallet.encryptionPrivateKey,
          sender.signingPublicKey,
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
      plaintext,
      signatureValid,
      senderDisplayName: sender?.displayName || "Unknown",
    });
  }

  return decryptedMessages;
}
