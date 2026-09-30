/**
 * /messenger — apps/web's pages/Messenger.tsx on site-next: conversation list (Chats / Requests,
 * mute, block), chat, new chat / group, privacy, blocked list, messaging-identity export / import,
 * re-register and key regeneration. Real time via the node's private `new_message` socket.
 * All crypto, signing, envelopes and storage go through @rougechain/core.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowDownUp,
  Ban,
  Bell,
  BellOff,
  Download,
  Key,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Upload,
  UserCircle,
  Users,
} from "lucide-react";
import {
  acceptChat,
  acceptChats,
  blockWalletKeys,
  classifyConversation,
  getAcceptedChats,
  getBlockedList,
  getMutedConversations,
  migrateExistingChats,
  notifiableActivity,
  otherMembers,
  walletKeys,
} from "@rougechain/core/messenger-prefs";
import {
  deleteConversation,
  exportMessengerIdentity,
  generateEncryptionKeypair,
  getConversations,
  getPrivacySettings,
  getWallets,
  importMessengerIdentity,
  registerWalletOnNode,
  type Conversation,
  type Wallet,
  type WalletWithPrivateKeys,
} from "@rougechain/core/pqc-messenger";
import { detectNewActivity, loadNotificationSettings, requestNotificationPermission, saveNotificationSettings, type ConversationActivity } from "@rougechain/core/notifications";
import { setProfileDisplayName } from "@rougechain/core/profile";
import { setStoredDisplayName } from "@rougechain/core/avatar";
import { loadUnifiedWallet, saveUnifiedWallet, type UnifiedWallet } from "@rougechain/core/unified-wallet";
import { useRougeAddress } from "../wallet/hooks";
import { notifyWalletChanged } from "../wallet/store";
import { toast } from "../wallet/toast";
import { useWallet } from "../wallet/WalletProvider";
import { ChatView } from "./ChatView";
import { ConversationList } from "./ConversationList";
import { WalletGate } from "./Gate";
import { useFillHeight, useIsPhone, useMessengerPrefs, useNicknames } from "./hooks";
import { GENERIC_SELF_NAMES, contactsFrom, normalizeMine, sortByActivity, splitConversations } from "./model";
import { BlockedSheet, ContactPicker, NewGroupSheet, PrivacySheet } from "./Sheets";
import { S, fmt } from "./strings";
import { Sheet } from "./ui";
import { useMessengerSocket } from "./ws";
import "./messenger.css";

export default function MessengerPage() {
  return (
    <WalletGate product="messenger">
      {({ wallet, identity, setIdentity }) => <Messenger wallet={wallet} identity={identity} setIdentity={setIdentity} />}
    </WalletGate>
  );
}

function Messenger({ wallet, identity, setIdentity }: { wallet: UnifiedWallet; identity: WalletWithPrivateKeys; setIdentity(w: WalletWithPrivateKeys | null): void }) {
  const { network, isExtension } = useWallet();
  const prefs = useMessengerPrefs();
  const { nicknameFor } = useNicknames();
  const phone = useIsPhone();
  const [fillRef, height] = useFillHeight<HTMLDivElement>();
  const [params, setParams] = useSearchParams();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contacts, setContacts] = useState<Wallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | "contacts" | "group" | "privacy" | "blocked" | "name">(() =>
    params.get("panel") === "blocked" ? "blocked" : GENERIC_SELF_NAMES.has((wallet.displayName || "").trim().toLowerCase()) ? "name" : null,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<null | "register" | "regen">(null);
  const [notifEnabled, setNotifEnabled] = useState(() => loadNotificationSettings().enabled);
  const importRef = useRef<HTMLInputElement>(null);
  const snapshotRef = useRef<Map<string, string>>(new Map());
  const directoryRef = useRef<Wallet[]>([]);
  const { display: myAddress } = useRougeAddress(wallet.signingPublicKey);

  const myIds = useMemo(
    () => new Set([identity.id, identity.signingPublicKey, identity.encryptionPublicKey, wallet.id, wallet.signingPublicKey].filter((x): x is string => !!x)),
    [identity, wallet.id, wallet.signingPublicKey],
  );

  const loadConversations = useCallback(async () => {
    try {
      const raw = await getConversations(identity.id, identity);
      const convs = normalizeMine(raw, identity);
      const blocked = new Set(getBlockedList());
      const mine = new Set([identity.id, identity.signingPublicKey, identity.encryptionPublicKey].filter(Boolean));
      // Message requests (Qwalla): grandfather existing chats once, then auto-accept chats I
      // started or last wrote in. 1:1s with a blocked peer are hidden.
      if (convs.length > 0) migrateExistingChats(convs.map((c) => c.id));
      acceptChats(convs.filter((c) => (c.createdBy && mine.has(c.createdBy)) || (c.lastSenderId && mine.has(c.lastSenderId))).map((c) => c.id));
      const accepted = new Set(getAcceptedChats());
      const visible = convs.filter((c) => classifyConversation(c, { myIds: mine, accepted, blocked }) !== "hidden");

      // Alerts for new activity: muted chats and blocked senders never alert.
      const activity: ConversationActivity[] = visible.map((c) => ({
        conversationId: c.id,
        lastMessageAt: c.lastMessageAt,
        lastSenderId: c.lastSenderId,
        lastMessagePreview: c.lastMessagePreview,
        unreadCount: c.unreadCount,
      }));
      const senderKeysOf = (id: string) => walletKeys(directoryRef.current.find((w) => walletKeys(w).includes(id)));
      snapshotRef.current = detectNewActivity(
        notifiableActivity(activity, new Set(getMutedConversations()), blocked, senderKeysOf),
        snapshotRef.current,
        mine,
        (senderId) => directoryRef.current.find((w) => walletKeys(w).includes(senderId))?.displayName || "Someone",
        (convId) => setSelectedId(convId),
      );
      setConversations(sortByActivity(visible));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [identity]);

  const loadContacts = useCallback(async () => {
    try {
      const all = await getWallets();
      directoryRef.current = all;
      setContacts(contactsFrom(all, identity, new Set(getBlockedList())));
    } catch {
      /* directory unavailable: contact list stays empty */
    }
  }, [identity]);

  // Register (required for messaging; `discoverable` only controls search), load, and keep fresh.
  useEffect(() => {
    if (wallet.encryptionPublicKey)
      registerWalletOnNode({ id: wallet.id, displayName: wallet.displayName, signingPublicKey: wallet.signingPublicKey, encryptionPublicKey: wallet.encryptionPublicKey }).catch(() => {});
    if (loadNotificationSettings().enabled) requestNotificationPermission().catch(() => {});
    // Only on identity change: the registration is idempotent.
  }, [identity.signingPublicKey]);

  useEffect(() => {
    setLoading(true);
    void loadConversations();
    void loadContacts();
  }, [loadConversations, loadContacts, network]);

  const onNewMessage = useCallback(() => void loadConversations(), [loadConversations]);
  const wsLive = useMessengerSocket(identity, network, onNewMessage);
  useEffect(() => {
    const id = window.setInterval(() => void loadConversations(), wsLive ? 20_000 : 3_000);
    return () => window.clearInterval(id);
  }, [loadConversations, wsLive]);

  const { primary, requests } = useMemo(
    () => splitConversations(conversations, { myIds, accepted: prefs.accepted, blocked: prefs.blocked }),
    [conversations, myIds, prefs],
  );
  const selected = conversations.find((c) => c.id === selectedId) ?? null;
  const selectedIsRequest = !!selected && requests.some((c) => c.id === selected.id);
  const nickname = useCallback((p: { id?: string; signingPublicKey?: string }) => nicknameFor(p.signingPublicKey, p.id), [nicknameFor]);

  const onCreated = (c: Conversation) => {
    setConversations((prev) => (prev.some((x) => x.id === c.id) ? prev : [c, ...prev]));
    acceptChat(c.id); // chats I start are never requests
    setSelectedId(c.id);
    setSheet(null);
  };

  const openSheet = (s: "group" | "privacy" | "blocked") => {
    setMenuOpen(false);
    setSheet(s);
  };

  const closeBlocked = () => {
    setSheet(null);
    if (params.get("panel")) {
      const next = new URLSearchParams(params);
      next.delete("panel");
      setParams(next, { replace: true });
    }
    void loadConversations();
    void loadContacts();
  };

  const acceptRequest = (c: Conversation) => {
    acceptChat(c.id);
    toast.success(S.requests.accepted);
  };
  const blockRequest = (c: Conversation) => {
    const other = otherMembers(c, myIds)[0];
    const name = other?.displayName || S.common.anonymous;
    if (!other || !window.confirm(fmt(S.block.confirm, { name }))) return;
    blockWalletKeys(walletKeys(other));
    if (selectedId === c.id) setSelectedId(null);
    toast.success(fmt(S.block.blocked, { name }));
  };
  const deleteRequest = async (c: Conversation) => {
    if (!window.confirm(S.requests.deleteConfirm)) return;
    try {
      await deleteConversation(identity, c.id);
      setConversations((prev) => prev.filter((x) => x.id !== c.id));
      if (selectedId === c.id) setSelectedId(null);
      toast.success(S.requests.deleted);
    } catch {
      toast.error(S.requests.deleteFailed);
    }
  };

  const reregister = async () => {
    setMenuOpen(false);
    if (busy) return;
    if (!getPrivacySettings().discoverable) return void toast.info(S.header.hidden);
    setBusy("register");
    try {
      await registerWalletOnNode(identity, isExtension ? false : undefined);
      toast.success(S.header.registered, { description: S.header.registeredHint });
      void loadContacts();
    } catch (e) {
      toast.error(S.header.registerFailed, { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async () => {
    setMenuOpen(false);
    if (busy) return;
    if (isExtension) return void toast.info(S.header.regenExtension);
    if (!window.confirm(S.header.regenConfirm)) return;
    setBusy("regen");
    try {
      // Only the ML-KEM-768 encryption keys: the signing keys ARE the wallet address.
      const current = loadUnifiedWallet() ?? wallet;
      const enc = generateEncryptionKeypair();
      const updated: UnifiedWallet = { ...current, encryptionPublicKey: enc.publicKey, encryptionPrivateKey: enc.privateKey };
      saveUnifiedWallet(updated);
      notifyWalletChanged();
      await registerWalletOnNode({ id: updated.id, displayName: updated.displayName, signingPublicKey: updated.signingPublicKey, encryptionPublicKey: updated.encryptionPublicKey });
      toast.success(S.header.regenDone);
      void loadContacts();
    } catch (e) {
      toast.error(S.header.regenFailed, { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const exportIdentity = () => {
    setMenuOpen(false);
    const json = exportMessengerIdentity(identity);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `rougechain-messaging-identity-${(identity.displayName || "identity").replace(/[^a-z0-9]/gi, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(S.header.exported);
  };
  const importIdentity = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const imported = await importMessengerIdentity(await file.text());
      setIdentity(imported);
      setSelectedId(null);
      toast.success(fmt(S.header.imported, { name: imported.displayName }));
    } catch (err) {
      toast.error(S.header.importFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const toggleNotifications = () => {
    const s = loadNotificationSettings();
    const next = !s.enabled;
    saveNotificationSettings({ ...s, enabled: next });
    setNotifEnabled(next);
    if (next) {
      void requestNotificationPermission();
      toast.success(S.header.notifEnabled);
    } else toast.info(S.header.notifMuted);
  };

  const showList = !phone || !selected;
  const showChat = !phone || !!selected;

  return (
    <main id="main" className={`msg-app ${selected ? "chat-open" : ""}`} ref={fillRef} style={height ? { height } : undefined}>
      <div className="msg-bar">
        <div className="msg-me">
          <Key size={15} className="accent" aria-hidden="true" />
          <span className="msg-me-text">
            <strong>{identity.displayName || wallet.displayName}</strong>
            <button
              type="button"
              className="msg-plain mono"
              title={S.header.copyAddress}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(wallet.signingPublicKey);
                  toast.success(S.header.addressCopied);
                } catch {
                  /* clipboard unavailable */
                }
              }}
            >
              {myAddress}
            </button>
          </span>
          <span className={`status ${wsLive ? "live" : "loading"}`} title={wsLive ? S.header.live : S.header.polling}>
            {network === "mainnet" ? S.gate.mainnet : S.gate.testnet}
          </span>
        </div>
        <div className="msg-bar-actions">
          <button type="button" className="button ghost icon msg-icon" aria-label={notifEnabled ? S.header.notifOn : S.header.notifOff} title={notifEnabled ? S.header.notifOn : S.header.notifOff} onClick={toggleNotifications}>
            {notifEnabled ? <Bell size={16} /> : <BellOff size={16} />}
          </button>
          <button type="button" className="button ghost small msg-hide-phone" onClick={() => setSheet("group")}>
            <Users size={15} /> {S.header.newGroup}
          </button>
          <button type="button" className="button small" onClick={() => setSheet("contacts")} aria-label={S.header.newChat}>
            <Plus size={15} /> <span className="msg-hide-phone">{S.header.newChat}</span>
          </button>
          <div className="msg-menu-wrap">
            <button type="button" className="button ghost icon msg-icon" aria-label={S.header.more} aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              <MoreHorizontal size={17} />
            </button>
            {menuOpen && (
              <>
                <div className="msg-menu-backdrop" onClick={() => setMenuOpen(false)} />
                <ul className="msg-menu" role="menu">
                  <li>
                    <button type="button" role="menuitem" onClick={() => openSheet("group")}>
                      <Users size={15} /> {S.group.new}
                    </button>
                  </li>
                  <li>
                    <button type="button" role="menuitem" onClick={() => openSheet("privacy")}>
                      <Settings size={15} /> {S.header.privacy}
                    </button>
                  </li>
                  <li>
                    <button type="button" role="menuitem" onClick={() => openSheet("blocked")}>
                      <Ban size={15} /> {S.header.blocked}
                    </button>
                  </li>
                  <li>
                    <button type="button" role="menuitem" disabled={busy === "register"} onClick={() => void reregister()}>
                      <RefreshCw size={15} className={busy === "register" ? "spin" : ""} /> {S.header.reregister}
                    </button>
                  </li>
                  <li>
                    <button type="button" role="menuitem" disabled={busy === "regen" || isExtension} onClick={() => void regenerate()}>
                      <KeyRound size={15} /> {S.header.regenerate}
                    </button>
                  </li>
                  <li>
                    <button type="button" role="menuitem" onClick={exportIdentity}>
                      <Download size={15} /> {S.header.exportId}
                    </button>
                  </li>
                  <li>
                    <button type="button" role="menuitem" onClick={() => {
                        setMenuOpen(false);
                        importRef.current?.click();
                      }}>
                      <Upload size={15} /> {S.header.importId}
                    </button>
                  </li>
                  <li>
                    <Link role="menuitem" to="/wallet">
                      <Shield size={15} /> {S.header.backup}
                    </Link>
                  </li>
                  <li>
                    <Link role="menuitem" to="/swap">
                      <ArrowDownUp size={15} /> {S.header.swap}
                    </Link>
                  </li>
                </ul>
              </>
            )}
          </div>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={importIdentity} />
        </div>
      </div>
      {isExtension && <p className="msg-note">{S.gate.extensionNote}</p>}

      <div className={`msg-panes ${selected ? "has-chat" : ""}`}>
        {showList && (
          <aside className="msg-pane-list" aria-label={S.list.title}>
            <ConversationList
              conversations={primary}
              requests={requests}
              identity={identity}
              myIds={myIds}
              selectedId={selected?.id}
              muted={prefs.muted}
              loading={loading}
              error={loadError}
              nickname={nickname}
              onSelect={(c) => setSelectedId(c.id)}
              onDeleted={(id) => {
                setConversations((prev) => prev.filter((c) => c.id !== id));
                if (selectedId === id) setSelectedId(null);
              }}
              onAcceptRequest={acceptRequest}
              onDeleteRequest={(c) => void deleteRequest(c)}
              onBlockRequest={blockRequest}
            />
          </aside>
        )}
        {showChat && (
          <div className="msg-pane-chat">
            {selected ? (
              <ChatView
                key={selected.id}
                conversation={selected}
                identity={identity}
                contacts={contacts}
                isRequest={selectedIsRequest}
                onBack={() => setSelectedId(null)}
                onBlocked={() => {
                  setSelectedId(null);
                  void loadConversations();
                  void loadContacts();
                }}
                onConversationChanged={() => void loadConversations()}
                onAccepted={() => toast.success(S.requests.accepted)}
              />
            ) : (
              <div className="msg-center msg-empty">
                <Shield size={44} aria-hidden="true" />
                <strong>{S.empty.selectTitle}</strong>
                <span>{S.empty.selectHint}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {sheet === "contacts" && (
        <ContactPicker contacts={contacts} identity={identity} conversations={conversations} onClose={() => setSheet(null)} onCreated={onCreated} onNewGroup={() => setSheet("group")} />
      )}
      {sheet === "group" && (
        <NewGroupSheet
          contacts={contacts}
          identity={identity}
          onClose={() => setSheet(null)}
          onCreated={(c) => {
            onCreated(c);
            void loadConversations();
          }}
        />
      )}
      {sheet === "blocked" && <BlockedSheet onClose={closeBlocked} />}
      {sheet === "privacy" && <PrivacySheet displayName={wallet.displayName} onClose={() => setSheet(null)} />}
      {sheet === "name" && <NamePrompt wallet={wallet} onClose={() => setSheet(null)} />}
    </main>
  );
}

/** apps/web's "Set your display name" prompt for generic wallet names. */
function NamePrompt({ wallet, onClose }: { wallet: UnifiedWallet; onClose: () => void }) {
  const [name, setName] = useState("");
  const save = async () => {
    const clean = name.trim();
    if (!clean) return;
    onClose();
    try {
      await setProfileDisplayName(clean);
      toast.success(fmt(S.namePrompt.saved, { name: clean }));
    } catch {
      // Node unreachable / name taken: keep it on this device (apps/web fallback).
      saveUnifiedWallet({ ...wallet, displayName: clean });
      setStoredDisplayName(wallet.signingPublicKey, clean);
      toast.success(fmt(S.namePrompt.savedLocal, { name: clean }));
    } finally {
      notifyWalletChanged();
    }
  };
  return (
    <Sheet
      title={S.namePrompt.title}
      icon={<UserCircle size={16} className="accent" />}
      onClose={onClose}
      footer={
        <div className="actions">
          <button type="button" className="button outline" onClick={onClose}>
            {S.common.later}
          </button>
          <button type="button" className="button" disabled={!name.trim()} onClick={() => void save()}>
            {S.common.save}
          </button>
        </div>
      }
    >
      <div className="msg-sheet-pad msg-stack-gap">
        <p className="msg-hint">{S.namePrompt.hint}</p>
        <input
          className="input"
          value={name}
          maxLength={50}
          autoFocus
          placeholder={S.namePrompt.placeholder}
          aria-label={S.namePrompt.placeholder}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
        />
      </div>
    </Sheet>
  );
}
