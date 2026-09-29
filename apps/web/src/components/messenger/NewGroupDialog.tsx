import { useMemo, useState } from "react";
import { Check, Loader2, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WalletAvatar } from "@/components/WalletAvatar";
import { ChatSheet } from "./ChatSheet";
import { createGroupConversation, MAX_GROUP_MEMBERS, type Conversation, type Wallet, type WalletWithPrivateKeys } from "@/lib/pqc-messenger";

interface NewGroupDialogProps {
  contacts: Wallet[];
  wallet: WalletWithPrivateKeys;
  onClose: () => void;
  onCreated: (conversation: Conversation) => void;
}

/** Create a group (Qwalla messenger/new-group.tsx): optional name + at least 2 members from the directory. */
export function NewGroupDialog({ contacts, wallet, onClose, onCreated }: NewGroupDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts
      .filter((c) => c.signingPublicKey && c.signingPublicKey !== wallet.signingPublicKey)
      .filter((c) => !q || (c.displayName || "").toLowerCase().includes(q) || c.signingPublicKey.toLowerCase().startsWith(q));
  }, [contacts, query, wallet.signingPublicKey]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else if (next.size + 1 < MAX_GROUP_MEMBERS) next.add(key);
      else toast.error(t("chat.group.maxMembers", { max: MAX_GROUP_MEMBERS }));
      return next;
    });
  };

  const create = async () => {
    if (selected.size < 2 || creating) return;
    setCreating(true);
    try {
      const conv = await createGroupConversation(wallet, [...selected], name);
      toast.success(t("chat.group.created"));
      onCreated(conv);
    } catch (e) {
      toast.error(t("chat.group.createFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setCreating(false);
    }
  };

  return (
    <ChatSheet
      title={t("chat.group.new")}
      icon={<Users className="w-4 h-4 text-[hsl(var(--hologram))]" />}
      onClose={onClose}
      footer={
        <Button className="w-full" onClick={create} disabled={selected.size < 2 || creating}>
          {creating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Users className="w-4 h-4 mr-2" />}
          {creating ? t("chat.group.creating") : t("chat.group.create", { count: selected.size + 1 })}
        </Button>
      }
    >
      <div className="p-4 space-y-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 100))}
          placeholder={t("chat.group.namePlaceholder")}
          className="cyber-input"
          autoFocus
        />
        <div className="flex items-center justify-between">
          <p className="hud-label">{t("chat.group.members")}</p>
          <span className="bubble-meta text-muted-foreground">{t("chat.group.selected", { count: selected.size })}</span>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("chat.group.searchContacts")} className="cyber-input pl-8 h-9 text-sm" />
        </div>
        {selected.size < 2 && <p className="text-xs text-muted-foreground">{t("chat.group.pickTwo")}</p>}
        <div className="divide-y divide-border/50 -mx-1">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">{t("chat.group.noContacts")}</p>
          ) : (
            candidates.map((c) => {
              const on = selected.has(c.signingPublicKey);
              return (
                <button
                  key={c.signingPublicKey}
                  type="button"
                  onClick={() => toggle(c.signingPublicKey)}
                  className={`w-full flex items-center gap-3 px-1 py-2 text-left rounded-md transition-colors ${on ? "bg-primary/10" : "hover:bg-muted/40"}`}
                  aria-pressed={on}
                >
                  <span className={`w-5 h-5 rounded-md border flex items-center justify-center flex-shrink-0 ${on ? "bg-primary border-primary" : "border-border"}`}>
                    {on && <Check className="w-3.5 h-3.5 text-primary-foreground" />}
                  </span>
                  <WalletAvatar id={c.id || c.signingPublicKey} uri={c.avatarUrl} name={c.displayName} size={32} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate">{c.displayName || t("chat.common.anonymous")}</span>
                    <span className="block text-[11px] font-mono text-muted-foreground truncate">{c.signingPublicKey.slice(0, 20)}…</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </ChatSheet>
  );
}

export default NewGroupDialog;
