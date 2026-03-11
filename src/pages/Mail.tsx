import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mail as MailIcon, Inbox, SendHorizonal, Trash2, Plus, RefreshCw,
  ArrowLeft, Send, Lock, Loader2, CheckCircle2, XCircle, AtSign,
  Reply, MailOpen, Key, Copy, Settings, ToggleLeft, ToggleRight, Type,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import WalletSetup from "@/components/messenger/WalletSetup";
import type { WalletWithPrivateKeys } from "@/lib/pqc-messenger";
import { registerWalletOnNode } from "@/lib/pqc-messenger";
import {
  getInbox, getSent, getTrash,
  sendMail, moveMail, deleteMail, markMailRead,
  registerName, reverseLookup, resolveRecipient,
  MAIL_DOMAIN,
  type MailItem,
} from "@/lib/pqc-mail";
import {
  UnifiedWallet,
  unlockUnifiedWallet,
  isWalletLocked,
  getLockedWalletMetadata,
  loadUnifiedWallet,
  saveUnifiedWallet,
  toMessengerWallet,
  fromMessengerWallet,
} from "@/lib/unified-wallet";

type Folder = "inbox" | "sent" | "trash";
type View = "list" | "compose" | "read" | "settings";

const MAIL_SETTINGS_KEY = "pqc_mail_settings";

interface MailSettings {
  signature: string;
  signatureEnabled: boolean;
}

function loadMailSettings(): MailSettings {
  try {
    const raw = localStorage.getItem(MAIL_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* */ }
  return { signature: "", signatureEnabled: false };
}

function saveMailSettings(settings: MailSettings): void {
  localStorage.setItem(MAIL_SETTINGS_KEY, JSON.stringify(settings));
}

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

function buildThread(allItems: MailItem[], selected: MailItem): MailItem[] {
  const byId = new Map<string, MailItem>();
  for (const item of allItems) byId.set(item.message.id, item);

  let rootId = selected.message.id;
  let cur = selected.message;
  while (cur.replyToId && byId.has(cur.replyToId)) {
    rootId = cur.replyToId;
    cur = byId.get(cur.replyToId)!.message;
  }

  const threadIds = new Set<string>();
  const collect = (parentId: string) => {
    threadIds.add(parentId);
    for (const item of allItems) {
      if (item.message.replyToId === parentId && !threadIds.has(item.message.id)) {
        collect(item.message.id);
      }
    }
  };
  collect(rootId);

  return allItems
    .filter(item => threadIds.has(item.message.id))
    .sort((a, b) => new Date(a.message.createdAt).getTime() - new Date(b.message.createdAt).getTime());
}

// --- Compose View ---

function ComposeView({
  wallet,
  myName,
  onBack,
  replyTo,
  mailSettings,
}: {
  wallet: WalletWithPrivateKeys;
  myName: string | null;
  onBack: () => void;
  replyTo?: MailItem | null;
  mailSettings: MailSettings;
}) {
  const sigBlock = mailSettings.signatureEnabled && mailSettings.signature.trim()
    ? `\n\n--\n${mailSettings.signature.trim()}`
    : "";
  const [to, setTo] = useState(replyTo?.message.senderName || replyTo?.message.fromWalletId || "");
  const [subject, setSubject] = useState(replyTo ? `Re: ${replyTo.message.subject || ""}` : "");
  const [body, setBody] = useState(sigBlock);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvedTo, setResolvedTo] = useState<string | null>(null);

  useEffect(() => {
    if (!to.trim()) { setResolvedTo(null); return; }
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
      await sendMail(wallet, [recipientId], subject, body || "(empty)", replyTo?.message.id);
      toast.success("Mail sent!");
      onBack();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send");
    }
    setIsSending(false);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card/50">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <MailIcon className="w-5 h-5 text-primary" />
        <span className="font-medium">Compose</span>
        {myName && (
          <span className="text-xs text-muted-foreground ml-auto">
            from: {myName}@{MAIL_DOMAIN}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">To</label>
          <Input
            placeholder={`alice@${MAIL_DOMAIN} or wallet ID`}
            value={to}
            onChange={e => setTo(e.target.value)}
            className="mt-1"
          />
          {to.trim() && (
            <p className={`text-xs mt-1 ${resolvedTo ? "text-green-500" : "text-muted-foreground"}`}>
              {resolvedTo ? `Resolved: ${resolvedTo.substring(0, 20)}...` : "Resolving..."}
            </p>
          )}
        </div>
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Subject</label>
          <Input
            placeholder="Subject"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Message</label>
          <textarea
            placeholder="Write your message..."
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={10}
            className="w-full mt-1 px-3 py-2 rounded-lg bg-input border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        </div>
        {error && (
          <div className="px-3 py-2 bg-destructive/10 rounded-lg text-destructive text-sm">{error}</div>
        )}
      </div>
      <div className="px-4 py-3 border-t border-border">
        <Button
          onClick={handleSend}
          disabled={!to.trim() || !subject.trim() || isSending}
          className="w-full"
        >
          {isSending ? (
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
          ) : (
            <Send className="w-4 h-4 mr-2" />
          )}
          Send Mail
        </Button>
      </div>
    </div>
  );
}

// --- Thread Message (single message in a thread) ---

function ThreadMessage({
  item,
  isLatest,
  defaultExpanded,
}: {
  item: MailItem;
  isLatest: boolean;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { message } = item;

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/20 transition-colors text-left border-b border-border/50"
      >
        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
          <AtSign className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground truncate">
              {message.senderName || "Unknown"}
            </span>
            <span className="text-xs text-muted-foreground flex-shrink-0">{formatDate(message.createdAt)}</span>
          </div>
          <p className="text-xs text-muted-foreground truncate">{message.body?.substring(0, 100)}</p>
        </div>
      </button>
    );
  }

  return (
    <div className={`border-b border-border/50 ${isLatest ? "" : "bg-card/30"}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
          isLatest ? "bg-primary/20" : "bg-muted"
        }`}>
          <AtSign className={`w-4 h-4 ${isLatest ? "text-primary" : "text-muted-foreground"}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium truncate ${isLatest ? "text-foreground" : "text-muted-foreground"}`}>
              {message.senderName || "Unknown"}
            </span>
            {message.signatureValid ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />
            )}
          </div>
          <p className="text-xs text-muted-foreground">{formatDate(message.createdAt)}</p>
        </div>
        {!isLatest && (
          <button onClick={() => setExpanded(false)} className="text-xs text-muted-foreground hover:text-foreground">
            collapse
          </button>
        )}
      </div>
      <div className="px-4 pb-4 pl-[3.25rem]">
        <div className={`text-sm whitespace-pre-wrap break-words leading-relaxed ${
          message.body?.startsWith("[Unable") ? "italic text-muted-foreground" : "text-foreground"
        }`}>
          {message.body}
        </div>
      </div>
    </div>
  );
}

