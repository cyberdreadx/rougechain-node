import { useState, useEffect, useRef } from "react";
import {
    ArrowLeft, Send, Lock, Shield, Plus, Loader2,
    MessageCircle, CheckCircle2, XCircle, Timer,
    Paperclip, EyeOff, Image as ImageIcon, Video, X, Trash2, Ban
} from "lucide-react";
import type { UnifiedWallet } from "../../lib/unified-wallet";
import { toMessengerWallet } from "../../lib/unified-wallet";
import {
    getConversations,
    getMessages,
    getWallets,
    sendMessage,
    createConversation,
    deleteConversation,
    registerWalletOnNode,
    fileToMediaPayload,
    MAX_MEDIA_SIZE,
    isWalletBlocked,
    blockWallet,
    unblockWallet,
    getBlockedWalletIds,
    type Conversation,
    type Message,
    type MessageType,
    type Wallet,
    type WalletWithPrivateKeys,
} from "../../lib/pqc-messenger";

interface Props {
    wallet: UnifiedWallet;
}

function formatTime(dateInput: string | number | Date): string {
    try {
        const date = new Date(dateInput);
        if (isNaN(date.getTime())) return "";
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
}

export default function MessengerTab({ wallet }: Props) {
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [selected, setSelected] = useState<Conversation | null>(null);
    const [contacts, setContacts] = useState<Wallet[]>([]);
    const [showContacts, setShowContacts] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [regStatus, setRegStatus] = useState<"pending" | "ok" | "error">("pending");
    const [regError, setRegError] = useState<string | null>(null);

    const messengerWallet = toMessengerWallet(wallet) as WalletWithPrivateKeys;

    const loadConversations = async () => {
        const convos = await getConversations(wallet.id, messengerWallet);
        setConversations(convos);
        setIsLoading(false);
    };

    const loadContacts = async () => {
        const wallets = await getWallets();
        const blocked = new Set(getBlockedWalletIds());
        setContacts(wallets.filter(w =>
            w.id !== wallet.id &&
            !blocked.has(w.id) && !blocked.has(w.signingPublicKey) && !blocked.has(w.encryptionPublicKey)
        ));
    };

    const doRegister = async () => {
        setRegStatus("pending");
        setRegError(null);
        try {
            await registerWalletOnNode(messengerWallet);
            setRegStatus("ok");
        } catch (err: any) {
            setRegStatus("error");
            setRegError(err.message || "Registration failed");
        }
    };

    useEffect(() => {
        doRegister();
        loadConversations();
        loadContacts();
        const interval = setInterval(loadConversations, 5000);
        return () => clearInterval(interval);
    }, []);

    if (selected) {
        return (
            <ChatView
                conversation={selected}
                wallet={messengerWallet}
                onBack={() => setSelected(null)}
                onBlocked={() => {
                    setSelected(null);
                    loadConversations();
                }}
            />
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Conversations
                </span>
                <button
                    onClick={() => { setShowContacts(!showContacts); loadContacts(); }}
                    className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center text-primary hover:bg-primary/30 transition-colors"
                >
                    <Plus className="w-3.5 h-3.5" />
                </button>
            </div>

            {/* Registration status */}
            {regStatus === "error" && (
                <div className="flex items-center justify-between px-3 py-1.5 bg-destructive/10 border-b border-destructive/20">
                    <span className="text-[10px] text-destructive truncate">{regError || "Registration failed"}</span>
                    <button onClick={doRegister} className="text-[10px] text-destructive font-medium hover:underline flex-shrink-0 ml-2">Retry</button>
                </div>
            )}
            {regStatus === "ok" && (
                <div className="flex items-center gap-1 px-3 py-1 bg-success/5 border-b border-success/10">
                    <CheckCircle2 className="w-2.5 h-2.5 text-success" />
                    <span className="text-[10px] text-success">Registered on node</span>
                </div>
            )}

            {/* Contact picker */}
            {showContacts && (
                <div className="border-b border-border bg-card/80 max-h-40 overflow-y-auto">
                    {/* Note to Self */}
                    <button
                        onClick={async () => {
                            try {
                                const convo = await createConversation(
                                    messengerWallet,
                                    [wallet.id, wallet.id],
                                    "Note to Self"
                                );
                                convo.name = "Note to Self";
                                setConversations(prev => [convo, ...prev]);
                                setSelected(convo);
                                setShowContacts(false);
                            } catch (err) { console.error(err); }
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-secondary/30 transition-colors text-left border-b border-border/50"
                    >
                        <div className="w-7 h-7 rounded-full bg-amber-500/20 flex items-center justify-center">
                            <MessageCircle className="w-3.5 h-3.5 text-amber-500" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-xs font-medium text-foreground">Note to Self</p>
                            <p className="text-[10px] text-muted-foreground">Save private notes</p>
                        </div>
                    </button>
                    {contacts.length === 0 ? (
                        <p className="text-xs text-muted-foreground p-3 text-center">No other contacts found</p>
                    ) : (
                        contacts.map(c => (
                            <button
                                key={c.id}
                                onClick={async () => {
                                    try {
                                        const convo = await createConversation(
                                            messengerWallet,
                                            [wallet.id, c.id],
                                        );
                                        setConversations(prev => [convo, ...prev]);
                                        setSelected(convo);
                                        setShowContacts(false);
                                    } catch (err) { console.error(err); }
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-secondary/30 transition-colors text-left"
                            >
                                <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center">
                                    <Shield className="w-3.5 h-3.5 text-primary" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-xs font-medium text-foreground truncate">{c.displayName}</p>
                                    <p className="text-[10px] text-muted-foreground font-mono truncate">
                                        {c.signingPublicKey.substring(0, 16)}...
                                    </p>
                                </div>
                            </button>
                        ))
                    )}
                </div>
            )}

            {/* Conversation list */}
            <div className="flex-1 overflow-y-auto">
                {isLoading ? (
                    <div className="flex items-center justify-center h-32">
                        <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    </div>
                ) : conversations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                        <MessageCircle className="w-8 h-8 mb-2 opacity-30" />
                        <p className="text-xs">No conversations yet</p>
                        <p className="text-[10px]">Tap + to start one</p>
                    </div>
                ) : (
                    conversations.map(convo => {
                        const myIds = new Set([wallet.id, wallet.signingPublicKey, wallet.encryptionPublicKey].filter(Boolean));
                        const isSelf = (p: any) => myIds.has(p.id) || myIds.has(p.signingPublicKey || "") || myIds.has(p.encryptionPublicKey || "");
                        const hasBot = convo.name === "Quantum Bot" || convo.participants?.some((p: any) => p.id?.startsWith("bot-"));
                        const isNoteToSelf = !hasBot && (convo.name === "Note to Self" || (convo.participants?.every((p: any) => isSelf(p)) ?? false));
                        let other = convo.participants?.find((p: any) => !isSelf(p));
                        if (!other && wallet.displayName && convo.participants?.length === 2) {
                            other = convo.participants.find((p: any) => p.displayName !== wallet.displayName);
                        }
                        const displayName = isNoteToSelf
                            ? "Note to Self"
                            : (other?.displayName || (convo.name && convo.name !== wallet.displayName ? convo.name : null) || "Unknown");
                        return (
                            <div
                                key={convo.id}
                                className="flex items-center border-b border-border/50 hover:bg-secondary/30 transition-colors"
                            >
                                <button
                                    onClick={() => setSelected(convo)}
                                    className="flex-1 flex items-center gap-2 px-3 py-2.5 text-left min-w-0"
                                >
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${isNoteToSelf ? "bg-amber-500/20" : "bg-primary/20"}`}>
                                        <MessageCircle className={`w-4 h-4 ${isNoteToSelf ? "text-amber-500" : "text-primary"}`} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5">
                                            <p className="text-xs font-medium text-foreground truncate">
                                                {displayName}
                                            </p>
                                            {(convo.unreadCount ?? 0) > 0 && (
                                                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
                                                    {convo.unreadCount! > 9 ? "9+" : convo.unreadCount}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[10px] text-muted-foreground truncate">
                                            {convo.lastMessagePreview || (
                                                <span className="flex items-center gap-1">
                                                    <Lock className="w-2.5 h-2.5" /> Encrypted
                                                </span>
                                            )}
                                        </p>
                                    </div>
                                </button>
                                <button
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        if (!confirm("Delete this conversation?")) return;
                                        try {
                                            await deleteConversation(messengerWallet, convo.id);
                                            setConversations(prev => prev.filter(c => c.id !== convo.id));
                                        } catch (err) { console.error("Delete failed:", err); }
                                    }}
                                    className="px-2 py-2.5 text-muted-foreground hover:text-destructive transition-colors flex-shrink-0"
                                    title="Delete conversation"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

// Compact chat view for extension popup
function ChatView({
    conversation,
    wallet,
    onBack,
    onBlocked,
}: {
    conversation: Conversation;
    wallet: WalletWithPrivateKeys;
    onBack: () => void;
    onBlocked?: () => void;
}) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [newMessage, setNewMessage] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [stagedMedia, setStagedMedia] = useState<{ file: File; previewUrl: string } | null>(null);
    const [spoiler, setSpoiler] = useState(false);
    const [resolvedRecipient, setResolvedRecipient] = useState<Wallet | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const prevCountRef = useRef(0);

    const chatMyIds = new Set([wallet.id, wallet.signingPublicKey, wallet.encryptionPublicKey].filter(Boolean));
    const chatIsSelf = (p: any) => chatMyIds.has(p.id) || chatMyIds.has(p.signingPublicKey || "") || chatMyIds.has(p.encryptionPublicKey || "");

    const chatHasBot = conversation.name === "Quantum Bot" || conversation.participants?.some((p: any) => p.id?.startsWith("bot-"));
    const isSelfConversation = !chatHasBot && (
        conversation.name === "Note to Self" ||
        (conversation.participants?.every((p: any) => chatIsSelf(p)) ?? false)
    );

    let participantRecipient = isSelfConversation
        ? { id: wallet.id, displayName: wallet.displayName, signingPublicKey: wallet.signingPublicKey, encryptionPublicKey: wallet.encryptionPublicKey }
        : conversation.participants?.find((p: any) => !chatIsSelf(p));
    if (!participantRecipient && wallet.displayName && conversation.participants?.length === 2) {
        participantRecipient = conversation.participants.find((p: any) => p.displayName !== wallet.displayName);
    }
    const recipient = participantRecipient || resolvedRecipient;
    const recipientMainId = recipient?.id || recipient?.signingPublicKey || "";
    const [blocked, setBlocked] = useState(() => recipientMainId ? isWalletBlocked(recipientMainId) : false);

    const handleToggleBlock = () => {
        if (!recipientMainId) return;
        if (blocked) {
            unblockWallet(recipientMainId);
            setBlocked(false);
        } else {
            if (!confirm(`Block ${recipient?.displayName || "this user"}?`)) return;
            blockWallet(recipientMainId);
            setBlocked(true);
            onBlocked?.();
        }
    };

    useEffect(() => {
        if (!participantRecipient && conversation.participantIds) {
            const otherId = conversation.participantIds.find(id => !chatMyIds.has(id));
            if (otherId) {
                getWallets().then(wallets => {
                    const match = wallets.find(w => w.id === otherId || w.signingPublicKey === otherId);
                    if (match) setResolvedRecipient(match);
                }).catch(() => {});
            }
        }
    }, [participantRecipient, conversation.participantIds, wallet.id]);

    const loadMessages = async () => {
        try {
            const msgs = await getMessages(
                conversation.id,
                wallet,
                conversation.participants || []
            );
            setMessages(prev => {
                if (prev.length === 0) return msgs;
                const existing = new Map(prev.map(m => [m.id, m]));
                return msgs.map(m => {
                    const old = existing.get(m.id);
                    if (!old) return m;
                    const oldGood = old.plaintext && !old.plaintext.startsWith("[Unable");
                    const newBad = !m.plaintext || m.plaintext.startsWith("[Unable");
                    if (oldGood && newBad) {
                        return { ...m, plaintext: old.plaintext, signatureValid: old.signatureValid, mediaUrl: old.mediaUrl, mediaFileName: old.mediaFileName, messageType: old.messageType };
                    }
                    if (old.mediaUrl && !m.mediaUrl) {
                        return { ...m, mediaUrl: old.mediaUrl, mediaFileName: old.mediaFileName, messageType: old.messageType, plaintext: old.plaintext };
                    }
                    return m;
                });
            });
        } catch (err) { console.error(err); }
        setIsLoading(false);
    };

    useEffect(() => {
        loadMessages();
        const interval = setInterval(loadMessages, 3000);
        return () => clearInterval(interval);
    }, [conversation.id]);

    useEffect(() => {
        if (messages.length > prevCountRef.current) {
            messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }
        prevCountRef.current = messages.length;
    }, [messages.length]);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > MAX_MEDIA_SIZE) {
            alert(`File too large. Max ${MAX_MEDIA_SIZE / (1024 * 1024)} MB.`);
            return;
        }
        if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
            alert("Only images and videos are supported.");
            return;
        }
        setStagedMedia({ file, previewUrl: URL.createObjectURL(file) });
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const clearStagedMedia = () => {
        if (stagedMedia) {
            URL.revokeObjectURL(stagedMedia.previewUrl);
            setStagedMedia(null);
        }
    };

    const [sendError, setSendError] = useState<string | null>(null);

    const handleSend = async () => {
        if ((!newMessage.trim() && !stagedMedia) || isSending) return;
        setSendError(null);

        if (!recipient) {
            setSendError("Recipient not found. They may not be registered.");
            return;
        }

        setIsSending(true);

        let textToSend = newMessage.trim();
        let msgType: MessageType = "text";

        if (stagedMedia) {
            try {
                const { payload, messageType } = await fileToMediaPayload(stagedMedia.file);
                textToSend = payload;
                msgType = messageType;
                clearStagedMedia();
            } catch (err) {
                setSendError(err instanceof Error ? err.message : "Failed to process media.");
                setIsSending(false);
                return;
            }
        }

        setNewMessage("");

        try {
            let recipientKey = recipient.encryptionPublicKey;
            if (!recipientKey) {
                const wallets = await getWallets();
                const match = wallets.find(w => w.id === recipient.id);
                if (!match?.encryptionPublicKey) {
                    setSendError("Recipient's encryption key not found");
                    setIsSending(false);
                    return;
                }
                recipientKey = match.encryptionPublicKey;
            }
            const msg = await sendMessage(
                conversation.id, textToSend, wallet, recipientKey,
                false, undefined, msgType, spoiler
            );
            setMessages(prev => [...prev, msg]);
        } catch (err: any) {
            console.error("Send failed:", err);
            setSendError(err.message || "Send failed");
        }
        setIsSending(false);
        setSpoiler(false);
    };

    return (
        <div className="flex flex-col h-full">
            {/* Chat header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50">
                <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center">
                    <Shield className="w-3.5 h-3.5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground truncate">
                        {isSelfConversation ? "Note to Self" : (conversation.name || recipient?.displayName || "Unknown")}
                    </p>
                    <p className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                        <Lock className="w-2 h-2" /> ML-KEM-768 + ML-DSA-65
                    </p>
                </div>
                {recipient && !isSelfConversation && (
                    <button
                        onClick={handleToggleBlock}
                        className={`p-1 rounded transition-colors flex-shrink-0 ${blocked ? "text-destructive bg-destructive/10" : "text-muted-foreground hover:text-destructive"}`}
                        title={blocked ? "Unblock user" : "Block user"}
                    >
                        <Ban className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {isLoading ? (
                    <div className="flex items-center justify-center h-full">
                        <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    </div>
                ) : messages.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-center">
                        <div>
                            <Lock className="w-8 h-8 mx-auto mb-2 opacity-30" />
                            <p className="text-xs">Start the conversation</p>
                        </div>
                    </div>
                ) : (
                    messages.map(msg => {
                        const isOwn = msg.senderWalletId === wallet.id ||
                            msg.senderWalletId === wallet.signingPublicKey;
                        return (
                            <MessageBubble key={msg.id} msg={msg} isOwn={isOwn} />
                        );
                    })
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-border bg-card/50">
                {sendError && (
                    <div className="px-3 py-1.5 bg-destructive/10 text-destructive text-[10px]">
                        {sendError}
                    </div>
                )}
                {/* Staged media preview */}
                {stagedMedia && (
                    <div className="px-2 pt-2 flex items-center gap-2">
                        <div className="relative rounded border border-border bg-muted/50 max-w-[100px]">
                            {stagedMedia.file.type.startsWith("video/") ? (
                                <div className="flex items-center gap-1 p-1.5">
                                    <Video className="w-3.5 h-3.5 text-primary" />
                                    <span className="text-[10px] truncate max-w-[60px]">{stagedMedia.file.name}</span>
                                </div>
                            ) : (
                                <img src={stagedMedia.previewUrl} alt="Preview" className="max-h-[50px] w-auto rounded" />
                            )}
                            <button
                                onClick={clearStagedMedia}
                                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center"
                            >
                                <X className="w-2.5 h-2.5" />
                            </button>
                        </div>
                        <span className="text-[10px] text-muted-foreground truncate">
                            {(stagedMedia.file.size / 1024).toFixed(0)} KB
                        </span>
                    </div>
                )}

                {/* Spoiler toggle */}
                <div className="px-2 pt-1.5 flex items-center gap-1.5">
                    <button
                        onClick={() => setSpoiler(!spoiler)}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${spoiler
                            ? "bg-amber-500/20 text-amber-500"
                            : "text-muted-foreground hover:text-foreground"
                            }`}
                    >
                        <EyeOff className="w-3 h-3" />
                        Spoiler
                    </button>
                </div>

                <div className="flex items-center gap-2 px-2 py-2">
                    {/* Hidden file input */}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*,video/*"
                        onChange={handleFileSelect}
                        className="hidden"
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isSending}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
                        title="Attach image or video"
                    >
                        <Paperclip className="w-3.5 h-3.5" />
                    </button>
                    <input
                        type="text"
                        placeholder={stagedMedia ? "Caption (optional)..." : "Type a message..."}
                        value={newMessage}
                        onChange={e => setNewMessage(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSend()}
                        className="flex-1 px-3 py-1.5 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <button
                        onClick={handleSend}
                        disabled={(!newMessage.trim() && !stagedMedia) || isSending}
                        className="w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-40 transition-colors"
                    >
                        {isSending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Send className="w-3.5 h-3.5" />
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Compact message bubble with media + spoiler support
function MessageBubble({ msg, isOwn }: { msg: Message; isOwn: boolean }) {
    const [revealed, setRevealed] = useState(false);
    const isSpoiler = msg.spoiler && !revealed;

    return (
        <div className={`flex ${isOwn ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-xl px-3 py-1.5 ${isOwn
                ? "bg-primary text-primary-foreground rounded-br-sm"
                : "bg-muted text-foreground rounded-bl-sm"
                }`}>
                {!isOwn && (
                    <p className="text-[10px] font-medium opacity-60 mb-0.5">
                        {msg.senderDisplayName}
                    </p>
                )}

                {/* Content with spoiler support */}
                <div className="relative">
                    {isSpoiler && (
                        <div
                            onClick={() => setRevealed(true)}
                            className="absolute inset-0 z-10 flex items-center justify-center cursor-pointer rounded"
                            style={{ backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
                        >
                            <div className="flex items-center gap-1 text-[10px] opacity-70">
                                <EyeOff className="w-3 h-3" />
                                <span>{msg.messageType !== "text" ? "SPOILER" : "Tap to reveal"}</span>
                            </div>
                        </div>
                    )}
                    <div className={isSpoiler ? "select-none" : ""}>
                        {msg.mediaUrl && msg.messageType === "image" ? (
                            <div className="my-1">
                                <img
                                    src={msg.mediaUrl}
                                    alt={msg.mediaFileName || "Image"}
                                    className={`max-w-full rounded max-h-[150px] object-contain transition-all duration-300 ${isSpoiler ? "blur-xl" : ""}`}
                                />
                                {msg.mediaFileName && !isSpoiler && (
                                    <p className="text-[9px] opacity-40 mt-0.5">{msg.mediaFileName}</p>
                                )}
                            </div>
                        ) : msg.mediaUrl && msg.messageType === "video" ? (
                            <div className="my-1">
                                <video
                                    src={isSpoiler ? undefined : msg.mediaUrl}
                                    controls={!isSpoiler}
                                    className={`max-w-full rounded max-h-[150px] transition-all duration-300 ${isSpoiler ? "blur-xl" : ""}`}
                                />
                                {msg.mediaFileName && !isSpoiler && (
                                    <p className="text-[9px] opacity-40 mt-0.5">{msg.mediaFileName}</p>
                                )}
                            </div>
                        ) : (
                            <p className={`text-xs whitespace-pre-wrap break-words transition-all duration-300 ${isSpoiler ? "blur-md" : ""}`}>
                                {msg.plaintext?.startsWith("[Unable") ? (
                                    <span className="italic opacity-60">{msg.plaintext}</span>
                                ) : msg.plaintext}
                            </p>
                        )}
                    </div>
                </div>

                <div className={`flex items-center gap-1 mt-0.5 text-[10px] ${isOwn ? "justify-end" : ""}`}>
                    <span className="opacity-50">{formatTime(msg.createdAt)}</span>
                    {msg.spoiler && <EyeOff className="w-2.5 h-2.5 opacity-50" />}
                    {msg.selfDestruct && <Timer className="w-2.5 h-2.5 text-destructive" />}
                    {msg.signatureValid ? (
                        <CheckCircle2 className="w-2.5 h-2.5 text-success" />
                    ) : (
                        <XCircle className="w-2.5 h-2.5 text-destructive" />
                    )}
                </div>
            </div>
        </div>
    );
}
