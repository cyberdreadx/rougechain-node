/**
 * /mail — apps/web's pages/Mail.tsx on site-next: inbox / sent / trash with threads, compose,
 * reply, attachments (≤ 2 MB, encrypted), name claim (both @rouge.quant and @qwalla.mail) and the
 * ML-DSA-65 signature verdict per mail. Everything goes through core's pqc-mail / mail-name.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
import { fmtNum } from "../i18n/format";
import { Toggle } from "../wallet/parts";
import { MailNameEditor } from "../wallet/profile";
import { toast } from "../wallet/toast";
import { useWallet } from "../wallet/WalletProvider";
import { WalletGate } from "../messenger/Gate";
import { useFillHeight } from "../messenger/hooks";
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
  const { t } = useTranslation("messenger");
  const [Icon, cls, label] =
    valid === true ? [CheckCircle2, "ok-icon", t("mail.sigValid")] : valid === false ? [XCircle, "danger-icon", t("mail.sigInvalid")] : [ShieldQuestion, "muted-icon", t("mail.sigUnknown")];
  return (
    <span className={`mail-sig-icon ${cls}`} role="img" aria-label={label} title={label}>
      <Icon size={size} aria-hidden="true" />
    </span>
  );
}

function Mail({ wallet, identity }: { wallet: UnifiedWallet; identity: WalletWithPrivateKeys }) {
  const { t } = useTranslation("messenger");
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
  const unread = folder === "inbox" ? threads.filter((th) => th.hasUnread).length : 0;

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
          toast.success(t("mail.settingsSaved"));
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
              <button type="button" className={`button ghost icon msg-icon ${showClaim ? "active" : ""}`} aria-label={t("mail.claim")} title={t("mail.claim")} aria-expanded={showClaim} onClick={() => setShowClaim((v) => !v)}>
                <AtSign size={16} />
              </button>
            )}
            <button type="button" className="button ghost icon msg-icon" aria-label={t("mail.settings")} title={t("mail.settings")} onClick={() => setView("settings")}>
              <Settings size={16} />
            </button>
            <button type="button" className="button ghost icon msg-icon" aria-label={t("mail.refresh")} title={t("mail.refresh")} onClick={() => void loadFolder()}>
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
              <Plus size={15} /> {t("mail.compose")}
            </button>
          </div>
        </div>
        {showClaim && !myName && (
          <div className="mail-claim">
            <p className="msg-hint">{t("mail.claimHint", { a: MAIL_DOMAIN, b: MAIL_DOMAIN_ALT })}</p>
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
              ["inbox", t("mail.inbox"), Inbox],
              ["sent", t("mail.sent"), SendHorizonal],
              ["trash", t("mail.trash"), Trash2],
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
              <Loader2 size={20} className="spin" aria-label={t("common.loading")} />
            </div>
          ) : items.length === 0 ? (
            <div className="msg-center msg-empty">
              {folder === "trash" ? <Trash2 size={32} /> : folder === "sent" ? <SendHorizonal size={32} /> : <MailOpen size={32} />}
              <strong>{t(`mail.empty.${folder}Title`)}</strong>
              <span>
                {folder === "inbox"
                  ? myName
                    ? t("mail.empty.inboxNamed", { a: mailAddresses(myName)[0], b: mailAddresses(myName)[1] })
                    : t("mail.empty.inboxClaim", { a: MAIL_DOMAIN, b: MAIL_DOMAIN_ALT })
                  : t(`mail.empty.${folder}Hint`)}
              </span>
            </div>
          ) : (
            <ul className="msg-rows">
              {threads.map((th) => (
                <li key={th.rootId} className={`msg-row ${th.hasUnread ? "unread" : ""}`}>
                  <button type="button" className="msg-row-main with-avatar" onClick={() => void open(th.latestItem)}>
                    <PeerAvatar id={th.latestItem.message.fromWalletId} name={th.latestItem.message.senderName} size={40} />
                    <span className="msg-row-text">
                      <span className="msg-row-top">
                        <span className="msg-row-name">{th.participants.join(", ")}</span>
                        {th.messages.length > 1 && <small className="muted">({th.messages.length})</small>}
                        <span className="msg-row-time">{formatMailDate(th.latestDate)}</span>
                      </span>
                      <span className="mail-subject">{th.subject}</span>
                      <span className="msg-row-preview">{th.latestItem.message.body?.slice(0, 100) || ""}</span>
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
  const { t } = useTranslation("messenger");
  return (
    <div className="mail-view-head">
      <button type="button" className="button ghost icon msg-icon" aria-label={t("common.back")} onClick={onBack}>
        <ArrowLeft size={18} />
      </button>
      {children}
    </div>
  );
}

function Attachment({ a, compact }: { a: MailAttachment; compact?: boolean }) {
  const { t } = useTranslation("messenger");
  const href = `data:${a.type};base64,${a.data}`;
  return (
    <div className="mail-attachment">
      <div className="msg-split">
        <span className="mail-attachment-name">
          <Paperclip size={14} /> {a.name} <small className="muted">{fmtNum(a.size / 1024, 1, { minimumFractionDigits: 1 })} KB</small>
        </span>
        <a className="button ghost small" href={href} download={a.name}>
          <Download size={14} /> {!compact && t("mail.download")}
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
  const { t } = useTranslation("messenger");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const m = item.message;
  if (!expanded)
    return (
      <button type="button" className="mail-thread-collapsed" onClick={() => setExpanded(true)}>
        <PeerAvatar id={m.fromWalletId} name={m.senderName} size={32} />
        <span>
          <strong>{m.senderName || t("common.unknown")}</strong> <small className="muted">{formatMailDate(m.createdAt)}</small>
          <small className="muted block">{m.body?.slice(0, 100)}</small>
        </span>
      </button>
    );
  return (
    <article className={`mail-message ${isLatest ? "latest" : ""}`}>
      <header>
        <PeerAvatar id={m.fromWalletId} name={m.senderName} size={32} />
        <span className="grow">
          <strong>{m.senderName || t("common.unknown")}</strong> <SignatureBadge valid={m.signatureValid} />
          <small className="muted block">{formatMailDate(m.createdAt)}</small>
        </span>
        {!isLatest && (
          <button type="button" className="button ghost small" onClick={() => setExpanded(false)}>
            {t("mail.collapse")}
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
  const { t } = useTranslation("messenger");
  const m = item.message;
  const trash = async () => {
    try {
      if (folder === "trash") {
        await deleteMail(identity, m.id);
        toast.success(t("mail.deletedForever"));
      } else {
        await moveMail(identity, m.id, "trash");
        toast.success(t("mail.moved"));
      }
      onBack();
    } catch {
      toast.error(t("mail.actionFailed"));
    }
  };
  const restore = async () => {
    try {
      await moveMail(identity, m.id, "inbox");
      toast.success(t("mail.restored"));
      onBack();
    } catch {
      toast.error(t("mail.actionFailed"));
    }
  };
  const hasThread = thread.length > 1;
  const sigText = m.signatureValid === true ? t("mail.sigValid") : m.signatureValid === false ? t("mail.sigInvalid") : t("mail.sigUnknown");
  return (
    <div className="mail-view">
      <ViewHead onBack={onBack}>
        <span className="grow mail-view-title">
          <strong>{m.subject || t("mail.noSubject")}</strong>
          {hasThread && <small className="muted block">{t("mail.thread", { count: thread.length })}</small>}
        </span>
        {folder === "trash" && (
          <button type="button" className="button ghost icon msg-icon" aria-label={t("mail.restore")} title={t("mail.restore")} onClick={() => void restore()}>
            <Inbox size={16} />
          </button>
        )}
        <button
          type="button"
          className="button ghost icon msg-icon"
          aria-label={folder === "trash" ? t("mail.deleteForever") : t("mail.toTrash")}
          title={folder === "trash" ? t("mail.deleteForever") : t("mail.toTrash")}
          onClick={() => void trash()}
        >
          <Trash2 size={16} />
        </button>
      </ViewHead>
      <div className="mail-scroll">
        {hasThread ? (
          thread.map((it, i) => <ThreadMessage key={it.message.id} item={it} isLatest={it.message.id === m.id} defaultExpanded={i >= thread.length - 2} />)
        ) : (
          <article className="mail-message latest">
            <header>
              <PeerAvatar id={m.fromWalletId} name={m.senderName} size={40} />
              <span className="grow">
                <strong>{m.senderName || t("common.unknown")}</strong>
                <small className="muted block">{formatMailDate(m.createdAt)}</small>
              </span>
            </header>
            <h2 className="mail-subject-big">{m.subject || t("mail.noSubject")}</h2>
            <MailBody message={m} />
            {m.attachmentData && <Attachment a={m.attachmentData} />}
          </article>
        )}
        <p className={`mail-sig ${m.signatureValid === true ? "ok" : m.signatureValid === false ? "bad" : ""}`}>
          <SignatureBadge valid={m.signatureValid} /> {sigText}
        </p>
        <p className="msg-hint">
          <Lock size={11} aria-hidden="true" /> {t("mail.e2e")}
        </p>
      </div>
      {folder !== "trash" && (
        <div className="mail-foot">
          <button type="button" className="button outline full" onClick={onReply}>
            <Reply size={16} /> {t("mail.reply")}
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
  const { t } = useTranslation("messenger");
  // A reply goes to the wallet that sent the mail. The To field shows the sender's label (their
  // mail name, or a display name / shortened id when they have none); that label is only looked
  // up as an address if the user edits it — a display name is not an address and could otherwise
  // resolve to whoever registered it as a mail name.
  const replyLabel = replyTo?.message.senderName || replyTo?.message.fromWalletId || "";
  const replyWalletId = replyTo?.message.fromWalletId || null;
  const resolveTo = useCallback(
    (input: string) => (replyWalletId && input.trim() === replyLabel.trim() ? Promise.resolve<string | null>(replyWalletId) : resolveRecipient(input)),
    [replyLabel, replyWalletId],
  );
  const [to, setTo] = useState(replyLabel);
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
    const timer = window.setTimeout(async () => {
      try {
        const id = await resolveTo(to);
        if (!cancelled) setResolved(id);
      } catch {
        if (!cancelled) setResolved(null);
      } finally {
        if (!cancelled) setResolving(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [to, resolveTo]);

  const send = async () => {
    if (!to.trim() || !subject.trim() || sending) return;
    setError(null);
    setSending(true);
    try {
      const recipientId = await resolveTo(to);
      if (!recipientId) {
        setError(t("mail.unresolved", { to, a: MAIL_DOMAIN, b: MAIL_DOMAIN_ALT }));
        return;
      }
      await sendMail(identity, [recipientId], subject, body || "(empty)", replyTo?.message.id, attachment ?? undefined);
      toast.success(t("mail.sentToast"));
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("mail.sendFailed"));
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
        <strong className="grow">{t("mail.compose")}</strong>
        {myName && <small className="muted mono mail-from">{t("mail.from", { addr: `${myName}@${MAIL_DOMAIN}` })}</small>}
      </ViewHead>
      <div className="mail-scroll mail-form">
        <label className="field">
          {t("mail.to")}
          <input className="input" value={to} placeholder={t("mail.toPlaceholder", { a: MAIL_DOMAIN, b: MAIL_DOMAIN_ALT })} onChange={(e) => setTo(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {to.trim() && (
          <p className={`msg-hint ${resolved ? "ok" : ""}`} role="status">
            {resolved ? t("mail.resolved", { id: resolved.slice(0, 20) }) : resolving ? t("mail.resolving") : t("mail.unresolved", { to, a: MAIL_DOMAIN, b: MAIL_DOMAIN_ALT })}
          </p>
        )}
        <label className="field">
          {t("mail.subject")}
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="field">
          {t("mail.message")}
          <textarea className="input mail-textarea" rows={10} value={body} placeholder={t("mail.messagePlaceholder")} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="mail-attach-row">
          <label className="button outline small">
            <Paperclip size={14} /> {t("mail.attach")}
            <input
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                if (file.size > MAX_ATTACHMENT) return setError(t("mail.attachTooLarge"));
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
          <small className="muted">{t("mail.attachHint")}</small>
        </div>
        {attachment && (
          <div className="mail-staged">
            {attachment.type.startsWith("image/") ? <ImageIcon size={15} /> : <FileText size={15} />}
            <span className="grow">{attachment.name}</span>
            <small className="muted">{fmtNum(attachment.size / 1024, 1, { minimumFractionDigits: 1 })} KB</small>
            <button type="button" className="button ghost icon msg-icon" aria-label={t("mail.removeAttachment")} onClick={() => setAttachment(null)}>
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
          {sending ? <Loader2 size={16} className="spin" /> : <Send size={16} />} {sending ? t("mail.sending") : t("mail.send")}
        </button>
      </div>
    </form>
  );
}

function SettingsView({ settings, onBack, onSave }: { settings: MailSettings; onBack: () => void; onSave: (s: MailSettings) => void }) {
  const { t } = useTranslation("messenger");
  const [sig, setSig] = useState(settings.signature);
  const [enabled, setEnabled] = useState(settings.signatureEnabled);
  return (
    <div className="mail-view">
      <ViewHead onBack={onBack}>
        <strong className="grow">{t("mail.settings")}</strong>
      </ViewHead>
      <div className="mail-scroll mail-form">
        <div className="msg-split">
          <strong>{t("mail.signature")}</strong>
          <Toggle checked={enabled} label={t("mail.signature")} onChange={setEnabled} />
        </div>
        <p className="msg-hint">{t("mail.signatureHint")}</p>
        <textarea className="input mail-textarea" rows={5} value={sig} disabled={!enabled} placeholder={t("mail.signaturePlaceholder")} aria-label={t("mail.signature")} onChange={(e) => setSig(e.target.value)} />
        {enabled && sig.trim() && (
          <div className="mail-sig-preview">
            <small className="muted">{t("mail.preview")}</small>
            <pre>{`--\n${sig.trim()}`}</pre>
          </div>
        )}
      </div>
      <div className="mail-foot">
        <button type="button" className="button full" onClick={() => onSave({ signature: sig, signatureEnabled: enabled })}>
          {t("mail.saveSettings")}
        </button>
      </div>
    </div>
  );
}
