/**
 * Device-local messenger preferences that mirror Qwalla (the node has no server-side mute,
 * block or "accept" primitive, so Qwalla keeps all three on the device):
 *
 *  - mute     Qwalla stores/muted-conversations.ts — a list of conversationIds. Muting silences
 *             in-app alerts (sound / desktop notification); unread badges still update.
 *  - requests Qwalla lib/message-requests.ts — a 1:1 chat you didn't start and haven't accepted is
 *             a *request*. Existing chats are grandfathered once ("migration") so only genuinely
 *             new incoming chats become requests. Groups are never gated.
 *  - block    Qwalla packages/qwalla-core/wallet/blocked-users.ts — keyed by the contact's signing
 *             public key. 1:1 chats whose only other member is blocked are hidden; in groups the
 *             blocked member's messages are hidden (you stay in the group).
 *
 * The site already had a block list under `pqc_blocked_wallets` (ids or keys); it is reused, and
 * matching checks every id form of a wallet (id / signing key / encryption key).
 * Everything here is plain functions over localStorage plus pure helpers that the tests cover.
 */

export const MUTED_KEY = "pqc_muted_conversations";
export const ACCEPTED_KEY = "pqc_accepted_chats";
export const REQUESTS_MIGRATED_KEY = "pqc_requests_migrated";
export const BLOCKED_KEY = "pqc_blocked_wallets";

/** Fired on window whenever mute / accept / block lists change, so open views re-render. */
export const MESSENGER_PREFS_EVENT = "rougechain:messenger-prefs";

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify([...new Set(list)]));
  } catch {
    /* storage full / blocked: the choice just won't persist */
  }
  try {
    window.dispatchEvent(new Event(MESSENGER_PREFS_EVENT));
  } catch {
    /* no window (tests without DOM) */
  }
}

// ── Mute ──────────────────────────────────────────────────────────────────

export function getMutedConversations(): string[] {
  return readList(MUTED_KEY);
}

export function isConversationMuted(conversationId: string | undefined): boolean {
  return !!conversationId && getMutedConversations().includes(conversationId);
}

export function setConversationMuted(conversationId: string, muted: boolean): void {
  if (!conversationId) return;
  const list = getMutedConversations().filter((id) => id !== conversationId);
  if (muted) list.push(conversationId);
  writeList(MUTED_KEY, list);
}

// ── Requests ──────────────────────────────────────────────────────────────

export function getAcceptedChats(): string[] {
  return readList(ACCEPTED_KEY);
}

export function acceptChat(conversationId: string): void {
  if (!conversationId) return;
  const list = getAcceptedChats();
  if (list.includes(conversationId)) return;
  writeList(ACCEPTED_KEY, [...list, conversationId]);
}

export function acceptChats(conversationIds: string[]): void {
  const list = getAcceptedChats();
  const next = [...new Set([...list, ...conversationIds.filter(Boolean)])];
  if (next.length !== list.length) writeList(ACCEPTED_KEY, next);
}

/**
 * One-time migration: grandfather every conversation that exists now as accepted, so turning the
 * feature on doesn't quarantine chats the user already has. Returns true if it ran.
 */
