import { useState, useEffect } from "react";
import {
    ArrowLeft, Send, Inbox, SendHorizonal, Trash2, Loader2,
    Mail, Plus, RefreshCw, CheckCircle2, XCircle, AtSign, Reply,
    MailOpen
} from "lucide-react";
import type { UnifiedWallet } from "../../lib/unified-wallet";
import { toMessengerWallet } from "../../lib/unified-wallet";
import type { WalletWithPrivateKeys } from "../../lib/pqc-messenger";
import {
    getInbox, getSent, getTrash,
    sendMail, moveMail, deleteMail, markMailRead,
    registerName, reverseLookup, resolveRecipient,
    MAIL_DOMAIN,
    type MailItem,
} from "../../lib/pqc-mail";

interface Props {
    wallet: UnifiedWallet;
}

type Folder = "inbox" | "sent" | "trash";
type View = "list" | "compose" | "read";

function formatDate(dateInput: string): string {
    try {
        const date = new Date(dateInput);
        if (isNaN(date.getTime())) return "";
        const now = new Date();
        if (date.toDateString() === now.toDateString()) {
            return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }
        return date.toLocaleDateString([], { month: "short", day: "numeric" });
    } catch { return ""; }
}

export default function MailTab({ wallet }: Props) {
    const [folder, setFolder] = useState<Folder>("inbox");
    const [view, setView] = useState<View>("list");
    const [items, setItems] = useState<MailItem[]>([]);
    const [selectedItem, setSelectedItem] = useState<MailItem | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [myName, setMyName] = useState<string | null>(null);
    const [showNameReg, setShowNameReg] = useState(false);
    const [nameInput, setNameInput] = useState("");
    const [nameError, setNameError] = useState<string | null>(null);
    const [nameRegistering, setNameRegistering] = useState(false);

    const messengerWallet = toMessengerWallet(wallet) as WalletWithPrivateKeys;

    useEffect(() => {
        reverseLookup(wallet.id).then(name => {
            setMyName(name);
        }).catch(() => {});
    }, [wallet.id]);

    const loadFolder = async () => {
        setIsLoading(true);
        try {
            let data: MailItem[];
            if (folder === "inbox") data = await getInbox(messengerWallet);
            else if (folder === "sent") data = await getSent(messengerWallet);
            else data = await getTrash(messengerWallet);
            setItems(data);
        } catch (err) {
            console.error("Failed to load mail:", err);
        }
        setIsLoading(false);
    };

    useEffect(() => {
        loadFolder();
        const interval = setInterval(loadFolder, 10000);
        return () => clearInterval(interval);
    }, [folder]);

    const handleRegisterName = async () => {
        if (!nameInput.trim()) return;
        setNameRegistering(true);
        setNameError(null);
        try {
            const result = await registerName(nameInput.trim(), wallet.id);
            if (result.success) {
                setMyName(nameInput.trim().toLowerCase());
                setShowNameReg(false);
                setNameInput("");
            } else {
                setNameError(result.error || "Registration failed");
            }
        } catch (err: any) {
            setNameError(err.message || "Registration failed");
        }
        setNameRegistering(false);
    };

    const openMail = (item: MailItem) => {
        setSelectedItem(item);
        setView("read");
        if (!item.label.isRead) {
            markMailRead(wallet.id, item.message.id).catch(() => {});
        }
    };

    if (view === "compose") {
        return (
            <ComposeView
                wallet={messengerWallet}
                myName={myName}
                onBack={() => { setView("list"); loadFolder(); }}
            />
        );
    }

    if (view === "read" && selectedItem) {
        return (
            <ReadView
                item={selectedItem}
                wallet={messengerWallet}
                myName={myName}
                folder={folder}
                onBack={() => { setView("list"); loadFolder(); }}
                onReply={() => setView("compose")}
            />
        );
    }

    const unreadCount = items.filter(i => !i.label.isRead).length;

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <div className="flex items-center gap-2">
                    <Mail className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Mail
                    </span>
                    {myName && (
                        <span className="text-[10px] text-primary font-mono">
                            {myName}@{MAIL_DOMAIN}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    {!myName && (
                        <button
                            onClick={() => setShowNameReg(!showNameReg)}
                            className="w-7 h-7 rounded-lg bg-amber-500/20 flex items-center justify-center text-amber-500 hover:bg-amber-500/30 transition-colors"
                            title="Claim your @rouge.quant address"
                        >
                            <AtSign className="w-3.5 h-3.5" />
                        </button>
                    )}
                    <button
                        onClick={() => setView("compose")}
                        className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center text-primary hover:bg-primary/30 transition-colors"
                    >
                        <Plus className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={loadFolder}
                        className="w-7 h-7 rounded-lg hover:bg-secondary/30 flex items-center justify-center text-muted-foreground transition-colors"
                    >
                        <RefreshCw className="w-3 h-3" />
                    </button>
                </div>
            </div>

            {/* Name registration prompt */}
            {showNameReg && (
                <div className="px-3 py-2 border-b border-border bg-amber-500/5">
                    <p className="text-[10px] text-muted-foreground mb-1.5">
                        Claim your @{MAIL_DOMAIN} address
                    </p>
                    <div className="flex items-center gap-1.5">
                        <input
                            type="text"
                            placeholder="yourname"
                            value={nameInput}
                            onChange={e => setNameInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
                            maxLength={20}
                            className="flex-1 px-2 py-1 rounded bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        <span className="text-[10px] text-muted-foreground">@{MAIL_DOMAIN}</span>
                        <button
                            onClick={handleRegisterName}
                            disabled={nameRegistering || nameInput.length < 3}
                            className="px-2 py-1 rounded bg-primary text-primary-foreground text-[10px] font-medium hover:bg-primary/90 disabled:opacity-40"
                        >
                            {nameRegistering ? "..." : "Claim"}
                        </button>
                    </div>
                    {nameError && <p className="text-[10px] text-destructive mt-1">{nameError}</p>}
                </div>
            )}

            {/* Folder tabs */}
            <div className="flex border-b border-border">
                {([
                    { id: "inbox" as Folder, label: "Inbox", icon: Inbox, badge: unreadCount },
                    { id: "sent" as Folder, label: "Sent", icon: SendHorizonal },
                    { id: "trash" as Folder, label: "Trash", icon: Trash2 },
                ]).map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setFolder(tab.id)}
                        className={`flex-1 flex items-center justify-center gap-1 py-2 text-[10px] font-medium transition-colors relative ${
                            folder === tab.id
                                ? "text-primary"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {folder === tab.id && (
                            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-primary" />
                        )}
                        <tab.icon className="w-3 h-3" />
                        {tab.label}
                        {tab.badge ? (
                            <span className="ml-0.5 px-1 py-0 rounded-full bg-primary text-primary-foreground text-[9px] leading-tight">
                                {tab.badge}
                            </span>
                        ) : null}
                    </button>
                ))}
            </div>

            {/* Message list */}
            <div className="flex-1 overflow-y-auto">
                {isLoading ? (
                    <div className="flex items-center justify-center h-32">
                        <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    </div>
                ) : items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                        <MailOpen className="w-8 h-8 mb-2 opacity-30" />
                        <p className="text-xs">No mail in {folder}</p>
                    </div>
                ) : (
                    items.map(item => (
                        <button
                            key={item.message.id}
                            onClick={() => openMail(item)}
                            className={`w-full flex items-start gap-2 px-3 py-2.5 border-b border-border/50 hover:bg-secondary/30 transition-colors text-left ${
                                !item.label.isRead ? "bg-primary/5" : ""
                            }`}
                        >
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                                !item.label.isRead ? "bg-primary/20" : "bg-muted"
                            }`}>
                                <Mail className={`w-3.5 h-3.5 ${!item.label.isRead ? "text-primary" : "text-muted-foreground"}`} />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-1">
                                    <p className={`text-[11px] truncate ${!item.label.isRead ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                                        {item.message.senderName || "Unknown"}
                                    </p>
                                    <span className="text-[9px] text-muted-foreground flex-shrink-0">
                                        {formatDate(item.message.createdAt)}
                                    </span>
                                </div>
                                <p className={`text-xs truncate ${!item.label.isRead ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                                    {item.message.subject || "(No subject)"}
                                </p>
                                <p className="text-[10px] text-muted-foreground truncate">
                                    {item.message.body?.substring(0, 80) || ""}
                                </p>
                            </div>
                        </button>
                    ))
                )}
            </div>
        </div>
    );
}

