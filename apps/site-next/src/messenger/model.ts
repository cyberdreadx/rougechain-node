/**
 * Pure conversation helpers shared by the list and the chat (ported from apps/web's
 * ConversationList / ChatView / Messenger page so both classify and name chats the same way).
 */
import { isNoteToSelf } from "@rougechain/core/messenger-envelope";
import { classifyConversation, isGroupConversation, otherMembers, type ParticipantLike } from "@rougechain/core/messenger-prefs";
import type { Conversation, Wallet } from "@rougechain/core/pqc-messenger";
import { S, plural } from "./strings";

export function idsOf(w: { id?: string; signingPublicKey?: string; encryptionPublicKey?: string } | null | undefined): string[] {
  if (!w) return [];
  return [w.id, w.signingPublicKey, w.encryptionPublicKey].filter((x): x is string => !!x);
}

export function isBotConversation(c: Conversation): boolean {
  return c.name === "Quantum Bot" || !!c.participants?.some((p) => p.id?.startsWith("bot-"));
}

/** Note to self: core's isNoteToSelf, never a bot chat (apps/web ChatView / ConversationList). */
export function isSelfChat(c: Conversation, myIds: Set<string>): boolean {
  return !isBotConversation(c) && isNoteToSelf(c, myIds);
}

/** The other member of a 1:1 (apps/web getOtherParticipant, including its display-name fallback). */
export function otherParticipant(c: Conversation, myIds: Set<string>, myName?: string): Wallet | undefined {
  let other = c.participants?.find((p) => !myIds.has(p.id) && !myIds.has(p.signingPublicKey) && !myIds.has(p.encryptionPublicKey));
  if (!other && myName && c.participants && c.participants.length === 2) other = c.participants.find((p) => p.displayName !== myName);
  return other;
}

const GENERIC_NAMES = new Set(["My Wallet", "Unknown", ""]);
/** Names too common to identify me (apps/web's name-prompt list, lowercased). */
export const GENERIC_SELF_NAMES = new Set(["my wallet", "wallet", "unnamed", "untitled", "extension wallet", "recovered wallet", "rougechain user", "unknown", ""]);

/**
 * List title of a conversation. "" means "no real name": the caller falls back to the peer's
 * rouge1 address (apps/web ConversationNameDisplay).
 */
export function conversationTitle(
  c: Conversation,
  myIds: Set<string>,
  opts: { myName?: string; nickname?: (p: ParticipantLike) => string | null } = {},
): string {
  if (isSelfChat(c, myIds)) return S.list.noteToSelf;
  if (isGroupConversation(c, myIds)) {
    const n = otherMembers(c, myIds).length + 1;
    return c.name || plural(n, S.group.untitled_one, S.group.untitled_other);
  }
  const other = otherParticipant(c, myIds, opts.myName);
  if (other) {
    const nick = opts.nickname?.(other);
    if (nick) return nick;
    return GENERIC_NAMES.has(other.displayName || "") ? "" : other.displayName || "";
  }
  if (c.name && c.name !== opts.myName) return c.name;
  return c.isGroup ? c.name || "Group" : "";
}

/** Primary vs Requests split (hidden = 1:1 with a blocked peer). */
export function splitConversations(
  conversations: Conversation[],
  ctx: { myIds: Set<string>; accepted: Set<string>; blocked: Set<string> },
): { primary: Conversation[]; requests: Conversation[] } {
  const primary: Conversation[] = [];
  const requests: Conversation[] = [];
  for (const c of conversations) {
    const cls = classifyConversation(c, ctx);
    if (cls === "request") requests.push(c);
    else if (cls === "primary") primary.push(c);
  }
  return { primary, requests };
}

/** Newest activity first (apps/web sort). */
export function sortByActivity(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => (b.lastMessageAt || b.createdAt || "").localeCompare(a.lastMessageAt || a.createdAt || ""));
}

/** Directory wallets usable as contacts: not me, not blocked, one per key (apps/web loadContacts). */
export function contactsFrom(wallets: Wallet[], me: Wallet | null, blocked: Set<string>): Wallet[] {
  const filtered = wallets.filter(
    (w) =>
      w.id !== me?.id &&
      w.id !== me?.signingPublicKey &&
      w.signingPublicKey !== me?.signingPublicKey &&
      w.encryptionPublicKey !== me?.encryptionPublicKey &&
      !blocked.has(w.id) &&
      !blocked.has(w.signingPublicKey) &&
      !blocked.has(w.encryptionPublicKey),
  );
  const unique = new Map<string, Wallet>();
  for (const w of filtered) {
    const key = w.signingPublicKey || w.encryptionPublicKey || w.id;
    const existing = unique.get(key);
    if (!existing || (existing.displayName === "My Wallet" && w.displayName !== "My Wallet") || (!existing.displayName && w.displayName))
      unique.set(key, w);
  }
  return [...unique.values()];
}

/** Replace my own participant records with my identity (apps/web loadConversations). */
export function normalizeMine(convs: Conversation[], me: Wallet): Conversation[] {
  const mine: Wallet = { id: me.id, displayName: me.displayName, signingPublicKey: me.signingPublicKey, encryptionPublicKey: me.encryptionPublicKey };
  return convs.map((c) =>
    c.participants
      ? {
          ...c,
          participants: c.participants.map((p) =>
            p.id === me.id ||
            p.signingPublicKey === me.signingPublicKey ||
            p.encryptionPublicKey === me.encryptionPublicKey ||
            // apps/web also matches on display name (stale ids of my own wallet). Only for a
            // distinctive name: two different "My Wallet"s must never collapse into a note to self.
            (!!me.displayName && !GENERIC_SELF_NAMES.has(me.displayName.trim().toLowerCase()) && p.displayName === me.displayName)
              ? mine
              : p,
          ),
        }
      : c,
  );
}
