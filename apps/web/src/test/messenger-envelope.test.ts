import { describe, expect, it } from "vitest";
import { applyEnvelopes, buildMsgEnvelope, buildRxEnvelope, isNoteToSelf, parseEnvelope, parseTip } from "@/lib/messenger-envelope";
import { encodePaymentMessage, encodeRequestMessage, getPaymentData, getRequestData, parsePaymentMessage } from "@/components/messenger/ChatPayment";
import { aggregateReactions, encodeReactionMessage, isSystemMessage } from "@/components/messenger/ChatReactions";
import { encodeReplyMessage, parseReplyMessage } from "@/components/messenger/ChatReply";
import type { Message } from "@/lib/pqc-messenger";

describe("Qwalla message envelope", () => {
  it("unwraps a message envelope and keeps plain text as is", () => {
    expect(parseEnvelope('{"v":1,"k":"msg","b":"what\'s up"}')).toEqual({ kind: "msg", body: "what's up", replyTo: undefined });
    expect(parseEnvelope("yo")).toEqual({ kind: "msg", body: "yo" });
    expect(parseEnvelope('{"hello":1}')).toEqual({ kind: "msg", body: '{"hello":1}' });
  });

  it("turns reactions into emoji on their target and drops them from the list", () => {
    const out = applyEnvelopes([
      { id: "a", plaintext: '{"v":1,"k":"msg","b":"hi","r":"z"}' },
      { id: "b", plaintext: '{"v":1,"k":"rx","t":"a","e":"🔥"}' },
      { id: "c", plaintext: "[Unable to decrypt]" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["a", "c"]);
    expect(out[0]).toMatchObject({ plaintext: "hi", replyTo: "z", reactions: ["🔥"] });
    expect(out[1].plaintext).toBe("[Unable to decrypt]");
  });
});

describe("site envelopes (what the site sends)", () => {
  it("builds exactly Qwalla's msg / rx shapes", () => {
    expect(JSON.parse(buildMsgEnvelope("hi"))).toEqual({ v: 1, k: "msg", b: "hi" });
    expect(JSON.parse(buildMsgEnvelope("yo", { replyTo: "m1" }))).toEqual({ v: 1, k: "msg", b: "yo", r: "m1" });
    expect(JSON.parse(buildRxEnvelope("m1", "👍"))).toEqual({ v: 1, k: "rx", t: "m1", e: "👍" });
    expect(JSON.parse(encodeReactionMessage({ type: "reaction", messageId: "m1", emoji: "🔥" }))).toEqual({ v: 1, k: "rx", t: "m1", e: "🔥" });
    expect(JSON.parse(encodeReplyMessage({ replyTo: "m1", text: "sure" }))).toEqual({ v: 1, k: "msg", b: "sure", r: "m1" });
  });

  it("sends payments / requests as a readable body plus structured pay / req", () => {
    const pay = encodePaymentMessage({ type: "payment", token: "XRGE", amount: 5, txHash: "abc", status: "sent" });
    expect(JSON.parse(pay)).toEqual({ v: 1, k: "msg", b: "💸 Sent 5 XRGE", pay: { token: "XRGE", amount: 5, txHash: "abc", status: "sent" } });
    const env = parseEnvelope(pay);
    expect(env).toMatchObject({ kind: "msg", body: "💸 Sent 5 XRGE", pay: { token: "XRGE", amount: 5 } });

    const req = encodeRequestMessage({ type: "request", token: "qETH", amount: 0.5, memo: "pizza" });
    expect(JSON.parse(req)).toEqual({ v: 1, k: "msg", b: "🧾 Requested 0.5 qETH — pizza", req: { token: "qETH", amount: 0.5, memo: "pizza" } });
  });

  it("carries pay / req / replyTo through applyEnvelopes and renders them back", () => {
    const [p, r] = applyEnvelopes<Message>([
      msg("p", encodePaymentMessage({ type: "payment", token: "XRGE", amount: 5, status: "sent", memo: "thx" })),
      msg("r", encodeRequestMessage({ type: "request", token: "XRGE", amount: 2 })),
    ]);
    expect(p.plaintext).toBe("💸 Sent 5 XRGE — thx");
    expect(getPaymentData(p)).toEqual({ type: "payment", token: "XRGE", amount: 5, txHash: undefined, status: "sent", memo: "thx" });
    expect(getRequestData(r)).toEqual({ type: "request", token: "XRGE", amount: 2, memo: undefined });
    expect(getPaymentData(r)).toBeNull();
  });

  it("ignores malformed pay / req fields", () => {
    expect(parseEnvelope('{"v":1,"k":"msg","b":"x","pay":[1]}')).toEqual({ kind: "msg", body: "x", replyTo: undefined });
    expect(getPaymentData({ plaintext: "x", pay: { token: "XRGE", amount: "5" } })).toBeNull();
    expect(getRequestData({ plaintext: "x", req: { amount: 5 } })).toBeNull();
  });

  it("is idempotent (the chat re-applies it after sending)", () => {
    const once = applyEnvelopes<Message>([msg("a", buildMsgEnvelope("hi")), msg("b", buildRxEnvelope("a", "👍"), "them")]);
    expect(applyEnvelopes(once)).toEqual(once);
    expect(once[0].reactionsFrom).toEqual([{ emoji: "👍", sender: "them" }]);
  });
});

describe("legacy site messages still render", () => {
  it("parses old PAYMENT: / REQUEST: / REPLY: / REACTION: text", () => {
    const legacyPay = 'PAYMENT:{"type":"payment","token":"XRGE","amount":3,"status":"sent"}';
    expect(parsePaymentMessage(legacyPay)).toMatchObject({ amount: 3 });
    expect(getPaymentData({ plaintext: legacyPay })).toMatchObject({ amount: 3, token: "XRGE" });
    expect(getRequestData({ plaintext: 'REQUEST:{"type":"request","token":"XRGE","amount":1}' })).toMatchObject({ amount: 1 });
    expect(parseReplyMessage('REPLY:{"type":"reply","replyTo":"a","replyPreview":"hi","text":"yo"}')).toMatchObject({ text: "yo" });
    expect(isSystemMessage('REACTION:{"type":"reaction","messageId":"a","emoji":"👍"}')).toBe(true);
    // Legacy prefixes are not envelopes: applyEnvelopes leaves them untouched.
    const out = applyEnvelopes<Message>([msg("x", legacyPay)]);
    expect(out[0].plaintext).toBe(legacyPay);
  });

  it("merges legacy and envelope reactions into one badge set", () => {
    const list = applyEnvelopes<Message>([
      msg("a", "hello", "them"),
      msg("r1", 'REACTION:{"type":"reaction","messageId":"a","emoji":"👍"}', "me"),
      msg("r2", buildRxEnvelope("a", "👍"), "them"),
      msg("r3", buildRxEnvelope("a", "🔥"), "them"),
      msg("r4", buildRxEnvelope("a", "🔥"), "them"), // same sender twice counts once
    ]);
    const badges = aggregateReactions(list, new Set(["me"])).get("a");
    expect(badges).toEqual([
      { emoji: "👍", count: 2, myReaction: true },
      { emoji: "🔥", count: 1, myReaction: false },
    ]);
  });
});

describe("Qwalla tips", () => {
  it("parses [tip:AMOUNT:SYMBOL] like Qwalla", () => {
    expect(parseTip("[tip:5:XRGE]")).toEqual({ amount: "5", symbol: "XRGE" });
    expect(parseTip(" [tip:0.25:qETH] ")).toEqual({ amount: "0.25", symbol: "qETH" });
    expect(parseTip("[tip:5:X]")).toBeNull();
    expect(parseTip("tip 5 XRGE")).toBeNull();
    expect(parseTip(undefined)).toBeNull();
    const [m] = applyEnvelopes<Message>([msg("t", buildMsgEnvelope("[tip:5:XRGE]"))]);
    expect(parseTip(m.plaintext)).toEqual({ amount: "5", symbol: "XRGE" });
  });
});

function msg(id: string, plaintext: string, sender = "me"): Message {
  return { id, plaintext, senderWalletId: sender, conversationId: "c", encryptedContent: "", signature: "", selfDestruct: false, createdAt: "2026-01-01T00:00:00Z" };
}

describe("note to self detection", () => {
  const me = new Set(["uuid-me", "sign-me", "enc-me"]);
  it("does not treat an unresolved DM as a note to self", () => {
    expect(isNoteToSelf({ participants: [] }, me)).toBe(false);
    expect(isNoteToSelf({ participants: [], participantIds: ["uuid-me", "sign-other"] }, me)).toBe(false);
    expect(isNoteToSelf({}, me)).toBe(false);
  });
  it("still recognises real notes to self", () => {
    expect(isNoteToSelf({ name: "Note to Self" }, me)).toBe(true);
    expect(isNoteToSelf({ participantIds: ["uuid-me", "sign-me"] }, me)).toBe(true);
    expect(isNoteToSelf({ participants: [{ id: "uuid-me" }, { signingPublicKey: "sign-me" }] }, me)).toBe(true);
    expect(isNoteToSelf({ participants: [{ id: "uuid-me" }, { id: "other" }] }, me)).toBe(false);
  });
});
