import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Send, Lock, Shield, CheckCircle2, XCircle, Timer, Loader2, Bot, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Conversation, WalletWithPrivateKeys, Message, Wallet } from "@/lib/pqc-messenger";
import { getMessages, sendMessage, isDemoBot, loadDemoBotWallet, getDemoBotResponse } from "@/lib/pqc-messenger";
import { supabase } from "@/integrations/supabase/client";

interface ChatViewProps {
  conversation: Conversation;
  wallet: WalletWithPrivateKeys;
  onBack: () => void;
}

// Encryption animation overlay component
const EncryptionAnimation = ({ 
  plaintext, 
  onComplete 
}: { 
  plaintext: string; 
  onComplete: () => void;
}) => {
  const [phase, setPhase] = useState<"plaintext" | "scrambling" | "encrypted" | "sending">("plaintext");
  const [displayText, setDisplayText] = useState(plaintext);
  
  // Generate pseudo-ciphertext
  const generateCiphertext = (length: number) => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    return Array.from({ length: Math.min(length * 2, 64) }, () => 
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  };

  useEffect(() => {
    // Phase 1: Show plaintext briefly
    const timer1 = setTimeout(() => setPhase("scrambling"), 400);
    
    return () => clearTimeout(timer1);
  }, []);

  useEffect(() => {
    if (phase === "scrambling") {
      // Scramble animation
      let iterations = 0;
      const maxIterations = 8;
      const scrambleInterval = setInterval(() => {
        const progress = iterations / maxIterations;
        const scrambled = plaintext.split("").map((char, i) => {
          if (i / plaintext.length < progress) {
            return generateCiphertext(1)[0];
          }
          return char;
        }).join("");
        setDisplayText(scrambled);
        iterations++;
        
        if (iterations >= maxIterations) {
          clearInterval(scrambleInterval);
          setPhase("encrypted");
          setDisplayText(generateCiphertext(plaintext.length));
        }
      }, 60);
      
      return () => clearInterval(scrambleInterval);
    }
  }, [phase, plaintext]);

  useEffect(() => {
    if (phase === "encrypted") {
      const timer = setTimeout(() => setPhase("sending"), 300);
      return () => clearTimeout(timer);
    }
    if (phase === "sending") {
      const timer = setTimeout(onComplete, 400);
      return () => clearTimeout(timer);
    }
  }, [phase, onComplete]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.8, y: -20 }}
      className="flex justify-end mb-4"
    >
      <div className="relative max-w-[80%]">
        {/* Encryption status indicator */}
        <motion.div
          initial={{ opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          className="absolute -top-6 right-0 flex items-center gap-1.5 text-xs text-primary"
        >
          <motion.div
            animate={{ rotate: phase === "scrambling" ? 360 : 0 }}
            transition={{ duration: 0.5, repeat: phase === "scrambling" ? Infinity : 0, ease: "linear" }}
          >
            <Key className="w-3 h-3" />
          </motion.div>
          <span className="font-mono">
            {phase === "plaintext" && "Preparing..."}
            {phase === "scrambling" && "Encrypting with ML-KEM-768..."}
            {phase === "encrypted" && "Signing with ML-DSA-65..."}
            {phase === "sending" && "Sending..."}
          </span>
        </motion.div>

        {/* Message bubble with animation */}
        <motion.div
          className={`rounded-2xl px-4 py-2 rounded-br-md overflow-hidden ${
            phase === "plaintext" 
              ? "bg-primary/50 text-primary-foreground" 
              : "bg-gradient-to-r from-primary via-accent to-primary bg-[length:200%_100%] text-primary-foreground"
          }`}
          animate={{
            backgroundPosition: phase !== "plaintext" ? ["0% 0%", "100% 0%", "0% 0%"] : "0% 0%",
          }}
          transition={{
            duration: 1,
            repeat: phase === "scrambling" || phase === "encrypted" ? Infinity : 0,
            ease: "linear"
          }}
        >
          <motion.p 
            className="text-sm font-mono break-all"
            animate={{ 
              opacity: phase === "sending" ? [1, 0.5, 1] : 1 
            }}
            transition={{ duration: 0.3, repeat: phase === "sending" ? Infinity : 0 }}
          >
            {displayText}
          </motion.p>
          
          {/* Lock icon animation */}
          <motion.div
            className="flex justify-end mt-1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <motion.div
              animate={{ 
                scale: phase === "encrypted" || phase === "sending" ? [1, 1.2, 1] : 1,
              }}
              transition={{ duration: 0.3 }}
            >
              <Lock className={`w-3 h-3 ${
                phase === "encrypted" || phase === "sending" 
                  ? "text-success" 
                  : "text-primary-foreground/60"
              }`} />
            </motion.div>
          </motion.div>
        </motion.div>

        {/* Particle effects during encryption */}
        {(phase === "scrambling" || phase === "encrypted") && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
            {[...Array(6)].map((_, i) => (
              <motion.div
                key={i}
                className="absolute w-1 h-1 bg-primary rounded-full"
                initial={{ 
                  x: "50%", 
                  y: "50%", 
                  opacity: 0 
                }}
                animate={{ 
                  x: `${Math.random() * 100}%`,
                  y: `${Math.random() * 100}%`,
                  opacity: [0, 1, 0],
                }}
                transition={{
                  duration: 0.6,
                  delay: i * 0.1,
                  repeat: Infinity,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
};

const ChatView = ({ conversation, wallet, onBack }: ChatViewProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [selfDestruct, setSelfDestruct] = useState(false);
  const [destructSeconds, setDestructSeconds] = useState(30);
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [encryptingMessage, setEncryptingMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const recipient = conversation.participants?.find(p => p.id !== wallet.id);
  const isRecipientBot = recipient ? isDemoBot(recipient.id) : false;

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

    const messageText = newMessage.trim();
    setNewMessage("");
    setEncryptingMessage(messageText);
  };

  const handleEncryptionComplete = async () => {
    if (!encryptingMessage || !recipient) return;
    
    setIsSending(true);
    const messageText = encryptingMessage;
    setEncryptingMessage(null);
    
    try {
      const msg = await sendMessage(
        conversation.id,
        messageText,
        wallet,
        recipient.encryptionPublicKey,
        selfDestruct,
        selfDestruct ? destructSeconds : undefined
      );
      setMessages(prev => [...prev, msg]);
      
      // If recipient is demo bot, send an auto-reply
      if (isRecipientBot) {
        // Small delay to make it feel natural
        setTimeout(async () => {
          const botWallet = loadDemoBotWallet();
          if (botWallet) {
            try {
              const botResponse = getDemoBotResponse();
              const botMsg = await sendMessage(
                conversation.id,
                botResponse,
                botWallet,
                wallet.encryptionPublicKey, // Encrypt for the user
                false
              );
              setMessages(prev => [...prev, botMsg]);
            } catch (e) {
              console.error("Bot reply failed:", e);
            }
          }
        }, 1000 + Math.random() * 1000); // 1-2 second delay
      }
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
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
          isRecipientBot 
            ? "bg-gradient-to-br from-primary to-accent" 
            : "bg-primary/20"
        }`}>
          {isRecipientBot ? (
            <Bot className="w-5 h-5 text-primary-foreground" />
          ) : (
            <Shield className="w-5 h-5 text-primary" />
          )}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="font-medium text-foreground">{getConversationName()}</p>
            {isRecipientBot && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-primary/20 text-primary">
                Demo
              </span>
            )}
          </div>
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
        ) : messages.length === 0 && !encryptingMessage ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <Lock className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>Start the conversation</p>
              <p className="text-xs mt-1">Messages are end-to-end encrypted</p>
            </div>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {messages.map((msg, index) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isOwn={msg.senderWalletId === wallet.id}
                index={index}
              />
            ))}
            {encryptingMessage && (
              <EncryptionAnimation
                key="encrypting"
                plaintext={encryptingMessage}
                onComplete={handleEncryptionComplete}
              />
            )}
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
            disabled={isSending || !!encryptingMessage}
          />
          <Button
            onClick={handleSend}
            disabled={!newMessage.trim() || isSending || !!encryptingMessage}
            size="icon"
          >
            {isSending || encryptingMessage ? (
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