function ComposeView({
    wallet,
    myName,
    onBack,
}: {
    wallet: WalletWithPrivateKeys;
    myName: string | null;
    onBack: () => void;
}) {
    const [to, setTo] = useState("");
    const [subject, setSubject] = useState("");
    const [body, setBody] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resolvedTo, setResolvedTo] = useState<string | null>(null);

    useEffect(() => {
        if (!to.trim()) {
            setResolvedTo(null);
            return;
        }
        const timeout = setTimeout(async () => {
            const id = await resolveRecipient(to);
            setResolvedTo(id);
        }, 500);
        return () => clearTimeout(timeout);
    }, [to]);

    const handleSend = async () => {
        if (!to.trim() || !subject.trim() || isSending) return;
        setError(null);
        setIsSending(true);

        try {
            const recipientId = await resolveRecipient(to);
            if (!recipientId) {
                setError(`Could not resolve "${to}". Use a @${MAIL_DOMAIN} address or wallet ID.`);
                setIsSending(false);
                return;
            }

            await sendMail(wallet, [recipientId], subject, body || "(empty)");
            onBack();
        } catch (err: any) {
            setError(err.message || "Failed to send");
        }
        setIsSending(false);
    };

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50">
                <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <Mail className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-medium">Compose</span>
                {myName && (
                    <span className="text-[10px] text-muted-foreground ml-auto">
                        from: {myName}@{MAIL_DOMAIN}
                    </span>
                )}
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {/* To */}
                <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider">To</label>
                    <input
                        type="text"
                        placeholder={`alice@${MAIL_DOMAIN} or wallet ID`}
                        value={to}
                        onChange={e => setTo(e.target.value)}
                        className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    {to.trim() && (
                        <p className={`text-[9px] mt-0.5 ${resolvedTo ? "text-success" : "text-muted-foreground"}`}>
                            {resolvedTo ? `Resolved: ${resolvedTo.substring(0, 16)}...` : "Resolving..."}
                        </p>
                    )}
                </div>

                {/* Subject */}
                <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Subject</label>
                    <input
                        type="text"
                        placeholder="Subject"
                        value={subject}
                        onChange={e => setSubject(e.target.value)}
                        className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                </div>

                {/* Body */}
                <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Message</label>
                    <textarea
                        placeholder="Write your message..."
                        value={body}
                        onChange={e => setBody(e.target.value)}
                        rows={6}
                        className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                </div>

                {error && (
                    <div className="px-2 py-1.5 bg-destructive/10 rounded text-destructive text-[10px]">
                        {error}
                    </div>
                )}
            </div>

            {/* Send button */}
            <div className="px-3 py-2 border-t border-border">
                <button
                    onClick={handleSend}
                    disabled={!to.trim() || !subject.trim() || isSending}
                    className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium flex items-center justify-center gap-1.5 hover:bg-primary/90 disabled:opacity-40 transition-colors"
                >
                    {isSending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                        <>
                            <Send className="w-3.5 h-3.5" />
                            Send Mail
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}

