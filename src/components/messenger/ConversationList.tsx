import { motion } from "framer-motion";
import { MessageSquare, Users, Lock } from "lucide-react";
import type { Conversation } from "@/lib/pqc-messenger";

interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  currentWalletId: string;
  onSelect: (conversation: Conversation) => void;
}

const ConversationList = ({ conversations, selectedId, currentWalletId, onSelect }: ConversationListProps) => {
  const getConversationName = (conversation: Conversation): string => {
    if (conversation.name) return conversation.name;
    
    // For 1:1, show the other participant's name
    const other = conversation.participants?.find(p => p.id !== currentWalletId);
    return other?.displayName || "Unknown";
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
            className={`w-full p-4 flex items-center gap-3 hover:bg-muted/50 transition-colors text-left ${
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
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Lock className="w-3 h-3" />
                End-to-end encrypted
              </p>
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  );
};

export default ConversationList;
