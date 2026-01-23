import { supabase } from "@/integrations/supabase/client";

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
  participants?: Wallet[];
  lastMessage?: Message;
}

const WALLET_STORAGE_KEY = "pqc_messenger_wallet";
const DEMO_BOT_STORAGE_KEY = "pqc_demo_bot_wallet";
const SENT_MESSAGES_KEY = "pqc_sent_messages";

// Helper to store sent message plaintext locally
function storeSentMessage(messageId: string, plaintext: string): void {
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

// Create a new wallet with ML-DSA-65 + ML-KEM-768 keypairs
export async function createWallet(displayName: string): Promise<WalletWithPrivateKeys> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "create-wallet", payload: { displayName } },
  });

  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.error || "Failed to create wallet");

  const wallet: WalletWithPrivateKeys = {
    id: data.wallet.id,
    displayName: data.wallet.displayName,
    signingPublicKey: data.wallet.signingPublicKey,
    encryptionPublicKey: data.wallet.encryptionPublicKey,
    signingPrivateKey: data.privateKeys.signingPrivateKey,
    encryptionPrivateKey: data.privateKeys.encryptionPrivateKey,
  };

  // Save locally
  saveWalletLocally(wallet);

  return wallet;
}

// Get all wallets (for finding contacts)
export async function getWallets(): Promise<Wallet[]> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "get-wallets" },
  });

  if (error) throw new Error(error.message);
  return data.wallets || [];
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

  // Create a new demo bot wallet
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "create-wallet", payload: { displayName: "🤖 Quantum Bot" } },
  });

  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.error || "Failed to create demo bot");

  const botWallet: WalletWithPrivateKeys = {
    id: data.wallet.id,
    displayName: data.wallet.displayName,
    signingPublicKey: data.wallet.signingPublicKey,
    encryptionPublicKey: data.wallet.encryptionPublicKey,
    signingPrivateKey: data.privateKeys.signingPrivateKey,
    encryptionPrivateKey: data.privateKeys.encryptionPrivateKey,
  };

  // Store the bot wallet locally so it can respond
  localStorage.setItem(DEMO_BOT_STORAGE_KEY, JSON.stringify(botWallet));

  return botWallet;
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

// Create a 1:1 conversation
export async function createConversation(
  myWalletId: string,
  recipientWalletId: string
): Promise<Conversation> {
  // Check if conversation already exists
  const { data: existing } = await supabase
    .from("conversation_participants")
    .select("conversation_id")
    .eq("wallet_id", myWalletId);

  if (existing) {
    for (const p of existing) {
      const { data: otherParticipant } = await supabase
        .from("conversation_participants")
        .select("wallet_id")
        .eq("conversation_id", p.conversation_id)
        .eq("wallet_id", recipientWalletId)
        .single();

      if (otherParticipant) {
        // Conversation already exists
        const { data: conv } = await supabase
          .from("conversations")
          .select("*")
          .eq("id", p.conversation_id)
          .single();
        
        if (conv && !conv.is_group) {
          return {
            id: conv.id,
            name: conv.name,
            isGroup: conv.is_group,
            createdBy: conv.created_by,
            createdAt: conv.created_at,
          };
        }
      }
    }
  }

  // Create new conversation
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .insert({
      is_group: false,
      created_by: myWalletId,
    })
    .select()
    .single();

  if (convError) throw new Error(convError.message);

  // Add participants
  await supabase.from("conversation_participants").insert([
    { conversation_id: conv.id, wallet_id: myWalletId },
    { conversation_id: conv.id, wallet_id: recipientWalletId },
  ]);

  return {
    id: conv.id,
    name: conv.name,
    isGroup: conv.is_group,
    createdBy: conv.created_by,
    createdAt: conv.created_at,
  };
}

