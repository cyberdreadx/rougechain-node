/**
 * One conversation (apps/web components/messenger/ChatView): load + decrypt through core's
 * getMessages, send through core's sendMessage (1:1 ML-KEM package, or Qwalla's v2 wrapped-CEK
 * package for groups), read receipts while visible, reactions / replies / payments as Qwalla
 * envelopes, media, GIFs, spoilers, self-destruct, search, block / mute and group info.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ArrowLeft,
  Ban,
  Bell,
  BellOff,
  Bot,
  Check,
  CheckCheck,
  CheckCircle2,
  Copy,
  DollarSign,
  EyeOff,
  FileKey2,
  Info,
  Loader2,
  Lock,
  MoreVertical,
  Paperclip,
  Pencil,
  Reply,
  Search,
  Send,
  Shield,
  SmilePlus,
  Timer,
  Trash2,
  Users,
  Video,
  X,
  XCircle,
} from "lucide-react";
import { applyEnvelopes, buildMsgEnvelope, parseTip } from "@rougechain/core/messenger-envelope";
import { classifyBody, gifsEnabled } from "@rougechain/core/messenger-content";
import {
  acceptChat,
  blockWalletKeys,
  filterBlockedMessages,
  isAnyBlocked,
  isGroupConversation,
  lastSeenOwnMessageId,
  otherMembers,
  receiptStatus,
  setConversationMuted,
  unblockWalletKeys,
  walletKeys,
  type ReceiptStatus,
} from "@rougechain/core/messenger-prefs";
import {
  checkTofu,
  deleteMessage,
  fileToMediaPayload,
  getBotReply,
  getMessages,
  getWallets,
  isDemoBot,
  keyFingerprint,
  loadDemoBotWallet,
  markMessagesRead,
  MAX_MEDIA_SIZE,
  registerWalletOnNode,
  sendMessage,
  type Conversation,
  type Message,
  type MessageType,
  type Wallet,
  type WalletWithPrivateKeys,
} from "@rougechain/core/pqc-messenger";
import { isV2Package } from "@rougechain/core/messenger-crypto-v2";
import { loadNotificationSettings, playNotificationSound } from "@rougechain/core/notifications";
import { useRougeAddress } from "../wallet/hooks";
import { toast } from "../wallet/toast";
import { Toggle } from "../wallet/parts";
import {
  aggregateReactions,
  encodePaymentMessage,
  encodeReactionMessage,
  encodeReplyMessage,
  encodeRequestMessage,
  formatMessageTime,
  getPaymentData,
  getRequestData,
  isSystemMessage,
  parseReplyMessage,
  previewText,
  readableText,
  REACTION_EMOJIS,
  type PaymentMessageData,
  type ReactionSummary,
  type RequestMessageData,
} from "./codec";
import { ChatPayment, PaymentBubble, PaymentRequestBubble, TipBubble } from "./ChatPayment";
import { useMessengerPrefs, useNicknames } from "./hooks";
import { conversationTitle, isBotConversation, isSelfChat } from "./model";
import { GifPicker, RichBody } from "./RichBody";
import { GroupInfoSheet } from "./Sheets";
import { S, fmt, plural } from "./strings";
import { subscribeNewMessage, isMessengerLive } from "./ws";
import { PeerAvatar, Sheet, StackedAvatars } from "./ui";

const DESTRUCT_SECONDS = 30;

export interface ChatViewProps {
  conversation: Conversation;
  identity: WalletWithPrivateKeys;
  contacts: Wallet[];
  isRequest: boolean;
  onBack(): void;
  onBlocked(): void;
  onConversationChanged(): void;
  onAccepted(): void;
}

/** Keep locally known media when a refetch can't re-open it (apps/web merge rule). */
export function mergeMessages(prev: Message[], next: Message[]): Message[] {
  if (prev.length === 0) return next;
  const old = new Map(prev.map((m) => [m.id, m]));
  return next.map((m) => {
    const o = old.get(m.id);
    return o?.mediaUrl && !m.mediaUrl ? { ...m, mediaUrl: o.mediaUrl, mediaFileName: o.mediaFileName, messageType: o.messageType, plaintext: o.plaintext } : m;
  });
}

