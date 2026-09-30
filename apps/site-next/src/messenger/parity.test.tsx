/**
 * Browser-storage parity with apps/web (same origin): a visitor's mute / requests / blocked /
 * nickname / mail-signature state written by apps/web is read by site-next unchanged, and
 * site-next writes it back in the same keys and shapes. Keys apps/web defines outside core are
 * pinned against apps/web's own source. Also pins the in-chat wire formats to apps/web's.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import * as prefs from "@rougechain/core/messenger-prefs";
import { getNickname } from "@rougechain/core/contact-nicknames";
import { loadMailSettings, MAIL_SETTINGS_KEY, saveMailSettings } from "../mail/threads";
import { resetBrowserState } from "../wallet/test-utils";
import {
  aggregateReactions,
  encodePaymentMessage,
  encodeReactionMessage,
  encodeReplyMessage,
  encodeRequestMessage,
  getPaymentData,
  getRequestData,
  parseReplyMessage,
} from "./codec";
import { useMessengerPrefs, useNicknames } from "./hooks";
import { conversationTitle, splitConversations } from "./model";
import type { Conversation } from "@rougechain/core/pqc-messenger";

const WEB = path.resolve(__dirname, "../../../web/src");
const webSource = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");

beforeEach(() => resetBrowserState());

describe("storage keys shared with apps/web", () => {
  it("apps/web's messenger libs are core (same key constants)", () => {
    for (const lib of ["messenger-prefs", "contact-nicknames", "pqc-messenger", "notifications", "pqc-mail", "messenger-envelope", "messenger-content", "messenger-crypto-v2"])
      expect(webSource(`lib/${lib}.ts`)).toContain(`export * from "@rougechain/core/${lib}"`);
    expect([prefs.MUTED_KEY, prefs.ACCEPTED_KEY, prefs.REQUESTS_MIGRATED_KEY, prefs.BLOCKED_KEY]).toEqual([
      "pqc_muted_conversations",
      "pqc_accepted_chats",
      "pqc_requests_migrated",
      "pqc_blocked_wallets",
    ]);
  });

  it("mail settings: apps/web's key and shape", () => {
    expect(webSource("pages/Mail.tsx").match(/MAIL_SETTINGS_KEY\s*=\s*"([^"]+)"/)?.[1]).toBe(MAIL_SETTINGS_KEY);
    localStorage.setItem(MAIL_SETTINGS_KEY, JSON.stringify({ signature: "Best,\nA", signatureEnabled: true }));
    expect(loadMailSettings()).toEqual({ signature: "Best,\nA", signatureEnabled: true });
    saveMailSettings({ signature: "x", signatureEnabled: false });
    expect(JSON.parse(localStorage.getItem(MAIL_SETTINGS_KEY)!)).toEqual({ signature: "x", signatureEnabled: false });
  });

  it("reads apps/web's mute / accepted / blocked lists and reacts to changes in another tab", () => {
    localStorage.setItem("pqc_muted_conversations", JSON.stringify(["c1"]));
    localStorage.setItem("pqc_accepted_chats", JSON.stringify(["c2"]));
    localStorage.setItem("pqc_blocked_wallets", JSON.stringify(["k1"]));
    const { result } = renderHook(() => useMessengerPrefs());
    expect([...result.current.muted]).toEqual(["c1"]);
    expect([...result.current.accepted]).toEqual(["c2"]);
    expect([...result.current.blocked]).toEqual(["k1"]);
    act(() => {
      localStorage.setItem("pqc_muted_conversations", JSON.stringify(["c1", "c3"]));
      window.dispatchEvent(new StorageEvent("storage", { key: "pqc_muted_conversations" }));
    });
    expect([...result.current.muted]).toEqual(["c1", "c3"]);
  });

  it("nicknames live in pqc_contact_nicknames (core contact-nicknames)", () => {
    localStorage.setItem("pqc_contact_nicknames", JSON.stringify({ keyA: "Mom" }));
    const { result } = renderHook(() => useNicknames());
    expect(result.current.nicknameFor(undefined, "keyA")).toBe("Mom");
    act(() => result.current.setNickname("keyB", "  Dad "));
    expect(JSON.parse(localStorage.getItem("pqc_contact_nicknames")!)).toEqual({ keyA: "Mom", keyB: "Dad" });
    expect(getNickname("keyB")).toBe("Dad");
    expect(result.current.nicknameFor("keyB")).toBe("Dad");
  });
});

describe("request classification (apps/web / Qwalla rules)", () => {
  const myIds = new Set(["me"]);
  const conv = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
    id,
    isGroup: false,
    createdAt: "2026-01-01",
    participantIds: ["me", "peer"],
    participants: [
      { id: "me", displayName: "Me", signingPublicKey: "me", encryptionPublicKey: "" },
      { id: "peer", displayName: "Peer", signingPublicKey: "peer", encryptionPublicKey: "" },
    ],
    ...extra,
  });
  it("new 1:1 from someone else → request; accepted / mine / groups / notes → primary; blocked → hidden", () => {
    const g: Conversation = {
      ...conv("g", { isGroup: true }),
      participants: [...conv("g").participants!, { id: "p2", displayName: "P2", signingPublicKey: "p2", encryptionPublicKey: "" }],
    };
    const note = conv("n", { participantIds: ["me"], participants: [{ id: "me", displayName: "Me", signingPublicKey: "me", encryptionPublicKey: "" }] });
    const all = [conv("req", { createdBy: "peer" }), conv("acc", { createdBy: "peer" }), conv("mine", { createdBy: "me" }), conv("replied", { lastSenderId: "me" }), g, note];
    const split = splitConversations(all, { myIds, accepted: new Set(["acc"]), blocked: new Set() });
    expect(split.requests.map((c) => c.id)).toEqual(["req"]);
    expect(split.primary.map((c) => c.id)).toEqual(["acc", "mine", "replied", "g", "n"]);
    const blocked = splitConversations(all, { myIds, accepted: new Set(["acc"]), blocked: new Set(["peer"]) });
    expect(blocked.primary.map((c) => c.id)).toEqual(["g", "n"]); // 1:1s with the blocked peer hidden; the group stays
    expect(blocked.requests).toEqual([]);
    expect(conversationTitle(note, myIds)).toBe("Note to Self");
    expect(conversationTitle(conv("x"), myIds, { nickname: (p) => (p.id === "peer" ? "Pal" : null) })).toBe("Pal");
  });
});

describe("in-chat wire formats (apps/web ChatPayment / ChatReactions / ChatReply)", () => {
  it("payment, request, reaction and reply envelopes", () => {
    expect(JSON.parse(encodePaymentMessage({ type: "payment", token: "XRGE", amount: 5, status: "sent", txHash: "ab", memo: "rent" }))).toEqual({
      v: 1,
      k: "msg",
      b: "💸 Sent 5 XRGE — rent",
      pay: { token: "XRGE", amount: 5, status: "sent", txHash: "ab", memo: "rent" },
    });
    expect(JSON.parse(encodeRequestMessage({ type: "request", token: "qETH", amount: 0.5 }))).toEqual({ v: 1, k: "msg", b: "🧾 Requested 0.5 qETH", req: { token: "qETH", amount: 0.5 } });
    expect(JSON.parse(encodeReactionMessage({ type: "reaction", messageId: "m1", emoji: "🔥" }))).toEqual({ v: 1, k: "rx", t: "m1", e: "🔥" });
    expect(JSON.parse(encodeReplyMessage({ replyTo: "m1", text: "yes" }))).toEqual({ v: 1, k: "msg", b: "yes", r: "m1" });
  });
  it("still reads the legacy PAYMENT: / REQUEST: / REPLY: / REACTION: forms", () => {
    expect(getPaymentData({ plaintext: 'PAYMENT:{"type":"payment","token":"XRGE","amount":1,"status":"sent"}' })?.amount).toBe(1);
    expect(getRequestData({ plaintext: 'REQUEST:{"type":"request","token":"XRGE","amount":2}' })?.amount).toBe(2);
    expect(parseReplyMessage('REPLY:{"type":"reply","replyTo":"a","replyPreview":"q","text":"t"}')?.text).toBe("t");
    const map = aggregateReactions(
      [
        { id: "a", conversationId: "c", senderWalletId: "x", encryptedContent: "", signature: "", selfDestruct: false, createdAt: "", plaintext: "hi" },
        { id: "b", conversationId: "c", senderWalletId: "me", encryptedContent: "", signature: "", selfDestruct: false, createdAt: "", plaintext: 'REACTION:{"type":"reaction","messageId":"a","emoji":"👍"}' },
      ],
      new Set(["me"]),
    );
    expect(map.get("a")).toEqual([{ emoji: "👍", count: 1, myReaction: true }]);
  });
});