// Get conversations for a wallet
export async function getConversations(walletId: string): Promise<Conversation[]> {
  const { data: participations, error } = await supabase
    .from("conversation_participants")
    .select(`
      conversation_id,
      conversations (
        id,
        name,
        is_group,
        created_by,
        created_at
      )
    `)
    .eq("wallet_id", walletId);

  if (error) throw new Error(error.message);

  const conversations: Conversation[] = [];
  
  for (const p of participations || []) {
    const conv = p.conversations as any;
    if (conv) {
      // Get other participants
      const { data: participants } = await supabase
        .from("conversation_participants")
        .select(`
          wallets (
            id,
            display_name,
            signing_public_key,
            encryption_public_key
          )
        `)
        .eq("conversation_id", conv.id);

      conversations.push({
        id: conv.id,
        name: conv.name,
        isGroup: conv.is_group,
        createdBy: conv.created_by,
        createdAt: conv.created_at,
        participants: (participants || []).map((pt: any) => ({
          id: pt.wallets.id,
          displayName: pt.wallets.display_name,
          signingPublicKey: pt.wallets.signing_public_key,
          encryptionPublicKey: pt.wallets.encryption_public_key,
        })),
      });
    }
  }

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
  // Encrypt the message
  const { data: encryptData, error: encryptError } = await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "encrypt-message",
      payload: {
        plaintext,
        recipientEncryptionPublicKey,
        senderSigningPrivateKey: senderWallet.signingPrivateKey,
      },
    },
  });

  if (encryptError) throw new Error(encryptError.message);
  if (!encryptData.success) throw new Error(encryptData.error || "Encryption failed");

  // Store encrypted message
  const { data: msg, error: msgError } = await supabase
    .from("encrypted_messages")
    .insert({
      conversation_id: conversationId,
      sender_wallet_id: senderWallet.id,
      encrypted_content: encryptData.encryptedPackage,
      signature: encryptData.signature,
      self_destruct: selfDestruct,
      destruct_after_seconds: destructAfterSeconds,
    })
    .select()
    .single();

  if (msgError) throw new Error(msgError.message);

  // Store the plaintext locally so we can display it later
  storeSentMessage(msg.id, plaintext);

  return {
    id: msg.id,
    conversationId: msg.conversation_id,
    senderWalletId: msg.sender_wallet_id,
    encryptedContent: msg.encrypted_content,
    signature: msg.signature,
    selfDestruct: msg.self_destruct,
    destructAfterSeconds: msg.destruct_after_seconds,
    readAt: msg.read_at,
    createdAt: msg.created_at,
    plaintext, // We know the plaintext since we sent it
    signatureValid: true,
  };
}

// Get and decrypt messages for a conversation
export async function getMessages(
  conversationId: string,
  recipientWallet: WalletWithPrivateKeys,
  participants: Wallet[]
): Promise<Message[]> {
  const { data: messages, error } = await supabase
    .from("encrypted_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);

  const decryptedMessages: Message[] = [];

  for (const msg of messages || []) {
    const sender = participants.find(p => p.id === msg.sender_wallet_id);
    
    // Check self-destruct
    if (msg.self_destruct && msg.read_at && msg.destruct_after_seconds) {
      const readTime = new Date(msg.read_at).getTime();
      const now = Date.now();
      const ttl = msg.destruct_after_seconds * 1000;
      if (now - readTime > ttl) {
        // Message expired, delete it
        await supabase.from("encrypted_messages").delete().eq("id", msg.id);
        continue;
      }
    }

    let plaintext = "[Unable to decrypt]";
    let signatureValid = false;

    // Only decrypt if we're the recipient (sender can see their own messages)
    if (msg.sender_wallet_id === recipientWallet.id) {
      // We sent this message - try to get plaintext from local storage
      const storedPlaintext = getSentMessage(msg.id);
      plaintext = storedPlaintext || "[Your encrypted message]";
      signatureValid = true;
    } else if (sender) {
      try {
        const { data: decryptData } = await supabase.functions.invoke("pqc-crypto", {
          body: {
            action: "decrypt-message",
            payload: {
              encryptedPackage: msg.encrypted_content,
              recipientEncryptionPrivateKey: recipientWallet.encryptionPrivateKey,
              senderSigningPublicKey: sender.signingPublicKey,
              signature: msg.signature,
            },
          },
        });

        if (decryptData?.success) {
          plaintext = decryptData.plaintext;
          signatureValid = decryptData.signatureValid;

          // Mark as read for self-destruct
          if (msg.self_destruct && !msg.read_at) {
            await supabase
              .from("encrypted_messages")
              .update({ read_at: new Date().toISOString() })
              .eq("id", msg.id);
          }
        }
      } catch (e) {
        console.error("Decryption error:", e);
      }
    }

    decryptedMessages.push({
      id: msg.id,
      conversationId: msg.conversation_id,
      senderWalletId: msg.sender_wallet_id,
      encryptedContent: msg.encrypted_content,
      signature: msg.signature,
      selfDestruct: msg.self_destruct,
      destructAfterSeconds: msg.destruct_after_seconds,
      readAt: msg.read_at,
      createdAt: msg.created_at,
      plaintext,
      signatureValid,
      senderDisplayName: sender?.displayName || "Unknown",
    });
  }

  return decryptedMessages;
}
