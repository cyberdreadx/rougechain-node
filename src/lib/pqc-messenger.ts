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
  lastMessageAt?: string;
  lastSenderId?: string;
  lastMessagePreview?: string;
  unreadCount?: number;
}

const WALLET_STORAGE_KEY = "pqc_messenger_wallet";
const DEMO_BOT_STORAGE_KEY = "pqc_demo_bot_wallet";
const SENT_MESSAGES_KEY = "pqc_sent_messages";
const PRIVACY_SETTINGS_KEY = "pqc_privacy_settings";
const BLOCKED_WALLETS_KEY = "pqc_blocked_wallets";
const TOFU_STORE_KEY = "pqc_tofu_fingerprints";
const MESSENGER_API_PREFIX = "/messenger";

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
  try {
    const raw = localStorage.getItem(TOFU_STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveTofuStore(store: Record<string, TofuEntry>): void {
  localStorage.setItem(TOFU_STORE_KEY, JSON.stringify(store));
}

export async function checkTofu(wallet: Wallet): Promise<{
  trusted: boolean;
  changed: boolean;
  firstSeen: number;
}> {
  const store = loadTofuStore();
  const sigFp = await keyFingerprint(wallet.signingPublicKey);
  const encFp = await keyFingerprint(wallet.encryptionPublicKey);
  const key = wallet.id;

  const existing = store[key];
  if (!existing) {
    store[key] = {
      walletId: wallet.id,
      signingFingerprint: sigFp,
      encryptionFingerprint: encFp,
      firstSeen: Date.now(),
    };
    saveTofuStore(store);
    return { trusted: true, changed: false, firstSeen: Date.now() };
  }

  const changed = existing.signingFingerprint !== sigFp || existing.encryptionFingerprint !== encFp;
  if (changed) {
    store[key] = {
      ...existing,
      signingFingerprint: sigFp,
      encryptionFingerprint: encFp,
    };
    saveTofuStore(store);
  }
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

// Media support constants
export const MAX_MEDIA_SIZE = 50 * 1024 * 1024; // 50 MB input (will be compressed)
const TARGET_PAYLOAD_BYTES = 1.5 * 1024 * 1024; // target compressed size ~1.5 MB
const IMAGE_MAX_DIM = 1600;
const VIDEO_MAX_DIM = 640;
const VIDEO_MAX_DURATION_S = 30;

// Media payload envelope (stored as encrypted plaintext)
interface MediaPayload {
  type: "image" | "video";
  fileName: string;
  mimeType: string;
  data: string; // base64 encoded
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

// Convert a File to a media payload string for encryption
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
  discoverable: boolean;
}

// Get privacy settings
export function getPrivacySettings(): PrivacySettings {
  try {
    const stored = localStorage.getItem(PRIVACY_SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        storeSentMessages: parsed.storeSentMessages ?? true,
        discoverable: parsed.discoverable ?? true,
      };
    }
  } catch {
    // Ignore parse errors
  }
  // Default: store sent messages (better UX), discoverable ON (backward compat)
  return { storeSentMessages: true, discoverable: true };
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

export async function registerWalletOnNode(wallet: Wallet | WalletWithPrivateKeys, discoverableOverride?: boolean): Promise<void> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) return;
  const privacy = getPrivacySettings();

  let priv = (wallet as WalletWithPrivateKeys).signingPrivateKey;
  let sigPub = wallet.signingPublicKey;

  // Fall back to unified wallet for private key if not provided
  if (!priv) {
    try {
      const { loadUnifiedWallet } = await import("@/lib/unified-wallet");
      const uw = loadUnifiedWallet();
      if (uw?.signingPrivateKey && uw.signingPublicKey === sigPub) {
        priv = uw.signingPrivateKey;
      }
    } catch {}
  }

  if (!priv) return;

  const signed = buildSignedRequest(
    {
      id: wallet.id,
      displayName: wallet.displayName,
      signingPublicKey: wallet.signingPublicKey,
      encryptionPublicKey: wallet.encryptionPublicKey,
      discoverable: discoverableOverride ?? privacy.discoverable,
    },
    priv,
    sigPub,
  );
  await fetch(`${apiBase}/v2/messenger/wallets/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(signed),
  });
}

async function kemEncryptPlaintext(
  plaintext: string,
  encryptionPublicKey: Uint8Array
): Promise<{ kemCipherText: string; iv: string; encryptedContent: string }> {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(encryptionPublicKey);

  const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret.buffer.slice(sharedSecret.byteOffset, sharedSecret.byteOffset + sharedSecret.byteLength) as ArrayBuffer, "HKDF", false, ["deriveKey"]);
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
  const senderPrivKeyBytes = hexToBytes(senderSigningPrivateKey);
  if (senderPrivKeyBytes.length !== 4032) {
    throw new Error(
      `Signing key invalid (${senderPrivKeyBytes.length} bytes, expected 4032). ` +
      `Your wallet has old-format keys. Please regenerate keys in Settings.`
    );
  }

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
  const signature = ml_dsa65.sign(new TextEncoder().encode(encryptedPackage), senderPrivKeyBytes);

  return {
    encryptedPackage,
    signature: bytesToHex(signature),
  };
}

async function kemDecryptPayload(
  kemCipherText: string,
  iv: string,
  encryptedContent: string,
  decryptionPrivateKey: Uint8Array
): Promise<string> {
  const sharedSecret = ml_kem768.decapsulate(hexToBytes(kemCipherText), decryptionPrivateKey);

  const ssArr = sharedSecret;
  const ssBuf = ssArr.buffer.slice(ssArr.byteOffset, ssArr.byteOffset + ssArr.byteLength) as ArrayBuffer;
  const keyMaterial = await crypto.subtle.importKey("raw", ssBuf, "HKDF", false, ["deriveKey"]);
  const aesKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("pqc-msg") },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const ivBytes = hexToBytes(iv);
  const ivBuf = ivBytes.buffer.slice(ivBytes.byteOffset, ivBytes.byteOffset + ivBytes.byteLength) as ArrayBuffer;
  const encBytes = hexToBytes(encryptedContent);
  const encBuf = encBytes.buffer.slice(encBytes.byteOffset, encBytes.byteOffset + encBytes.byteLength) as ArrayBuffer;
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBuf },
    aesKey,
    encBuf
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
  const encryptedData = JSON.parse(encryptedPackage) as {
    kemCipherText: string;
    iv: string;
    encryptedContent: string;
    senderKemCipherText?: string;
    senderIv?: string;
    senderEncryptedContent?: string;
  };

  const privKeyBytes = hexToBytes(recipientEncryptionPrivateKey);
  let plaintext: string;

  if (isSender && encryptedData.senderKemCipherText && encryptedData.senderIv && encryptedData.senderEncryptedContent) {
    plaintext = await kemDecryptPayload(
      encryptedData.senderKemCipherText, encryptedData.senderIv, encryptedData.senderEncryptedContent, privKeyBytes
    );
  } else {
    plaintext = await kemDecryptPayload(
      encryptedData.kemCipherText, encryptedData.iv, encryptedData.encryptedContent, privKeyBytes
    );
  }

  let signatureValid = false;
  if (senderSigningPublicKey && signature) {
    try {
      const sigPubKeyBytes = hexToBytes(senderSigningPublicKey);
      const sigBytes = hexToBytes(signature);
      signatureValid = ml_dsa65.verify(sigBytes, new TextEncoder().encode(encryptedPackage), sigPubKeyBytes);
    } catch (e) {
      console.warn("[Messenger] Signature verification failed", e);
    }
  }

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
      const parsed = JSON.parse(stored) as WalletWithPrivateKeys;
      // Migrate legacy fixed-ID bot to unique-ID format
      if (parsed.id === "demo-bot") {
        localStorage.removeItem(DEMO_BOT_STORAGE_KEY);
      } else {
        return parsed;
      }
    } catch {
      // Continue to create new one
    }
  }

  // Let the libraries generate their own secure random seeds
  const signingKeypair = ml_dsa65.keygen();
  const encryptionKeypair = ml_kem768.keygen();

  const pubHex = bytesToHex(signingKeypair.publicKey);
  const saved: WalletWithPrivateKeys = {
    id: `bot-${pubHex.slice(0, 16)}`,
    displayName: "Quantum Bot",
    signingPublicKey: bytesToHex(signingKeypair.publicKey),
    encryptionPublicKey: bytesToHex(encryptionKeypair.publicKey),
    signingPrivateKey: bytesToHex(signingKeypair.secretKey),
    encryptionPrivateKey: bytesToHex(encryptionKeypair.secretKey),
  };

  // Store the bot wallet locally so it can respond
  localStorage.setItem(DEMO_BOT_STORAGE_KEY, JSON.stringify(saved));
  try {
    await registerWalletOnNode(saved, false);
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
    const apiBase = getMessengerApiBase();
    if (!apiBase) throw new Error("No API base");
    const res = await fetch(`${apiBase}/bot/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
      body: JSON.stringify({ message: userMessage.slice(0, 500) }),
    });
    if (!res.ok) throw new Error(`Bot API error: ${res.status}`);
    const data = await res.json() as { reply?: string; error?: string };
    if (data.reply) return data.reply;
  } catch (error) {
    console.warn("[Messenger] Bot AI unavailable, using fallback:", error);
  }
  return getDemoBotResponse();
}

