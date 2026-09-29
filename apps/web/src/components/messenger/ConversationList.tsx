import { useState } from "react";
import { motion } from "framer-motion";
import { MessageSquare, Users, Lock, Trash2, Loader2, StickyNote, BellOff, Inbox, Ban } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StackedAvatars } from "./StackedAvatars";
import { isGroupConversation, otherMembers } from "@/lib/messenger-prefs";
import { Button } from "@/components/ui/button";
import type { Conversation, WalletWithPrivateKeys } from "@/lib/pqc-messenger";
import { deleteConversation } from "@/lib/pqc-messenger";
import { toast } from "sonner";
import { useRougeAddress } from "@/hooks/useRougeAddress";
import { WalletAvatar } from "@/components/WalletAvatar";

function formatRelativeTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return "";
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d`;
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch { return ""; }
}

interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  wallet: WalletWithPrivateKeys;
  currentWalletId: string;
  currentWalletKeys?: string[];
  currentWalletName?: string;
  onSelect: (conversation: Conversation) => void;
  onDelete?: (conversationId: string) => void;
  /** Message requests (1:1 chats from people I haven't accepted) — Qwalla's Requests tab. */
  requests?: Conversation[];
  onAcceptRequest?: (conversation: Conversation) => void;
  onDeleteRequest?: (conversation: Conversation) => void;
  onBlockRequest?: (conversation: Conversation) => void;
  /** Muted conversation ids (bell-off icon in the row). */
  muted?: Set<string>;
}

const ConversationList = ({ conversations, selectedId, wallet, currentWalletId, currentWalletKeys = [], currentWalletName, onSelect, onDelete, requests = [], onAcceptRequest, onDeleteRequest, onBlockRequest, muted }: ConversationListProps) => {
  const { t } = useTranslation();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [tab, setTab] = useState<"primary" | "requests">("primary");

  const myIds = new Set([currentWalletId, ...currentWalletKeys].filter(Boolean));

  const handleDelete = async (e: React.MouseEvent, conversationId: string) => {
    e.stopPropagation();
    if (deletingId) return;
    
    if (!confirm(t("chat.list.deleteConfirm"))) return;
    
    setDeletingId(conversationId);
    try {
      await deleteConversation(wallet, conversationId);
      onDelete?.(conversationId);
      toast.success("Conversation deleted");
    } catch (error) {
      console.error("Failed to delete conversation:", error);
      toast.error("Failed to delete conversation");
    } finally {
      setDeletingId(null);
    }
  };

  const isSelfConversation = (conversation: Conversation): boolean => {
    if (conversation.name === "Note to Self") return true;
    if (conversation.name === "Quantum Bot") return false;
    if (conversation.participants?.some(p => p.id?.startsWith("bot-"))) return false;
    if (!conversation.participants || conversation.participants.length === 0) return false;
    return conversation.participants.every(p =>
      myIds.has(p.id) || myIds.has(p.signingPublicKey) || myIds.has(p.encryptionPublicKey)
    );
  };

  const getOtherParticipant = (conversation: Conversation) => {
    let other = conversation.participants?.find(p =>
      !myIds.has(p.id) &&
      !myIds.has(p.signingPublicKey) &&
      !myIds.has(p.encryptionPublicKey)
    );
    if (!other && currentWalletName && conversation.participants && conversation.participants.length === 2) {
      other = conversation.participants.find(p => p.displayName !== currentWalletName);
    }
    return other;
  };

  const isGroup = (conversation: Conversation) => isGroupConversation(conversation, myIds);

  const getConversationName = (conversation: Conversation): string => {
    if (isSelfConversation(conversation)) return "Note to Self";
    if (isGroup(conversation)) {
      return conversation.name || t("chat.group.untitled", { count: otherMembers(conversation, myIds).length + 1 });
    }

    const other = getOtherParticipant(conversation);

    if (other) {
      const genericNames = ["My Wallet", "Unknown", ""];
      if (genericNames.includes(other.displayName || "")) {
        return ""; // Will be resolved to rouge1 by the component
      }
      return other.displayName || "";
    }

    if (conversation.name && conversation.name !== currentWalletName) return conversation.name;

    return conversation.isGroup ? (conversation.name || "Group") : "";
  };
  
  const getConversationPubkey = (conversation: Conversation): string | undefined => {
    if (isSelfConversation(conversation) || isGroup(conversation)) return undefined;
    const other = getOtherParticipant(conversation);
    if (!other) return undefined;
    return other.signingPublicKey || other.encryptionPublicKey || undefined;
  };

  // Helper component to resolve rouge1 address for conversation names
  const ConversationNameDisplay = ({ name, pubkey }: { name: string; pubkey?: string }) => {
    const { display: rougeAddr } = useRougeAddress(pubkey);
    const displayName = name || rougeAddr || (pubkey ? `${pubkey.substring(0, 12)}...` : "Unknown");
    return <p className="font-medium truncate text-foreground">{displayName}</p>;
  };

  const showRequests = tab === "requests" && requests.length > 0;

  const tabs = requests.length > 0 && (
    <div className="flex gap-1 p-2 border-b border-border">
      {(["primary", "requests"] as const).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setTab(k)}
          className={`flex-1 rounded-md px-2 py-1.5 bubble-meta transition-colors ${tab === k || (k === "primary" && !showRequests) ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted/40"}`}
        >
          {k === "primary" ? t("chat.requests.primary") : `${t("chat.requests.tab")} (${requests.length})`}
        </button>
      ))}
    </div>
  );

  if (showRequests) {
    return (
      <div className="h-full overflow-y-auto">
        {tabs}
        <p className="px-4 pt-3 pb-1 text-xs text-muted-foreground">{t("chat.requests.hint")}</p>
        <div className="divide-y divide-border">
          {requests.map((conversation) => {
            const other = getOtherParticipant(conversation);
            return (
              <div key={conversation.id} className="p-3 sm:p-4 flex items-center gap-3">
                {other ? (
                  <WalletAvatar id={other.id || other.signingPublicKey} uri={other.avatarUrl} name={getConversationName(conversation)} size={40} />
                ) : (
                  <div className="w-10 h-10 rounded-full flex items-center justify-center bg-primary/20"><Inbox className="w-5 h-5 text-primary" /></div>
                )}
                <button type="button" onClick={() => onSelect(conversation)} className="flex-1 min-w-0 text-left">
                  <ConversationNameDisplay name={getConversationName(conversation)} pubkey={getConversationPubkey(conversation)} />
                  <p className="text-xs text-muted-foreground truncate">{t("chat.requests.wantsToMessage")}</p>
                </button>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {onBlockRequest && (
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title={t("chat.block.block")} onClick={() => onBlockRequest(conversation)}>
                      <Ban className="w-4 h-4" />
                    </Button>
                  )}
                  <Button variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={() => onDeleteRequest?.(conversation)}>{t("chat.requests.delete")}</Button>
                  <Button size="sm" className="h-8 px-2 text-xs" onClick={() => onAcceptRequest?.(conversation)}>{t("chat.requests.accept")}</Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="h-full flex flex-col">
        {tabs}
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-muted-foreground">
          <Lock className="w-12 h-12 mb-4 opacity-50" />
          <p className="font-medium">No conversations yet</p>
          <p className="text-sm mt-1">Start a new chat to begin messaging</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {tabs || (
        <div className="p-3 border-b border-border">
          <h2 className="hud-label">
            {t("chat.list.title")}
          </h2>
        </div>
      )}
      <div className="divide-y divide-border">
        {conversations.map((conversation, index) => (
          <motion.button
            key={conversation.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.05 }}
            onClick={() => onSelect(conversation)}
            className={`group w-full p-4 flex items-center gap-3 hover:bg-muted/50 transition-colors text-left ${
              selectedId === conversation.id ? "bg-muted" : ""
            }`}
          >
            {isGroup(conversation) ? (
              <StackedAvatars members={otherMembers(conversation, myIds)} size={40} />
            ) : !isSelfConversation(conversation) ? (
              (() => {
                const other = getOtherParticipant(conversation);
                return other ? (
                  <WalletAvatar id={other.id || other.signingPublicKey} uri={other.avatarUrl} name={getConversationName(conversation)} size={40} />
                ) : (
                  <div className="w-10 h-10 rounded-full flex items-center justify-center bg-primary/20">
                    <MessageSquare className="w-5 h-5 text-primary" />
                  </div>
                );
              })()
            ) : (
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
              isSelfConversation(conversation)
                ? "bg-amber-500/20"
                : "bg-accent/20"
            }`}>
              {isSelfConversation(conversation) ? (
                <StickyNote className="w-5 h-5 text-amber-500" />
              ) : (
                <Users className="w-5 h-5 text-accent" />
              )}
            </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <ConversationNameDisplay name={getConversationName(conversation)} pubkey={getConversationPubkey(conversation)} />
                {muted?.has(conversation.id) && (
                  <BellOff className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" aria-label={t("chat.mute.muted")} />
                )}
                {(conversation.unreadCount ?? 0) > 0 && (
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                    {conversation.unreadCount! > 9 ? "9+" : conversation.unreadCount}
                  </span>
                )}
              </div>
              {conversation.lastMessagePreview ? (
                <p className="text-xs text-muted-foreground truncate">
                  {conversation.lastMessagePreview}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Lock className="w-3 h-3" />
                  End-to-end encrypted
                </p>
              )}
            </div>
            {conversation.lastMessageAt && (
              <span className="text-xs text-muted-foreground flex-shrink-0 self-start mt-1">
                {formatRelativeTime(conversation.lastMessageAt)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-opacity"
              onClick={(e) => handleDelete(e, conversation.id)}
              disabled={deletingId === conversation.id}
              title="Delete conversation"
            >
              {deletingId === conversation.id ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
            </Button>
          </motion.button>
        ))}
      </div>
    </div>
  );
};

export default ConversationList;
