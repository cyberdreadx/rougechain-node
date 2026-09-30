/**
 * In-chat payloads (payments, payment requests, reactions, replies), ported unchanged from
 * apps/web's components/messenger/ChatPayment / ChatReactions / ChatReply so both sites send and
 * read the same wire format. Everything is built on core's messenger-envelope (Qwalla envelopes);
 * the legacy `PAYMENT:` / `REQUEST:` / `REACTION:` / `REPLY:` prefixes are only parsed (old history).
 */
import { buildMsgEnvelope, buildRxEnvelope, parseEnvelope, parseTip, type EnvelopeData } from "@rougechain/core/messenger-envelope";
import type { Message } from "@rougechain/core/pqc-messenger";
import i18n from "../i18n";
import { fmtDate, fmtTime } from "../i18n/format";

// ── Payments ──────────────────────────────────────────────────────────────

export interface PaymentMessageData {
  type: "payment";
  token: string;
  amount: number;
  txHash?: string;
  status: "sent" | "confirmed" | "failed";
  memo?: string;
}

export function parsePaymentMessage(text: string): PaymentMessageData | null {
  if (!text.startsWith("PAYMENT:")) return null;
  try {
    return JSON.parse(text.slice(8));
  } catch {
    return null;
  }
}

/** A Qwalla msg envelope: readable body (what Qwalla / the extension show) + a `pay` field. */
export function encodePaymentMessage(data: PaymentMessageData): string {
  const { type: _type, ...pay } = data;
  void _type;
  const memo = data.memo ? ` — ${data.memo}` : "";
  return buildMsgEnvelope(`💸 Sent ${data.amount} ${data.token}${memo}`, { pay });
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const optStr = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

export function paymentFromEnvelope(pay: EnvelopeData | undefined): PaymentMessageData | null {
  if (!pay || typeof pay.token !== "string" || !isNum(pay.amount)) return null;
  const status = pay.status === "confirmed" || pay.status === "failed" ? pay.status : "sent";
  return { type: "payment", token: pay.token, amount: pay.amount, txHash: optStr(pay.txHash), status, memo: optStr(pay.memo) };
}

export function getPaymentData(message: { plaintext?: string; pay?: EnvelopeData }): PaymentMessageData | null {
  return paymentFromEnvelope(message.pay) ?? (message.plaintext ? parsePaymentMessage(message.plaintext) : null);
}

// ── Payment requests ──────────────────────────────────────────────────────

export interface RequestMessageData {
  type: "request";
  token: string;
  amount: number;
  memo?: string;
}

export function parseRequestMessage(text: string): RequestMessageData | null {
  if (!text.startsWith("REQUEST:")) return null;
  try {
    return JSON.parse(text.slice(8));
  } catch {
    return null;
  }
}

export function encodeRequestMessage(data: RequestMessageData): string {
  const { type: _type, ...req } = data;
  void _type;
  const memo = data.memo ? ` — ${data.memo}` : "";
  return buildMsgEnvelope(`🧾 Requested ${data.amount} ${data.token}${memo}`, { req });
}

export function requestFromEnvelope(req: EnvelopeData | undefined): RequestMessageData | null {
  if (!req || typeof req.token !== "string" || !isNum(req.amount)) return null;
  return { type: "request", token: req.token, amount: req.amount, memo: optStr(req.memo) };
}

export function getRequestData(message: { plaintext?: string; req?: EnvelopeData }): RequestMessageData | null {
  return requestFromEnvelope(message.req) ?? (message.plaintext ? parseRequestMessage(message.plaintext) : null);
}

// ── Reactions ─────────────────────────────────────────────────────────────

export const REACTION_EMOJIS = ["👍", "❤️", "😂", "🔥", "👏", "😮"];

export interface ReactionData {
  type: "reaction";
  messageId: string;
  emoji: string;
}

export function parseReactionMessage(text: string): ReactionData | null {
  if (!text.startsWith("REACTION:")) return null;
  try {
    return JSON.parse(text.slice(9));
  } catch {
    return null;
  }
}

/** Qwalla's `{"v":1,"k":"rx",...}` envelope. */
export function encodeReactionMessage(data: ReactionData): string {
  return buildRxEnvelope(data.messageId, data.emoji);
}

/** A legacy reaction message that shouldn't render as a bubble. */
export function isSystemMessage(text: string | undefined): boolean {
  return !!text && text.startsWith("REACTION:");
}

export type ReactionSummary = { emoji: string; count: number; myReaction: boolean };

/** messageId → reactions (counted once per sender per emoji), legacy + envelope reactions. */
export function aggregateReactions(messages: Message[], myIds: Set<string>): Map<string, ReactionSummary[]> {
  const map = new Map<string, Map<string, { count: number; senders: Set<string> }>>();
  const add = (messageId: string, emoji: string, sender: string) => {
    if (!map.has(messageId)) map.set(messageId, new Map());
    const byEmoji = map.get(messageId)!;
    if (!byEmoji.has(emoji)) byEmoji.set(emoji, { count: 0, senders: new Set() });
    const e = byEmoji.get(emoji)!;
    if (!e.senders.has(sender)) {
      e.count++;
      e.senders.add(sender);
    }
  };
  for (const msg of messages) {
    const legacy = msg.plaintext ? parseReactionMessage(msg.plaintext) : null;
    if (legacy) add(legacy.messageId, legacy.emoji, msg.senderWalletId);
    if (msg.reactionsFrom?.length) msg.reactionsFrom.forEach((r, i) => add(msg.id, r.emoji, r.sender ?? `?${i}`));
    else if (msg.reactions?.length) msg.reactions.forEach((emoji, i) => add(msg.id, emoji, `?${i}`));
  }
  const out = new Map<string, ReactionSummary[]>();
  for (const [id, byEmoji] of map)
    out.set(
      id,
      [...byEmoji.entries()].map(([emoji, { count, senders }]) => ({ emoji, count, myReaction: [...senders].some((s) => myIds.has(s)) })),
    );
  return out;
}

// ── Replies ───────────────────────────────────────────────────────────────

export interface ReplyData {
  type: "reply";
  replyTo: string;
  replyPreview: string;
  text: string;
}

export function parseReplyMessage(text: string): ReplyData | null {
  if (!text.startsWith("REPLY:")) return null;
  try {
    return JSON.parse(text.slice(6));
  } catch {
    return null;
  }
}

/** Qwalla msg envelope with `"r"` = id of the message replied to. */
export function encodeReplyMessage(data: Pick<ReplyData, "replyTo" | "text">): string {
  return buildMsgEnvelope(data.text, { replyTo: data.replyTo });
}

// ── Display helpers ───────────────────────────────────────────────────────

/** Readable text of an outgoing plaintext (envelopes → body / emoji). */
export function readableText(raw: string): string {
  const env = parseEnvelope(raw);
  return env.kind === "rx" ? env.emoji : env.body;
}

/** Short quote of a message for a reply; "" when it isn't loaded. */
export function previewText(m: Message | undefined): string {
  if (!m) return "";
  const pay = getPaymentData(m);
  if (pay) return `💸 ${pay.amount} ${pay.token}`;
  const req = getRequestData(m);
  if (req) return `🧾 ${req.amount} ${req.token}`;
  const tip = parseTip(m.plaintext);
  if (tip) return `💸 ${tip.amount} ${tip.symbol}`;
  if (m.mediaUrl) return m.messageType === "video" ? `🎬 ${i18n.t("messenger:media.video")}` : `🖼️ ${i18n.t("messenger:media.image")}`;
  const legacy = m.plaintext ? parseReplyMessage(m.plaintext) : null;
  return (legacy?.text ?? m.plaintext ?? "").slice(0, 80);
}

export function formatMessageTime(input: string | number | Date): string {
  const d = new Date(input);
  return isNaN(d.getTime()) ? "" : fmtTime(d);
}

export function formatRelativeTime(dateStr: string, now = Date.now()): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "";
  const min = Math.floor((now - date.getTime()) / 60000);
  if (min < 1) return i18n.t("messenger:time.now");
  if (min < 60) return i18n.t("messenger:time.minutes", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return i18n.t("messenger:time.hours", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return i18n.t("messenger:time.days", { n: day });
  return fmtDate(date, { month: "short", day: "numeric" });
}
