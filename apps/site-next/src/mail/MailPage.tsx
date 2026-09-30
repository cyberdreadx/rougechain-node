/**
 * /mail — apps/web's pages/Mail.tsx on site-next: inbox / sent / trash with threads, compose,
 * reply, attachments (≤ 2 MB, encrypted), name claim (both @rouge.quant and @qwalla.mail) and the
 * ML-DSA-65 signature verdict per mail. Everything goes through core's pqc-mail / mail-name.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  AtSign,
  CheckCircle2,
  Download,
  FileText,
  Image as ImageIcon,
  Inbox,
  Key,
  Loader2,
  Lock,
  MailOpen,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  Send,
  SendHorizonal,
  Settings,
  ShieldQuestion,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  deleteMail,
  getInbox,
  getSent,
  getTrash,
  MAIL_DOMAIN,
  MAIL_DOMAIN_ALT,
  markMailRead,
  moveMail,
  resolveRecipient,
  sendMail,
  type MailAttachment,
  type MailItem,
  type MailMessage,
} from "@rougechain/core/pqc-mail";
import { getMyMailName, mailAddresses } from "@rougechain/core/mail-name";
import { registerWalletOnNode, type WalletWithPrivateKeys } from "@rougechain/core/pqc-messenger";
import type { UnifiedWallet } from "@rougechain/core/unified-wallet";
import { Toggle } from "../wallet/parts";
import { MailNameEditor } from "../wallet/profile";
import { toast } from "../wallet/toast";
import { useWallet } from "../wallet/WalletProvider";
import { WalletGate } from "../messenger/Gate";
import { useFillHeight } from "../messenger/hooks";
import { MAIL, S, fmt, plural } from "../messenger/strings";
import { PeerAvatar } from "../messenger/ui";
import { buildThread, formatMailDate, groupByThread, loadMailSettings, saveMailSettings, signatureBlock, type MailSettings } from "./threads";
import "../messenger/messenger.css";

type Folder = "inbox" | "sent" | "trash";
type View = "list" | "compose" | "read" | "settings";
const MAX_ATTACHMENT = 2 * 1024 * 1024;
const loaders: Record<Folder, (w: WalletWithPrivateKeys) => Promise<MailItem[]>> = { inbox: getInbox, sent: getSent, trash: getTrash };

export default function MailPage() {
  return <WalletGate product="mail">{({ wallet, identity }) => <Mail wallet={wallet} identity={identity} />}</WalletGate>;
}

function SignatureBadge({ valid, size = 14 }: { valid: boolean | null | undefined; size?: number }) {
  const [Icon, cls, label] =
    valid === true ? [CheckCircle2, "ok-icon", MAIL.sigValid] : valid === false ? [XCircle, "danger-icon", MAIL.sigInvalid] : [ShieldQuestion, "muted-icon", MAIL.sigUnknown];
  return (
    <span className={`mail-sig-icon ${cls}`} role="img" aria-label={label} title={label}>
      <Icon size={size} aria-hidden="true" />
    </span>
  );
}

function Mail({ wallet, identity }: { wallet: UnifiedWallet; identity: WalletWithPrivateKeys }) {
  const { network } = useWallet();
  const [fillRef, height] = useFillHeight<HTMLElement>();
  const [folder, setFolder] = useState<Folder>("inbox");
  const [view, setView] = useState<View>("list");
  const [items, setItems] = useState<MailItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MailItem | null>(null);
  const [thread, setThread] = useState<MailItem[]>([]);
  const [replyTo, setReplyTo] = useState<MailItem | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  const [showClaim, setShowClaim] = useState(false);
  const [settings, setSettings] = useState<MailSettings>(loadMailSettings);

  useEffect(() => {
    if (wallet.encryptionPublicKey)
      registerWalletOnNode({ id: wallet.id, displayName: wallet.displayName, signingPublicKey: wallet.signingPublicKey, encryptionPublicKey: wallet.encryptionPublicKey }).catch(() => {});
    let cancelled = false;
    getMyMailName(wallet)
      .then((n) => {
        if (!cancelled) setMyName(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Re-query when the identity or network changes.
  }, [identity.id, network]);

  const loadFolder = useCallback(async () => {
    try {
      setItems(await loaders[folder](identity));
    } finally {
      setLoading(false);
    }
  }, [folder, identity]);

  useEffect(() => {
    setLoading(true);
    setItems([]);
    void loadFolder();
    const id = window.setInterval(() => void loadFolder(), 10_000);
    return () => window.clearInterval(id);
  }, [loadFolder, network]);

  const threads = useMemo(() => groupByThread(items), [items]);
  const unread = folder === "inbox" ? threads.filter((t) => t.hasUnread).length : 0;

  const open = async (item: MailItem) => {
    setSelected(item);
    setThread([item]);
    setView("read");
    if (!item.label.isRead) markMailRead(identity, item.message.id).catch(() => {});
    try {
      const [inbox, sent] = await Promise.all([getInbox(identity), getSent(identity)]);
      const dedup = new Map<string, MailItem>();
      for (const m of [...inbox, ...sent]) dedup.set(m.message.id, m);
      setThread(buildThread([...dedup.values()], item));
    } catch {
      setThread([item]);
    }
  };
  const backToList = () => {
    setView("list");
    setSelected(null);
    setThread([]);
    setReplyTo(null);
    void loadFolder();
  };

  let body;
  if (view === "settings")
    body = (
      <SettingsView
        settings={settings}
        onBack={() => setView("list")}
        onSave={(s) => {
          saveMailSettings(s);
          setSettings(s);
          toast.success(MAIL.settingsSaved);
          setView("list");
        }}
      />
    );
  else if (view === "compose") body = <ComposeView identity={identity} myName={myName} replyTo={replyTo} settings={settings} onBack={backToList} />;
  else if (view === "read" && selected)
    body = (
      <ReadView
        item={selected}
        identity={identity}
        folder={folder}
        thread={thread}
        onBack={backToList}
        onReply={() => {
          setReplyTo(selected);
          setView("compose");
        }}
      />
    );
  else
    body = (
      <>
        <div className="mail-bar">
          <div className="msg-me">
            <Key size={15} className="accent" aria-hidden="true" />
            <span className="msg-me-text">
              <strong>{identity.displayName || wallet.displayName}</strong>
              {myName ? (
                <span className="mono mail-addr" title={`${myName}@${MAIL_DOMAIN_ALT}`}>
                  {myName}@{MAIL_DOMAIN}
                  <span className="muted"> · @{MAIL_DOMAIN_ALT}</span>
                </span>
              ) : (
                <span className="mono muted">{`${wallet.signingPublicKey.slice(0, 12)}…`}</span>
              )}
            </span>
          </div>
          <div className="msg-bar-actions">
            {!myName && (
              <button type="button" className={`button ghost icon msg-icon ${showClaim ? "active" : ""}`} aria-label={MAIL.claim} title={MAIL.claim} aria-expanded={showClaim} onClick={() => setShowClaim((v) => !v)}>
                <AtSign size={16} />
              </button>
            )}
            <button type="button" className="button ghost icon msg-icon" aria-label={MAIL.settings} title={MAIL.settings} onClick={() => setView("settings")}>
              <Settings size={16} />
            </button>
            <button type="button" className="button ghost icon msg-icon" aria-label={MAIL.refresh} title={MAIL.refresh} onClick={() => void loadFolder()}>
              <RefreshCw size={16} />
            </button>
            <button
              type="button"
              className="button small"
              onClick={() => {
                setReplyTo(null);
                setView("compose");
              }}
            >
              <Plus size={15} /> {MAIL.compose}
            </button>
          </div>
        </div>
        {showClaim && !myName && (
          <div className="mail-claim">
            <p className="msg-hint">{fmt(MAIL.claimHint, { a: MAIL_DOMAIN, b: MAIL_DOMAIN_ALT })}</p>
            <MailNameEditor
              wallet={wallet}
              allowChange={false}
              onClaimed={(n) => {
                setMyName(n);
                setShowClaim(false);
              }}
            />
          </div>
        )}
        <div className="msg-tabs mail-tabs" role="tablist">
          {(
            [
              ["inbox", MAIL.inbox, Inbox],
              ["sent", MAIL.sent, SendHorizonal],
              ["trash", MAIL.trash, Trash2],
            ] as const
          ).map(([id, label, Icon]) => (
            <button key={id} type="button" role="tab" aria-selected={folder === id} className={folder === id ? "active" : ""} onClick={() => setFolder(id)}>
              <Icon size={15} /> {label}
              {id === "inbox" && unread > 0 && <span className="msg-badge">{unread}</span>}
            </button>
          ))}
        </div>
        <div className="mail-list">
          {loading ? (
            <div className="msg-center">
              <Loader2 size={20} className="spin" aria-label={S.common.loading} />
            </div>
          ) : items.length === 0 ? (
            <div className="msg-center msg-empty">
              {folder === "trash" ? <Trash2 size={32} /> : folder === "sent" ? <SendHorizonal size={32} /> : <MailOpen size={32} />}
              <strong>{MAIL.empty[`${folder}Title`]}</strong>
              <span>
                {folder === "inbox"
                  ? myName
                    ? fmt(MAIL.empty.inboxNamed, { a: mailAddresses(myName)[0], b: mailAddresses(myName)[1] })
                    : fmt(MAIL.empty.inboxClaim, { a: MAIL_DOMAIN, b: MAIL_DOMAIN_ALT })
                  : MAIL.empty[`${folder}Hint`]}
              </span>
            </div>
          ) : (
            <ul className="msg-rows">
              {threads.map((t) => (
                <li key={t.rootId} className={`msg-row ${t.hasUnread ? "unread" : ""}`}>
                  <button type="button" className="msg-row-main with-avatar" onClick={() => void open(t.latestItem)}>
                    <PeerAvatar id={t.latestItem.message.fromWalletId} name={t.latestItem.message.senderName} size={40} />
                    <span className="msg-row-text">
                      <span className="msg-row-top">
                        <span className="msg-row-name">{t.participants.join(", ")}</span>
                        {t.messages.length > 1 && <small className="muted">({t.messages.length})</small>}
                        <span className="msg-row-time">{formatMailDate(t.latestDate)}</span>
                      </span>
                      <span className="mail-subject">{t.subject}</span>
                      <span className="msg-row-preview">{t.latestItem.message.body?.slice(0, 100) || ""}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </>
    );

  return (
    <main id="main" className="msg-app mail-app" ref={fillRef} style={height ? { height } : undefined}>
      <div className="mail-column">{body}</div>
    </main>
  );
}

function ViewHead({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="mail-view-head">
      <button type="button" className="button ghost icon msg-icon" aria-label={S.common.back} onClick={onBack}>
        <ArrowLeft size={18} />
      </button>
      {children}
    </div>
  );
}

function Attachment({ a, compact }: { a: MailAttachment; compact?: boolean }) {
  const href = `data:${a.type};base64,${a.data}`;
  return (
    <div className="mail-attachment">
      <div className="msg-split">
        <span className="mail-attachment-name">
          <Paperclip size={14} /> {a.name} <small className="muted">{(a.size / 1024).toFixed(1)} KB</small>
        </span>
        <a className="button ghost small" href={href} download={a.name}>
          <Download size={14} /> {!compact && MAIL.download}
        </a>
      </div>
      {a.type.startsWith("image/") && <img src={href} alt={a.name} />}
    </div>
  );
}

function MailBody({ message }: { message: MailMessage }) {
  const failed = message.body?.startsWith("[Unable");
  return <div className={`mail-body ${failed ? "failed" : ""}`}>{message.body}</div>;
}

function ThreadMessage({ item, isLatest, defaultExpanded }: { item: MailItem; isLatest: boolean; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const m = item.message;
  if (!expanded)
    return (
      <button type="button" className="mail-thread-collapsed" onClick={() => setExpanded(true)}>
        <PeerAvatar id={m.fromWalletId} name={m.senderName} size={32} />
        <span>
          <strong>{m.senderName || S.common.unknown}</strong> <small className="muted">{formatMailDate(m.createdAt)}</small>
          <small className="muted block">{m.body?.slice(0, 100)}</small>
        </span>
      </button>
    );
  return (
    <article className={`mail-message ${isLatest ? "latest" : ""}`}>
      <header>
        <PeerAvatar id={m.fromWalletId} name={m.senderName} size={32} />
        <span className="grow">
          <strong>{m.senderName || S.common.unknown}</strong> <SignatureBadge valid={m.signatureValid} />
          <small className="muted block">{formatMailDate(m.createdAt)}</small>
        </span>
        {!isLatest && (
          <button type="button" className="button ghost small" onClick={() => setExpanded(false)}>
            {MAIL.collapse}
          </button>
        )}
      </header>
      <MailBody message={m} />
      {m.attachmentData && <Attachment a={m.attachmentData} compact />}
    </article>
  );
}

function ReadView({
  item,
  identity,
  folder,
  thread,
  onBack,
  onReply,
}: {
  item: MailItem;
  identity: WalletWithPrivateKeys;
  folder: Folder;
  thread: MailItem[];
  onBack: () => void;
  onReply: () => void;
}) {
  const m = item.message;
  const trash = async () => {
    try {
      if (folder === "trash") {
        await deleteMail(identity, m.id);
        toast.success(MAIL.deletedForever);
      } else {
        await moveMail(identity, m.id, "trash");
        toast.success(MAIL.moved);
      }
      onBack();
    } catch {
      toast.error(MAIL.actionFailed);
    }
  };
  const restore = async () => {
    try {
      await moveMail(identity, m.id, "inbox");
      toast.success(MAIL.restored);
      onBack();
    } catch {
      toast.error(MAIL.actionFailed);
    }
  };
  const hasThread = thread.length > 1;
  const sigText = m.signatureValid === true ? MAIL.sigValid : m.signatureValid === false ? MAIL.sigInvalid : MAIL.sigUnknown;
  return (
    <div className="mail-view">
      <ViewHead onBack={onBack}>
        <span className="grow mail-view-title">
          <strong>{m.subject || MAIL.noSubject}</strong>
          {hasThread && <small className="muted block">{plural(thread.length, MAIL.thread_one, MAIL.thread_other)}</small>}
        </span>
        {folder === "trash" && (
          <button type="button" className="button ghost icon msg-icon" aria-label={MAIL.restore} title={MAIL.restore} onClick={() => void restore()}>
            <Inbox size={16} />
          </button>
        )}
        <button
          type="button"
          className="button ghost icon msg-icon"
          aria-label={folder === "trash" ? MAIL.deleteForever : MAIL.toTrash}
          title={folder === "trash" ? MAIL.deleteForever : MAIL.toTrash}
          onClick={() => void trash()}
        >
          <Trash2 size={16} />
        </button>
      </ViewHead>
      <div className="mail-scroll">
        {hasThread ? (
          thread.map((t, i) => <ThreadMessage key={t.message.id} item={t} isLatest={t.message.id === m.id} defaultExpanded={i >= thread.length - 2} />)
        ) : (
          <article className="mail-message latest">
            <header>
              <PeerAvatar id={m.fromWalletId} name={m.senderName} size={40} />
              <span className="grow">
                <strong>{m.senderName || S.common.unknown}</strong>
                <small className="muted block">{formatMailDate(m.createdAt)}</small>
              </span>
            </header>
            <h2 className="mail-subject-big">{m.subject || MAIL.noSubject}</h2>
            <MailBody message={m} />
            {m.attachmentData && <Attachment a={m.attachmentData} />}
          </article>
        )}
        <p className={`mail-sig ${m.signatureValid === true ? "ok" : m.signatureValid === false ? "bad" : ""}`}>
          <SignatureBadge valid={m.signatureValid} /> {sigText}
        </p>
        <p className="msg-hint">
          <Lock size={11} aria-hidden="true" /> {MAIL.e2e}
        </p>
      </div>
      {folder !== "trash" && (
        <div className="mail-foot">
          <button type="button" className="button outline full" onClick={onReply}>
            <Reply size={16} /> {MAIL.reply}
          </button>
        </div>
      )}
    </div>
  );
}

function ComposeView({
  identity,
  myName,
  replyTo,
  settings,
  onBack,
}: {
  identity: WalletWithPrivateKeys;
  myName: string | null;
  replyTo: MailItem | null;
  settings: MailSettings;
  onBack: () => void;
}) {
  const [to, setTo] = useState(replyTo?.message.senderName || replyTo?.message.fromWalletId || "");
  const [subject, setSubject] = useState(replyTo ? `Re: ${replyTo.message.subject || ""}` : "");
  const [body, setBody] = useState(() => signatureBlock(settings));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [attachment, setAttachment] = useState<MailAttachment | null>(null);

  useEffect(() => {
    setResolved(null);
    if (!to.trim()) return;
    setResolving(true);
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const id = await resolveRecipient(to);
        if (!cancelled) setResolved(id);
      } catch {
        if (!cancelled) setResolved(null);
      } finally {
        if (!cancelled) setResolving(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [to]);

  const send = async () => {
    if (!to.trim() || !subject.trim() || sending) return;
    setError(null);
    setSending(true);
    try {
      const recipientId = await resolveRecipient(to);
      if (!recipientId) {
        setError(fmt(MAIL.unresolved, { to, a: MAIL_DOMAIN, b: MAIL_DOMAIN_ALT }));
        return;
      }
      await sendMail(identity, [recipientId], subject, body || "(empty)", replyTo?.message.id, attachment ?? undefined);
      toast.success(MAIL.sentToast);
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : MAIL.sendFailed);
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="mail-view"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <ViewHead onBack={onBack}>
        <strong className="grow">{MAIL.compose}</strong>
        {myName && <small className="muted mono mail-from">{fmt(MAIL.from, { addr: `${myName}@${MAIL_DOMAIN}` })}</small>}
      </ViewHead>
      <div className="mail-scroll mail-form">
        <label className="field">
          {MAIL.to}
          <input className="input" value={to} placeholder={fmt(MAIL.toPlaceholder, { a: MAIL_DOMAIN, b: MAIL_DOMAIN_ALT })} onChange={(e) => setTo(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {to.trim() && (
          <p className={`msg-hint ${resolved ? "ok" : ""}`} role="status">
            {resolved ? fmt(MAIL.resolved, { id: resolved.slice(0, 20) }) : resolving ? MAIL.resolving : fmt(MAIL.unresolved, { to, a: MAIL_DOMAIN, b: MAIL_DOMAIN_ALT })}
          </p>
        )}
        <label className="field">
          {MAIL.subject}
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="field">
          {MAIL.message}
          <textarea className="input mail-textarea" rows={10} value={body} placeholder={MAIL.messagePlaceholder} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="mail-attach-row">
          <label className="button outline small">
            <Paperclip size={14} /> {MAIL.attach}
            <input
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                if (file.size > MAX_ATTACHMENT) return setError(MAIL.attachTooLarge);
                const reader = new FileReader();
                reader.onload = () => {
                  const base64 = String(reader.result).split(",")[1] ?? "";
                  setAttachment({ name: file.name, type: file.type || "application/octet-stream", data: base64, size: file.size });
                  setError(null);
                };
                reader.readAsDataURL(file);
              }}
            />
          </label>
          <small className="muted">{MAIL.attachHint}</small>
        </div>
        {attachment && (
          <div className="mail-staged">
            {attachment.type.startsWith("image/") ? <ImageIcon size={15} /> : <FileText size={15} />}
            <span className="grow">{attachment.name}</span>
            <small className="muted">{(attachment.size / 1024).toFixed(1)} KB</small>
            <button type="button" className="button ghost icon msg-icon" aria-label={MAIL.removeAttachment} onClick={() => setAttachment(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="mail-foot">
        <button type="submit" className="button full" disabled={!to.trim() || !subject.trim() || sending}>
          {sending ? <Loader2 size={16} className="spin" /> : <Send size={16} />} {sending ? MAIL.sending : MAIL.send}
        </button>
      </div>
    </form>
  );
}

function SettingsView({ settings, onBack, onSave }: { settings: MailSettings; onBack: () => void; onSave: (s: MailSettings) => void }) {
  const [sig, setSig] = useState(settings.signature);
  const [enabled, setEnabled] = useState(settings.signatureEnabled);
  return (
    <div className="mail-view">
      <ViewHead onBack={onBack}>
        <strong className="grow">{MAIL.settings}</strong>
      </ViewHead>
      <div className="mail-scroll mail-form">
        <div className="msg-split">
          <strong>{MAIL.signature}</strong>
          <Toggle checked={enabled} label={MAIL.signature} onChange={setEnabled} />
        </div>
        <p className="msg-hint">{MAIL.signatureHint}</p>
        <textarea className="input mail-textarea" rows={5} value={sig} disabled={!enabled} placeholder={MAIL.signaturePlaceholder} aria-label={MAIL.signature} onChange={(e) => setSig(e.target.value)} />
        {enabled && sig.trim() && (
          <div className="mail-sig-preview">
            <small className="muted">{MAIL.preview}</small>
            <pre>{`--\n${sig.trim()}`}</pre>
          </div>
        )}
      </div>
      <div className="mail-foot">
        <button type="button" className="button full" onClick={() => onSave({ signature: sig, signatureEnabled: enabled })}>
          {MAIL.saveSettings}
        </button>
      </div>
    </div>
  );
}
