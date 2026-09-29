import { useState, useEffect, useRef, useMemo } from "react";
import { applyEnvelopes, buildMsgEnvelope, isNoteToSelf, parseEnvelope, parseTip } from "@/lib/messenger-envelope";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Send, Lock, Shield, CheckCircle2, XCircle, Timer, Loader2, Bot, Key, X, Copy, Check, FileKey2, Binary, Fingerprint, Paperclip, Image as ImageIcon, Video, EyeOff, Eye, Ban, Trash2, DollarSign, Search, Reply, MoreVertical, Bell, BellOff, Users, CheckCheck, Check as CheckIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Conversation, WalletWithPrivateKeys, Message, Wallet, MessageType } from "@/lib/pqc-messenger";
import { getBotReply, getMessages, sendMessage, deleteMessage, isDemoBot, loadDemoBotWallet, registerWalletOnNode, getWallets, fileToMediaPayload, MAX_MEDIA_SIZE, keyFingerprint, checkTofu, markMessagesRead } from "@/lib/pqc-messenger";
import { acceptChat, blockWalletKeys, filterBlockedMessages, isAnyBlocked, isGroupConversation, lastSeenOwnMessageId, otherMembers, receiptStatus, setConversationMuted, unblockWalletKeys, walletKeys, type ReceiptStatus } from "@/lib/messenger-prefs";
import { classifyBody, gifsEnabled } from "@/lib/messenger-content";
import { useMessengerPrefs } from "./useMessengerPrefs";
import { StackedAvatars } from "./StackedAvatars";
import { GroupInfoSheet } from "./GroupInfoSheet";
import { GifPicker } from "./GifPicker";
import { RichBody } from "./RichBody";
import { playNotificationSound, loadNotificationSettings } from "@/lib/notifications";
import { useRougeAddress } from "@/hooks/useRougeAddress";
import { subscribeNewMessage, isMessengerLive } from "@/hooks/use-blockchain-ws";
import ChatPayment, { PaymentBubble, encodePaymentMessage, encodeRequestMessage, PaymentRequestBubble, TipBubble, getPaymentData, getRequestData } from "./ChatPayment";
import type { PaymentMessageData, RequestMessageData } from "./ChatPayment";
import { ReactionPicker, ReactionBadges, aggregateReactions, isSystemMessage, encodeReactionMessage } from "./ChatReactions";
import { QuotedMessage, ReplyComposer, parseReplyMessage, encodeReplyMessage } from "./ChatReply";
import { WalletAvatar } from "@/components/WalletAvatar";

