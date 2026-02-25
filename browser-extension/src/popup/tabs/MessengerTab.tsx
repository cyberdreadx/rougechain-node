import { useState, useEffect, useRef } from "react";
import {
    ArrowLeft, Send, Lock, Shield, Plus, Loader2,
    MessageCircle, CheckCircle2, XCircle, Timer,
    Paperclip, EyeOff, Image as ImageIcon, Video, X
} from "lucide-react";
import type { UnifiedWallet } from "../../lib/unified-wallet";
import { toMessengerWallet } from "../../lib/unified-wallet";
import {
    getConversations,
    getMessages,
    getWallets,
    sendMessage,
    createConversation,
    registerWalletOnNode,
    fileToMediaPayload,
    MAX_MEDIA_SIZE,
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

    const messengerWallet = toMessengerWallet(wallet) as WalletWithPrivateKeys;

    const loadConversations = async () => {
        const convos = await getConversations(wallet.id);
        setConversations(convos);
        setIsLoading(false);
    };

    const loadContacts = async () => {
        const wallets = await getWallets();
        setContacts(wallets.filter(w => w.id !== wallet.id));
    };

    useEffect(() => {
        // Register wallet on mount
        registerWalletOnNode({
            id: wallet.id,
            displayName: wallet.displayName,
            signingPublicKey: wallet.signingPublicKey,
            encryptionPublicKey: wallet.encryptionPublicKey,
        }).catch(() => { });

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

            {/* Contact picker */}
            {showContacts && (
                <div className="border-b border-border bg-card/80 max-h-40 overflow-y-auto">
                    {contacts.length === 0 ? (
                        <p className="text-xs text-muted-foreground p-3 text-center">No contacts found</p>
                    ) : (
                        contacts.map(c => (
                            <button
                                key={c.id}
                                onClick={async () => {
                                    try {
                                        const convo = await createConversation(
                                            wallet.id,
                                            [wallet.id, c.id],
                                            c.displayName
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
                        const other = convo.participants?.find(p => p.id !== wallet.id);
                        return (
                            <button
                                key={convo.id}
                                onClick={() => setSelected(convo)}
                                className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-secondary/30 transition-colors text-left border-b border-border/50"
                            >
                                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                                    <MessageCircle className="w-4 h-4 text-primary" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="text-xs font-medium text-foreground truncate">
                                        {convo.name || other?.displayName || "Unknown"}
                                    </p>
                                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <Lock className="w-2.5 h-2.5" /> End-to-end encrypted
                                    </p>
                                </div>
                            </button>
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
}: {
    conversation: Conversation;
    wallet: WalletWithPrivateKeys;
    onBack: () => void;
}) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [newMessage, setNewMessage] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [stagedMedia, setStagedMedia] = useState<{ file: File; previewUrl: string } | null>(null);
    const [spoiler, setSpoiler] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const prevCountRef = useRef(0);

    const recipient = conversation.participants?.find(p => p.id !== wallet.id);

    const loadMessages = async () => {
        try {
            const msgs = await getMessages(
                conversation.id,
                wallet,
                conversation.participants || []
            );
            setMessages(msgs);
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

    const handleSend = async () => {
        if ((!newMessage.trim() && !stagedMedia) || !recipient || isSending) return;
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
                alert(err instanceof Error ? err.message : "Failed to process media.");
                setIsSending(false);
                return;
            }
        }

        setNewMessage("");

        try {
            const recipientKey = recipient.encryptionPublicKey;
            if (!recipientKey) {
                const wallets = await getWallets();
                const match = wallets.find(w => w.id === recipient.id);
                if (!match?.encryptionPublicKey) {
                    alert("Recipient's encryption key not found");
                    setIsSending(false);
                    return;
                }
                const msg = await sendMessage(
                    conversation.id, textToSend, wallet, match.encryptionPublicKey,
                    false, undefined, msgType, spoiler
                );
                setMessages(prev => [...prev, msg]);
            } else {
                const msg = await sendMessage(
                    conversation.id, textToSend, wallet, recipientKey,
                    false, undefined, msgType, spoiler
                );
                setMessages(prev => [...prev, msg]);
            }
        } catch (err) {
            console.error("Send failed:", err);
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
                <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">
                        {conversation.name || recipient?.displayName || "Unknown"}
                    </p>
                    <p className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                        <Lock className="w-2 h-2" /> ML-KEM-768 + ML-DSA-65
                    </p>
                </div>
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