// --- Read View ---

function ReadView({
  item,
  wallet,
  folder,
  thread,
  onBack,
  onReply,
}: {
  item: MailItem;
  wallet: WalletWithPrivateKeys;
  folder: Folder;
  thread: MailItem[];
  onBack: () => void;
  onReply: () => void;
}) {
  const { message } = item;

  const handleTrash = async () => {
    try {
      if (folder === "trash") {
        await deleteMail(wallet.id, message.id);
        toast.success("Mail deleted permanently");
      } else {
        await moveMail(wallet.id, message.id, "trash");
        toast.success("Moved to trash");
      }
      onBack();
    } catch (err) {
      console.error("Failed to move/delete:", err);
      toast.error("Action failed");
    }
  };

  const handleRestore = async () => {
    try {
      await moveMail(wallet.id, message.id, "inbox");
      toast.success("Restored to inbox");
      onBack();
    } catch (err) {
      console.error("Failed to restore:", err);
    }
  };

  const hasThread = thread.length > 1;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card/50">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-foreground truncate">{message.subject || "(No subject)"}</p>
          {hasThread && (
            <p className="text-xs text-muted-foreground">{thread.length} messages in thread</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {folder === "trash" && (
            <Button variant="ghost" size="icon" onClick={handleRestore} title="Restore to inbox">
              <Inbox className="w-4 h-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleTrash}
            title={folder === "trash" ? "Delete permanently" : "Move to trash"}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {hasThread ? (
          <div>
            {thread.map((threadItem, idx) => (
              <ThreadMessage
                key={threadItem.message.id}
                item={threadItem}
                isLatest={threadItem.message.id === item.message.id}
                defaultExpanded={idx >= thread.length - 2}
              />
            ))}
          </div>
        ) : (
          <div className="p-4 sm:p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                <AtSign className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">
                  {message.senderName || "Unknown"}
                </p>
                <p className="text-xs text-muted-foreground">{formatDate(message.createdAt)}</p>
              </div>
              {message.signatureValid ? (
                <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
              ) : (
                <XCircle className="w-4 h-4 text-destructive flex-shrink-0" />
              )}
            </div>

            <h3 className="text-lg font-semibold text-foreground mb-3">{message.subject || "(No subject)"}</h3>

            <div className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">
              {message.body?.startsWith("[Unable") ? (
                <span className="italic text-muted-foreground">{message.body}</span>
              ) : (
                message.body
              )}
            </div>
          </div>
        )}

        <div className="px-4 pb-2 flex items-center gap-1 text-xs text-muted-foreground">
          <Lock className="w-3 h-3" />
          ML-KEM-768 + ML-DSA-65 encrypted
        </div>
      </div>

      {folder !== "trash" && (
        <div className="px-4 py-3 border-t border-border">
          <Button variant="outline" onClick={onReply} className="w-full">
            <Reply className="w-4 h-4 mr-2" />
            Reply
          </Button>
        </div>
      )}
    </div>
  );
}

// --- Settings View ---

function SettingsView({
  onBack,
  settings,
  onSave,
}: {
  onBack: () => void;
  settings: MailSettings;
  onSave: (s: MailSettings) => void;
}) {
  const [sig, setSig] = useState(settings.signature);
  const [sigEnabled, setSigEnabled] = useState(settings.signatureEnabled);

  const handleSave = () => {
    const updated: MailSettings = { signature: sig, signatureEnabled: sigEnabled };
    saveMailSettings(updated);
    onSave(updated);
    toast.success("Settings saved");
    onBack();
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card/50">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <Settings className="w-5 h-5 text-primary" />
        <span className="font-medium">Mail Settings</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
        {/* Signature */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Type className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Email Signature</h3>
            </div>
            <button
              onClick={() => setSigEnabled(!sigEnabled)}
              className="flex items-center gap-1.5 text-sm"
            >
              {sigEnabled ? (
                <ToggleRight className="w-6 h-6 text-primary" />
              ) : (
                <ToggleLeft className="w-6 h-6 text-muted-foreground" />
              )}
              <span className={sigEnabled ? "text-primary" : "text-muted-foreground"}>
                {sigEnabled ? "On" : "Off"}
              </span>
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Your signature is automatically appended to new emails and replies.
          </p>
          <textarea
            placeholder={"Best regards,\nYour Name\nyou@rouge.quant"}
            value={sig}
            onChange={e => setSig(e.target.value)}
            rows={5}
            disabled={!sigEnabled}
            className={`w-full px-3 py-2 rounded-lg bg-input border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none transition-opacity ${
              !sigEnabled ? "opacity-40" : ""
            }`}
          />
          {sigEnabled && sig.trim() && (
            <div className="rounded-lg border border-border/50 bg-card/50 p-3">
              <p className="text-xs text-muted-foreground mb-1.5 font-medium">Preview:</p>
              <div className="text-sm text-muted-foreground whitespace-pre-wrap border-l-2 border-primary/30 pl-3">
                --{"\n"}{sig.trim()}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-border">
        <Button onClick={handleSave} className="w-full">
          Save Settings
        </Button>
      </div>
    </div>
  );
}

// --- Main Page ---

const MailPage = () => {
  const [wallet, setWallet] = useState<UnifiedWallet | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const [folder, setFolder] = useState<Folder>("inbox");
  const [view, setView] = useState<View>("list");
  const [items, setItems] = useState<MailItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<MailItem | null>(null);
  const [isLoadingMail, setIsLoadingMail] = useState(true);
  const [myName, setMyName] = useState<string | null>(null);
  const [showNameReg, setShowNameReg] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameRegistering, setNameRegistering] = useState(false);
  const [replyItem, setReplyItem] = useState<MailItem | null>(null);
  const [threadItems, setThreadItems] = useState<MailItem[]>([]);
  const [mailSettings, setMailSettings] = useState<MailSettings>(loadMailSettings);

  useEffect(() => {
    const locked = isWalletLocked();
    setIsLocked(locked);
    if (!locked) {
      const w = loadUnifiedWallet();
      setWallet(w);
      if (w?.encryptionPublicKey) {
        registerWalletOnNode({
          id: w.id,
          displayName: w.displayName,
          signingPublicKey: w.signingPublicKey,
          encryptionPublicKey: w.encryptionPublicKey,
        }).catch(() => {});
      }
    }
    setIsLoading(false);
  }, []);

  const messengerWallet = useMemo(() =>
    wallet ? toMessengerWallet(wallet) as WalletWithPrivateKeys : null,
    [wallet]
  );

  useEffect(() => {
    if (wallet) {
      reverseLookup(wallet.id).then(name => setMyName(name)).catch(() => {});
    }
  }, [wallet?.id]);

  const loadFolder = async () => {
    if (!messengerWallet) return;
    setIsLoadingMail(true);
    try {
      let data: MailItem[];
      if (folder === "inbox") data = await getInbox(messengerWallet);
      else if (folder === "sent") data = await getSent(messengerWallet);
      else data = await getTrash(messengerWallet);
      setItems(data);
    } catch (err) {
      console.error("Failed to load mail:", err);
    }
    setIsLoadingMail(false);
  };

  useEffect(() => {
    if (messengerWallet) {
      loadFolder();
      const interval = setInterval(loadFolder, 10000);
      return () => clearInterval(interval);
    }
  }, [folder, messengerWallet]);

  const handleRegisterName = async () => {
    if (!nameInput.trim() || !wallet) return;
    setNameRegistering(true);
    setNameError(null);
    try {
      const result = await registerName(nameInput.trim(), wallet.id);
      if (result.success) {
        setMyName(nameInput.trim().toLowerCase());
        setShowNameReg(false);
        setNameInput("");
        toast.success(`Claimed ${nameInput.trim().toLowerCase()}@${MAIL_DOMAIN}!`);
      } else {
        setNameError(result.error || "Registration failed");
      }
    } catch (err: unknown) {
      setNameError(err instanceof Error ? err.message : "Registration failed");
    }
    setNameRegistering(false);
  };

  const openMail = async (item: MailItem) => {
    setSelectedItem(item);
    setView("read");
    if (!item.label.isRead && wallet) {
      markMailRead(wallet.id, item.message.id).catch(() => {});
    }
    if (messengerWallet) {
      try {
        const [inbox, sent] = await Promise.all([
          getInbox(messengerWallet),
          getSent(messengerWallet),
        ]);
        const deduped = new Map<string, MailItem>();
        for (const m of [...inbox, ...sent]) deduped.set(m.message.id, m);
        const thread = buildThread([...deduped.values()], item);
        setThreadItems(thread);
      } catch {
        setThreadItems([item]);
      }
    }
  };

  const handleUnlock = async () => {
    if (!unlockPassword.trim()) {
      toast.error("Enter your vault password");
      return;
    }
    setUnlocking(true);
    try {
      await unlockUnifiedWallet(unlockPassword.trim());
      const validated = loadUnifiedWallet();
      if (!validated) throw new Error("Wallet could not be loaded");
      setWallet(validated);
      setIsLocked(false);
      setUnlockPassword("");
      toast.success("Wallet unlocked");
    } catch {
      toast.error("Unlock failed", { description: "Invalid password" });
    } finally {
      setUnlocking(false);
    }
  };

  const handleWalletCreated = (newWallet: WalletWithPrivateKeys) => {
    const unified = fromMessengerWallet(newWallet);
    saveUnifiedWallet(unified);
    setWallet(unified);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
          <Lock className="w-8 h-8 text-primary" />
        </motion.div>
      </div>
    );
  }

  if (!wallet) {
    if (isLocked) {
      const meta = getLockedWalletMetadata();
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-card border border-border rounded-xl p-6 space-y-4">
            <h2 className="text-lg font-semibold">Wallet Locked</h2>
            <p className="text-sm text-muted-foreground">
              {meta?.displayName ? `${meta.displayName} is locked.` : "Your wallet is locked."}
            </p>
            <Input type="password" placeholder="Enter vault password" value={unlockPassword} onChange={e => setUnlockPassword(e.target.value)} />
            <Button className="w-full" onClick={handleUnlock} disabled={unlocking}>
              {unlocking ? "Unlocking..." : "Unlock Wallet"}
            </Button>
          </div>
        </div>
      );
    }
    return <WalletSetup onWalletCreated={handleWalletCreated} onWalletImported={(w) => { saveUnifiedWallet(w); setWallet(w); }} />;
  }

  const unreadCount = items.filter(i => !i.label.isRead).length;

  if (view === "settings") {
    return (
      <div className="flex flex-col overflow-hidden h-[calc(100dvh-3.5rem)] md:h-dvh max-w-full">
        <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
        <SettingsView
          onBack={() => setView("list")}
          settings={mailSettings}
          onSave={setMailSettings}
        />
      </div>
    );
  }

  if (view === "compose" && messengerWallet) {
    return (
      <div className="flex flex-col overflow-hidden h-[calc(100dvh-3.5rem)] md:h-dvh max-w-full">
        <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
        <ComposeView
          wallet={messengerWallet}
          myName={myName}
          onBack={() => { setView("list"); setReplyItem(null); loadFolder(); }}
          replyTo={replyItem}
          mailSettings={mailSettings}
        />
      </div>
    );
  }

  if (view === "read" && selectedItem && messengerWallet) {
    return (
      <div className="flex flex-col overflow-hidden h-[calc(100dvh-3.5rem)] md:h-dvh max-w-full">
        <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
        <ReadView
          item={selectedItem}
          wallet={messengerWallet}
          folder={folder}
          thread={threadItems}
          onBack={() => { setView("list"); setThreadItems([]); loadFolder(); }}
          onReply={() => { setReplyItem(selectedItem); setView("compose"); }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden h-[calc(100dvh-3.5rem)] md:h-dvh max-w-full">
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="sticky top-0 z-40 flex items-center justify-between px-2 sm:px-4 py-2 bg-background/80 backdrop-blur-sm border-b border-border gap-1 w-full min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Key className="w-4 h-4 text-primary flex-shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium text-foreground truncate">{wallet.displayName}</span>
            {myName ? (
              <span className="text-xs text-primary font-mono">{myName}@{MAIL_DOMAIN}</span>
            ) : (
              <button
                className="flex items-center gap-1 text-xs text-muted-foreground font-mono hover:text-foreground transition-colors"
                onClick={() => {
                  navigator.clipboard.writeText(wallet.signingPublicKey);
                  toast.success("Address copied!");
                }}
              >
                <span className="truncate max-w-[100px] sm:max-w-[180px]">{wallet.signingPublicKey.substring(0, 12)}...</span>
                <Copy className="w-3 h-3 flex-shrink-0" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          {!myName && (
            <Button variant="ghost" size="icon" onClick={() => setShowNameReg(!showNameReg)} title="Claim your @rouge.quant address">
              <AtSign className="w-4 h-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => setView("settings")} title="Mail settings">
            <Settings className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={loadFolder} title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={() => { setReplyItem(null); setView("compose"); }} title="Compose" className="sm:hidden">
            <Plus className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setReplyItem(null); setView("compose"); }} className="hidden sm:flex">
            <Plus className="w-4 h-4 mr-1" />
            Compose
          </Button>
        </div>
      </div>

      {/* Name registration banner */}
      <AnimatePresence>
        {showNameReg && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-b border-border bg-amber-500/5 overflow-hidden"
          >
            <div className="px-4 py-3">
              <p className="text-xs text-muted-foreground mb-2">
                Claim your @{MAIL_DOMAIN} address to receive mail by name instead of wallet ID.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="yourname"
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
                  maxLength={20}
                  className="flex-1"
                />
                <span className="text-sm text-muted-foreground whitespace-nowrap">@{MAIL_DOMAIN}</span>
                <Button onClick={handleRegisterName} disabled={nameRegistering || nameInput.length < 3} size="sm">
                  {nameRegistering ? "..." : "Claim"}
                </Button>
              </div>
              {nameError && <p className="text-xs text-destructive mt-1">{nameError}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Folder tabs */}
      <div className="flex border-b border-border relative z-10">
        {([
          { id: "inbox" as Folder, label: "Inbox", icon: Inbox, badge: unreadCount },
          { id: "sent" as Folder, label: "Sent", icon: SendHorizonal },
          { id: "trash" as Folder, label: "Trash", icon: Trash2 },
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => setFolder(tab.id)}
            className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors relative ${
              folder === tab.id ? "text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {folder === tab.id && (
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-0.5 rounded-full bg-primary" />
            )}
            <tab.icon className="w-4 h-4" />
            {tab.label}
            {"badge" in tab && tab.badge ? (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground text-xs leading-tight">
                {tab.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto relative z-10">
        {isLoadingMail ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
            <MailOpen className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">No mail in {folder}</p>
            {folder === "inbox" && (
              <p className="text-xs mt-1">
                {myName ? `Your address: ${myName}@${MAIL_DOMAIN}` : "Claim a @rouge.quant address to start receiving mail"}
              </p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {items.map(item => (
              <button
                key={item.message.id}
                onClick={() => openMail(item)}
                className={`w-full flex items-start gap-3 px-4 py-3 hover:bg-secondary/30 transition-colors text-left ${
                  !item.label.isRead ? "bg-primary/5" : ""
                }`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                  !item.label.isRead ? "bg-primary/20" : "bg-muted"
                }`}>
                  <MailIcon className={`w-5 h-5 ${!item.label.isRead ? "text-primary" : "text-muted-foreground"}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className={`text-sm truncate ${!item.label.isRead ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                      {item.message.senderName || "Unknown"}
                    </p>
                    <span className="text-xs text-muted-foreground flex-shrink-0">{formatDate(item.message.createdAt)}</span>
                  </div>
                  <p className={`text-sm truncate ${!item.label.isRead ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                    {item.message.subject || "(No subject)"}
                  </p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {item.message.body?.substring(0, 100) || ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default MailPage;
