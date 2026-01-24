import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface MessengerWallet {
  id: string;
  displayName: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  createdAt: string;
}

export interface MessengerConversation {
  id: string;
  name?: string;
  isGroup: boolean;
  createdBy: string;
  createdAt: string;
  participantIds: string[];
}

export interface MessengerMessage {
  id: string;
  conversationId: string;
  senderWalletId: string;
  encryptedContent: string;
  signature: string;
  selfDestruct: boolean;
  destructAfterSeconds?: number;
  readAt?: string;
  createdAt: string;
}

export class MessengerStore {
  private walletsPath: string;
  private conversationsPath: string;
  private messagesPath: string;

  constructor(private dataDir: string) {
    this.walletsPath = path.join(dataDir, "messenger-wallets.json");
    this.conversationsPath = path.join(dataDir, "messenger-conversations.json");
    this.messagesPath = path.join(dataDir, "messenger-messages.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.ensureFile(this.walletsPath);
    await this.ensureFile(this.conversationsPath);
    await this.ensureFile(this.messagesPath);
  }

  private async ensureFile(filePath: string): Promise<void> {
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, "[]", "utf8");
    }
  }

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      await fs.writeFile(filePath, JSON.stringify(fallback), "utf8");
      return fallback;
    }
  }

  private async writeJson<T>(filePath: string, data: T): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  async registerWallet(wallet: MessengerWallet): Promise<MessengerWallet> {
    const wallets = await this.readJson<MessengerWallet[]>(this.walletsPath, []);
    const existingIndex = wallets.findIndex((w) => w.id === wallet.id || w.signingPublicKey === wallet.signingPublicKey);
    if (existingIndex >= 0) {
      wallets[existingIndex] = { ...wallets[existingIndex], ...wallet };
    } else {
      wallets.push(wallet);
    }
    await this.writeJson(this.walletsPath, wallets);
    return wallet;
  }

  async listWallets(): Promise<MessengerWallet[]> {
    return this.readJson<MessengerWallet[]>(this.walletsPath, []);
  }

  async createConversation(params: {
    createdBy: string;
    participantIds: string[];
    name?: string;
    isGroup?: boolean;
  }): Promise<MessengerConversation> {
    const conversations = await this.readJson<MessengerConversation[]>(this.conversationsPath, []);
    const participantIds = Array.from(new Set(params.participantIds));
    const isGroup = params.isGroup ?? participantIds.length > 2;

    if (!isGroup && participantIds.length === 2) {
      const existing = conversations.find((conv) => {
        if (conv.isGroup) return false;
        if (conv.participantIds.length !== 2) return false;
        const set = new Set(conv.participantIds);
        return participantIds.every((id) => set.has(id));
      });
      if (existing) {
        return existing;
      }
    }

    const conversation: MessengerConversation = {
      id: randomUUID(),
      name: params.name,
      isGroup,
      createdBy: params.createdBy,
      createdAt: new Date().toISOString(),
      participantIds,
    };
    conversations.push(conversation);
    await this.writeJson(this.conversationsPath, conversations);
    return conversation;
  }

  async listConversations(walletId: string): Promise<Array<MessengerConversation & {
    participants: MessengerWallet[];
    lastMessage?: MessengerMessage;
  }>> {
    const conversations = await this.readJson<MessengerConversation[]>(this.conversationsPath, []);
    const wallets = await this.readJson<MessengerWallet[]>(this.walletsPath, []);
    const messages = await this.readJson<MessengerMessage[]>(this.messagesPath, []);

    const byConversation = new Map<string, MessengerMessage[]>();
    for (const msg of messages) {
      const list = byConversation.get(msg.conversationId) ?? [];
      list.push(msg);
      byConversation.set(msg.conversationId, list);
    }

    return conversations
      .filter((conv) => conv.participantIds.includes(walletId))
      .map((conv) => {
        const participants = conv.participantIds.map((id) => {
          return wallets.find((w) => w.id === id) ?? {
            id,
            displayName: "Unknown",
            signingPublicKey: "",
            encryptionPublicKey: "",
            createdAt: new Date().toISOString(),
          };
        });
        const convMessages = byConversation.get(conv.id) ?? [];
        const lastMessage = convMessages
          .slice()
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
          .at(-1);
        return { ...conv, participants, lastMessage };
      })
      .sort((a, b) => {
        const aTime = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : new Date(a.createdAt).getTime();
        const bTime = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : new Date(b.createdAt).getTime();
        return bTime - aTime;
      });
  }

  async addMessage(message: Omit<MessengerMessage, "id" | "createdAt">): Promise<MessengerMessage> {
    const messages = await this.readJson<MessengerMessage[]>(this.messagesPath, []);
    const entry: MessengerMessage = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...message,
    };
    messages.push(entry);
    await this.writeJson(this.messagesPath, messages);
    return entry;
  }

  async listMessages(conversationId: string): Promise<MessengerMessage[]> {
    const messages = await this.readJson<MessengerMessage[]>(this.messagesPath, []);
    const now = Date.now();
    let changed = false;
    const filtered = messages.filter((msg) => {
      if (msg.conversationId !== conversationId) return true;
      if (msg.selfDestruct && msg.readAt && msg.destructAfterSeconds) {
        const readAt = new Date(msg.readAt).getTime();
        if (now - readAt > msg.destructAfterSeconds * 1000) {
          changed = true;
          return false;
        }
      }
      return true;
    });

    if (changed) {
      await this.writeJson(this.messagesPath, filtered);
    }

    return filtered
      .filter((msg) => msg.conversationId === conversationId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  async markMessageRead(messageId: string): Promise<MessengerMessage | null> {
    const messages = await this.readJson<MessengerMessage[]>(this.messagesPath, []);
    const idx = messages.findIndex((msg) => msg.id === messageId);
    if (idx === -1) return null;
    if (!messages[idx].readAt) {
      messages[idx] = { ...messages[idx], readAt: new Date().toISOString() };
      await this.writeJson(this.messagesPath, messages);
    }
    return messages[idx];
  }
}