export function ChatView({ conversation, identity, contacts, isRequest, onBack, onBlocked, onConversationChanged, onAccepted }: ChatViewProps) {
  const prefs = useMessengerPrefs();
  const { nicknameFor, setNickname } = useNicknames();
  const myIds = useMemo(() => new Set([identity.id, identity.signingPublicKey, identity.encryptionPublicKey].filter(Boolean)), [identity]);
  const members = useMemo(() => otherMembers(conversation, myIds), [conversation, myIds]);
  const isGroup = isGroupConversation(conversation, myIds);
  const muted = prefs.muted.has(conversation.id);
  const hasBot = isBotConversation(conversation);
  const isSelf = isSelfChat(conversation, myIds);

  const recipient: Wallet | undefined = isSelf
    ? { id: identity.id, displayName: identity.displayName, signingPublicKey: identity.signingPublicKey, encryptionPublicKey: identity.encryptionPublicKey }
    : conversation.participants?.find((p) => !myIds.has(p.id) && !myIds.has(p.signingPublicKey) && !myIds.has(p.encryptionPublicKey));
  const isRecipientBot = !!recipient && !isSelf && (isDemoBot(recipient.id) || (hasBot && !!recipient.id?.startsWith("bot-")));
  const recipientKeys = recipient ? walletKeys(recipient) : [];
  const blocked = !isGroup && recipientKeys.length > 0 && isAnyBlocked(recipientKeys, prefs.blocked);
  const title = conversationTitle(conversation, myIds, { myName: identity.displayName, nickname: (p) => nicknameFor(p.signingPublicKey, p.id) }) || recipient?.displayName || S.common.unknown;
  const recipientMainId = recipient?.id || recipient?.signingPublicKey || "";
  const { display: recipientAddr } = useRougeAddress(recipient?.signingPublicKey || recipientMainId || null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ label: string; media: boolean } | null>(null);
  const [selfDestruct, setSelfDestruct] = useState(false);
  const [spoiler, setSpoiler] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [staged, setStaged] = useState<{ file: File; previewUrl: string } | null>(null);
  const [details, setDetails] = useState<Message | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [pay, setPay] = useState<{ initial?: { token: string; amount: number; memo?: string } } | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [reactingTo, setReactingTo] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tofuChanged, setTofuChanged] = useState(false);
  const [fingerprint, setFingerprint] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const markedRef = useRef<Set<string>>(new Set());
  const prevCount = useRef(0);
  const live = useRef({ isRequest, muted, blocked: prefs.blocked });
  useEffect(() => {
    live.current = { isRequest, muted, blocked: prefs.blocked };
  });

  // TOFU key-change warning + fingerprint (1:1 only).
  const recipientSigning = recipient?.signingPublicKey;
  useEffect(() => {
    setTofuChanged(false);
    setFingerprint("");
    if (!recipient || !recipientSigning || isRecipientBot || isSelf || isGroup) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await checkTofu(recipient);
        const fp = await keyFingerprint(recipientSigning);
        if (!cancelled) {
          setTofuChanged(t.changed);
          setFingerprint(fp);
        }
      } catch {
        /* storage / crypto unavailable */
      }
    })();
    return () => {
      cancelled = true;
    };
    // recipient identity is captured by its signing key.
  }, [recipientSigning, recipient?.id, isRecipientBot, isSelf, isGroup]);

  const participantsRef = useRef(conversation.participants ?? []);
  useEffect(() => {
    participantsRef.current = conversation.participants ?? [];
  }, [conversation.participants]);

  const load = useCallback(
    async (initial = false) => {
      try {
        const msgs = await getMessages(conversation.id, identity, participantsRef.current, (unread) => {
          // Read receipts: only for accepted chats and while the page is visible.
          if (live.current.isRequest || document.visibilityState !== "visible") return;
          const fresh = unread.filter((id) => !markedRef.current.has(id));
          if (fresh.length === 0) return;
          fresh.forEach((id) => markedRef.current.add(id));
          void markMessagesRead(identity, conversation.id, fresh);
        });
        if (!initial && msgs.length > 0) {
          const fresh = msgs.filter((m) => !seenRef.current.has(m.id) && !myIds.has(m.senderWalletId));
          if (fresh.length > 0) {
            setNewIds((prev) => new Set([...prev, ...fresh.map((m) => m.id)]));
            const n = loadNotificationSettings();
            const fromBlocked = fresh.some((m) =>
              isAnyBlocked([m.senderWalletId, ...(m.senderSigningPublicKey ? [m.senderSigningPublicKey] : [])], live.current.blocked),
            );
            if (n.enabled && n.sound && !live.current.muted && !fromBlocked) playNotificationSound();
          }
        }
        msgs.forEach((m) => seenRef.current.add(m.id));
        setMessages((prev) => mergeMessages(prev, msgs));
        setLoadError(false);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    },
    [conversation.id, identity, myIds],
  );

  // Initial load, real-time refresh on this chat's new_message, and a poll: every 3 s while the
  // private socket isn't live, every 15 s as a safety net otherwise (apps/web cadence).
  useEffect(() => {
    seenRef.current = new Set();
    markedRef.current = new Set();
    prevCount.current = 0;
    setMessages([]);
    setNewIds(new Set());
    setLoading(true);
    setReplyingTo(null);
    setActiveId(null);
    void load(true);
    const unsubscribe = subscribeNewMessage((ev) => {
      if (ev.conversation_id === conversation.id) void load(false);
    });
    let ticks = 0;
    const id = window.setInterval(() => {
      ticks++;
      if (!isMessengerLive() || ticks % 5 === 0) void load(false);
    }, 3000);
    // Coming back to the tab: mark what arrived meanwhile as read.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [conversation.id, load]);

  useEffect(() => {
    if (messages.length > prevCount.current) endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
    prevCount.current = messages.length;
  }, [messages.length]);

  const senderKeys = useCallback(
    (senderId: string): string[] => {
      const m = members.find((p) => walletKeys(p).includes(senderId));
      return m ? walletKeys(m) : [];
    },
    [members],
  );
  const unblocked = useMemo(
    () =>
      filterBlockedMessages(messages, prefs.blocked, myIds, (id) => {
        const msg = messages.find((m) => m.senderWalletId === id);
        return [...senderKeys(id), ...(msg?.senderSigningPublicKey ? [msg.senderSigningPublicKey] : [])];
      }),
    [messages, prefs.blocked, myIds, senderKeys],
  );
  const reactionMap = useMemo(() => aggregateReactions(unblocked, myIds), [unblocked, myIds]);
  const byId = useMemo(() => new Map(unblocked.map((m) => [m.id, m])), [unblocked]);
  const visible = useMemo(
    () => unblocked.filter((m) => !isSystemMessage(m.plaintext)).filter((m) => !query || m.plaintext?.toLowerCase().includes(query.toLowerCase())),
    [unblocked, query],
  );
  const isOwn = useCallback((m: Message) => myIds.has(m.senderWalletId), [myIds]);
  const lastSeenId = useMemo(() => lastSeenOwnMessageId(visible, isOwn), [visible, isOwn]);

  // ── sending ──────────────────────────────────────────────────────────

  const sending = pending !== null;
  const send = async (plaintext: string, messageType: MessageType = "text", label = readableText(plaintext)) => {
    if (!recipient || sending) return;
    setPending({ label, media: messageType !== "text" });
    try {
      let keys: string[] | string | null = null;
      if (isGroup) {
        let list = members.map((m) => m.encryptionPublicKey).filter((k): k is string => !!k);
        if (list.length < members.length) {
          try {
            const dir = await getWallets();
            list = members
              .map((m) => m.encryptionPublicKey || dir.find((w) => walletKeys(m).some((k) => walletKeys(w).includes(k)))?.encryptionPublicKey)
              .filter((k): k is string => !!k);
          } catch {
            /* keep what we have */
          }
        }
        list = [...new Set(list)];
        if (list.length === 0) {
          toast.error(S.group.noKeys);
          return;
        }
        if (list.length < members.length)
          toast.info(plural(members.length - list.length, S.group.someKeysMissing_one, S.group.someKeysMissing_other));
        keys = list;
      } else {
        let key: string | undefined = recipient.encryptionPublicKey;
        if (!key) {
          try {
            const dir = await getWallets();
            key = dir.find(
              (w) => w.id === recipient.id || w.signingPublicKey === recipient.signingPublicKey || (!!recipient.encryptionPublicKey && w.encryptionPublicKey === recipient.encryptionPublicKey),
            )?.encryptionPublicKey;
          } catch {
            /* handled below */
          }
        }
        if (!key) {
          toast.error(S.chat.noKey);
          return;
        }
        keys = key;
      }
      const msg = await sendMessage(
        conversation.id,
        plaintext,
        identity,
        keys,
        selfDestruct,
        selfDestruct ? DESTRUCT_SECONDS : undefined,
        messageType,
        spoiler,
      );
      seenRef.current.add(msg.id);
      setMessages((prev) => applyEnvelopes([...prev, msg]));
      if (isRecipientBot) void botReply(plaintext);
    } catch (e) {
      toast.error(S.chat.sendFailed, { description: e instanceof Error ? e.message : undefined });
    } finally {
      setPending(null);
    }
  };

  const botReply = async (userText: string) => {
    const bot = loadDemoBotWallet();
    if (!bot) return;
    await new Promise((r) => window.setTimeout(r, 800));
    try {
      await registerWalletOnNode(bot, false);
      const reply = await getBotReply(readableText(userText));
      const msg = await sendMessage(conversation.id, reply, bot, identity.encryptionPublicKey, false);
      setNewIds((prev) => new Set([...prev, msg.id]));
      seenRef.current.add(msg.id);
      setMessages((prev) => applyEnvelopes([...prev, { ...msg, senderDisplayName: bot.displayName }]));
    } catch {
      toast.error(S.chat.botFailed);
    }
  };

  const onSubmit = async () => {
    if (sending) return;
    if (staged) {
      try {
        const { payload, messageType } = await fileToMediaPayload(staged.file);
        const name = staged.file.name;
        clearStaged();
        await send(payload, messageType, name);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : S.chat.mediaFailed);
      }
      return;
    }
    const body = text.trim();
    if (!body) return;
    setText("");
    if (replyingTo) {
      const target = replyingTo;
      setReplyingTo(null);
      await send(encodeReplyMessage({ replyTo: target.id, text: body }), "text", body);
    } else {
      await send(body);
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_MEDIA_SIZE) return void toast.error(fmt(S.chat.tooLarge, { mb: MAX_MEDIA_SIZE / (1024 * 1024) }));
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) return void toast.error(S.chat.onlyMedia);
    setStaged({ file, previewUrl: URL.createObjectURL(file) });
  };
  const clearStaged = () => {
    if (staged) URL.revokeObjectURL(staged.previewUrl);
    setStaged(null);
  };

  const react = (messageId: string, emoji: string) => {
    setReactingTo(null);
    setActiveId(null);
    void send(encodeReactionMessage({ type: "reaction", messageId, emoji }), "text", emoji);
  };
  const onPaymentSent = (data: PaymentMessageData) => void send(encodePaymentMessage(data));
  const onRequest = (data: RequestMessageData) => void send(encodeRequestMessage(data));
  // GIFs go out exactly as Qwalla's sendGif: the GIPHY URL as the body of a msg envelope.
  const onGif = (url: string) => {
    setShowGifs(false);
    void send(buildMsgEnvelope(url), "text", "GIF");
  };

  // ── menu actions ─────────────────────────────────────────────────────

  const toggleBlock = () => {
    if (recipientKeys.length === 0) return;
    const who = recipient?.displayName || S.common.anonymous;
    setMenuOpen(false);
    if (blocked) {
      unblockWalletKeys(recipientKeys);
      toast.success(fmt(S.block.unblocked, { name: who }));
    } else {
      if (!window.confirm(fmt(S.block.confirm, { name: who }))) return;
      blockWalletKeys(recipientKeys);
      toast.success(fmt(S.block.blocked, { name: who }));
      onBlocked();
    }
  };
  const toggleMute = () => {
    setMenuOpen(false);
    setConversationMuted(conversation.id, !muted);
    toast.success(muted ? S.mute.unmuted : S.mute.muted);
  };
  const editNickname = () => {
    setMenuOpen(false);
    if (!recipient) return;
    const key = recipient.signingPublicKey || recipient.id;
    const next = window.prompt(fmt(S.chat.nicknamePrompt, { name: recipient.displayName || S.common.anonymous }), nicknameFor(key) ?? "");
    if (next === null) return;
    setNickname(key, next);
    toast.success(S.chat.nicknameSaved);
  };
  const accept = () => {
    acceptChat(conversation.id);
    live.current = { ...live.current, isRequest: false };
    onAccepted();
    void load(false); // now allowed to send read receipts
  };

  const removeMessage = async (m: Message) => {
    if (!window.confirm(S.chat.deleteConfirm)) return;
    try {
      await deleteMessage(identity, m.id, conversation.id);
      setMessages((prev) => prev.filter((x) => x.id !== m.id));
      setDetails(null);
      toast.success(S.chat.deleted);
    } catch {
      toast.error(S.chat.deleteFailed);
    }
  };

  const canPay = !isSelf && !isRecipientBot && !isGroup && !!recipient;
  const composerDisabled = sending || blocked;
  const placeholder = replyingTo ? S.chat.replyPlaceholder : staged ? S.chat.captionPlaceholder : S.chat.placeholder;

  return (
    <section className="msg-chat" aria-label={title}>
      <header className="msg-chat-head">
        <button type="button" className="button ghost icon msg-icon msg-back" aria-label={S.common.back} onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        {isGroup ? (
          <button type="button" className="msg-plain" aria-label={S.group.info} onClick={() => setShowGroupInfo(true)}>
            <StackedAvatars members={members} size={38} />
          </button>
        ) : isRecipientBot || !recipient ? (
          <span className={`msg-glyph ${isRecipientBot ? "bot" : ""}`}>{isRecipientBot ? <Bot size={18} /> : <Shield size={18} />}</span>
        ) : (
          <PeerAvatar id={recipient.id || recipient.signingPublicKey} uri={recipient.avatarUrl} name={title} size={38} />
        )}
        <div className="msg-chat-title">
          <div className="msg-chat-name">
            {isGroup ? (
              <button type="button" className="msg-plain" onClick={() => setShowGroupInfo(true)}>
                {title}
              </button>
            ) : (
              <strong>{title}</strong>
            )}
            {muted && <BellOff size={13} className="warn-icon" aria-label={S.mute.muted} />}
            {isRecipientBot && <span className="pill">{S.chat.ai}</span>}
            {!isGroup && tofuChanged && !isRecipientBot && (
              <span className="pill danger" title={S.chat.keyChangedHint}>
                {S.chat.keyChanged}
              </span>
            )}
            {!isGroup && fingerprint && !tofuChanged && !isRecipientBot && (
              <span className="pill ok mono msg-fp" title={fmt(S.chat.fingerprint, { fp: fingerprint })}>
                {fingerprint.slice(0, 9)}
              </span>
            )}
            {blocked && <span className="pill danger">{S.block.blockedBadge}</span>}
          </div>
          {isGroup ? (
            <button type="button" className="msg-plain msg-chat-sub" onClick={() => setShowGroupInfo(true)}>
              {plural(members.length + 1, S.group.memberCount_one, S.group.memberCount_other)}
            </button>
          ) : recipient && !isRecipientBot ? (
            <button
              type="button"
              className="msg-plain msg-chat-sub mono"
              title={S.header.copyAddress}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(recipient.signingPublicKey || recipient.encryptionPublicKey || "");
                  toast.success(S.chat.recipientCopied);
                } catch {
                  /* clipboard unavailable */
                }
              }}
            >
              {recipientAddr || `${(recipient.signingPublicKey || "").slice(0, 16)}…`} <Copy size={11} />
            </button>
          ) : null}
          <span className="msg-chat-sub">
            <Lock size={11} aria-hidden="true" /> {S.chat.cryptoLabel}
          </span>
        </div>
        <div className="msg-menu-wrap">
          <button type="button" className="button ghost icon msg-icon" aria-label={S.menu.title} aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            <MoreVertical size={18} />
          </button>
          {menuOpen && (
            <>
              <div className="msg-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <ul className="msg-menu" role="menu">
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowSearch(true);
                      setMenuOpen(false);
                    }}
                  >
                    <Search size={15} /> {S.menu.search}
                  </button>
                </li>
                <li>
                  <button type="button" role="menuitem" onClick={toggleMute}>
                    {muted ? <Bell size={15} /> : <BellOff size={15} />} {muted ? S.mute.unmute : S.mute.mute}
                  </button>
                </li>
                {isGroup && (
                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowGroupInfo(true);
                        setMenuOpen(false);
                      }}
                    >
                      <Users size={15} /> {S.group.info}
                    </button>
                  </li>
                )}
                {!isGroup && recipient && !isRecipientBot && !isSelf && (
                  <>
                    <li>
                      <button type="button" role="menuitem" onClick={editNickname}>
                        <Pencil size={15} /> {S.chat.nickname}
                      </button>
                    </li>
                    <li>
                      <button type="button" role="menuitem" className={blocked ? "" : "danger"} onClick={toggleBlock}>
                        <Ban size={15} /> {blocked ? S.block.unblock : S.block.block}
                      </button>
                    </li>
                  </>
                )}
              </ul>
            </>
          )}
        </div>
      </header>

      {isRequest && (
        <div className="msg-banner">
          <p>{fmt(S.requests.banner, { name: title || S.common.anonymous })}</p>
          <button type="button" className="button ghost small danger" onClick={toggleBlock}>
            {S.block.block}
          </button>
          <button type="button" className="button small" onClick={accept}>
            {S.requests.accept}
          </button>
        </div>
      )}

      {showSearch && (
        <div className="msg-searchbar">
          <Search size={15} aria-hidden="true" />
          <input className="input" value={query} autoFocus placeholder={S.chat.searchPlaceholder} aria-label={S.menu.search} onChange={(e) => setQuery(e.target.value)} />
          {query && <span className="msg-hint">{plural(visible.length, S.chat.results_one, S.chat.results_other)}</span>}
          <button
            type="button"
            className="button ghost icon msg-icon"
            aria-label={S.common.close}
            onClick={() => {
              setShowSearch(false);
              setQuery("");
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}

      <div className="msg-scroll" onClick={() => setActiveId(null)}>
        {loading ? (
          <div className="msg-center">
            <Loader2 size={20} className="spin" aria-label={S.common.loading} />
          </div>
        ) : visible.length === 0 && !pending ? (
          <div className="msg-center msg-empty">
            <Lock size={32} aria-hidden="true" />
            <strong>{query ? S.chat.noMatchTitle : S.chat.startTitle}</strong>
            <span>{query ? S.chat.noMatchHint : S.chat.startHint}</span>
            {loadError && (
              <button type="button" className="button outline small" onClick={() => void load(false)}>
                {S.common.retry}
              </button>
            )}
          </div>
        ) : (
          <ol className="msg-thread">
            {visible.map((m) => {
              const own = isOwn(m);
              return (
                <Bubble
                  key={m.id}
                  message={m}
                  own={own}
                  group={isGroup}
                  active={activeId === m.id}
                  isNew={newIds.has(m.id) && !own}
                  onAnimated={() =>
                    setNewIds((prev) => {
                      const n = new Set(prev);
                      n.delete(m.id);
                      return n;
                    })
                  }
                  onToggle={() => {
                    setActiveId((cur) => (cur === m.id ? null : m.id));
                    setReactingTo(null);
                  }}
                  reactions={reactionMap.get(m.id)}
                  reacting={reactingTo === m.id}
                  onReactPicker={() => setReactingTo((cur) => (cur === m.id ? null : m.id))}
                  onReact={(emoji) => react(m.id, emoji)}
                  onReply={() => {
                    setReplyingTo(m);
                    setActiveId(null);
                  }}
                  onDetails={() => setDetails(m)}
                  quotedPreview={m.replyTo ? previewText(byId.get(m.replyTo)) : undefined}
                  onPayRequest={
                    !own && canPay && getRequestData(m)
                      ? () => {
                          const r = getRequestData(m)!;
                          setPay({ initial: { token: r.token, amount: r.amount, memo: r.memo } });
                        }
                      : undefined
                  }
                  onImage={setLightbox}
                  receipt={own ? receiptStatus(m) : undefined}
                  seen={own && m.id === lastSeenId}
                  senderName={
                    own ? S.common.you : nicknameFor(m.senderSigningPublicKey, m.senderWalletId) || m.senderDisplayName || S.common.unknown
                  }
                />
              );
            })}
            {pending && (
              <li className="msg-item own">
                <div className="msg-bubble own pending" aria-live="polite">
                  <span className="msg-pending-label">
                    <Loader2 size={12} className="spin" /> {S.chat.encrypting}
                  </span>
                  <span className="msg-text">{pending.media ? `🔒 ${pending.label}` : pending.label}</span>
                </div>
              </li>
            )}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      {showGifs && gifsEnabled() && <GifPicker onSelect={onGif} onClose={() => setShowGifs(false)} />}

      <footer className="msg-composer">
        {replyingTo && (
          <div className="msg-replying">
            <Reply size={14} aria-hidden="true" />
            <span>
              <strong>{fmt(S.reply.replyingTo, { name: isOwn(replyingTo) ? S.common.you : replyingTo.senderDisplayName || S.common.unknown })}</strong>
              <small>{previewText(replyingTo)}</small>
            </span>
            <button type="button" className="button ghost icon msg-icon" aria-label={S.reply.cancel} onClick={() => setReplyingTo(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        {staged && (
          <div className="msg-staged">
            {staged.file.type.startsWith("video/") ? (
              <span className="msg-staged-file">
                <Video size={16} /> {staged.file.name}
              </span>
            ) : (
              <img src={staged.previewUrl} alt="" />
            )}
            <small>
              {staged.file.name} ({(staged.file.size / 1024).toFixed(0)} KB)
            </small>
            <button type="button" className="button ghost icon msg-icon" aria-label={S.common.cancel} onClick={clearStaged}>
              <X size={14} />
            </button>
          </div>
        )}
        {showOptions && (
          <div className="msg-options">
            <label>
              <Timer size={14} className={selfDestruct ? "danger-icon" : ""} />
              <span>{selfDestruct ? fmt(S.chat.selfDestructOn, { s: DESTRUCT_SECONDS }) : S.chat.selfDestruct}</span>
              <Toggle checked={selfDestruct} label={S.chat.selfDestruct} onChange={setSelfDestruct} />
            </label>
            <label>
              <EyeOff size={14} className={spoiler ? "warn-icon" : ""} />
              <span>{spoiler ? S.chat.spoilerOn : S.chat.spoiler}</span>
              <Toggle checked={spoiler} label={S.chat.spoiler} onChange={setSpoiler} />
            </label>
          </div>
        )}
        <form
          className="msg-compose-row"
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
        >
          <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onFile} />
          <button
            type="button"
            className={`button ghost icon msg-icon ${showOptions || selfDestruct || spoiler ? "active" : ""}`}
            aria-label={S.chat.options}
            title={S.chat.options}
            aria-expanded={showOptions}
            onClick={() => setShowOptions((v) => !v)}
          >
            {selfDestruct ? <Timer size={17} /> : spoiler ? <EyeOff size={17} /> : <SmilePlus size={17} />}
          </button>
          <button type="button" className="button ghost icon msg-icon" aria-label={S.chat.attach} title={S.chat.attach} disabled={composerDisabled} onClick={() => fileRef.current?.click()}>
            <Paperclip size={17} />
          </button>
          {gifsEnabled() && (
            <button
              type="button"
              className={`button ghost icon msg-icon msg-gif ${showGifs ? "active" : ""}`}
              aria-label={S.gif.button}
              title={S.gif.button}
              aria-pressed={showGifs}
              disabled={composerDisabled}
              onClick={() => setShowGifs((v) => !v)}
            >
              GIF
            </button>
          )}
          {canPay && (
            <button type="button" className="button ghost icon msg-icon msg-pay-btn" aria-label={S.chat.pay} title={S.chat.pay} disabled={composerDisabled} onClick={() => setPay({})}>
              <DollarSign size={17} />
            </button>
          )}
          <input
            className="input msg-input"
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => setText(e.target.value)}
            disabled={composerDisabled}
            enterKeyHint="send"
          />
          <button
            type="submit"
            className="button icon msg-send"
            aria-label={replyingTo ? S.chat.sendReply : S.chat.send}
            disabled={(!text.trim() && !staged) || composerDisabled}
          >
            {sending ? <Loader2 size={17} className="spin" /> : replyingTo ? <Reply size={17} /> : <Send size={17} />}
          </button>
        </form>
      </footer>

      {details && <DetailsSheet message={details} onClose={() => setDetails(null)} onDelete={isOwn(details) ? () => void removeMessage(details) : undefined} />}
      {showGroupInfo && isGroup && (
        <GroupInfoSheet conversation={conversation} identity={identity} contacts={contacts} onClose={() => setShowGroupInfo(false)} onChanged={onConversationChanged} />
      )}
      {pay && recipient && canPay && (
        <ChatPayment
          recipientPublicKey={recipient.signingPublicKey || recipient.encryptionPublicKey || recipient.id}
          recipientName={title}
          initial={pay.initial}
          onClose={() => setPay(null)}
          onPaymentSent={onPaymentSent}
          onRequest={onRequest}
        />
      )}
      {lightbox && (
        <div className="msg-lightbox" role="dialog" aria-label={S.chat.lightbox} onClick={() => setLightbox(null)}>
          <button type="button" className="button ghost icon" aria-label={S.common.close} onClick={() => setLightbox(null)}>
            <X size={20} />
          </button>
          <img src={lightbox} alt={S.chat.lightbox} onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  );
}

/** Incoming text reveal (apps/web's decrypt animation, reduced to a short CSS-cheap scramble). */
function DecryptReveal({ text, onDone }: { text: string; onDone: () => void }) {
  const [shown, setShown] = useState(() => scramble(text, 0));
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !text) {
      done.current();
      return;
    }
    let i = 0;
    const steps = 12;
    const id = window.setInterval(() => {
      i++;
      setShown(scramble(text, i / steps));
      if (i >= steps) {
        window.clearInterval(id);
        done.current();
      }
    }, 45);
    return () => window.clearInterval(id);
  }, [text]);
  return (
    <span className="msg-text decrypting" aria-label={text}>
      {shown}
    </span>
  );
}

const CIPHER = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
function scramble(text: string, progress: number): string {
  const keep = Math.floor(progress * text.length);
  let out = text.slice(0, keep);
  for (let i = keep; i < Math.min(text.length, 120); i++) out += text[i] === " " ? " " : CIPHER[Math.floor(Math.random() * CIPHER.length)];
  return out;
}

function Bubble({
  message,
  own,
  group,
  active,
  isNew,
  onAnimated,
  onToggle,
  reactions,
  reacting,
  onReactPicker,
  onReact,
  onReply,
  onDetails,
  quotedPreview,
  onPayRequest,
  onImage,
  receipt,
  seen,
  senderName,
}: {
  message: Message;
  own: boolean;
  group: boolean;
  active: boolean;
  isNew: boolean;
  onAnimated: () => void;
  onToggle: () => void;
  reactions?: ReactionSummary[];
  reacting: boolean;
  onReactPicker: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onDetails: () => void;
  quotedPreview?: string;
  onPayRequest?: () => void;
  onImage: (url: string) => void;
  receipt?: ReceiptStatus;
  seen: boolean;
  senderName: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const hidden = !!message.spoiler && !revealed;
  const legacyReply = message.plaintext ? parseReplyMessage(message.plaintext) : null;
  const quote = legacyReply ? legacyReply.replyPreview : message.replyTo !== undefined ? quotedPreview || S.reply.unavailable : null;
  const payment = getPaymentData(message);
  const request = getRequestData(message);
  const tip = parseTip(message.plaintext);
  const failed = message.plaintext?.startsWith("[Unable") || message.plaintext?.startsWith("[Your encrypted");
  const plainText = legacyReply ? legacyReply.text : message.plaintext ?? "";
  const rich = !legacyReply && !payment && !request && !tip && !message.mediaUrl && classifyBody(message.plaintext) !== "text";

  let body;
  if (message.mediaUrl && message.messageType === "image")
    body = (
      <img
        className={`msg-media ${hidden ? "blurred" : ""}`}
        src={message.mediaUrl}
        alt={message.mediaFileName || S.media.image}
        onClick={(e) => {
          e.stopPropagation();
          if (!hidden) onImage(message.mediaUrl!);
        }}
      />
    );
  else if (message.mediaUrl && message.messageType === "video")
    body = <video className={`msg-media ${hidden ? "blurred" : ""}`} src={hidden ? undefined : message.mediaUrl} controls={!hidden} onClick={(e) => e.stopPropagation()} />;
  else if (payment) body = <PaymentBubble payment={payment} isOwn={own} />;
  else if (request) body = <PaymentRequestBubble request={request} isOwn={own} onAccept={onPayRequest} />;
  else if (tip) body = <TipBubble amount={tip.amount} symbol={tip.symbol} isOwn={own} />;
  else if (rich) body = <RichBody body={message.plaintext} blurred={hidden} onImageClick={onImage} />;
  else if (isNew && !failed && !hidden) body = <DecryptReveal text={plainText} onDone={onAnimated} />;
  else body = <span className={`msg-text ${failed ? "failed" : ""} ${hidden ? "blurred" : ""}`}>{plainText}</span>;

  return (
    <li className={`msg-item ${own ? "own" : ""}`}>
      <div
        className={`msg-bubble ${own ? "own" : ""} ${active ? "active" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={active}
        onClick={(e) => {
          e.stopPropagation();
          if (hidden) setRevealed(true);
          else onToggle();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (hidden) setRevealed(true);
            else onToggle();
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onReactPicker();
        }}
      >
        {!own && (group || message.senderDisplayName) && (
          <span className="msg-sender">
            <PeerAvatar id={message.senderSigningPublicKey || message.senderWalletId} name={senderName} size={16} />
            {senderName}
          </span>
        )}
        {quote !== null && <span className="msg-quote">{quote}</span>}
        <span className="msg-body">
          {hidden && (
            <span className="msg-spoiler">
              <EyeOff size={15} /> {S.chat.reveal}
            </span>
          )}
          {body}
          {message.mediaFileName && message.mediaUrl && !hidden && <small className="msg-file">{message.mediaFileName}</small>}
        </span>
        {reactions && reactions.length > 0 && (
          <span className="msg-reactions">
            {reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={r.myReaction ? "mine" : ""}
                onClick={(e) => {
                  e.stopPropagation();
                  onReact(r.emoji);
                }}
              >
                {r.emoji}
                {r.count > 1 && <small>{r.count}</small>}
              </button>
            ))}
          </span>
        )}
        <span className="msg-meta">
          <span>{formatMessageTime(message.createdAt)}</span>
          {message.selfDestruct && <Timer size={11} className="danger-icon" aria-label={S.chat.selfDestruct} />}
          {message.signatureValid ? (
            <CheckCircle2 size={11} className="ok-icon" aria-label={S.details.valid} />
          ) : (
            <XCircle size={11} className="danger-icon" aria-label={S.details.invalid} />
          )}
          {receipt &&
            (receipt === "sent" ? (
              <Check size={13} aria-label={S.receipts.sent} />
            ) : (
              <CheckCheck size={13} className={receipt === "read" ? "read-icon" : ""} aria-label={receipt === "read" ? S.receipts.read : S.receipts.delivered} />
            ))}
        </span>
        {seen && <span className="msg-seen">{S.receipts.seen}</span>}
      </div>
      {active && (
        <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={onReply}>
            <Reply size={14} /> {S.chat.reply}
          </button>
          <button type="button" onClick={onReactPicker} aria-expanded={reacting}>
            <SmilePlus size={14} /> {S.chat.react}
          </button>
          <button type="button" onClick={onDetails}>
            <Info size={14} /> {S.chat.tapDetails}
          </button>
        </div>
      )}
      {reacting && (
        <div className="msg-react-picker" role="menu" onClick={(e) => e.stopPropagation()}>
          {REACTION_EMOJIS.map((emoji) => (
            <button key={emoji} type="button" role="menuitem" aria-label={`${S.chat.react} ${emoji}`} onClick={() => onReact(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function HexField({ label, hint, value, max = 128 }: { label: string; hint?: string; value: string; max?: number }) {
  const [copied, setCopied] = useState(false);
  const shown = value.length <= max ? value : `${value.slice(0, max / 2)}…${value.slice(-max / 2)}`;
  return (
    <div className="msg-hex">
      <div className="msg-split">
        <strong>
          {label} <small>{fmt(S.details.bytes, { n: Math.floor(value.length / 2) })}</small>
        </strong>
        <button
          type="button"
          className="button ghost icon msg-icon"
          aria-label={`${S.common.copy} ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard unavailable */
            }
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <code className="mono">{shown || "—"}</code>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Encryption details (apps/web EncryptionDetailsPanel) for 1:1 and group packages. */
function DetailsSheet({ message, onClose, onDelete }: { message: Message; onClose: () => void; onDelete?: () => void }) {
  let pkg: { kemCipherText?: string; iv?: string; encryptedContent?: string; wrappedKeys?: Record<string, unknown> } | null = null;
  try {
    pkg = JSON.parse(message.encryptedContent);
  } catch {
    pkg = null;
  }
  const group = !!message.encryptedContent && isV2Package(message.encryptedContent);
  const created = new Date(message.createdAt);
  return (
    <Sheet
      title={S.details.title}
      icon={<FileKey2 size={16} className="accent" />}
      onClose={onClose}
      wide
      footer={
        onDelete ? (
          <button type="button" className="button destructive small" onClick={onDelete}>
            <Trash2 size={14} /> {S.details.delete}
          </button>
        ) : undefined
      }
    >
      <div className="msg-sheet-pad msg-stack-gap">
        <p className="msg-hint">{S.details.subtitle}</p>
        <dl className="msg-dl">
          <dt>{S.details.messageId}</dt>
          <dd className="mono">{message.id}</dd>
          <dt>{S.details.timestamp}</dt>
          <dd>{isNaN(created.getTime()) ? "—" : created.toLocaleString()}</dd>
        </dl>
        {group && pkg ? (
          <>
            <p className="msg-hint">{fmt(S.details.group, { count: Object.keys(pkg.wrappedKeys ?? {}).length })}</p>
            <HexField label={S.details.iv} hint={S.details.ivHint} value={pkg.iv ?? ""} />
            <HexField label={S.details.content} hint={S.details.contentHint} value={pkg.encryptedContent ?? ""} />
          </>
        ) : pkg && pkg.kemCipherText ? (
          <>
            <HexField label={S.details.kem} hint={S.details.kemHint} value={pkg.kemCipherText ?? ""} />
            <HexField label={S.details.iv} hint={S.details.ivHint} value={pkg.iv ?? ""} />
            <HexField label={S.details.content} hint={S.details.contentHint} value={pkg.encryptedContent ?? ""} />
          </>
        ) : (
          <HexField label={S.details.raw} value={message.encryptedContent ?? ""} max={256} />
        )}
        <HexField label={`${S.details.signature} · ${message.signatureValid ? S.details.valid : S.details.invalid}`} hint={S.details.signatureHint} value={message.signature ?? ""} />
        {message.plaintext && !message.plaintext.startsWith("[") && (
          <div className="msg-hex ok">
            <strong>{S.details.plaintext}</strong>
            <p>{message.plaintext}</p>
          </div>
        )}
      </div>
    </Sheet>
  );
}