export async function createConversation(
  senderWallet: WalletWithPrivateKeys,
  recipientWalletId: string,
  name?: string,
): Promise<Conversation> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) throw new Error("Node API is not configured");

  const payload: Record<string, unknown> = {
    participantIds: [senderWallet.id, recipientWalletId],
    isGroup: false,
  };
  if (name) payload.name = name;

  const signed = buildSignedRequest(
    payload,
    senderWallet.signingPrivateKey,
    senderWallet.signingPublicKey,
  );
  const response = await fetch(`${apiBase}/v2/messenger/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(signed),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed to create conversation: ${response.status} ${errorText}`);
  }
  const data = await response.json().catch(() => null);
  return data?.conversation as Conversation;
}

export async function deleteMessage(wallet: WalletWithPrivateKeys, messageId: string, conversationId: string): Promise<void> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) throw new Error("Node API is not configured");
  const signed = buildSignedRequest(
    { messageId, conversationId },
    wallet.signingPrivateKey,
    wallet.signingPublicKey,
  );
  const response = await fetch(`${apiBase}/v2/messenger/messages/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(signed),
  });
  if (!response.ok) throw new Error(`Failed to delete message: ${response.status}`);
}

export async function deleteConversation(wallet: WalletWithPrivateKeys, conversationId: string): Promise<void> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) throw new Error("Node API is not configured");
  const signed = buildSignedRequest(
    { conversationId },
    wallet.signingPrivateKey,
    wallet.signingPublicKey,
  );
  const response = await fetch(`${apiBase}/v2/messenger/conversations/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(signed),
  });
  if (!response.ok) throw new Error(`Failed to delete conversation: ${response.status}`);
}

