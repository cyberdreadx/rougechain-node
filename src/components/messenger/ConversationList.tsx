import { useState } from "react";
import { motion } from "framer-motion";
import { MessageSquare, Users, Lock, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Conversation } from "@/lib/pqc-messenger";
import { deleteConversation } from "@/lib/pqc-messenger";
import { toast } from "sonner";

interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  currentWalletId: string;
  onSelect: (conversation: Conversation) => void;
  onDelete?: (conversationId: string) => void;
}

const ConversationList = ({ conversations, selectedId, currentWalletId, onSelect, onDelete }: ConversationListProps) => {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (e: React.MouseEvent, conversationId: string) => {
    e.stopPropagation();
    if (deletingId) return;
    
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    
    setDeletingId(conversationId);
    try {
      await deleteConversation(conversationId);
      onDelete?.(conversationId);
      toast.success("Conversation deleted");
    } catch (error) {
      console.error("Failed to delete conversation:", error);
      toast.error("Failed to delete conversation");
    } finally {
      setDeletingId(null);
    }
  };

  const getOtherParticipant = (conversation: Conversation) => {
    return conversation.participants?.find(p => p.id !== currentWalletId);
  };

  const getConversationName = (conversation: Conversation): string => {
    if (conversation.name) return conversation.name;
    
    // For 1:1, show the other participant's name
    const other = getOtherParticipant(conversation);
    if (!other) return "Unknown";
    
    // If displayName is generic or empty, show truncated address
    const genericNames = ["My Wallet", "Unknown", ""];
    if (genericNames.includes(other.displayName || "")) {
      const addr = other.signingPublicKey || other.encryptionPublicKey || other.id || "";
      return addr.length > 12 ? `${addr.substring(0, 12)}...` : addr || "Unknown";
    }
    
    return other.displayName || "Unknown";
  };
  
  const getConversationAddress = (conversation: Conversation): string => {
    const other = getOtherParticipant(conversation);
    if (!other) return "";
    const addr = other.signingPublicKey || other.encryptionPublicKey || "";
    return addr.length > 10 ? `${addr.substring(0, 10)}...` : addr;
  };

  if (conversations.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center text-muted-foreground">
        <Lock className="w-12 h-12 mb-4 opacity-50" />
        <p className="font-medium">No conversations yet</p>
        <p className="text-sm mt-1">Start a new chat to begin messaging</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 border-b border-border">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Conversations
        </h2>
      </div>
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
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
              conversation.isGroup 
                ? "bg-accent/20" 
                : "bg-primary/20"
            }`}>
              {conversation.isGroup ? (
                <Users className="w-5 h-5 text-accent" />
              ) : (
                <MessageSquare className="w-5 h-5 text-primary" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-foreground truncate">
                {getConversationName(conversation)}
              </p>
              {getConversationAddress(conversation) && (
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {getConversationAddress(conversation)}
                </p>
              )}
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Lock className="w-3 h-3" />
                End-to-end encrypted
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 opacity-0 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-opacity"
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