function ReadView({
    item,
    wallet,
    myName,
    folder,
    onBack,
    onReply,
}: {
    item: MailItem;
    wallet: WalletWithPrivateKeys;
    myName: string | null;
    folder: Folder;
    onBack: () => void;
    onReply: () => void;
}) {
    const { message, label } = item;

    const handleTrash = async () => {
        try {
            if (folder === "trash") {
                await deleteMail(wallet.id, message.id);
            } else {
                await moveMail(wallet.id, message.id, "trash");
            }
            onBack();
        } catch (err) {
            console.error("Failed to move/delete:", err);
        }
    };

    const handleRestore = async () => {
        try {
            await moveMail(wallet.id, message.id, "inbox");
            onBack();
        } catch (err) {
            console.error("Failed to restore:", err);
        }
    };

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50">
                <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">
                        {message.subject || "(No subject)"}
                    </p>
                </div>
                <div className="flex items-center gap-1">
                    {folder === "trash" && (
                        <button
                            onClick={handleRestore}
                            className="w-7 h-7 rounded-lg hover:bg-secondary/30 flex items-center justify-center text-muted-foreground transition-colors"
                            title="Restore to inbox"
                        >
                            <Inbox className="w-3.5 h-3.5" />
                        </button>
                    )}
                    <button
                        onClick={handleTrash}
                        className="w-7 h-7 rounded-lg hover:bg-destructive/20 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                        title={folder === "trash" ? "Delete permanently" : "Move to trash"}
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* Message content */}
            <div className="flex-1 overflow-y-auto p-3">
                {/* Sender info */}
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                        <AtSign className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">
                            {message.senderName || "Unknown"}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                            {formatDate(message.createdAt)}
                        </p>
                    </div>
                    {message.signatureValid ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-success ml-auto flex-shrink-0" />
                    ) : (
                        <XCircle className="w-3.5 h-3.5 text-destructive ml-auto flex-shrink-0" />
                    )}
                </div>

                {/* Subject */}
                <h3 className="text-sm font-semibold text-foreground mb-2">
                    {message.subject || "(No subject)"}
                </h3>

                {/* Body */}
                <div className="text-xs text-foreground whitespace-pre-wrap break-words leading-relaxed">
                    {message.body?.startsWith("[Unable") ? (
                        <span className="italic text-muted-foreground">{message.body}</span>
                    ) : (
                        message.body
                    )}
                </div>

                {/* Encryption badge */}
                <div className="mt-4 flex items-center gap-1 text-[10px] text-muted-foreground">
                    <CheckCircle2 className="w-2.5 h-2.5" />
                    ML-KEM-768 + ML-DSA-65 encrypted
                </div>
            </div>

            {/* Reply button */}
            {folder !== "trash" && (
                <div className="px-3 py-2 border-t border-border">
                    <button
                        onClick={onReply}
                        className="w-full py-2 rounded-lg bg-secondary text-foreground text-xs font-medium flex items-center justify-center gap-1.5 hover:bg-secondary/80 transition-colors"
                    >
                        <Reply className="w-3.5 h-3.5" />
                        Reply
                    </button>
                </div>
            )}
        </div>
    );
}
