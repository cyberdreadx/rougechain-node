/** Mail threading + device-local mail settings, ported unchanged from apps/web's pages/Mail.tsx. */
import type { MailItem } from "@rougechain/core/pqc-mail";

/** apps/web's key; same shape, so the signature survives the switch to site-next. */
export const MAIL_SETTINGS_KEY = "pqc_mail_settings";

export interface MailSettings {
  signature: string;
  signatureEnabled: boolean;
}

export function loadMailSettings(): MailSettings {
  try {
    const raw = localStorage.getItem(MAIL_SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<MailSettings>;
      return { signature: typeof p.signature === "string" ? p.signature : "", signatureEnabled: !!p.signatureEnabled };
    }
  } catch {
    /* unreadable: defaults */
  }
  return { signature: "", signatureEnabled: false };
}

export function saveMailSettings(settings: MailSettings): void {
  try {
    localStorage.setItem(MAIL_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

/** The signature block appended to a new mail / reply (apps/web ComposeView). */
export function signatureBlock(s: MailSettings): string {
  return s.signatureEnabled && s.signature.trim() ? `\n\n--\n${s.signature.trim()}` : "";
}

function findRootId(item: MailItem, byId: Map<string, MailItem>): string {
  let rootId = item.message.id;
  let cur = item.message;
  const seen = new Set<string>([rootId]);
  while (cur.replyToId && byId.has(cur.replyToId) && !seen.has(cur.replyToId)) {
    rootId = cur.replyToId;
    seen.add(rootId);
    cur = byId.get(cur.replyToId)!.message;
  }
  return rootId;
}

/** Every mail in `selected`'s thread, oldest first. */
export function buildThread(allItems: MailItem[], selected: MailItem): MailItem[] {
  const byId = new Map<string, MailItem>();
  for (const item of allItems) byId.set(item.message.id, item);
  const rootId = findRootId(selected, byId);
  const ids = new Set<string>();
  const collect = (parentId: string) => {
    ids.add(parentId);
    for (const item of allItems) if (item.message.replyToId === parentId && !ids.has(item.message.id)) collect(item.message.id);
  };
  collect(rootId);
  return allItems.filter((i) => ids.has(i.message.id)).sort((a, b) => new Date(a.message.createdAt).getTime() - new Date(b.message.createdAt).getTime());
}

export interface ThreadGroup {
  rootId: string;
  subject: string;
  latestItem: MailItem;
  messages: MailItem[];
  participants: string[];
  hasUnread: boolean;
  latestDate: string;
}

/** Folder items grouped by thread, newest thread first. */
export function groupByThread(items: MailItem[]): ThreadGroup[] {
  const byId = new Map<string, MailItem>();
  for (const item of items) byId.set(item.message.id, item);
  const groups = new Map<string, MailItem[]>();
  for (const item of items) {
    const root = findRootId(item, byId);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  }
  const out: ThreadGroup[] = [];
  for (const [rootId, msgs] of groups) {
    msgs.sort((a, b) => new Date(a.message.createdAt).getTime() - new Date(b.message.createdAt).getTime());
    const latest = msgs[msgs.length - 1];
    const root = byId.get(rootId);
    out.push({
      rootId,
      subject: root?.message.subject || latest.message.subject || "(No subject)",
      latestItem: latest,
      messages: msgs,
      participants: [...new Set(msgs.map((m) => m.message.senderName || "Unknown"))],
      hasUnread: msgs.some((m) => !m.label.isRead),
      latestDate: latest.message.createdAt,
    });
  }
  return out.sort((a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime());
}

export function formatMailDate(input: string, now = new Date()): string {
  const d = new Date(input);
  if (isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
