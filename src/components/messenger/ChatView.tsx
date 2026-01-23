import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Send, Lock, Shield, CheckCircle2, XCircle, Timer, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Conversation, WalletWithPrivateKeys, Message, Wallet } from "@/lib/pqc-messenger";
import { getMessages, sendMessage } from "@/lib/pqc-messenger";
import { supabase } from "@/integrations/supabase/client";

interface ChatViewProps {
  conversation: Conversation;
  wallet: WalletWithPrivateKeys;
  onBack: () => void;
}

const ChatView = ({ conversation, wallet, onBack }: ChatViewProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [selfDestruct, setSelfDestruct] = useState(false);
  const [destructSeconds, setDestructSeconds] = useState(30);
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const recipient = conversation.participants?.find(p => p.id !== wallet.id);

  const getConversationName = (): string => {
    if (conversation.name) return conversation.name;
    return recipient?.displayName || "Unknown";
  };

  // Load messages
  useEffect(() => {
    loadMessages();
    
    // Subscribe to realtime updates
    const channel = supabase
      .channel(`messages-${conversation.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "encrypted_messages",
          filter: `conversation_id=eq.${conversation.id}`,
        },
        () => {
          // Reload messages when new one arrives
          loadMessages();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversation.id]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadMessages = async () => {
    try {
      const msgs = await getMessages(
        conversation.id,
        wallet,
        conversation.participants || []
      );
      setMessages(msgs);
    } catch (error) {
      console.error("Failed to load messages:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
    if (!newMessage.trim() || !recipient || isSending) return;

    setIsSending(true);
    try {
      const msg = await sendMessage(
        conversation.id,
        newMessage.trim(),
        wallet,
        recipient.encryptionPublicKey,
        selfDestruct,
        selfDestruct ? destructSeconds : undefined
      );
      setMessages(prev => [...prev, msg]);
      setNewMessage("");
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Chat header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card/50">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="sm:hidden"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
          <Shield className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1">
          <p className="font-medium text-foreground">{getConversationName()}</p>
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Lock className="w-3 h-3" />
            ML-KEM-768 + ML-DSA-65
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <Lock className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>Start the conversation</p>
              <p className="text-xs mt-1">Messages are end-to-end encrypted</p>
            </div>
          </div>
        ) : (
          <AnimatePresence>
            {messages.map((msg, index) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isOwn={msg.senderWalletId === wallet.id}
                index={index}
              />
            ))}
          </AnimatePresence>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Message input */}
      <div className="p-4 border-t border-border bg-card/50">
        {/* Self-destruct toggle */}
        <div className="flex items-center justify-between mb-3 text-sm">
          <div className="flex items-center gap-2">
            <Timer className={`w-4 h-4 ${selfDestruct ? "text-destructive" : "text-muted-foreground"}`} />
            <span className={selfDestruct ? "text-destructive" : "text-muted-foreground"}>
              Self-destruct {selfDestruct ? `(${destructSeconds}s)` : ""}
            </span>
          </div>
          <Switch
            checked={selfDestruct}
            onCheckedChange={setSelfDestruct}
          />
        </div>

        <div className="flex gap-2">
          <Input
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            placeholder="Type a message..."
            className="flex-1"
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            disabled={isSending}
          />
          <Button
            onClick={handleSend}
            disabled={!newMessage.trim() || isSending}
            size="icon"
          >
            {isSending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

// Message bubble component
const MessageBubble = ({ message, isOwn, index }: { message: Message; isOwn: boolean; index: number }) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.02 }}
      className={`flex ${isOwn ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 ${
          isOwn
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-muted text-foreground rounded-bl-md"
        }`}
      >
        {!isOwn && (
          <p className="text-xs font-medium mb-1 opacity-70">
            {message.senderDisplayName}
          </p>
        )}
        <p className="text-sm whitespace-pre-wrap">{message.plaintext}</p>
        <div className={`flex items-center gap-1 mt-1 text-xs ${isOwn ? "justify-end" : ""}`}>
          <span className="opacity-60">
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          {message.selfDestruct && (
            <Timer className="w-3 h-3 text-destructive" />
          )}
          {message.signatureValid ? (
            <CheckCircle2 className="w-3 h-3 text-success" />
          ) : (
            <XCircle className="w-3 h-3 text-destructive" />
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default ChatView;
