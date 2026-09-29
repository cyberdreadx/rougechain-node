import { useMemo, useState } from "react";
import { Ban, Bell, BellOff, Check, Loader2, Pencil, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { WalletAvatar } from "@/components/WalletAvatar";
import { ChatSheet } from "./ChatSheet";
import { StackedAvatars } from "./StackedAvatars";
import { useMessengerPrefs } from "./useMessengerPrefs";
import {
  addConversationParticipants,
  renameConversation,
  MAX_GROUP_MEMBERS,
  type Conversation,
  type Wallet,
  type WalletWithPrivateKeys,
} from "@/lib/pqc-messenger";
import {
  blockWalletKeys,
  isAnyBlocked,
  otherMembers,
  setConversationMuted,
  unblockWalletKeys,
  walletKeys,
} from "@/lib/messenger-prefs";

interface GroupInfoSheetProps {
  conversation: Conversation;
  wallet: WalletWithPrivateKeys;
  /** Directory wallets that can be added. */
  contacts: Wallet[];
  onClose: () => void;
  /** After a rename / add, so the page reloads the conversation. */
  onChanged?: () => void;
}

/**
 * Group info (Qwalla components/chat/GroupInfoSheet.tsx): rename, add members, member list.
 * The node has no leave / remove-member endpoint, so neither is offered (same as Qwalla).
 * Blocking a member here hides their messages in every chat, like Qwalla's block list.
 */
export function GroupInfoSheet({ conversation, wallet, contacts, onClose, onChanged }: GroupInfoSheetProps) {
  const { t } = useTranslation();
  const prefs = useMessengerPrefs();
  const myIds = useMemo(() => new Set(walletKeys(wallet)), [wallet]);
  const members = useMemo(() => otherMembers(conversation, myIds), [conversation, myIds]);
  const memberKeys = useMemo(() => new Set(members.flatMap((m) => walletKeys(m))), [members]);
  const total = members.length + 1;

  const [name, setName] = useState(conversation.name ?? "");
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const muted = prefs.muted.has(conversation.id);
  const candidates = contacts.filter((c) => c.signingPublicKey && !walletKeys(c).some((k) => memberKeys.has(k) || myIds.has(k)));
  const room = MAX_GROUP_MEMBERS - total;

  const rename = async () => {
    const next = name.trim();
    if (renaming || next === (conversation.name ?? "")) return;
    setRenaming(true);
    try {
      await renameConversation(wallet, conversation.id, next);
      toast.success(next ? t("chat.group.renamed", { name: next }) : t("chat.group.nameCleared"));
      onChanged?.();
    } catch (e) {
      toast.error(t("chat.group.renameFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setRenaming(false);
    }
  };

  const add = async () => {
    if (selected.size === 0 || adding) return;
    setAdding(true);
    try {
      await addConversationParticipants(wallet, conversation.id, [...selected]);
      toast.success(t("chat.group.added", { count: selected.size }));
      setSelected(new Set());
      setShowAdd(false);
      onChanged?.();
    } catch (e) {
      toast.error(t("chat.group.addFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setAdding(false);
    }
  };

  const toggleSelected = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else if (next.size < room) next.add(key);
      else toast.error(t("chat.group.maxMembers", { max: MAX_GROUP_MEMBERS }));
      return next;
    });

  const toggleBlock = (m: Wallet | (typeof members)[number]) => {
    const keys = walletKeys(m);
    if (isAnyBlocked(keys, prefs.blocked)) {
      unblockWalletKeys(keys);
      toast.success(t("chat.block.unblocked", { name: m.displayName || t("chat.common.anonymous") }));
    } else {
      if (!confirm(t("chat.block.confirmMember", { name: m.displayName || t("chat.common.anonymous") }))) return;
      blockWalletKeys(keys);
      toast.success(t("chat.block.blocked", { name: m.displayName || t("chat.common.anonymous") }));
    }
  };

  return (
    <ChatSheet
      title={showAdd ? t("chat.group.addMembers") : t("chat.group.info")}
      icon={<Users className="w-4 h-4 text-[hsl(var(--hologram))]" />}
      onClose={onClose}
      footer={showAdd ? (
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => { setShowAdd(false); setSelected(new Set()); }}>
            {t("chat.common.cancel")}
          </Button>
          <Button className="flex-1" onClick={add} disabled={selected.size === 0 || adding}>
            {adding ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UserPlus className="w-4 h-4 mr-2" />}
            {t("chat.group.addCount", { count: selected.size })}
          </Button>
        </div>
      ) : undefined}
    >
      {showAdd ? (
        <div className="p-4 space-y-2">
          <p className="text-xs text-muted-foreground">{t("chat.group.addHint")}</p>
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">{t("chat.group.noOneToAdd")}</p>
          ) : (
            candidates.map((c) => {
              const on = selected.has(c.signingPublicKey);
              return (
                <button
                  key={c.signingPublicKey}
                  type="button"
                  onClick={() => toggleSelected(c.signingPublicKey)}
                  className={`w-full flex items-center gap-3 px-1 py-2 text-left rounded-md transition-colors ${on ? "bg-primary/10" : "hover:bg-muted/40"}`}
                  aria-pressed={on}
                >
                  <span className={`w-5 h-5 rounded-md border flex items-center justify-center flex-shrink-0 ${on ? "bg-primary border-primary" : "border-border"}`}>
                    {on && <Check className="w-3.5 h-3.5 text-primary-foreground" />}
                  </span>
                  <WalletAvatar id={c.id || c.signingPublicKey} uri={c.avatarUrl} name={c.displayName} size={32} />
                  <span className="flex-1 min-w-0 text-sm font-medium truncate">{c.displayName || t("chat.common.anonymous")}</span>
                </button>
              );
            })
          )}
        </div>
      ) : (
        <div className="p-4 space-y-5">
          <div className="flex flex-col items-center gap-2 text-center">
            <StackedAvatars members={members} size={64} />
            <p className="font-medium truncate max-w-full">{conversation.name || t("chat.group.untitled", { count: total })}</p>
            <p className="bubble-meta text-muted-foreground">{t("chat.group.memberCount", { count: total })}</p>
          </div>

          <div className="space-y-2">
            <p className="hud-label">{t("chat.group.name")}</p>
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 100))}
                placeholder={t("chat.group.namePlaceholder")}
                className="cyber-input"
                onKeyDown={(e) => e.key === "Enter" && rename()}
              />
              <Button onClick={rename} disabled={renaming || name.trim() === (conversation.name ?? "")} size="icon" aria-label={t("chat.group.rename")}>
                {renaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pencil className="w-4 h-4" />}
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {muted ? <BellOff className="w-4 h-4 text-amber-500" /> : <Bell className="w-4 h-4 text-muted-foreground" />}
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("chat.mute.label")}</p>
                <p className="text-xs text-muted-foreground">{t("chat.mute.hint")}</p>
              </div>
            </div>
            <Switch checked={muted} onCheckedChange={(v) => setConversationMuted(conversation.id, v)} />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="hud-label">{t("chat.group.members")}</p>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAdd(true)} disabled={room <= 0}>
                <UserPlus className="w-3.5 h-3.5 mr-1" /> {t("chat.group.addMembers")}
              </Button>
            </div>
            <div className="flex items-center gap-3 py-2">
              <WalletAvatar id={wallet.id || wallet.signingPublicKey} name={wallet.displayName} size={32} />
              <span className="flex-1 min-w-0 text-sm font-medium truncate">{wallet.displayName || t("chat.common.anonymous")}</span>
              <span className="bubble-meta text-[hsl(var(--hologram))]">{t("chat.common.you")}</span>
            </div>
            {members.map((m) => {
              const isBlocked = isAnyBlocked(walletKeys(m), prefs.blocked);
              return (
                <div key={walletKeys(m)[0]} className="flex items-center gap-3 py-2">
                  <WalletAvatar id={m.id || m.signingPublicKey} uri={m.avatarUrl} name={m.displayName} size={32} />
                  <span className="flex-1 min-w-0">
                    <span className={`block text-sm font-medium truncate ${isBlocked ? "line-through opacity-60" : ""}`}>
                      {m.displayName && m.displayName !== "Unknown" ? m.displayName : `${(m.signingPublicKey || m.id || "").slice(0, 12)}…`}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-8 w-8 ${isBlocked ? "text-destructive" : "text-muted-foreground"}`}
                    onClick={() => toggleBlock(m)}
                    title={isBlocked ? t("chat.block.unblock") : t("chat.block.block")}
                  >
                    <Ban className="w-4 h-4" />
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">{t("chat.group.e2eNote")}</p>
        </div>
      )}
    </ChatSheet>
  );
}

export default GroupInfoSheet;
