/**
 * Messenger sheets: new chat (ContactPicker), new group, group info, blocked wallets and privacy —
 * ports of apps/web's components/messenger/* on core's pqc-messenger / messenger-prefs.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Ban, Bot, Check, CheckCircle2, Loader2, MessageSquare, Pencil, Search, Shield, ShieldCheck, StickyNote, UserPlus, Users } from "lucide-react";
import { isRougeAddress } from "@rougechain/core/address";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@rougechain/core/network";
import {
  addConversationParticipants,
  clearStoredSentMessages,
  createConversation,
  createGroupConversation,
  getOrCreateDemoBot,
  getPrivacySettings,
  getWallets,
  MAX_GROUP_MEMBERS,
  renameConversation,
  savePrivacySettings,
  type Conversation,
  type Wallet,
  type WalletWithPrivateKeys,
} from "@rougechain/core/pqc-messenger";
import { blockWalletKeys, isAnyBlocked, otherMembers, setConversationMuted, unblockWalletKeys, walletKeys } from "@rougechain/core/messenger-prefs";
import { loadNotificationSettings, requestNotificationPermission, saveNotificationSettings } from "@rougechain/core/notifications";
import { setProfileDisplayName } from "@rougechain/core/profile";
import { Toggle, SettingRow } from "../wallet/parts";
import { notifyWalletChanged } from "../wallet/store";
import { toast } from "../wallet/toast";
import { useMessengerPrefs } from "./hooks";
import { S, fmt, plural } from "./strings";
import { PeerAvatar, Sheet, StackedAvatars } from "./ui";

const errText = (e: unknown) => (e instanceof Error ? e.message : undefined);

/** rouge1… address, `xrge:`-prefixed or raw public key (apps/web ContactPicker parseAddress). */
export function parseContactAddress(input: string): { valid: boolean; publicKey: string; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, publicKey: "", error: S.contacts.enterAddress };
  if (isRougeAddress(trimmed)) return { valid: true, publicKey: trimmed };
  const raw = /^xrge:/i.test(trimmed) ? trimmed.slice(5) : trimmed;
  if (raw.length < 100) return { valid: false, publicKey: raw, error: S.contacts.tooShort };
  return { valid: true, publicKey: raw };
}

/** Find the Note to Self conversation I already have (apps/web dedup). */
export function existingNoteToSelf(conversations: Conversation[], me: WalletWithPrivateKeys): Conversation | undefined {
  const mine = [me.id, me.signingPublicKey, me.encryptionPublicKey].filter(Boolean);
  return conversations.find(
    (c) =>
      !c.isGroup &&
      c.name !== "Quantum Bot" &&
      (c.name === "Note to Self" || ((c.participantIds?.length ?? 0) > 0 && (c.participantIds ?? []).every((id) => mine.includes(id)))),
  );
}

const meRecord = (w: WalletWithPrivateKeys): Wallet => ({
  id: w.id,
  displayName: w.displayName,
  signingPublicKey: w.signingPublicKey,
  encryptionPublicKey: w.encryptionPublicKey,
});