interface ChatViewProps {
  conversation: Conversation;
  wallet: WalletWithPrivateKeys;
  onBack: () => void;
  onBlocked?: () => void;
  /** Directory wallets (for adding group members). */
  contacts?: Wallet[];
  /** A group was renamed / grew: reload the conversation. */
  onConversationChanged?: () => void;
  /** A message request (1:1 I haven't accepted): no read receipts until accepted. */
  isRequest?: boolean;
  onAccepted?: () => void;
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
  onDelete,
}: {
  message: Message;
  onClose: () => void;
  onDelete?: (messageId: string) => void;
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
      className="h-8 w-8 shrink-0"
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
          <div className="flex items-center gap-1">
            {onDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => {
                  if (confirm("Delete this message? This cannot be undone.")) {
                    onDelete(message.id);
                    onClose();
                  }
                }}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
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
          className={`bubble-own px-4 py-2 overflow-hidden min-w-[120px] break-words ${phase === "plaintext"
            ? "opacity-60"
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
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
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

const ChatView = ({ conversation, wallet, onBack, onBlocked, contacts = [], onConversationChanged, isRequest = false, onAccepted }: ChatViewProps) => {
  const { t } = useTranslation();
  const prefs = useMessengerPrefs();
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const markedReadRef = useRef<Set<string>>(new Set());
  const isRequestRef = useRef(isRequest);
  isRequestRef.current = isRequest;
  const mutedRef = useRef(false);
  mutedRef.current = prefs.muted.has(conversation.id);
  const blockedRef = useRef(prefs.blocked);
  blockedRef.current = prefs.blocked;
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
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showRequestMode, setShowRequestMode] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [reactingTo, setReactingTo] = useState<string | null>(null); // message ID
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  const myIds = new Set([wallet.id, wallet.signingPublicKey, wallet.encryptionPublicKey].filter(Boolean));
  const members = useMemo(() => otherMembers(conversation, myIds), [conversation, wallet.id, wallet.signingPublicKey]);
  const isGroup = isGroupConversation(conversation, myIds);
  const muted = prefs.muted.has(conversation.id);

  /** Every id form of a message sender (resolved through the conversation members). */
  const senderKeys = (senderId: string): string[] => {
    const m = members.find(p => walletKeys(p).includes(senderId));
    return m ? walletKeys(m) : [];
  };
  const isOwnMessage = (m: Message) => myIds.has(m.senderWalletId);

  // Aggregate reactions and filter system messages; hide blocked senders (Qwalla: matched on any key).
  const unblockedMessages = useMemo(
    () => filterBlockedMessages(messages, prefs.blocked, myIds, (id) => {
      const msg = messages.find(m => m.senderWalletId === id);
      return [...senderKeys(id), ...(msg?.senderSigningPublicKey ? [msg.senderSigningPublicKey] : [])];
    }),
    [messages, prefs.version, members],
  );
  const reactionMap = useMemo(() => aggregateReactions(unblockedMessages, myIds), [unblockedMessages]);
  const messagesById = useMemo(() => new Map(unblockedMessages.map(m => [m.id, m])), [unblockedMessages]);
  const visibleMessages = useMemo(() =>
    unblockedMessages.filter(m => !isSystemMessage(m.plaintext))
      .filter(m => !searchQuery || m.plaintext?.toLowerCase().includes(searchQuery.toLowerCase())),
    [unblockedMessages, searchQuery]
  );
  // Read receipts: where the "Seen" label goes (newest of my messages with read_at).
  const lastSeenId = useMemo(() => lastSeenOwnMessageId(visibleMessages, isOwnMessage), [visibleMessages]);


  const hasBot = conversation.name === "Quantum Bot" ||
    conversation.participants?.some(p => p.id?.startsWith("bot-"));
  const isSelfConversation = !hasBot && isNoteToSelf(conversation, myIds);

  const recipient = isSelfConversation
    ? { id: wallet.id, displayName: wallet.displayName, signingPublicKey: wallet.signingPublicKey, encryptionPublicKey: wallet.encryptionPublicKey }
    : conversation.participants?.find(p =>
        !myIds.has(p.id) && !myIds.has(p.signingPublicKey) && !myIds.has(p.encryptionPublicKey)
      );
  const isRecipientBot = recipient && !isSelfConversation ? isDemoBot(recipient.id) : false;
  const recipientMainId = recipient?.id || recipient?.signingPublicKey || "";
  const recipientKeys = recipient ? walletKeys(recipient) : [];
  const blocked = !isGroup && recipientKeys.length > 0 && isAnyBlocked(recipientKeys, prefs.blocked);
  const [tofuWarning, setTofuWarning] = useState(false);
  const [fingerprint, setFingerprint] = useState("");
  const { display: recipientRougeAddr } = useRougeAddress(recipientMainId || undefined);

  useEffect(() => {
    if (!recipient || isRecipientBot || isSelfConversation || isGroup) return;
    (async () => {
      const tofu = await checkTofu(recipient);
      setTofuWarning(tofu.changed);
      const fp = await keyFingerprint(recipient.signingPublicKey);
      setFingerprint(fp);
    })();
  }, [recipient?.id, recipient?.signingPublicKey]);

  const handleToggleBlock = () => {
    if (recipientKeys.length === 0) return;
    const name = recipient?.displayName || t("chat.common.anonymous");
    if (blocked) {
      unblockWalletKeys(recipientKeys);
      toast.success(t("chat.block.unblocked", { name }));
    } else {
      if (!confirm(t("chat.block.confirm", { name }))) return;
      blockWalletKeys(recipientKeys);
      toast.success(t("chat.block.blocked", { name }));
      onBlocked?.();
    }
  };

  const toggleMute = () => {
    setConversationMuted(conversation.id, !muted);
    toast.success(muted ? t("chat.mute.unmuted") : t("chat.mute.muted"));
  };

  const acceptRequest = () => {
    acceptChat(conversation.id);
    onAccepted?.();
  };

  const getConversationName = (): string => {
    if (conversation.name) return conversation.name;
    if (isGroup) return t("chat.group.untitled", { count: members.length + 1 });
    if (isSelfConversation) return "Note to Self";
    return recipient?.displayName || "Unknown";
  };

  // Load messages
  useEffect(() => {
    // Reset seen messages on conversation change
    seenMessageIdsRef.current = new Set();
    markedReadRef.current = new Set();
    prevMessageCountRef.current = 0;
    setNewMessageIds(new Set());
    loadMessages(true);

    // Instant refresh on this wallet's private new_message event for THIS
    // conversation (socket owned by the Messenger page). Poll every 3 s only while
    // that stream isn't live; otherwise a 15 s safety net.
    const unsubscribe = subscribeNewMessage((ev) => {
      if (ev.conversation_id === conversation.id) loadMessages(false);
    });
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
      if (!isMessengerLive() || ticks % 5 === 0) loadMessages(false);
    }, 3000);

    return () => { unsubscribe(); clearInterval(interval); };
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
        conversation.participants || [],
        (unread) => {
          // Read receipts (Qwalla: markRead for every unread incoming message while the chat is
          // open). Not for message requests, and only while the page is actually visible.
          if (isRequestRef.current || document.visibilityState !== "visible") return;
          const fresh = unread.filter(id => !markedReadRef.current.has(id));
          if (fresh.length === 0) return;
          fresh.forEach(id => markedReadRef.current.add(id));
          void markMessagesRead(wallet, conversation.id, fresh);
        },
      );

      // Track new messages that arrived after initial load (not from current user)
      if (!isInitialLoad && msgs.length > 0) {
        const newIds = new Set<string>();
        const myIdSet = new Set([wallet.id, wallet.signingPublicKey, wallet.encryptionPublicKey].filter(Boolean));
        msgs.forEach(msg => {
          if (!seenMessageIdsRef.current.has(msg.id) && !myIdSet.has(msg.senderWalletId)) {
            newIds.add(msg.id);
          }
        });
        if (newIds.size > 0) {
          setNewMessageIds(prev => new Set([...prev, ...newIds]));
          const settings = loadNotificationSettings();
          const fromBlocked = msgs.some(m => newIds.has(m.id) && isAnyBlocked([m.senderWalletId, ...(m.senderSigningPublicKey ? [m.senderSigningPublicKey] : [])], blockedRef.current));
          if (settings.enabled && settings.sound && !mutedRef.current && !fromBlocked) {
            playNotificationSound();
          }
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

  const handlePaymentSent = async (paymentData: PaymentMessageData) => {
    const paymentText = encodePaymentMessage(paymentData);
    setEncryptingMessageType("text");
    setEncryptingMessage(paymentText);
    pendingMediaPayloadRef.current = null;
  };

  const handleSendReaction = (messageId: string, emoji: string) => {
    const reactionText = encodeReactionMessage({ type: "reaction", messageId, emoji });
    setEncryptingMessageType("text");
    setEncryptingMessage(reactionText);
    pendingMediaPayloadRef.current = null;
    setReactingTo(null);
  };

  const handleSendReply = () => {
    if (!replyingTo || !newMessage.trim()) return;
    const replyText = encodeReplyMessage({
      replyTo: replyingTo.id,
      text: newMessage.trim(),
    });
    setNewMessage("");
    setReplyingTo(null);
    setEncryptingMessageType("text");
    setEncryptingMessage(replyText);
    pendingMediaPayloadRef.current = null;
  };

  const handleSendRequest = (amount: number, token: string, memo?: string) => {
    const requestText = encodeRequestMessage({ type: "request", token, amount, memo });
    setEncryptingMessageType("text");
    setEncryptingMessage(requestText);
    pendingMediaPayloadRef.current = null;
    setShowRequestMode(false);
  };

  // GIFs go out exactly as Qwalla's sendGif: the GIPHY URL as the body of a msg envelope.
  const handleSendGif = (url: string) => {
    setShowGifs(false);
    setEncryptingMessageType("text");
    setEncryptingMessage(buildMsgEnvelope(url));
    pendingMediaPayloadRef.current = null;
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

    // Groups: encrypt for every other member (Qwalla's v2 wrapped-CEK package).
    let groupKeys: string[] | null = null;
    if (isGroup) {
      let keys = members.map(m => m.encryptionPublicKey).filter((k): k is string => !!k);
      if (keys.length < members.length) {
        try {
          const directory = await getWallets();
          keys = members
            .map(m => m.encryptionPublicKey || directory.find(w => walletKeys(m).some(k => walletKeys(w).includes(k)))?.encryptionPublicKey)
            .filter((k): k is string => !!k);
        } catch (error) {
          console.warn("Failed to resolve group member keys:", error);
        }
      }
      keys = [...new Set(keys)];
      if (keys.length === 0) {
        toast.error(t("chat.group.noKeys"));
        setIsSending(false);
        return;
      }
      if (keys.length < members.length) toast.warning(t("chat.group.someKeysMissing", { count: members.length - keys.length }));
      groupKeys = keys;
    }

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
    if (!recipientEncryptionKey && !groupKeys) {
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
        groupKeys ?? recipientEncryptionKey!,
        selfDestruct,
        selfDestruct ? destructSeconds : undefined,
        currentMessageType,
        spoiler
      );

      // Add to seen messages so it doesn't trigger animations
      seenMessageIdsRef.current.add(msg.id);
      // applyEnvelopes: show the body of what we just sent, and fold a sent reaction into its target.
      setMessages(prev => applyEnvelopes([...prev, msg]));

      // If recipient is demo bot, get AI response
      if (isRecipientBot) {
        // Small delay to make it feel natural
        setTimeout(async () => {
          const botWallet = loadDemoBotWallet();
          if (botWallet) {
            try {
              await registerWalletOnNode(botWallet, false);
              const botResponse = await getBotReply(animationText(messageText));

              const botMsg = await sendMessage(
                conversation.id,
                botResponse,
                botWallet,
                wallet.encryptionPublicKey,
                false
              );

              // Mark bot message as new for decryption animation
              setNewMessageIds(prev => new Set([...prev, botMsg.id]));
              setMessages(prev => applyEnvelopes([...prev, botMsg]));
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
      <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-4 py-3 border-b border-border bg-card/50 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="sm:hidden flex-shrink-0"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        {isGroup ? (
          <button type="button" onClick={() => setShowGroupInfo(true)} className="flex-shrink-0 rounded-full" aria-label={t("chat.group.info")}>
            <StackedAvatars members={members} size={40} />
          </button>
        ) : isRecipientBot || !recipient ? (
          <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${isRecipientBot
            ? "bg-gradient-to-br from-primary to-accent"
            : "bg-primary/20"
            }`}>
            {isRecipientBot ? (
              <Bot className="w-5 h-5 text-primary-foreground" />
            ) : (
              <Shield className="w-5 h-5 text-primary" />
            )}
          </div>
        ) : (
          <WalletAvatar id={recipient.id || recipient.signingPublicKey} uri={"avatarUrl" in recipient ? recipient.avatarUrl : undefined} name={getConversationName()} size={40} ring />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {isGroup ? (
              <button type="button" onClick={() => setShowGroupInfo(true)} className="font-medium text-foreground truncate text-left hover:underline">
                {getConversationName()}
              </button>
            ) : (
              <p className="font-medium text-foreground truncate">{getConversationName()}</p>
            )}
            {muted && <BellOff className="w-3.5 h-3.5 flex-shrink-0 text-amber-500" aria-label={t("chat.mute.muted")} />}
            {isRecipientBot && (
              <span className="px-1.5 py-0.5 text-xs rounded bg-primary/20 text-primary">
                AI
              </span>
            )}
            {!isGroup && tofuWarning && !isRecipientBot && (
              <span className="px-1.5 py-0.5 text-xs rounded bg-destructive/20 text-destructive font-medium" title="This contact's keys have changed since you first communicated">
                Key Changed
              </span>
            )}
            {!isGroup && fingerprint && !isRecipientBot && !tofuWarning && (
              <span className="hidden sm:inline px-1.5 py-0.5 text-xs rounded bg-green-500/20 text-green-600 dark:text-green-400 font-mono" title={`Fingerprint: ${fingerprint}`}>
                {fingerprint.substring(0, 9)}
              </span>
            )}
          </div>
          {isGroup ? (
            <button type="button" onClick={() => setShowGroupInfo(true)} className="bubble-meta text-muted-foreground hover:text-foreground truncate block max-w-full text-left">
              {t("chat.group.memberCount", { count: members.length + 1 })}
            </button>
          ) : recipient && !isRecipientBot && (
            <button
              className="text-xs sm:text-xs text-muted-foreground font-mono hover:text-foreground transition-colors flex items-center gap-1 w-full"
              onClick={() => {
                const address = recipient.signingPublicKey || recipient.encryptionPublicKey || "";
                navigator.clipboard.writeText(address);
                toast.success("Recipient address copied!");
              }}
              title="Click to copy recipient address"
            >
              <span className="truncate max-w-[140px] sm:max-w-[240px] inline-block">
                {recipientRougeAddr || `${(recipient.signingPublicKey || recipient.encryptionPublicKey || "").substring(0, 16)}...`}
              </span>
              <Copy className="w-3 h-3 flex-shrink-0" />
            </button>
          )}
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Lock className="w-3 h-3" />
            ML-KEM-768 + ML-DSA-65
          </p>
        </div>
        {blocked && (
          <span className="hidden sm:inline px-1.5 py-0.5 text-xs rounded bg-destructive/20 text-destructive font-medium flex-shrink-0">
            {t("chat.block.blockedBadge")}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="flex-shrink-0" title={t("chat.menu.title")}>
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => setShowSearch(true)}>
              <Search className="w-4 h-4 mr-2" /> {t("chat.menu.search")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={toggleMute}>
              {muted ? <Bell className="w-4 h-4 mr-2" /> : <BellOff className="w-4 h-4 mr-2" />}
              {muted ? t("chat.mute.unmute") : t("chat.mute.mute")}
            </DropdownMenuItem>
            {isGroup && (
              <DropdownMenuItem onClick={() => setShowGroupInfo(true)}>
                <Users className="w-4 h-4 mr-2" /> {t("chat.group.info")}
              </DropdownMenuItem>
            )}
            {!isGroup && recipient && !isRecipientBot && !isSelfConversation && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleToggleBlock} className={blocked ? "" : "text-destructive focus:text-destructive"}>
                  <Ban className="w-4 h-4 mr-2" /> {blocked ? t("chat.block.unblock") : t("chat.block.block")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Message request banner (Qwalla: accept, or delete = block) */}
      {isRequest && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-primary/5">
          <p className="text-xs text-muted-foreground flex-1 min-w-[160px]">{t("chat.requests.banner", { name: getConversationName() || t("chat.common.anonymous") })}</p>
          <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={handleToggleBlock}>{t("chat.block.block")}</Button>
          <Button size="sm" className="h-7" onClick={acceptRequest}>{t("chat.requests.accept")}</Button>
        </div>
      )}

      {/* Search bar */}
      <AnimatePresence>
        {showSearch && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-3 py-2 border-b border-border bg-muted/30 overflow-hidden"
          >
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search messages..."
                className="h-8 text-sm"
                autoFocus
              />
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setShowSearch(false); setSearchQuery(""); }}>
                <X className="w-3 h-3" />
              </Button>
            </div>
            {searchQuery && <p className="text-xs text-muted-foreground mt-1">{visibleMessages.length} result{visibleMessages.length !== 1 ? "s" : ""}</p>}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Messages */}
      <div className="cyber-chat flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : visibleMessages.length === 0 && !encryptingMessage ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <Lock className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>{searchQuery ? "No messages match" : "Start the conversation"}</p>
              <p className="text-xs mt-1">{searchQuery ? "Try a different search" : "Messages are end-to-end encrypted"}</p>
            </div>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {visibleMessages.map((msg, index) => {
              const isOwn = msg.senderWalletId === wallet.id ||
                msg.senderWalletId === wallet.signingPublicKey ||
                msg.senderWalletId === wallet.encryptionPublicKey;
              return (
                <div key={msg.id} className="relative">
                  <MessageBubble
                    message={msg}
                    isOwn={isOwn}
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
                    reactions={reactionMap.get(msg.id)}
                    onReact={(emoji) => handleSendReaction(msg.id, emoji)}
                    onReply={() => setReplyingTo(msg)}
                    reactingTo={reactingTo}
                    onToggleReactionPicker={(id) => setReactingTo(reactingTo === id ? null : id)}
                    quotedPreview={msg.replyTo ? previewText(messagesById.get(msg.replyTo)) : undefined}
                    onAcceptRequest={getRequestData(msg) && !isOwn ? () => setShowPaymentDialog(true) : undefined}
                    onImageClick={(url) => setLightboxUrl(url)}
                    receipt={isOwn ? receiptStatus(msg) : undefined}
                    seen={isOwn && msg.id === lastSeenId}
                  />
                </div>
              );
            })}
            {encryptingMessage && (
              <EncryptionAnimation
                key="encrypting"
                plaintext={animationText(encryptingMessage)}
                onComplete={handleEncryptionComplete}
                isMedia={encryptingMessageType !== "text"}
              />
            )}
          </AnimatePresence>
        )}
        <div ref={messagesEndRef} />
      </div>

      <AnimatePresence>
        {showGifs && gifsEnabled() && (
          <GifPicker key="gifs" onSelect={handleSendGif} onClose={() => setShowGifs(false)} />
        )}
      </AnimatePresence>

      {/* Message input */}
      <div className="p-3 sm:p-4 border-t border-border bg-card/50">
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
            <p className="text-xs text-muted-foreground mt-1 truncate max-w-[200px]">
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
          {/* GIF picker (Qwalla GifPicker; hidden when no GIPHY key is configured) */}
          {gifsEnabled() && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowGifs(v => !v)}
              disabled={isSending || !!encryptingMessage}
              title={t("chat.gif.button")}
              aria-pressed={showGifs}
              className={`flex-shrink-0 font-mono text-[10px] font-bold ${showGifs ? "text-[hsl(var(--hologram))]" : ""}`}
            >
              GIF
            </Button>
          )}
          {/* Payment button (1:1 only, like Qwalla's tip) */}
          {!isSelfConversation && !isRecipientBot && !isGroup && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowPaymentDialog(true)}
              disabled={isSending || !!encryptingMessage}
              title="Send payment"
              className="flex-shrink-0 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10"
            >
              <DollarSign className="w-4 h-4" />
            </Button>
          )}
          <Input
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            placeholder={replyingTo ? "Type your reply..." : stagedMedia ? "Add a caption (optional)..." : "Type a message..."}
            className="cyber-input flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                if (replyingTo) handleSendReply();
                else handleSend();
              }
            }}
            disabled={isSending || !!encryptingMessage}
          />
          <Button
            onClick={replyingTo ? handleSendReply : handleSend}
            disabled={(!newMessage.trim() && !stagedMedia) || isSending || !!encryptingMessage}
            size="icon"
          >
            {isSending || encryptingMessage ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : replyingTo ? (
              <Reply className="w-4 h-4" />
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
            onDelete={async (msgId) => {
              try {
                await deleteMessage(wallet, msgId, conversation.id);
                setMessages(prev => prev.filter(m => m.id !== msgId));
                toast.success("Message deleted");
              } catch {
                toast.error("Failed to delete message");
              }
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showGroupInfo && isGroup && (
          <GroupInfoSheet
            key="group-info"
            conversation={conversation}
            wallet={wallet}
            contacts={contacts}
            onClose={() => setShowGroupInfo(false)}
            onChanged={() => onConversationChanged?.()}
          />
        )}
      </AnimatePresence>

      {/* Payment dialog */}
      <AnimatePresence>
        {lightboxUrl && (
          <motion.div
            key="lightbox"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm cursor-pointer"
            onClick={() => setLightboxUrl(null)}
          >
            <button
              onClick={() => setLightboxUrl(null)}
              className="absolute top-4 right-4 z-[101] p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            >
              <X className="w-6 h-6 text-white" />
            </button>
            <motion.img
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              src={lightboxUrl}
              alt="Full size"
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg cursor-default"
              onClick={(e) => e.stopPropagation()}
            />
          </motion.div>
        )}

        {showPaymentDialog && recipient && !isSelfConversation && (
          <ChatPayment
            walletPublicKey={wallet.signingPublicKey}
            walletPrivateKey={(wallet as any).signingPrivateKey || (wallet as any).privateKey || ""}
            recipientPublicKey={recipient.signingPublicKey || recipient.encryptionPublicKey || recipient.id}
            recipientName={recipient.displayName || "Unknown"}
            onClose={() => setShowPaymentDialog(false)}
            onPaymentSent={handlePaymentSent}
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
          className={`bubble-peer px-4 py-2 overflow-hidden ${phase === "done"
            ? ""
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
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
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

/** Readable text of an outgoing plaintext for the encryption animation (envelopes → body / emoji). */
const animationText = (raw: string): string => {
  const env = parseEnvelope(raw);
  return env.kind === "rx" ? env.emoji : env.body;
};

/** Short quote of a message for a reply; "" when the replied-to message isn't loaded. */
const previewText = (m: Message | undefined): string => {
  if (!m) return "";
  const pay = getPaymentData(m);
  if (pay) return `💸 ${pay.amount} ${pay.token}`;
  const req = getRequestData(m);
  if (req) return `🧾 ${req.amount} ${req.token}`;
  const tip = parseTip(m.plaintext);
  if (tip) return `💸 ${tip.amount} ${tip.symbol}`;
  if (m.mediaUrl) return m.messageType === "video" ? "🎬 Video" : "🖼️ Image";
  const legacyReply = m.plaintext ? parseReplyMessage(m.plaintext) : null;
  return (legacyReply?.text ?? m.plaintext ?? "").slice(0, 80);
};

// Message bubble component
const MessageBubble = ({
  message,
  isOwn,
  index,
  onTap,
  isNew = false,
  onAnimationComplete,
  reactions,
  onReact,
  onReply,
  reactingTo,
  onToggleReactionPicker,
  onAcceptRequest,
  onImageClick,
  quotedPreview,
  receipt,
  seen = false,
}: {
  message: Message;
  isOwn: boolean;
  index: number;
  onTap: () => void;
  isNew?: boolean;
  onAnimationComplete?: () => void;
  reactions?: { emoji: string; count: number; myReaction: boolean }[];
  onReact?: (emoji: string) => void;
  onReply?: () => void;
  reactingTo?: string | null;
  onToggleReactionPicker?: (id: string) => void;
  onAcceptRequest?: () => void;
  onImageClick?: (url: string) => void;
  /** Quote of the message this one replies to (envelope replyTo); "" if it isn't loaded. */
  quotedPreview?: string;
  /** Read receipt for my own messages (Qwalla's check / double-check). */
  receipt?: ReceiptStatus;
  /** Show "Seen" under this message (the newest of mine the recipient opened). */
  seen?: boolean;
}) => {
  const { t } = useTranslation();
  const [showDecryptAnimation, setShowDecryptAnimation] = useState(isNew && !isOwn);
  const [spoilerRevealed, setSpoilerRevealed] = useState(false);
  const [showActions, setShowActions] = useState(false);
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

  // Check for special message types
  const replyData = message.plaintext ? parseReplyMessage(message.plaintext) : null;
  const requestData = getRequestData(message);
  const quote = replyData
    ? replyData.replyPreview
    : message.replyTo !== undefined
      ? quotedPreview || t("messenger.reply.unavailable")
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.02 }}
      className={`flex ${isOwn ? "justify-end" : "justify-start"}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      onClick={() => setShowActions((s) => !s)}
    >
      <div className="relative">
        {/* Action buttons (reply/react) */}
        <AnimatePresence>
          {showActions && !isSpoiler && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className={`absolute top-0 z-20 flex gap-0.5 ${isOwn ? "left-0 -translate-x-full pr-1" : "right-0 translate-x-full pl-1"}`}
            >
              {onReply && (
                <button
                  onClick={(e) => { e.stopPropagation(); onReply(); }}
                  className="p-1 rounded-full bg-muted/80 hover:bg-muted border border-border text-muted-foreground hover:text-foreground transition-colors"
                  title="Reply"
                >
                  <Reply className="w-3 h-3" />
                </button>
              )}
              {onToggleReactionPicker && (
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleReactionPicker(message.id); }}
                  className="p-1 rounded-full bg-muted/80 hover:bg-muted border border-border text-muted-foreground hover:text-foreground transition-colors"
                  title="React"
                >
                  <span className="text-xs leading-none">😊</span>
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Reaction picker */}
        <AnimatePresence>
          {reactingTo === message.id && onReact && (
            <ReactionPicker
              onSelect={onReact}
              onClose={() => onToggleReactionPicker?.(message.id)}
              position={isOwn ? "above" : "above"}
            />
          )}
        </AnimatePresence>

        <motion.div
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.98 }}
          onClick={onTap}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onToggleReactionPicker?.(message.id);
          }}
          className={`max-w-[85%] sm:max-w-[80%] px-4 py-2 cursor-pointer break-words ${isOwn ? "bubble-own" : "bubble-peer"}`}
        >
          {!isOwn && (
            <p className="bubble-meta font-medium mb-1 text-[hsl(var(--hologram))] flex items-center gap-1.5">
              <WalletAvatar id={message.senderWalletId} name={message.senderDisplayName} size={16} />
              {message.senderDisplayName}
            </p>
          )}

          {/* Quoted reply */}
          {quote !== null && (
            <QuotedMessage preview={quote} isOwn={isOwn} />
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
                      if (!isSpoiler && message.mediaUrl) onImageClick?.(message.mediaUrl);
                    }}
                  />
                  {message.mediaFileName && !isSpoiler && (
                    <p className="text-xs opacity-50 mt-1">{message.mediaFileName}</p>
                  )}
                </div>
              ) : message.mediaUrl && message.messageType === "video" ? (
                <div className="my-1">
                  <video
                    src={isSpoiler ? undefined : message.mediaUrl}
                    controls={!isSpoiler}
                    className={`max-w-full rounded-lg max-h-[300px] transition-all duration-300 ${isSpoiler ? "blur-xl scale-[0.98]" : ""}`}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {message.mediaFileName && !isSpoiler && (
                    <p className="text-xs opacity-50 mt-1">{message.mediaFileName}</p>
                  )}
                </div>
              ) : (() => {
                const paymentData = getPaymentData(message);
                if (paymentData) {
                  return <PaymentBubble payment={paymentData} isOwn={isOwn} />;
                }
                if (requestData) {
                  return <PaymentRequestBubble request={requestData} isOwn={isOwn} onAccept={onAcceptRequest} />;
                }
                const tip = parseTip(message.plaintext);
                if (tip) {
                  return <TipBubble amount={tip.amount} symbol={tip.symbol} isOwn={isOwn} />;
                }
                if (!replyData && classifyBody(message.plaintext) !== "text") {
                  return <RichBody body={message.plaintext} blurred={isSpoiler} onImageClick={onImageClick} />;
                }
                if (replyData) {
                  return (
                    <p className={`text-sm whitespace-pre-wrap break-words min-w-0 transition-all duration-300 ${isSpoiler ? "blur-md" : ""}`}>
                      {replyData.text}
                    </p>
                  );
                }
                return (
                  <p className={`text-sm whitespace-pre-wrap break-words min-w-0 transition-all duration-300 ${isSpoiler ? "blur-md" : ""}`}>
                    {message.plaintext?.startsWith("[Unable") ? (
                      <span className="text-muted-foreground italic break-words">{message.plaintext}</span>
                    ) : message.plaintext}
                  </p>
                );
              })()}
            </div>
          </div>

          {/* Reaction badges */}
          {reactions && reactions.length > 0 && (
            <ReactionBadges reactions={reactions} onReact={onReact} />
          )}

          <div className={`bubble-meta flex items-center gap-1 mt-1 ${isOwn ? "justify-end" : ""}`}>
            <span className="opacity-70">
              {formatMessageTime(message.createdAt)}
            </span>
            <span className="opacity-50">// ML-DSA</span>
            {message.selfDestruct && (
              <Timer className="w-3 h-3 text-destructive" />
            )}
            {message.signatureValid ? (
              <CheckCircle2 className="w-3 h-3 text-success" />
            ) : (
              <XCircle className="w-3 h-3 text-destructive" />
            )}
            {receipt && (
              receipt === "sent" ? (
                <CheckIcon className="w-3.5 h-3.5 opacity-70" aria-label={t("chat.receipts.sent")} />
              ) : (
                <CheckCheck
                  className={`w-3.5 h-3.5 ${receipt === "read" ? "text-[hsl(var(--hologram))] drop-shadow-[0_0_4px_hsl(var(--hologram))]" : "opacity-70"}`}
                  aria-label={receipt === "read" ? t("chat.receipts.read") : t("chat.receipts.delivered")}
                />
              )
            )}
          </div>
          {seen && <p className="bubble-meta mt-0.5 text-right text-[hsl(var(--hologram))]">{t("chat.receipts.seen")}</p>}
          <p className="bubble-meta opacity-40 mt-0.5 text-right">Tap for details</p>
        </motion.div>
      </div>
    </motion.div>
  );
};

export default ChatView;