export async function getConversations(walletId: string, currentWallet?: Wallet | WalletWithPrivateKeys): Promise<Conversation[]> {
  const apiBase = getMessengerApiBase();
  if (!apiBase) return [];

  let rawConversations: unknown[];
  const privKey = (currentWallet as WalletWithPrivateKeys)?.signingPrivateKey;
  if (privKey && currentWallet?.signingPublicKey) {
    const signed = buildSignedRequest({}, privKey, currentWallet.signingPublicKey);
    const response = await fetch(`${apiBase}/v2/messenger/conversations/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
      body: JSON.stringify(signed),
    });
    if (!response.ok) return [];
    const data = await response.json().catch(() => null);
    rawConversations = data?.conversations || [];
  } else {
    const params = new URLSearchParams({ walletId });
    if (currentWallet?.signingPublicKey) params.set("signingPublicKey", currentWallet.signingPublicKey);
    if (currentWallet?.encryptionPublicKey) params.set("encryptionPublicKey", currentWallet.encryptionPublicKey);
    const response = await fetch(`${apiBase}${MESSENGER_API_PREFIX}/conversations?${params.toString()}`, {
      headers: getCoreApiHeaders(),
    });
    if (!response.ok) return [];
    const data = await response.json().catch(() => null);
    rawConversations = data?.conversations || [];
  }

  const allWallets = await getWallets();
  const walletMap = new Map<string, Wallet>();
  for (const w of allWallets) {
    if (w.id) walletMap.set(w.id, w);
    if (w.signingPublicKey) walletMap.set(w.signingPublicKey, w);
    if (w.encryptionPublicKey) walletMap.set(w.encryptionPublicKey, w);
  }

  // Include locally stored demo bot wallet (not discoverable on server)
  const botWallet = loadDemoBotWallet();
  if (botWallet) {
    const bw: Wallet = {
      id: botWallet.id,
      displayName: botWallet.displayName,
      signingPublicKey: botWallet.signingPublicKey,
      encryptionPublicKey: botWallet.encryptionPublicKey,
    };
    if (bw.id) walletMap.set(bw.id, bw);
    if (bw.signingPublicKey) walletMap.set(bw.signingPublicKey, bw);
    if (bw.encryptionPublicKey) walletMap.set(bw.encryptionPublicKey, bw);
  }

  const currentIds = currentWallet
    ? new Set([currentWallet.id, currentWallet.signingPublicKey, currentWallet.encryptionPublicKey].filter(Boolean))
    : new Set<string>();

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
    last_message_at?: string;
    last_sender_id?: string;
    last_message_preview?: string;
    unread_count?: number;
  }) => {
    const participantIds = conv.participant_ids || conv.participantIds || [];
    const participants: Wallet[] = participantIds
      .map((id: string) => {
        if (currentIds.has(id)) return currentWallet!;
        const w = walletMap.get(id);
        if (w && currentWallet && w.displayName === currentWallet.displayName && !currentIds.has(w.id)) {
          return currentWallet;
        }
        if (w) return w;
        const fallback = allWallets.find(aw =>
          aw.id === id || aw.signingPublicKey === id || aw.encryptionPublicKey === id
        );
        if (fallback) return fallback;
        return { id, displayName: id.startsWith("bot-") ? "Quantum Bot" : "Unknown", signingPublicKey: "", encryptionPublicKey: "" };
      });

    return {
      id: conv.id,
      name: conv.name,
      isGroup: conv.is_group ?? conv.isGroup ?? false,
      createdBy: conv.created_by || conv.createdBy,
      createdAt: conv.created_at || conv.createdAt || new Date().toISOString(),
      participantIds,
      participants,
      lastMessageAt: conv.last_message_at,
      lastSenderId: conv.last_sender_id,
      lastMessagePreview: conv.last_message_preview,
      unreadCount: conv.unread_count,
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
    senderWallet.signingPrivateKey,
    senderWallet.encryptionPublicKey
  );

  const signed = buildSignedRequest(
    {
      conversationId,
      encryptedContent: encryptData.encryptedPackage,
      contentSignature: encryptData.signature,
      selfDestruct,
      destructAfterSeconds,
      messageType,
      spoiler,
    },
    senderWallet.signingPrivateKey,
    senderWallet.signingPublicKey,
  );
  const response = await fetch(`${apiBase}/v2/messenger/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(signed),
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

  const signed = buildSignedRequest(
    { conversationId },
    recipientWallet.signingPrivateKey,
    recipientWallet.signingPublicKey,
  );
  const response = await fetch(`${apiBase}/v2/messenger/messages/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(signed),
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
          w.signingPublicKey === msg.senderWalletId ||
          w.encryptionPublicKey === msg.senderWalletId
        );
        // Last resort: if the sender is the other participant in the conversation,
        // use the non-self participant (common in 1:1 chats with stale IDs)
        if (!sender && participants.length >= 2) {
          const otherParticipant = participants.find(p =>
            p.id !== recipientWallet.id &&
            p.signingPublicKey !== recipientWallet.signingPublicKey
          );
          if (otherParticipant) sender = otherParticipant;
        }
      } catch {
        // Network error: fall back to the other conversation participant
        if (participants.length >= 2) {
          const otherParticipant = participants.find(p =>
            p.id !== recipientWallet.id &&
            p.signingPublicKey !== recipientWallet.signingPublicKey
          );
          if (otherParticipant) sender = otherParticipant;
        }
      }
    }

    let plaintext = "[Unable to decrypt]";
    let signatureValid = false;
    const senderSigningPublicKey = sender?.signingPublicKey;

    // Check if this is our own message (check all possible ID formats)
    const isOwnMessage = msg.senderWalletId === recipientWallet.id ||
      msg.senderWalletId === recipientWallet.signingPublicKey ||
      msg.senderWalletId === recipientWallet.encryptionPublicKey ||
      (recipientWallet.signingPublicKey &&
        msg.senderWalletId?.startsWith(recipientWallet.signingPublicKey.substring(0, 20)));

    if (isOwnMessage) {
      const storedPlaintext = getSentMessage(msg.id);
      if (storedPlaintext) {
        plaintext = storedPlaintext;
        signatureValid = true;
      } else if (msg.encryptedContent) {
        try {
          const decryptData = await decryptMessage(
            msg.encryptedContent,
            recipientWallet.encryptionPrivateKey,
            recipientWallet.signingPublicKey,
            msg.signature
          );
          plaintext = decryptData.plaintext;
          signatureValid = decryptData.signatureValid;
        } catch {
          plaintext = "[Your encrypted message]";
          signatureValid = true;
        }
      } else {
        plaintext = "[Your encrypted message]";
        signatureValid = true;
      }
    } else if (msg.encryptedContent) {
      try {
        const decryptData = await decryptMessage(
          msg.encryptedContent,
          recipientWallet.encryptionPrivateKey,
          senderSigningPublicKey || "",
          msg.signature
        );
        plaintext = decryptData.plaintext;
        signatureValid = senderSigningPublicKey ? decryptData.signatureValid : false;

        if (msg.selfDestruct && !msg.readAt) {
          const readSigned = buildSignedRequest(
            { messageId: msg.id, conversationId },
            recipientWallet.signingPrivateKey,
            recipientWallet.signingPublicKey,
          );
          await fetch(`${apiBase}/v2/messenger/messages/read`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
            body: JSON.stringify(readSigned),
          });
        }
      } catch (e) {
        console.error("Decryption error:", e);
      }
    }

    // Detect garbage decryption output — if most chars are non-printable,
    // the wrong key was used and decryption produced nonsense
    if (plaintext !== "[Unable to decrypt]" && plaintext !== "[Your encrypted message]" && plaintext.length > 20) {
      const nonPrintable = [...plaintext].filter(c => {
        const code = c.charCodeAt(0);
        return code < 32 && code !== 10 && code !== 13 && code !== 9;
      }).length;
      if (nonPrintable / plaintext.length > 0.1) {
        plaintext = "[Unable to decrypt]";
      }
    }

    // Detect media messages and extract media data
    const rawMessageType = (raw.message_type || raw.messageType || "text") as MessageType;

    // Always try to parse media from plaintext — backend may default
    // messageType to "text" even for image/video messages
    const mediaInfo = (plaintext && plaintext !== "[Unable to decrypt]" && plaintext !== "[Your encrypted message]")
      ? parseMediaPayload(plaintext)
      : null;

    // If decryption failed and this is a media message, show clean placeholder
    let displayPlaintext = plaintext;
    if ((plaintext === "[Unable to decrypt]" || plaintext === "[Your encrypted message]") && rawMessageType !== "text") {
      displayPlaintext = `[${rawMessageType === "image" ? "Image" : "Video"} — unable to decrypt]`;
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
      plaintext: mediaInfo?.mediaFileName || displayPlaintext,
      signatureValid,
      senderDisplayName: sender?.displayName || (isOwnMessage ? "You" : "Unknown"),
      messageType: mediaInfo?.messageType || rawMessageType,
      mediaUrl: mediaInfo?.mediaUrl,
      mediaFileName: mediaInfo?.mediaFileName,
      spoiler: raw.spoiler ?? false,
    });
  }

  // Filter out expired self-destruct messages client-side
  const now = Date.now();
  return decryptedMessages.filter(m => {
    if (!m.selfDestruct || !m.readAt) return true;
    const readTime = new Date(m.readAt).getTime();
    if (isNaN(readTime)) return true;
    const ttl = (m.destructAfterSeconds ?? 30) * 1000;
    return now < readTime + ttl;
  });
}