export function ContactPicker({
  contacts,
  identity,
  conversations,
  onClose,
  onCreated,
  onNewGroup,
}: {
  contacts: Wallet[];
  identity: WalletWithPrivateKeys;
  conversations: Conversation[];
  onClose: () => void;
  onCreated: (c: Conversation) => void;
  onNewGroup: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState("");
  const [detected, setDetected] = useState<Wallet | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [manualError, setManualError] = useState("");
  const check = address ? parseContactAddress(address) : null;

  useEffect(() => {
    setDetected(null);
    setManualError("");
    const parsed = address ? parseContactAddress(address) : null;
    if (!parsed?.valid) return;
    let pk = parsed.publicKey;
    if (pk === identity.signingPublicKey || pk === identity.encryptionPublicKey) {
      setManualError(S.contacts.self);
      return;
    }
    let cancelled = false;
    setLookingUp(true);
    (async () => {
      try {
        if (isRougeAddress(pk)) {
          const res = await fetch(`${getCoreApiBaseUrl()}/resolve/${encodeURIComponent(pk)}`, { headers: getCoreApiHeaders() });
          const data = (await res.json().catch(() => null)) as { publicKey?: string } | null;
          if (data?.publicKey) pk = data.publicKey;
        }
        const all = await getWallets();
        const match = all.find((w) => w.signingPublicKey === pk || w.encryptionPublicKey === pk || w.id === pk);
        if (!cancelled && match) setDetected(match);
      } catch {
        /* lookup errors: shows "not registered" */
      } finally {
        if (!cancelled) setLookingUp(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, identity.signingPublicKey, identity.encryptionPublicKey]);

  const start = async (key: string, make: () => Promise<Conversation>) => {
    setBusy(key);
    try {
      onCreated(await make());
    } catch (e) {
      toast.error(S.contacts.failed, { description: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const withContact = (contact: Wallet) =>
    start(contact.id || contact.signingPublicKey, async () => {
      const c = await createConversation(identity, contact.id);
      return { ...c, participants: [meRecord(identity), contact] };
    });

  const bot = () =>
    start("bot", async () => {
      const b = await getOrCreateDemoBot();
      const c = await createConversation(identity, b.id, "Quantum Bot");
      return {
        ...c,
        participants: [meRecord(identity), { id: b.id, displayName: b.displayName, signingPublicKey: b.signingPublicKey, encryptionPublicKey: b.encryptionPublicKey }],
      };
    });

  const note = () =>
    start("note", async () => {
      const existing = existingNoteToSelf(conversations, identity);
      if (existing) return existing;
      const c = await createConversation(identity, identity.id);
      return { ...c, participants: [meRecord(identity)], name: "Note to Self" };
    });

  const q = query.trim().toLowerCase();
  const list = contacts.filter(
    (c) =>
      c.id !== identity.id &&
      c.signingPublicKey !== identity.signingPublicKey &&
      c.encryptionPublicKey !== identity.encryptionPublicKey &&
      (!q || (c.displayName || "").toLowerCase().includes(q) || c.signingPublicKey.toLowerCase().startsWith(q)),
  );

  return (
    <Sheet title={S.contacts.title} icon={<MessageSquare size={16} className="accent" />} onClose={onClose}>
      <div className="msg-sheet-pad msg-stack-gap">
        <button type="button" className="msg-option featured" disabled={busy !== null} onClick={() => void bot()}>
          <span className="msg-glyph bot">{busy === "bot" ? <Loader2 size={18} className="spin" /> : <Bot size={18} />}</span>
          <span>
            <strong>
              {S.contacts.bot} <span className="pill">{S.chat.ai}</span>
            </strong>
            <small>{S.contacts.botHint}</small>
          </span>
        </button>
        <button type="button" className="msg-option" onClick={onNewGroup}>
          <span className="msg-glyph">
            <Users size={18} />
          </span>
          <span>
            <strong>{S.group.new}</strong>
            <small>{S.group.newHint}</small>
          </span>
        </button>
        <button type="button" className="msg-option" disabled={busy !== null} onClick={() => void note()}>
          <span className="msg-glyph note">{busy === "note" ? <Loader2 size={18} className="spin" /> : <StickyNote size={18} />}</span>
          <span>
            <strong>{S.list.noteToSelf}</strong>
            <small>{S.contacts.noteHint}</small>
          </span>
        </button>

        {!manual ? (
          <button type="button" className="msg-option dashed" onClick={() => setManual(true)}>
            <UserPlus size={16} /> <span>{S.contacts.addByAddress}</span>
          </button>
        ) : (
          <div className="msg-manual">
            <label className="field">
              {S.contacts.addressLabel}
              <span className="msg-input-wrap">
                <input
                  className="input mono"
                  value={address}
                  placeholder={S.contacts.addressPlaceholder}
                  onChange={(e) => setAddress(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                />
                {address &&
                  (lookingUp ? <Loader2 size={15} className="spin" /> : check?.valid ? <CheckCircle2 size={15} className="ok" /> : <AlertCircle size={15} className="bad" />)}
              </span>
            </label>
            {check && !check.valid && <p className="form-error">{check.error}</p>}
            {detected && (
              <p className="msg-found">
                <PeerAvatar id={detected.id || detected.signingPublicKey} uri={detected.avatarUrl} name={detected.displayName} size={24} />
                <span>
                  <strong>{detected.displayName || S.common.unknown}</strong> · {S.contacts.found}
                </span>
              </p>
            )}
            {manualError && <p className="form-error">{manualError}</p>}
            {check?.valid && !detected && !lookingUp && !manualError && <p className="msg-hint warn">{S.contacts.notRegistered}</p>}
            <button
              type="button"
              className="button small"
              disabled={!detected || busy !== null}
              onClick={() => detected && void withContact(detected)}
            >
              {busy && detected && busy === (detected.id || detected.signingPublicKey) ? <Loader2 size={14} className="spin" /> : <MessageSquare size={14} />}
              {S.contacts.start}
            </button>
          </div>
        )}

        <label className="msg-search">
          <Search size={14} aria-hidden="true" />
          <input className="input" value={query} placeholder={S.contacts.search} aria-label={S.contacts.search} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      {list.length === 0 ? (
        <div className="msg-center msg-empty small">
          <strong>{S.contacts.none}</strong>
          <span>{S.contacts.noneHint}</span>
        </div>
      ) : (
        <ul className="msg-rows">
          {list.map((c) => {
            const key = c.id || c.signingPublicKey;
            return (
              <li key={key} className="msg-row">
                <button type="button" className="msg-row-main with-avatar" disabled={busy !== null} onClick={() => void withContact(c)}>
                  <PeerAvatar id={c.id || c.signingPublicKey} uri={c.avatarUrl} name={c.displayName} size={36} />
                  <span className="msg-row-text">
                    <span className="msg-row-name">{c.displayName || S.common.unknown}</span>
                    <span className="msg-row-preview mono">{(c.signingPublicKey || c.id).slice(0, 20)}…</span>
                  </span>
                  {busy === key ? <Loader2 size={16} className="spin" /> : <MessageSquare size={16} className="muted-icon" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}

function MemberPicker({
  candidates,
  selected,
  onToggle,
}: {
  candidates: Wallet[];
  selected: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <ul className="msg-rows">
      {candidates.map((c) => {
        const on = selected.has(c.signingPublicKey);
        return (
          <li key={c.signingPublicKey} className="msg-row">
            <button type="button" className={`msg-row-main with-avatar ${on ? "picked" : ""}`} aria-pressed={on} onClick={() => onToggle(c.signingPublicKey)}>
              <span className={`msg-check ${on ? "on" : ""}`}>{on && <Check size={13} />}</span>
              <PeerAvatar id={c.id || c.signingPublicKey} uri={c.avatarUrl} name={c.displayName} size={32} />
              <span className="msg-row-text">
                <span className="msg-row-name">{c.displayName || S.common.anonymous}</span>
                <span className="msg-row-preview mono">{c.signingPublicKey.slice(0, 20)}…</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function NewGroupSheet({
  contacts,
  identity,
  onClose,
  onCreated,
}: {
  contacts: Wallet[];
  identity: WalletWithPrivateKeys;
  onClose: () => void;
  onCreated: (c: Conversation) => void;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts
      .filter((c) => c.signingPublicKey && c.signingPublicKey !== identity.signingPublicKey)
      .filter((c) => !q || (c.displayName || "").toLowerCase().includes(q) || c.signingPublicKey.toLowerCase().startsWith(q));
  }, [contacts, query, identity.signingPublicKey]);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else if (next.size + 1 < MAX_GROUP_MEMBERS) next.add(key);
      else toast.error(fmt(S.group.maxMembers, { max: MAX_GROUP_MEMBERS }));
      return next;
    });

  const create = async () => {
    if (selected.size < 2 || creating) return;
    setCreating(true);
    try {
      const conv = await createGroupConversation(identity, [...selected], name);
      toast.success(S.group.created);
      onCreated(conv);
    } catch (e) {
      toast.error(S.group.createFailed, { description: errText(e) });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Sheet
      title={S.group.new}
      icon={<Users size={16} className="accent" />}
      onClose={onClose}
      footer={
        <button type="button" className="button full" onClick={() => void create()} disabled={selected.size < 2 || creating}>
          {creating ? <Loader2 size={16} className="spin" /> : <Users size={16} />}
          {creating ? S.group.creating : plural(selected.size + 1, S.group.create_one, S.group.create_other)}
        </button>
      }
    >
      <div className="msg-sheet-pad msg-stack-gap">
        <input className="input" value={name} maxLength={100} placeholder={S.group.namePlaceholder} aria-label={S.group.name} onChange={(e) => setName(e.target.value.slice(0, 100))} autoFocus />
        <div className="msg-split">
          <span className="eyebrow">{S.group.members}</span>
          <span className="msg-hint">{plural(selected.size, S.group.selected_one, S.group.selected_other)}</span>
        </div>
        <label className="msg-search">
          <Search size={14} aria-hidden="true" />
          <input className="input" value={query} placeholder={S.group.searchContacts} aria-label={S.group.searchContacts} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {selected.size < 2 && <p className="msg-hint">{S.group.pickTwo}</p>}
      </div>
      {candidates.length === 0 ? <p className="msg-hint center">{S.group.noContacts}</p> : <MemberPicker candidates={candidates} selected={selected} onToggle={toggle} />}
    </Sheet>
  );
}

export function GroupInfoSheet({
  conversation,
  identity,
  contacts,
  onClose,
  onChanged,
}: {
  conversation: Conversation;
  identity: WalletWithPrivateKeys;
  contacts: Wallet[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const prefs = useMessengerPrefs();
  const myIds = useMemo(() => new Set(walletKeys(identity)), [identity]);
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
      await renameConversation(identity, conversation.id, next);
      toast.success(next ? fmt(S.group.renamed, { name: next }) : S.group.nameCleared);
      onChanged();
    } catch (e) {
      toast.error(S.group.renameFailed, { description: errText(e) });
    } finally {
      setRenaming(false);
    }
  };

  const add = async () => {
    if (selected.size === 0 || adding) return;
    setAdding(true);
    try {
      await addConversationParticipants(identity, conversation.id, [...selected]);
      toast.success(plural(selected.size, S.group.added_one, S.group.added_other));
      setSelected(new Set());
      setShowAdd(false);
      onChanged();
    } catch (e) {
      toast.error(S.group.addFailed, { description: errText(e) });
    } finally {
      setAdding(false);
    }
  };

  const toggleSelected = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else if (next.size < room) next.add(key);
      else toast.error(fmt(S.group.maxMembers, { max: MAX_GROUP_MEMBERS }));
      return next;
    });

  const toggleBlock = (m: (typeof members)[number]) => {
    const keys = walletKeys(m);
    const who = m.displayName || S.common.anonymous;
    if (isAnyBlocked(keys, prefs.blocked)) {
      unblockWalletKeys(keys);
      toast.success(fmt(S.block.unblocked, { name: who }));
    } else {
      if (!window.confirm(fmt(S.block.confirmMember, { name: who }))) return;
      blockWalletKeys(keys);
      toast.success(fmt(S.block.blocked, { name: who }));
    }
  };

  return (
    <Sheet
      title={showAdd ? S.group.addMembers : S.group.info}
      icon={<Users size={16} className="accent" />}
      onClose={onClose}
      footer={
        showAdd ? (
          <div className="actions">
            <button
              type="button"
              className="button outline"
              onClick={() => {
                setShowAdd(false);
                setSelected(new Set());
              }}
            >
              {S.common.cancel}
            </button>
            <button type="button" className="button" onClick={() => void add()} disabled={selected.size === 0 || adding}>
              {adding ? <Loader2 size={16} className="spin" /> : <UserPlus size={16} />}
              {plural(selected.size, S.group.addCount_one, S.group.addCount_other)}
            </button>
          </div>
        ) : undefined
      }
    >
      {showAdd ? (
        <>
          <p className="msg-hint msg-sheet-pad">{S.group.addHint}</p>
          {candidates.length === 0 ? (
            <p className="msg-hint center">{S.group.noOneToAdd}</p>
          ) : (
            <MemberPicker candidates={candidates} selected={selected} onToggle={toggleSelected} />
          )}
        </>
      ) : (
        <div className="msg-sheet-pad msg-stack-gap">
          <div className="msg-group-hero">
            <StackedAvatars members={members} size={64} />
            <strong>{conversation.name || plural(total, S.group.untitled_one, S.group.untitled_other)}</strong>
            <span className="msg-hint">{plural(total, S.group.memberCount_one, S.group.memberCount_other)}</span>
          </div>
          <label className="field">
            {S.group.name}
            <span className="field-row">
              <input
                className="input"
                value={name}
                maxLength={100}
                placeholder={S.group.namePlaceholder}
                onChange={(e) => setName(e.target.value.slice(0, 100))}
                onKeyDown={(e) => e.key === "Enter" && void rename()}
              />
              <button type="button" className="button outline icon" aria-label={S.group.rename} onClick={() => void rename()} disabled={renaming || name.trim() === (conversation.name ?? "")}>
                {renaming ? <Loader2 size={16} className="spin" /> : <Pencil size={16} />}
              </button>
            </span>
          </label>
          <SettingRow title={S.mute.label} hint={S.mute.hint}>
            <Toggle checked={muted} label={S.mute.label} onChange={(v) => setConversationMuted(conversation.id, v)} />
          </SettingRow>
          <div className="msg-split">
            <span className="eyebrow">{S.group.members}</span>
            <button type="button" className="button ghost small" onClick={() => setShowAdd(true)} disabled={room <= 0}>
              <UserPlus size={14} /> {S.group.addMembers}
            </button>
          </div>
          <ul className="msg-members">
            <li>
              <PeerAvatar id={identity.id || identity.signingPublicKey} name={identity.displayName} size={32} />
              <span className="grow">{identity.displayName || S.common.anonymous}</span>
              <span className="pill">{S.common.you}</span>
            </li>
            {members.map((m) => {
              const blocked = isAnyBlocked(walletKeys(m), prefs.blocked);
              return (
                <li key={walletKeys(m)[0]}>
                  <PeerAvatar id={m.id || m.signingPublicKey} uri={m.avatarUrl} name={m.displayName} size={32} />
                  <span className={`grow ${blocked ? "struck" : ""}`}>
                    {m.displayName && m.displayName !== "Unknown" ? m.displayName : `${(m.signingPublicKey || m.id || "").slice(0, 12)}…`}
                  </span>
                  <button
                    type="button"
                    className={`button ghost icon msg-icon ${blocked ? "danger" : ""}`}
                    aria-label={blocked ? S.block.unblock : S.block.block}
                    title={blocked ? S.block.unblock : S.block.block}
                    onClick={() => toggleBlock(m)}
                  >
                    <Ban size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="msg-hint">{S.group.e2eNote}</p>
        </div>
      )}
    </Sheet>
  );
}

export function BlockedSheet({ onClose }: { onClose: () => void }) {
  const { blocked } = useMessengerPrefs();
  const [directory, setDirectory] = useState<Wallet[]>([]);
  useEffect(() => {
    getWallets()
      .then(setDirectory)
      .catch(() => setDirectory([]));
  }, []);
  const lookup = (key: string) => directory.find((w) => walletKeys(w).includes(key));
  const unblock = (key: string) => {
    const w = lookup(key);
    unblockWalletKeys(w ? [key, ...walletKeys(w)] : [key]);
    toast.success(fmt(S.block.unblocked, { name: w?.displayName || S.common.anonymous }));
  };
  const keys = [...blocked];
  return (
    <Sheet title={S.block.title} icon={<Ban size={16} className="accent" />} onClose={onClose}>
      {keys.length === 0 ? (
        <div className="msg-center msg-empty">
          <ShieldCheck size={32} aria-hidden="true" />
          <strong>{S.block.emptyTitle}</strong>
          <span>{S.block.emptyBody}</span>
        </div>
      ) : (
        <div className="msg-sheet-pad">
          <p className="msg-hint">{S.block.hint}</p>
          <ul className="msg-members">
            {keys.map((key) => {
              const w = lookup(key);
              return (
                <li key={key}>
                  <PeerAvatar id={w?.id || key} uri={w?.avatarUrl} name={w?.displayName} size={32} />
                  <span className="grow">
                    {w?.displayName || S.common.anonymous}
                    <small className="mono">{key.slice(0, 24)}…</small>
                  </span>
                  <button type="button" className="button outline small" onClick={() => unblock(key)}>
                    {S.block.unblock}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Sheet>
  );
}

/** Privacy & notifications (apps/web PrivacySettings + the page's notification toggle). */
export function PrivacySheet({ displayName, onClose }: { displayName: string; onClose: () => void }) {
  const [settings, setSettings] = useState(getPrivacySettings);
  const [notif, setNotif] = useState(loadNotificationSettings);
  const [name, setName] = useState(displayName);
  const [saving, setSaving] = useState(false);

  const savePrivacy = (next: typeof settings, toastText?: string) => {
    setSettings(next);
    savePrivacySettings(next);
    if (toastText) toast.info(toastText);
  };
  const saveNotif = (next: typeof notif) => {
    setNotif(next);
    saveNotificationSettings(next);
  };

  return (
    <Sheet title={S.privacy.title} icon={<Shield size={16} className="accent" />} onClose={onClose}>
      <div className="msg-sheet-pad msg-stack-gap">
        <form
          className="field"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim() || name.trim() === displayName) return;
            setSaving(true);
            try {
              await setProfileDisplayName(name);
              notifyWalletChanged();
              toast.success(S.privacy.profileSaved);
            } catch (err) {
              toast.error(S.privacy.profileFailed, { description: errText(err) });
            } finally {
              setSaving(false);
            }
          }}
        >
          {S.privacy.displayName}
          <span className="field-row">
            <input className="input" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="button outline" disabled={saving || !name.trim() || name.trim() === displayName}>
              {saving ? <Loader2 size={15} className="spin" /> : S.common.save}
            </button>
          </span>
        </form>
        <SettingRow title={S.privacy.discoverable} hint={S.privacy.discoverableHint}>
          <Toggle
            checked={settings.discoverable}
            label={S.privacy.discoverable}
            onChange={(v) => {
              // Takes effect on the next registration (page load or "Re-register"), as in apps/web.
              savePrivacy({ ...settings, discoverable: v });
            }}
          />
        </SettingRow>
        <SettingRow title={S.privacy.storeSent} hint={S.privacy.storeSentHint}>
          <Toggle
            checked={settings.storeSentMessages}
            label={S.privacy.storeSent}
            onChange={(v) => savePrivacy({ ...settings, storeSentMessages: v }, v ? S.privacy.storeOn : S.privacy.storeOff)}
          />
        </SettingRow>
        <button
          type="button"
          className="button outline small"
          onClick={() => {
            clearStoredSentMessages();
            toast.success(S.privacy.cleared);
          }}
        >
          {S.privacy.clearSent}
        </button>
        <SettingRow title={S.privacy.notifications} hint={S.privacy.notificationsHint}>
          <Toggle
            checked={notif.enabled}
            label={S.privacy.notifications}
            onChange={(v) => {
              saveNotif({ ...notif, enabled: v });
              if (v) void requestNotificationPermission();
            }}
          />
        </SettingRow>
        <SettingRow title={S.privacy.sound}>
          <Toggle checked={notif.sound} label={S.privacy.sound} disabled={!notif.enabled} onChange={(v) => saveNotif({ ...notif, sound: v })} />
        </SettingRow>
      </div>
    </Sheet>
  );
}

