import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Send, Lock, Shield, CheckCircle2, XCircle, Timer, Loader2, Bot, Key, X, Copy, Check, FileKey2, Binary, Fingerprint, Paperclip, Image as ImageIcon, Video, EyeOff, Eye } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Conversation, WalletWithPrivateKeys, Message, Wallet, MessageType } from "@/lib/pqc-messenger";
import { getBotReply, getMessages, sendMessage, isDemoBot, loadDemoBotWallet, getWallets, fileToMediaPayload, MAX_MEDIA_SIZE } from "@/lib/pqc-messenger";

interface ChatViewProps {
  conversation: Conversation;
  wallet: WalletWithPrivateKeys;
  onBack: () => void;
}

interface EncryptedPackage {
  kemCipherText: string;
  iv: string;
  encryptedContent: string;
}

// Safe date formatter to handle invalid dates
const formatMessageTime = (dateInput: string | number | Date): string => {
  try {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};

const formatMessageDate = (dateInput: string | number | Date | undefined): string => {
  if (!dateInput) return "Unknown date";
  try {
    // Handle Unix timestamps (seconds)
    let date: Date;
    if (typeof dateInput === "number") {
      // If it's a small number, treat as seconds; otherwise milliseconds
      date = dateInput < 10000000000 ? new Date(dateInput * 1000) : new Date(dateInput);
    } else {
      date = new Date(dateInput);
    }
    if (isNaN(date.getTime())) return "Unknown date";
    return date.toLocaleString();
  } catch {
    return "Unknown date";
  }
};

// Encryption details panel component
const EncryptionDetailsPanel = ({
  message,
  onClose,
}: {
  message: Message;
  onClose: () => void;
}) => {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  let parsedPackage: EncryptedPackage | null = null;
  try {
    parsedPackage = JSON.parse(message.encryptedContent);
  } catch {
    // Invalid JSON
  }

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const formatHex = (hex: string, maxLength: number = 64) => {
    if (hex.length <= maxLength) return hex;
    return `${hex.slice(0, maxLength / 2)}...${hex.slice(-maxLength / 2)}`;
  };

  const CopyButton = ({ text, field }: { text: string; field: string }) => (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 shrink-0"
      onClick={() => copyToClipboard(text, field)}
    >
      {copiedField === field ? (
        <Check className="w-3 h-3 text-success" />
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </Button>
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.9, y: 20 }}
        className="bg-card border border-border rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
              <FileKey2 className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Encryption Details</h3>
              <p className="text-xs text-muted-foreground">ML-KEM-768 + AES-256-GCM</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <ScrollArea className="h-[calc(80vh-80px)]">
          <div className="p-4 pb-12 space-y-4">
            {/* Message info */}
            <div className="p-3 rounded-lg bg-muted/30 border border-border">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium text-muted-foreground">Message ID</span>
                <span className="text-xs font-mono text-foreground">{message.id}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Timestamp</span>
                <span className="text-xs text-foreground">
                  {formatMessageDate(message.createdAt)}
                </span>
              </div>
            </div>

            {parsedPackage ? (
              <>
                {/* KEM Ciphertext */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Key className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium text-foreground">KEM Ciphertext</span>
                    <span className="text-xs text-muted-foreground">
                      ({(parsedPackage.kemCipherText?.length || 0) / 2} bytes)
                    </span>
                    <CopyButton text={parsedPackage.kemCipherText || ""} field="kem" />
                  </div>
                  <div className="p-3 rounded-lg bg-background border border-border overflow-hidden">
                    <p className="text-xs font-mono text-muted-foreground break-all leading-relaxed">
                      {formatHex(parsedPackage.kemCipherText || "", 128)}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    ML-KEM-768 encapsulated shared secret (FIPS 203)
                  </p>
                </div>

                {/* IV */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Binary className="w-4 h-4 text-accent" />
                    <span className="text-sm font-medium text-foreground">Initialization Vector</span>
                    <span className="text-xs text-muted-foreground">
                      ({(parsedPackage.iv?.length || 0) / 2} bytes)
                    </span>
                    <CopyButton text={parsedPackage.iv || ""} field="iv" />
                  </div>
                  <div className="p-3 rounded-lg bg-background border border-border">
                    <p className="text-xs font-mono text-foreground break-all">
                      {parsedPackage.iv || ""}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Random nonce for AES-256-GCM encryption
                  </p>
                </div>

                {/* Encrypted Content */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Lock className="w-4 h-4 text-destructive" />
                    <span className="text-sm font-medium text-foreground">Encrypted Content</span>
                    <span className="text-xs text-muted-foreground">
                      ({(parsedPackage.encryptedContent?.length || 0) / 2} bytes)
                    </span>
                    <CopyButton text={parsedPackage.encryptedContent || ""} field="content" />
                  </div>
                  <div className="p-3 rounded-lg bg-background border border-border overflow-hidden">
                    <p className="text-xs font-mono text-muted-foreground break-all leading-relaxed">
                      {formatHex(parsedPackage.encryptedContent || "", 128)}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    AES-256-GCM ciphertext with authentication tag
                  </p>
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium text-foreground">Raw Encrypted Package</span>
                  {message.encryptedContent && (
                    <span className="text-xs text-muted-foreground">
                      ({message.encryptedContent.length} chars)
                    </span>
                  )}
                  <CopyButton text={message.encryptedContent || ""} field="raw" />
                </div>
                <div className="p-3 rounded-lg bg-background border border-border overflow-hidden min-h-[60px]">
                  {message.encryptedContent ? (
                    <p className="text-xs font-mono text-muted-foreground break-all leading-relaxed">
                      {formatHex(message.encryptedContent, 256)}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">No encrypted content available</p>
                  )}
                </div>
              </div>
            )}

            {/* Signature */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Fingerprint className="w-4 h-4 text-success" />
                <span className="text-sm font-medium text-foreground">Digital Signature</span>
                <span className="text-xs text-muted-foreground">
                  ({(message.signature?.length || 0) / 2} bytes)
                </span>
                {message.signatureValid ? (
                  <span className="flex items-center gap-1 text-xs text-success">
                    <CheckCircle2 className="w-3 h-3" /> Valid
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="w-3 h-3" /> Invalid
                  </span>
                )}
                <CopyButton text={message.signature || ""} field="sig" />
              </div>
              <div className="p-3 rounded-lg bg-background border border-border overflow-hidden">
                <p className="text-xs font-mono text-muted-foreground break-all leading-relaxed">
                  {formatHex(message.signature || "", 128)}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                ML-DSA-65 digital signature (FIPS 204) - proves sender authenticity
              </p>
            </div>

            {/* Decrypted plaintext */}
            {message.plaintext && !message.plaintext.startsWith("[") && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-success" />
                  <span className="text-sm font-medium text-foreground">Decrypted Plaintext</span>
                </div>
                <div className="p-3 rounded-lg bg-success/10 border border-success/20">
                  <p className="text-sm text-foreground">{message.plaintext}</p>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </motion.div>
    </motion.div>
  );
};

// Encryption animation overlay component
const EncryptionAnimation = ({
  plaintext,
  onComplete,
  isMedia = false,
}: {
  plaintext: string;
  onComplete: () => void;
  isMedia?: boolean;
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
      <div className="relative w-full max-w-[85%] sm:max-w-[75%] flex flex-col items-end">
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
            {phase === "plaintext" && (isMedia ? "Preparing media..." : "Preparing...")}
            {phase === "scrambling" && (isMedia ? "Encrypting media with ML-KEM-768..." : "Encrypting with ML-KEM-768...")}
            {phase === "encrypted" && "Signing with ML-DSA-65..."}
            {phase === "sending" && "Sending..."}
          </span>
        </motion.div>

        {/* Message bubble with animation */}
        <motion.div
          className={`rounded-2xl px-4 py-2 rounded-br-md overflow-hidden min-w-[120px] break-words ${phase === "plaintext"
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
            {isMedia ? (
              <span className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4" />
                {phase === "plaintext" ? plaintext : displayText}
              </span>
            ) : displayText}
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
              <Lock className={`w-3 h-3 ${phase === "encrypted" || phase === "sending"
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
  const [encryptingMessageType, setEncryptingMessageType] = useState<MessageType>("text");
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(new Set());
  const [stagedMedia, setStagedMedia] = useState<{ file: File; previewUrl: string } | null>(null);
  const [spoiler, setSpoiler] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  const myIds = new Set([wallet.id, wallet.signingPublicKey, wallet.encryptionPublicKey].filter(Boolean));
  const recipient = conversation.participants?.find(p =>
    !myIds.has(p.id) && !myIds.has(p.signingPublicKey) && !myIds.has(p.encryptionPublicKey)
  );
  const isRecipientBot = recipient ? isDemoBot(recipient.id) : false;

  const getConversationName = (): string => {
    if (conversation.name) return conversation.name;
    return recipient?.displayName || "Unknown";
  };

  // Load messages
  useEffect(() => {
    // Reset seen messages on conversation change
    seenMessageIdsRef.current = new Set();
    prevMessageCountRef.current = 0;
    setNewMessageIds(new Set());
    loadMessages(true);

    const interval = setInterval(() => {
      loadMessages(false);
    }, 3000);

    return () => clearInterval(interval);
  }, [conversation.id]);

  // Track previous message count to detect new messages
  const prevMessageCountRef = useRef<number>(0);

  // Scroll to bottom only on initial load or when new messages arrive
  useEffect(() => {
    // Only scroll if message count increased (new message arrived)
    if (messages.length > prevMessageCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  const loadMessages = async (isInitialLoad = false) => {
    try {
      const msgs = await getMessages(
        conversation.id,
        wallet,
        conversation.participants || []
      );

      // Track new messages that arrived after initial load (not from current user)
      if (!isInitialLoad && msgs.length > 0) {
        const newIds = new Set<string>();
        msgs.forEach(msg => {
          if (!seenMessageIdsRef.current.has(msg.id) && msg.senderWalletId !== wallet.id) {
            newIds.add(msg.id);
          }
        });
        if (newIds.size > 0) {
          setNewMessageIds(prev => new Set([...prev, ...newIds]));
        }
      }

      // Update seen messages
      msgs.forEach(msg => seenMessageIdsRef.current.add(msg.id));

      // Merge with existing messages to preserve locally-known media data.
      // The sender can't re-decrypt their own messages (encrypted for recipient),
      // so mediaUrl from sendMessage() would be lost on re-fetch without this.
      setMessages(prev => {
        if (prev.length === 0) return msgs;
        const existing = new Map(prev.map(m => [m.id, m]));
        return msgs.map(m => {
          const old = existing.get(m.id);
          // If we had media data but re-fetch lost it, keep the old message data
          if (old?.mediaUrl && !m.mediaUrl) {
            return { ...m, mediaUrl: old.mediaUrl, mediaFileName: old.mediaFileName, messageType: old.messageType, plaintext: old.plaintext };
          }
          return m;
        });
      });
    } catch (error) {
      console.error("Failed to load messages:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_MEDIA_SIZE) {
      toast.error(`File too large. Maximum size is ${MAX_MEDIA_SIZE / (1024 * 1024)} MB.`);
      return;
    }

    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      toast.error("Only images and videos are supported.");
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setStagedMedia({ file, previewUrl });
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const clearStagedMedia = () => {
    if (stagedMedia) {
      URL.revokeObjectURL(stagedMedia.previewUrl);
      setStagedMedia(null);
    }
  };

  const handleSend = async () => {
    if ((!newMessage.trim() && !stagedMedia) || !recipient || isSending) return;

    if (stagedMedia) {
      // Media message
      try {
        const { payload, messageType } = await fileToMediaPayload(stagedMedia.file);
        const displayName = stagedMedia.file.name;
        clearStagedMedia();
        setNewMessage("");
        setEncryptingMessageType(messageType);
        setEncryptingMessage(displayName);
        // Store payload in a ref for the encryption complete handler
        pendingMediaPayloadRef.current = payload;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to process media.");
        return;
      }
    } else {
      // Text message
      const messageText = newMessage.trim();
      setNewMessage("");
      setEncryptingMessageType("text");
      setEncryptingMessage(messageText);
      pendingMediaPayloadRef.current = null;
    }
  };

  const pendingMediaPayloadRef = useRef<string | null>(null);

  const handleEncryptionComplete = async () => {
    if (!encryptingMessage || !recipient) return;

    setIsSending(true);
    const messageText = pendingMediaPayloadRef.current || encryptingMessage;
    const currentMessageType = encryptingMessageType;
    setEncryptingMessage(null);
    setEncryptingMessageType("text");
    pendingMediaPayloadRef.current = null;

    // Ensure recipient has the latest encryption key (fetch from server)
    let recipientEncryptionKey = recipient.encryptionPublicKey;
    if (!recipientEncryptionKey) {
      try {
        const wallets = await getWallets();
        const match = wallets.find(w =>
          w.id === recipient.id ||
          w.signingPublicKey === recipient.signingPublicKey ||
          w.encryptionPublicKey === recipient.encryptionPublicKey
        );
        recipientEncryptionKey = match?.encryptionPublicKey;
      } catch (error) {
        console.warn("Failed to refresh recipient keys:", error);
      }
    }
    if (!recipientEncryptionKey) {
      console.error("Recipient has no encryption key. Recipient:", recipient);
      alert("Cannot send message: recipient's encryption key is not available. Ask them to re-register their wallet.");
      setIsSending(false);
      return;
    }

    try {
      const msg = await sendMessage(
        conversation.id,
        messageText,
        wallet,
        recipientEncryptionKey,
        selfDestruct,
        selfDestruct ? destructSeconds : undefined,
        currentMessageType,
        spoiler
      );

      // Add to seen messages so it doesn't trigger animations
      seenMessageIdsRef.current.add(msg.id);
      setMessages(prev => [...prev, msg]);

      // If recipient is demo bot, get AI response
      if (isRecipientBot) {
        // Small delay to make it feel natural
        setTimeout(async () => {
          const botWallet = loadDemoBotWallet();
          if (botWallet) {
            try {
              const botResponse = await getBotReply(messageText);

              const botMsg = await sendMessage(
                conversation.id,
                botResponse,
                botWallet,
                wallet.encryptionPublicKey,
                false
              );

              // Mark bot message as new for decryption animation
              setNewMessageIds(prev => new Set([...prev, botMsg.id]));
              setMessages(prev => [...prev, botMsg]);
            } catch (e) {
              console.error("Bot reply failed:", e);
            }
          }
        }, 1000 + Math.random() * 1000);
      }
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
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
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isRecipientBot
          ? "bg-gradient-to-br from-primary to-accent"
          : "bg-primary/20"
          }`}>
          {isRecipientBot ? (
            <Bot className="w-5 h-5 text-primary-foreground" />
          ) : (
            <Shield className="w-5 h-5 text-primary" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium text-foreground">{getConversationName()}</p>
            {isRecipientBot && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-primary/20 text-primary">
                Local AI
              </span>
            )}
          </div>
          {recipient && !isRecipientBot && (
            <button
              className="text-[10px] sm:text-xs text-muted-foreground font-mono hover:text-foreground transition-colors flex items-center gap-1 w-full"
              onClick={() => {
                const address = recipient.signingPublicKey || recipient.encryptionPublicKey || "";
                navigator.clipboard.writeText(address);
                toast.success("Recipient address copied!");
              }}
              title="Click to copy recipient address"
            >
              <span className="truncate max-w-[100px] sm:max-w-[200px] inline-block">
                {(recipient.signingPublicKey || recipient.encryptionPublicKey || "").substring(0, 16)}...
              </span>
              <Copy className="w-3 h-3 flex-shrink-0" />
            </button>
          )}
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Lock className="w-3 h-3" />
            ML-KEM-768 + ML-DSA-65
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
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
                isOwn={
                  msg.senderWalletId === wallet.id ||
                  msg.senderWalletId === wallet.signingPublicKey ||
                  msg.senderWalletId === wallet.encryptionPublicKey
                }
                index={index}
                onTap={() => setSelectedMessage(msg)}
                isNew={newMessageIds.has(msg.id)}
                onAnimationComplete={() => {
                  setNewMessageIds(prev => {
                    const next = new Set(prev);
                    next.delete(msg.id);
                    return next;
                  });
                }}
              />
            ))}
            {encryptingMessage && (
              <EncryptionAnimation
                key="encrypting"
                plaintext={encryptingMessage}
                onComplete={handleEncryptionComplete}
                isMedia={encryptingMessageType !== "text"}
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

        {/* Spoiler toggle */}
        <div className="flex items-center justify-between mb-3 text-sm">
          <div className="flex items-center gap-2">
            <EyeOff className={`w-4 h-4 ${spoiler ? "text-amber-500" : "text-muted-foreground"}`} />
            <span className={spoiler ? "text-amber-500" : "text-muted-foreground"}>
              Spoiler {spoiler ? "(hidden until clicked)" : ""}
            </span>
          </div>
          <Switch
            checked={spoiler}
            onCheckedChange={setSpoiler}
          />
        </div>

        {/* Staged media preview */}
        {stagedMedia && (
          <div className="mb-3 relative inline-block">
            <div className="relative rounded-lg overflow-hidden border border-border bg-muted/50 max-w-[200px]">
              {stagedMedia.file.type.startsWith("video/") ? (
                <div className="flex items-center gap-2 p-3">
                  <Video className="w-5 h-5 text-primary" />
                  <span className="text-sm text-foreground truncate max-w-[140px]">{stagedMedia.file.name}</span>
                </div>
              ) : (
                <img
                  src={stagedMedia.previewUrl}
                  alt="Preview"
                  className="max-h-[120px] w-auto object-cover"
                />
              )}
              <button
                onClick={clearStagedMedia}
                className="absolute top-1 right-1 p-1 rounded-full bg-background/80 hover:bg-background transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 truncate max-w-[200px]">
              {stagedMedia.file.name} ({(stagedMedia.file.size / 1024).toFixed(0)} KB)
            </p>
          </div>
        )}

        <div className="flex gap-2">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            onChange={handleFileSelect}
            className="hidden"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSending || !!encryptingMessage}
            title="Attach image or video"
            className="flex-shrink-0"
          >
            <Paperclip className="w-4 h-4" />
          </Button>
          <Input
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            placeholder={stagedMedia ? "Add a caption (optional)..." : "Type a message..."}
            className="flex-1"
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            disabled={isSending || !!encryptingMessage}
          />
          <Button
            onClick={handleSend}
            disabled={(!newMessage.trim() && !stagedMedia) || isSending || !!encryptingMessage}
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

      {/* Encryption details panel */}
      <AnimatePresence>
        {selectedMessage && (
          <EncryptionDetailsPanel
            message={selectedMessage}
            onClose={() => setSelectedMessage(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

// Decryption animation component for incoming messages
const DecryptionAnimation = ({
  message,
  onComplete,
}: {
  message: Message;
  onComplete: () => void;
}) => {
  const [phase, setPhase] = useState<"ciphertext" | "decrypting" | "verifying" | "done">("ciphertext");
  const [displayText, setDisplayText] = useState("");
  const plaintext = message.plaintext || "";

  // Generate pseudo-ciphertext from the actual encrypted content
  const generateDisplayCiphertext = () => {
    try {
      const parsed = JSON.parse(message.encryptedContent);
      return parsed.encryptedContent?.slice(0, 40) || message.encryptedContent.slice(0, 40);
    } catch {
      return message.encryptedContent.slice(0, 40);
    }
  };

  useEffect(() => {
    setDisplayText(generateDisplayCiphertext());
    const timer = setTimeout(() => setPhase("decrypting"), 600);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (phase === "decrypting") {
      let iterations = 0;
      const maxIterations = 12;
      const scrambleInterval = setInterval(() => {
        const progress = iterations / maxIterations;
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

        // Gradually reveal plaintext from left to right
        const revealed = plaintext.slice(0, Math.floor(progress * plaintext.length));
        const remaining = plaintext.length - revealed.length;
        const scrambled = Array.from({ length: remaining }, () =>
          chars[Math.floor(Math.random() * chars.length)]
        ).join("");

        setDisplayText(revealed + scrambled);
        iterations++;

        if (iterations >= maxIterations) {
          clearInterval(scrambleInterval);
          setDisplayText(plaintext);
          setPhase("verifying");
        }
      }, 50);

      return () => clearInterval(scrambleInterval);
    }
  }, [phase, plaintext]);

  useEffect(() => {
    if (phase === "verifying") {
      const timer = setTimeout(() => setPhase("done"), 400);
      return () => clearTimeout(timer);
    }
    if (phase === "done") {
      const timer = setTimeout(onComplete, 200);
      return () => clearTimeout(timer);
    }
  }, [phase, onComplete]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex justify-start"
    >
      <div className="relative max-w-[80%]">
        {/* Decryption status indicator */}
        <motion.div
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          className="absolute -top-6 left-0 flex items-center gap-1.5 text-xs text-accent"
        >
          <motion.div
            animate={{ rotate: phase === "decrypting" ? -360 : 0 }}
            transition={{ duration: 0.5, repeat: phase === "decrypting" ? Infinity : 0, ease: "linear" }}
          >
            <Key className="w-3 h-3" />
          </motion.div>
          <span className="font-mono">
            {phase === "ciphertext" && "Receiving encrypted..."}
            {phase === "decrypting" && "Decrypting with ML-KEM-768..."}
            {phase === "verifying" && "Verifying ML-DSA-65 signature..."}
            {phase === "done" && "✓ Verified"}
          </span>
        </motion.div>

        {/* Message bubble with animation */}
        <motion.div
          className={`rounded-2xl px-4 py-2 rounded-bl-md overflow-hidden ${phase === "done"
            ? "bg-muted text-foreground"
            : "bg-gradient-to-r from-accent/80 via-primary/80 to-accent/80 bg-[length:200%_100%] text-foreground"
            }`}
          animate={{
            backgroundPosition: phase !== "done" ? ["0% 0%", "100% 0%", "0% 0%"] : "0% 0%",
          }}
          transition={{
            duration: 1,
            repeat: phase === "ciphertext" || phase === "decrypting" ? Infinity : 0,
            ease: "linear"
          }}
        >
          <p className="text-xs font-medium mb-1 opacity-70">
            {message.senderDisplayName}
          </p>
          <motion.p
            className={`text-sm ${phase !== "done" ? "font-mono" : ""} break-all`}
            animate={{
              opacity: phase === "verifying" ? [1, 0.7, 1] : 1
            }}
            transition={{ duration: 0.2, repeat: phase === "verifying" ? Infinity : 0 }}
          >
            {displayText}
          </motion.p>

          {/* Lock icon animation */}
          <motion.div className="flex items-center gap-1 mt-1 text-xs">
            <span className="opacity-60">
              {formatMessageTime(message.createdAt)}
            </span>
            <motion.div
              animate={{
                scale: phase === "verifying" || phase === "done" ? [1, 1.3, 1] : 1,
              }}
              transition={{ duration: 0.3 }}
            >
              {phase === "done" ? (
                <CheckCircle2 className="w-3 h-3 text-success" />
              ) : (
                <Lock className="w-3 h-3 text-primary" />
              )}
            </motion.div>
          </motion.div>
        </motion.div>

        {/* Particle effects during decryption */}
        {(phase === "ciphertext" || phase === "decrypting") && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
            {[...Array(6)].map((_, i) => (
              <motion.div
                key={i}
                className="absolute w-1 h-1 bg-accent rounded-full"
                initial={{
                  x: `${Math.random() * 100}%`,
                  y: `${Math.random() * 100}%`,
                  opacity: 0
                }}
                animate={{
                  x: "50%",
                  y: "50%",
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

// Message bubble component
const MessageBubble = ({
  message,
  isOwn,
  index,
  onTap,
  isNew = false,
  onAnimationComplete,
}: {
  message: Message;
  isOwn: boolean;
  index: number;
  onTap: () => void;
  isNew?: boolean;
  onAnimationComplete?: () => void;
}) => {
  const [showDecryptAnimation, setShowDecryptAnimation] = useState(isNew && !isOwn);

  const [spoilerRevealed, setSpoilerRevealed] = useState(false);
  const isSpoiler = message.spoiler && !spoilerRevealed;

  if (showDecryptAnimation && onAnimationComplete) {
    return (
      <DecryptionAnimation
        message={message}
        onComplete={() => {
          setShowDecryptAnimation(false);
          onAnimationComplete();
        }}
      />
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.02 }}
      className={`flex ${isOwn ? "justify-end" : "justify-start"}`}
    >
      <motion.div
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.98 }}
        onClick={onTap}
        className={`max-w-[85%] sm:max-w-[80%] rounded-2xl px-4 py-2 cursor-pointer transition-shadow hover:shadow-lg break-words ${isOwn
          ? "bg-primary text-primary-foreground rounded-br-md hover:shadow-primary/20"
          : "bg-muted text-foreground rounded-bl-md hover:shadow-accent/20"
          }`}
      >
        {!isOwn && (
          <p className="text-xs font-medium mb-1 opacity-70">
            {message.senderDisplayName}
          </p>
        )}
        {/* Media or text content */}
        <div className="relative">
          {isSpoiler && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="absolute inset-0 z-10 flex items-center justify-center rounded-lg cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setSpoilerRevealed(true);
              }}
              style={{ backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}
            >
              <div className="flex flex-col items-center gap-1 px-3 py-2">
                <EyeOff className="w-5 h-5 opacity-70" />
                <span className="text-xs font-medium opacity-70">
                  {message.messageType !== "text" ? "SPOILER" : "Click to reveal"}
                </span>
              </div>
            </motion.div>
          )}
          <div className={isSpoiler ? "select-none" : ""}>
            {message.mediaUrl && message.messageType === "image" ? (
              <div className="my-1">
                <img
                  src={message.mediaUrl}
                  alt={message.mediaFileName || "Image"}
                  className={`max-w-full rounded-lg max-h-[300px] object-contain cursor-pointer transition-all duration-300 ${isSpoiler ? "blur-xl scale-[0.98]" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isSpoiler) window.open(message.mediaUrl, "_blank");
                  }}
                />
                {message.mediaFileName && !isSpoiler && (
                  <p className="text-[10px] opacity-50 mt-1">{message.mediaFileName}</p>
                )}
              </div>
            ) : message.mediaUrl && message.messageType === "video" ? (
              <div className="my-1">
                <video
                  src={isSpoiler ? undefined : message.mediaUrl}
                  controls={!isSpoiler}
                  className={`max-w-full rounded-lg max-h-[300px] transition-all duration-300 ${isSpoiler ? "blur-xl scale-[0.98]" : ""}`}
                  onClick={(e) => e.stopPropagation()}
                  poster={isSpoiler ? undefined : undefined}
                />
                {message.mediaFileName && !isSpoiler && (
                  <p className="text-[10px] opacity-50 mt-1">{message.mediaFileName}</p>
                )}
              </div>
            ) : (
              <p className={`text-sm whitespace-pre-wrap break-words min-w-0 transition-all duration-300 ${isSpoiler ? "blur-md" : ""}`}>
                {message.plaintext?.startsWith("[Unable") ? (
                  <span className="text-muted-foreground italic break-words">{message.plaintext}</span>
                ) : message.plaintext}
              </p>
            )}
          </div>
        </div>
        <div className={`flex items-center gap-1 mt-1 text-xs ${isOwn ? "justify-end" : ""}`}>
          <span className="opacity-60">
            {formatMessageTime(message.createdAt)}
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
        <p className="text-[10px] opacity-40 mt-0.5 text-right">Tap for details</p>
      </motion.div>
    </motion.div>
  );
};

export default ChatView;