export function migrateExistingChats(conversationIds: string[]): boolean {
  try {
    if (localStorage.getItem(REQUESTS_MIGRATED_KEY)) return false;
    acceptChats(conversationIds);
    localStorage.setItem(REQUESTS_MIGRATED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

// ── Block ─────────────────────────────────────────────────────────────────

export function getBlockedList(): string[] {
  return readList(BLOCKED_KEY);
}

/** A wallet's id forms (id / signing key / encryption key), empty ones dropped. */
export function walletKeys(w: { id?: string; signingPublicKey?: string; encryptionPublicKey?: string } | null | undefined): string[] {
  if (!w) return [];
  return [w.signingPublicKey, w.id, w.encryptionPublicKey].filter((k): k is string => typeof k === "string" && k.length > 0);
}

export function isAnyBlocked(keys: string[], blocked: Set<string> = new Set(getBlockedList())): boolean {
  return keys.some((k) => blocked.has(k));
}

/** Block a wallet. Stores its signing key when known (Qwalla's key), else whatever id we have. */
export function blockWalletKeys(keys: string[]): void {
  const key = keys.find(Boolean);
  if (!key) return;
  const list = getBlockedList();
  if (keys.some((k) => list.includes(k))) return;
  writeList(BLOCKED_KEY, [...list, key]);
}

/** Unblock a wallet: removes every id form of it from the list. */
export function unblockWalletKeys(keys: string[]): void {
  const drop = new Set(keys.filter(Boolean));
  writeList(BLOCKED_KEY, getBlockedList().filter((k) => !drop.has(k)));
}

// ── Pure helpers (tested) ─────────────────────────────────────────────────

export interface ParticipantLike {
  id?: string;
  signingPublicKey?: string;
  encryptionPublicKey?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface ConversationLike {
  id: string;
  name?: string;
  isGroup?: boolean;
  createdBy?: string;
  participantIds?: string[];
  participants?: ParticipantLike[];
  lastSenderId?: string;
}

/**
 * The other members of a conversation, one entry per member (deduped across id forms). Uses the
 * resolved participant records when present, else the raw participant ids.
 */
export function otherMembers(conv: ConversationLike, myIds: Set<string>): ParticipantLike[] {
  const out: ParticipantLike[] = [];
  const seen = new Set<string>();
  const add = (p: ParticipantLike) => {
    const keys = walletKeys(p);
    if (keys.length === 0 || keys.some((k) => myIds.has(k) || seen.has(k))) return;
    keys.forEach((k) => seen.add(k));
    out.push(p);
  };
  for (const p of conv.participants ?? []) add(p);
  for (const id of conv.participantIds ?? []) {
    if (!id || seen.has(id) || myIds.has(id)) continue;
    // An id not covered by a resolved record (e.g. participants not loaded yet).
    if ((conv.participants ?? []).length === 0) add({ id });
  }
  return out;
}

/** Qwalla's isGroupConvo: flagged as a group, or more than one other member. */
export function isGroupConversation(conv: ConversationLike, myIds: Set<string>): boolean {
  return !!conv.isGroup || otherMembers(conv, myIds).length > 1;
}

export type ConversationClass = "primary" | "request" | "hidden";

/**
 * Where a conversation belongs in the list (Qwalla app/(tabs)/messenger/index.tsx):
 *  - hidden:  a 1:1 whose only other member is blocked;
 *  - primary: groups, notes to self / bot chats, accepted chats, chats I created or last wrote in;
 *  - request: any other 1:1 (someone new wrote first and I haven't accepted).
 * The "created by me / last sender is me" rule is a site addition: the accepted list is per device,
 * so a chat I started or answered on Qwalla must not land in Requests on the site.
 */
export function classifyConversation(
  conv: ConversationLike,
  ctx: { myIds: Set<string>; accepted: Set<string>; blocked: Set<string> },
): ConversationClass {
  const others = otherMembers(conv, ctx.myIds);
  if (isGroupConversation(conv, ctx.myIds)) return "primary";
  if (others.length === 1 && isAnyBlocked(walletKeys(others[0]), ctx.blocked)) return "hidden";
  if (others.length === 0) return "primary"; // note to self (or unresolved)
  if (conv.name === "Quantum Bot" || others.some((p) => p.id?.startsWith("bot-"))) return "primary";
  if (ctx.accepted.has(conv.id)) return "primary";
  if (conv.createdBy && ctx.myIds.has(conv.createdBy)) return "primary";
  if (conv.lastSenderId && ctx.myIds.has(conv.lastSenderId)) return "primary";
  return "request";
}

/**
 * Drop messages sent by blocked wallets (never my own). `senderKeys` resolves a sender id (the
 * node's sender_wallet_id) to all of that wallet's id forms.
 */
export function filterBlockedMessages<M extends { senderWalletId: string }>(
  messages: M[],
  blocked: Set<string>,
  myIds: Set<string>,
  senderKeys: (senderId: string) => string[],
): M[] {
  if (blocked.size === 0) return messages;
  return messages.filter((m) => {
    if (myIds.has(m.senderWalletId)) return true;
    const keys = [m.senderWalletId, ...senderKeys(m.senderWalletId)];
    return !isAnyBlocked(keys, blocked);
  });
}

/**
 * Which conversations may alert (sound / desktop notification): not muted, and the last sender
 * isn't blocked. Muted chats still refresh and keep their unread badge.
 */
export function notifiableActivity<A extends { conversationId: string; lastSenderId?: string }>(
  activity: A[],
  muted: Set<string>,
  blocked: Set<string>,
  senderKeys: (senderId: string) => string[] = () => [],
): A[] {
  return activity.filter((a) => {
    if (muted.has(a.conversationId)) return false;
    if (a.lastSenderId && isAnyBlocked([a.lastSenderId, ...senderKeys(a.lastSenderId)], blocked)) return false;
    return true;
  });
}

// ── Read receipts ─────────────────────────────────────────────────────────

export type ReceiptStatus = "sent" | "delivered" | "read";

/**
 * Qwalla's statusOf: the node sets `read_at` when a recipient opens the chat
 * (POST /v2/messenger/messages/read). Mine + read_at → read; mine otherwise → delivered
 * (it's stored on the node once it has an id); a local pending message → sent.
 */
export function receiptStatus(m: { id?: string; readAt?: string; isRead?: boolean }): ReceiptStatus {
  if (!m.id) return "sent";
  if (m.readAt || m.isRead) return "read";
  return "delivered";
}

/** The newest of my messages that has been read — where the "Seen" label goes. */
export function lastSeenOwnMessageId<M extends { id: string; readAt?: string; isRead?: boolean; createdAt?: string }>(
  messages: M[],
  isOwn: (m: NoInfer<M>) => boolean,
): string | null {
  let best: M | null = null;
  for (const m of messages) {
    if (!isOwn(m) || receiptStatus(m) !== "read") continue;
    if (!best || (m.createdAt ?? "") >= (best.createdAt ?? "")) best = m;
  }
  return best?.id ?? null;
}

/** Incoming messages I haven't marked read yet (what to POST to /messages/read). */
export function unreadIncomingIds<M extends { id: string; readAt?: string; isRead?: boolean; senderWalletId: string }>(
  messages: M[],
  myIds: Set<string>,
): string[] {
  return messages.filter((m) => m.id && !myIds.has(m.senderWalletId) && !m.readAt && !m.isRead).map((m) => m.id);
}
