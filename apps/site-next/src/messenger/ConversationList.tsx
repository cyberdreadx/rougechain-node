/** Conversation list with the Chats / Requests tabs (apps/web components/messenger/ConversationList). */
import { useState } from "react";
import { Ban, BellOff, Inbox, Loader2, Lock, MessageSquare, StickyNote, Trash2 } from "lucide-react";
import { isGroupConversation, otherMembers } from "@rougechain/core/messenger-prefs";
import { deleteConversation, type Conversation, type WalletWithPrivateKeys } from "@rougechain/core/pqc-messenger";
import { useRougeAddress } from "../wallet/hooks";
import { toast } from "../wallet/toast";
import { formatRelativeTime } from "./codec";
import { conversationTitle, isSelfChat, otherParticipant } from "./model";
import { useTranslation } from "react-i18next";
import { PeerAvatar, StackedAvatars } from "./ui";

function NameWithAddress({ name, pubkey }: { name: string; pubkey?: string }) {
  const { t } = useTranslation("messenger");
  const { display } = useRougeAddress(name ? null : pubkey);
  const shown = name || display || (pubkey ? `${pubkey.slice(0, 12)}…` : t("common.unknown"));
  return <span className="msg-row-name">{shown}</span>;
}

export interface ConversationListProps {
  conversations: Conversation[];
  requests: Conversation[];
  identity: WalletWithPrivateKeys;
  myIds: Set<string>;
  selectedId?: string;
  muted: Set<string>;
  loading: boolean;
  error: boolean;
  nickname: (p: { id?: string; signingPublicKey?: string }) => string | null;
  onSelect(c: Conversation): void;
  onDeleted(id: string): void;
  onAcceptRequest(c: Conversation): void;
  onDeleteRequest(c: Conversation): void;
  onBlockRequest(c: Conversation): void;
}

export function ConversationList(p: ConversationListProps) {
  const { t } = useTranslation("messenger");
  const [tab, setTab] = useState<"primary" | "requests">("primary");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const showRequests = tab === "requests" && p.requests.length > 0;
  const title = (c: Conversation) => conversationTitle(c, p.myIds, { myName: p.identity.displayName, nickname: p.nickname });
  const pubkeyOf = (c: Conversation) => {
    if (isSelfChat(c, p.myIds) || isGroupConversation(c, p.myIds)) return undefined;
    const o = otherParticipant(c, p.myIds, p.identity.displayName);
    return o ? o.signingPublicKey || o.encryptionPublicKey || undefined : undefined;
  };

  const remove = async (c: Conversation) => {
    if (deletingId || !window.confirm(t("list.deleteConfirm"))) return;
    setDeletingId(c.id);
    try {
      await deleteConversation(p.identity, c.id);
      p.onDeleted(c.id);
      toast.success(t("list.deleted"));
    } catch {
      toast.error(t("list.deleteFailed"));
    } finally {
      setDeletingId(null);
    }
  };

  const tabs =
    p.requests.length > 0 ? (
      <div className="msg-tabs" role="tablist">
        {(["primary", "requests"] as const).map((k) => {
          const on = k === "primary" ? !showRequests : showRequests;
          return (
            <button key={k} type="button" role="tab" aria-selected={on} className={on ? "active" : ""} onClick={() => setTab(k)}>
              {k === "primary" ? t("requests.primary") : t("requests.tabCount", { n: p.requests.length })}
            </button>
          );
        })}
      </div>
    ) : (
      <div className="msg-list-title">
        <span className="eyebrow">{t("list.title")}</span>
      </div>
    );

  if (showRequests)
    return (
      <div className="msg-list">
        {tabs}
        <p className="msg-hint">{t("requests.hint")}</p>
        <ul className="msg-rows">
          {p.requests.map((c) => {
            const other = otherParticipant(c, p.myIds, p.identity.displayName);
            return (
              <li key={c.id} className="msg-row request">
                {other ? (
                  <PeerAvatar id={other.id || other.signingPublicKey} uri={other.avatarUrl} name={title(c)} size={40} />
                ) : (
                  <span className="msg-glyph">
                    <Inbox size={18} />
                  </span>
                )}
                <button type="button" className="msg-row-main" onClick={() => p.onSelect(c)}>
                  <NameWithAddress name={title(c)} pubkey={pubkeyOf(c)} />
                  <span className="msg-row-preview">{t("requests.wantsToMessage")}</span>
                </button>
                <span className="msg-row-actions">
                  <button type="button" className="button ghost icon msg-icon" aria-label={t("block.block")} title={t("block.block")} onClick={() => p.onBlockRequest(c)}>
                    <Ban size={16} />
                  </button>
                  <button type="button" className="button outline small" onClick={() => p.onDeleteRequest(c)}>
                    {t("requests.delete")}
                  </button>
                  <button type="button" className="button small" onClick={() => p.onAcceptRequest(c)}>
                    {t("requests.accept")}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );

  return (
    <div className="msg-list">
      {tabs}
      {p.error && <p className="msg-hint error">{t("list.loadFailed")}</p>}
      {p.loading && p.conversations.length === 0 ? (
        <div className="msg-center">
          <Loader2 className="spin" size={20} aria-label={t("common.loading")} />
        </div>
      ) : p.conversations.length === 0 ? (
        <div className="msg-center msg-empty">
          <Lock size={36} aria-hidden="true" />
          <strong>{t("list.emptyTitle")}</strong>
          <span>{t("list.emptyHint")}</span>
        </div>
      ) : (
        <ul className="msg-rows">
          {p.conversations.map((c) => {
            const group = isGroupConversation(c, p.myIds);
            const self = isSelfChat(c, p.myIds);
            const other = !group && !self ? otherParticipant(c, p.myIds, p.identity.displayName) : undefined;
            const unread = c.unreadCount ?? 0;
            return (
              <li key={c.id} className={`msg-row ${p.selectedId === c.id ? "selected" : ""} ${unread > 0 ? "unread" : ""}`}>
                <button type="button" className="msg-row-main with-avatar" onClick={() => p.onSelect(c)} aria-current={p.selectedId === c.id ? "true" : undefined}>
                  {group ? (
                    <StackedAvatars members={otherMembers(c, p.myIds)} size={40} />
                  ) : self ? (
                    <span className="msg-glyph note">
                      <StickyNote size={18} />
                    </span>
                  ) : other ? (
                    <PeerAvatar id={other.id || other.signingPublicKey} uri={other.avatarUrl} name={title(c)} size={40} />
                  ) : (
                    <span className="msg-glyph">
                      <MessageSquare size={18} />
                    </span>
                  )}
                  <span className="msg-row-text">
                    <span className="msg-row-top">
                      <NameWithAddress name={title(c)} pubkey={pubkeyOf(c)} />
                      {p.muted.has(c.id) && <BellOff size={13} className="muted-icon" aria-label={t("mute.muted")} />}
                      {unread > 0 && <span className="msg-badge">{unread > 9 ? "9+" : unread}</span>}
                      {c.lastMessageAt && <span className="msg-row-time">{formatRelativeTime(c.lastMessageAt)}</span>}
                    </span>
                    <span className="msg-row-preview">
                      {c.lastMessagePreview || (
                        <>
                          <Lock size={11} aria-hidden="true" /> {t("list.e2e")}
                        </>
                      )}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="button ghost icon msg-icon msg-row-delete"
                  aria-label={t("list.delete")}
                  title={t("list.delete")}
                  disabled={deletingId === c.id}
                  onClick={() => void remove(c)}
                >
                  {deletingId === c.id ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
