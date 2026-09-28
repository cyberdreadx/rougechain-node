/**
 * Batch 4 — chat parity with Qwalla. Samples are exactly what Qwalla puts on the wire
 * (app/(tabs)/messenger/[id].tsx buildMsgEnvelope / sendGif / sendSticker, GifPicker.tsx,
 * packages/qwalla-core/pq/encryption.ts encryptMailV2 / decryptMailV2).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applyEnvelopes, buildMsgEnvelope, parseEnvelope } from "@/lib/messenger-envelope";
import { buildStickerBody, classifyBody, giphyUrl, isAutoloadImage, parseGiphyResponse, parseSticker } from "@/lib/messenger-content";
import {
  acceptChat,
  blockWalletKeys,
  classifyConversation,
  filterBlockedMessages,
  getAcceptedChats,
  getBlockedList,
  isConversationMuted,
  lastSeenOwnMessageId,
  migrateExistingChats,
  notifiableActivity,
  otherMembers,
  receiptStatus,
  setConversationMuted,
  unblockWalletKeys,
  unreadIncomingIds,
  type ConversationLike,
} from "@/lib/messenger-prefs";

// Qwalla's own envelope builder, verbatim.
const qwallaMsgEnvelope = (body: string, replyTo?: string) =>
  JSON.stringify(replyTo ? { v: 1, k: "msg", b: body, r: replyTo } : { v: 1, k: "msg", b: body });

const GIPHY_URL = "https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/3o7abKhOpu0NwenH3O/giphy.gif?cid=790b7611&rid=giphy.gif&ct=g";

describe("new message kinds — byte-for-byte with Qwalla", () => {
  it("GIF: the site sends exactly Qwalla's sendGif envelope", () => {
    expect(buildMsgEnvelope(GIPHY_URL)).toBe(qwallaMsgEnvelope(GIPHY_URL));
    expect(buildMsgEnvelope(GIPHY_URL)).toBe(`{"v":1,"k":"msg","b":"${GIPHY_URL}"}`);
    const env = parseEnvelope(qwallaMsgEnvelope(GIPHY_URL));
    expect(env).toEqual({ kind: "msg", body: GIPHY_URL, replyTo: undefined });
    expect(classifyBody(GIPHY_URL)).toBe("gif");
    expect(isAutoloadImage(GIPHY_URL)).toBe(true);
  });

  it("GIF reply keeps the r field", () => {
    expect(buildMsgEnvelope(GIPHY_URL, { replyTo: "m9" })).toBe(qwallaMsgEnvelope(GIPHY_URL, "m9"));
  });

  it("decoded GIF / sticker / voice / photo bodies survive applyEnvelopes as plaintext", () => {
    const sticker = buildStickerBody("Party", "🎉");
    expect(sticker).toBe("[sticker:Party]🎉");
    const out = applyEnvelopes([
      { id: "g", plaintext: qwallaMsgEnvelope(GIPHY_URL) },
      { id: "s", plaintext: qwallaMsgEnvelope(sticker) },
      { id: "v", plaintext: qwallaMsgEnvelope("data:audio/mp4;base64,AAAA") },
      { id: "p", plaintext: qwallaMsgEnvelope("data:image/jpeg;base64,/9j/4AAQ") },
    ]);
    expect(out.map((m) => m.plaintext)).toEqual([GIPHY_URL, sticker, "data:audio/mp4;base64,AAAA", "data:image/jpeg;base64,/9j/4AAQ"]);
    expect(out.map((m) => classifyBody(m.plaintext))).toEqual(["gif", "sticker", "voice", "image"]);
    expect(parseSticker(sticker)).toEqual({ label: "Party", emoji: "🎉" });
  });

  it("classifies bodies with Qwalla's regexes and order", () => {
    expect(classifyBody("[tip:5:XRGE]")).toBe("tip");
    expect(classifyBody("https://example.com/cat.png")).toBe("image");
    expect(classifyBody("https://example.com/a.webp")).toBe("gif");
    expect(classifyBody("🔥🔥")).toBe("emoji");
    expect(classifyBody("123")).toBe("text");
    expect(classifyBody("hello https://x.com")).toBe("text");
    expect(classifyBody("javascript:alert(1)//.gif")).toBe("text");
    expect(isAutoloadImage("https://evil.example/track.gif")).toBe(false);
    expect(isAutoloadImage("http://media.giphy.com/x.gif")).toBe(false);
  });

  it("queries GIPHY like Qwalla's GifPicker and maps images", () => {
    const trending = new URL(giphyUrl("", "KEY"));
    expect(trending.origin + trending.pathname).toBe("https://api.giphy.com/v1/gifs/trending");
    expect(Object.fromEntries(trending.searchParams)).toEqual({ api_key: "KEY", limit: "20", rating: "pg-13" });
    const search = new URL(giphyUrl(" cats ", "KEY"));
    expect(search.pathname).toBe("/v1/gifs/search");
    expect(search.searchParams.get("q")).toBe("cats");
    expect(parseGiphyResponse({
      data: [
        { id: "a", images: { fixed_width_small: { url: "https://media.giphy.com/s.gif" }, original: { url: "https://media.giphy.com/o.gif" } } },
        { id: "b", images: { fixed_width: { url: "https://media.giphy.com/w.gif" } } },
        { id: "c", images: {} },
      ],
    })).toEqual([
      { id: "a", preview: "https://media.giphy.com/s.gif", full: "https://media.giphy.com/o.gif" },
      { id: "b", preview: "https://media.giphy.com/w.gif", full: "" },
    ]);
    expect(parseGiphyResponse(null)).toEqual([]);
  });
});

// ── Requests / mute / block ─────────────────────────────────────────────
const me = { id: "uuid-me", signingPublicKey: "sig-me", encryptionPublicKey: "enc-me" };
const myIds = new Set([me.id, me.signingPublicKey, me.encryptionPublicKey]);
const bob = { id: "uuid-bob", signingPublicKey: "sig-bob", encryptionPublicKey: "enc-bob", displayName: "Bob" };
const carol = { id: "uuid-carol", signingPublicKey: "sig-carol", encryptionPublicKey: "enc-carol", displayName: "Carol" };
const dm = (over: Partial<ConversationLike> = {}): ConversationLike => ({ id: "dm_1", isGroup: false, participants: [me, bob], ...over });

describe("message request classification (Qwalla lib/message-requests.ts)", () => {
  const ctx = (over: Partial<{ accepted: Set<string>; blocked: Set<string> }> = {}) => ({ myIds, accepted: new Set<string>(), blocked: new Set<string>(), ...over });

  it("a new incoming 1:1 is a request until accepted", () => {
    expect(classifyConversation(dm({ createdBy: bob.id, lastSenderId: bob.id }), ctx())).toBe("request");
    expect(classifyConversation(dm({ createdBy: bob.id }), ctx({ accepted: new Set(["dm_1"]) }))).toBe("primary");
  });

  it("chats I started or answered are never requests", () => {
    expect(classifyConversation(dm({ createdBy: me.id }), ctx())).toBe("primary");
    expect(classifyConversation(dm({ createdBy: bob.id, lastSenderId: me.signingPublicKey }), ctx())).toBe("primary");
  });

  it("groups are never gated; note-to-self and the bot are primary", () => {
    expect(classifyConversation({ id: "g", isGroup: true, participants: [me, bob] }, ctx())).toBe("primary");
    expect(classifyConversation({ id: "g2", participants: [me, bob, carol] }, ctx())).toBe("primary");
    expect(classifyConversation({ id: "n", participants: [me] }, ctx())).toBe("primary");
    expect(classifyConversation({ id: "b", participants: [me, { id: "bot-1" }] }, ctx())).toBe("primary");
  });

  it("a 1:1 whose other member is blocked is hidden (any key form); a group stays", () => {
    expect(classifyConversation(dm(), ctx({ blocked: new Set(["sig-bob"]) }))).toBe("hidden");
    expect(classifyConversation(dm({ participants: undefined, participantIds: ["uuid-me", "uuid-bob"] }), ctx({ blocked: new Set(["uuid-bob"]) }))).toBe("hidden");
    expect(classifyConversation({ id: "g", participants: [me, bob, carol] }, ctx({ blocked: new Set(["sig-bob"]) }))).toBe("primary");
  });

  it("otherMembers dedupes id forms and skips me", () => {
    expect(otherMembers({ id: "x", participants: [me, bob, { ...bob }], participantIds: ["sig-me", "sig-bob"] }, myIds)).toEqual([bob]);
    expect(otherMembers({ id: "x", participantIds: ["sig-me", "sig-bob", "sig-carol"] }, myIds).map((p) => p.id)).toEqual(["sig-bob", "sig-carol"]);
  });
});

describe("mute / block storage and filtering", () => {
  beforeEach(() => localStorage.clear());

  it("mute toggles per conversation", () => {
    expect(isConversationMuted("c1")).toBe(false);
    setConversationMuted("c1", true);
    setConversationMuted("c1", true);
    expect(isConversationMuted("c1")).toBe(true);
    expect(JSON.parse(localStorage.getItem("pqc_muted_conversations")!)).toEqual(["c1"]);
    setConversationMuted("c1", false);
    expect(isConversationMuted("c1")).toBe(false);
  });

  it("block stores the signing key; unblock clears every id form", () => {
    localStorage.setItem("pqc_blocked_wallets", JSON.stringify(["uuid-bob"])); // legacy site entry
    blockWalletKeys(["sig-carol", "uuid-carol"]);
    expect(getBlockedList()).toEqual(["uuid-bob", "sig-carol"]);
    blockWalletKeys(["sig-bob", "uuid-bob"]); // already blocked by another form: no duplicate
    expect(getBlockedList()).toEqual(["uuid-bob", "sig-carol"]);
    unblockWalletKeys(["sig-bob", "uuid-bob", "enc-bob"]);
    expect(getBlockedList()).toEqual(["sig-carol"]);
  });

  it("grandfathers existing chats once, then only explicit accepts", () => {
    expect(migrateExistingChats(["a", "b"])).toBe(true);
    expect(migrateExistingChats(["c"])).toBe(false);
    acceptChat("d");
    expect(getAcceptedChats()).toEqual(["a", "b", "d"]);
  });

  it("hides blocked senders' messages but never mine", () => {
    const msgs = [
      { id: "1", senderWalletId: "uuid-bob" },
      { id: "2", senderWalletId: "uuid-carol" },
      { id: "3", senderWalletId: "uuid-me" },
    ];
    const keysOf = (id: string) => [bob, carol].find((w) => w.id === id) ? Object.values([bob, carol].find((w) => w.id === id)!) : [];
    expect(filterBlockedMessages(msgs, new Set(["sig-bob"]), myIds, keysOf).map((m) => m.id)).toEqual(["2", "3"]);
    expect(filterBlockedMessages(msgs, new Set(["sig-me"]), myIds, keysOf).map((m) => m.id)).toEqual(["1", "2", "3"]);
    expect(filterBlockedMessages(msgs, new Set(), myIds, keysOf)).toBe(msgs);
  });

  it("muted chats and blocked senders don't alert", () => {
    const activity = [
      { conversationId: "a", lastSenderId: "uuid-bob" },
      { conversationId: "b", lastSenderId: "uuid-carol" },
      { conversationId: "c", lastSenderId: "uuid-dave" },
    ];
    const keysOf = (id: string) => (id === "uuid-carol" ? ["sig-carol"] : []);
    expect(notifiableActivity(activity, new Set(["a"]), new Set(["sig-carol"]), keysOf).map((a) => a.conversationId)).toEqual(["c"]);
  });
});

describe("read receipts (node read_at, Qwalla statusOf)", () => {
  const own = (m: { senderWalletId: string }) => myIds.has(m.senderWalletId);
  const msgs = [
    { id: "1", senderWalletId: "uuid-me", createdAt: "2026-09-01T10:00:00Z", readAt: "2026-09-01T10:01:00Z" },
    { id: "2", senderWalletId: "uuid-bob", createdAt: "2026-09-01T10:02:00Z" },
    { id: "3", senderWalletId: "uuid-me", createdAt: "2026-09-01T10:03:00Z", isRead: true },
    { id: "4", senderWalletId: "uuid-me", createdAt: "2026-09-01T10:04:00Z" },
    { id: "5", senderWalletId: "uuid-bob", createdAt: "2026-09-01T10:05:00Z", readAt: "2026-09-01T10:06:00Z" },
  ];

  it("maps read_at / is_read to read, stored to delivered, pending to sent", () => {
    expect(msgs.map((m) => receiptStatus(m))).toEqual(["read", "delivered", "read", "delivered", "read"]);
    expect(receiptStatus({})).toBe("sent");
  });

  it("puts Seen on the newest read message of mine", () => {
    expect(lastSeenOwnMessageId(msgs, own)).toBe("3");
    expect(lastSeenOwnMessageId(msgs.filter((m) => m.id === "4"), own)).toBeNull();
  });

  it("marks only unread incoming messages", () => {
    expect(unreadIncomingIds(msgs, myIds)).toEqual(["2"]);
  });
});
