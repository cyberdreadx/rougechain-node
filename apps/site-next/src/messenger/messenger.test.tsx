/**
 * Messenger on site-next against a mocked node: interop with apps/web's code path (core) and
 * Qwalla's group format both ways, endpoints + payload shapes, read receipts, requests, blocking,
 * real-time WebSocket, extension wallets, payments, GIF gating and the phone layout.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { buildMsgEnvelope, parseEnvelope } from "@rougechain/core/messenger-envelope";
import { decryptMessage, encryptMessage, saveWalletLocally } from "@rougechain/core/pqc-messenger";
import { isV2Package } from "@rougechain/core/messenger-crypto-v2";
import { ACCEPTED_KEY, BLOCKED_KEY, MUTED_KEY, REQUESTS_MIGRATED_KEY } from "@rougechain/core/messenger-prefs";
import { WALLET_TRANSFER_FEE } from "@rougechain/core/pqc-wallet";
import { saveUnifiedWallet, type UnifiedWallet } from "@rougechain/core/unified-wallet";
import { mockFetch, resetBrowserState, seedAppsWebLockedWallet, seedAppsWebWallet } from "../wallet/test-utils";
import { FakeWebSocket, asPhone, dirEntry, hex, makePeer, qwallaDecryptV2, qwallaEncryptV2, renderRoute, signMessage, signedBody, unhex, type Peer } from "./test-helpers";
import { RichBody } from "./RichBody";
import { render } from "@testing-library/react";

const WAIT = { timeout: 30_000 };
const originalMatchMedia = window.matchMedia;
const now = () => new Date().toISOString();

type Raw = Record<string, unknown>;
interface Post {
  url: string;
  body: ReturnType<typeof signedBody>;
}

/** A tiny in-memory node: directory, conversations, messages; records every signed POST. */
function mockNode(opts: { me: { signingPublicKey: string; id: string }; directory: Raw[]; conversations: Raw[]; messages?: Record<string, Raw[]> }) {
  const posts: Post[] = [];
  const messages: Record<string, Raw[]> = { ...(opts.messages ?? {}) };
  let n = 0;
  const record = (url: string, init?: RequestInit) => {
    const body = signedBody(init);
    posts.push({ url, body });
    return body;
  };
  const { calls, fn } = mockFetch({
    "/v2/messenger/wallets/register": (u, i) => (record(u, i), { success: true }),
    "/v2/messenger/conversations/list": (u, i) => (record(u, i), { success: true, conversations: opts.conversations }),
    "/v2/messenger/conversations/delete": (u, i) => (record(u, i), { success: true }),
    "/v2/messenger/conversations/update": (u, i) => (record(u, i), { success: true }),
    "/v2/messenger/conversations/participants": (u, i) => (record(u, i), { success: true }),
    "/v2/messenger/conversations": (u, i) => {
      const b = record(u, i);
      return { success: true, conversation: { id: `new-${++n}`, participant_ids: b.payload.participantIds, is_group: b.payload.isGroup, created_by: b.public_key, created_at: now() } };
    },
    "/v2/messenger/messages/list": (u, i) => {
      const b = record(u, i);
      return { success: true, messages: messages[String(b.payload.conversationId)] ?? [] };
    },
    "/v2/messenger/messages/read": (u, i) => (record(u, i), { success: true }),
    "/v2/messenger/messages/delete": (u, i) => (record(u, i), { success: true }),
    "/v2/messenger/messages": (u, i) => {
      const b = record(u, i);
      const msg = {
        id: `sent-${++n}`,
        conversation_id: b.payload.conversationId,
        sender_wallet_id: b.public_key,
        encrypted_content: b.payload.encryptedContent,
        signature: b.payload.contentSignature,
        message_type: b.payload.messageType,
        self_destruct: b.payload.selfDestruct,
        spoiler: b.payload.spoiler,
        created_at: now(),
      };
      (messages[String(b.payload.conversationId)] ??= []).push(msg);
      return { success: true, message: msg };
    },
    "/messenger/wallets": () => ({ success: true, wallets: opts.directory }),
    "/balance/": () => ({ success: true, balance: 1000, token_balances: {} }),
    "/v2/transfer": (u, i) => {
      posts.push({ url: u, body: { ...(JSON.parse(String(i?.body)) as Post["body"]), valid: true } });
      return { success: true, txHash: "feedbeefcafe0011" };
    },
  });
  const postsTo = (suffix: string) => posts.filter((p) => p.url.endsWith(suffix));
  return { posts, postsTo, calls, fn, messages };
}

function incoming(id: string, conversationId: string, from: Peer, encrypted: string, signature: string, extra: Raw = {}): Raw {
  return { id, conversation_id: conversationId, sender_wallet_id: from.signingPublicKey, encrypted_content: encrypted, signature, created_at: now(), is_read: false, ...extra };
}

let me: UnifiedWallet;
let bob: Peer;
let carol: Peer;

beforeEach(() => {
  resetBrowserState();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  bob = makePeer("Bob");
  carol = makePeer("Carol");
});
afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(window, "matchMedia", { writable: true, configurable: true, value: originalMatchMedia });
});

function oneToOne(id = "c1", creator?: string, extra: Raw = {}): Raw {
  return { id, participant_ids: [me.signingPublicKey, bob.signingPublicKey], is_group: false, created_by: creator ?? me.signingPublicKey, created_at: now(), last_message_at: now(), ...extra };
}
function group(id = "g1"): Raw {
  return { id, name: "Crew", participant_ids: [me.signingPublicKey, bob.signingPublicKey, carol.signingPublicKey], is_group: true, created_by: me.signingPublicKey, created_at: now(), last_message_at: now() };
}
const directory = () => [dirEntry({ ...me, id: me.signingPublicKey }), dirEntry(bob), dirEntry(carol)];

async function openChat(name: string | RegExp) {
  const row = await screen.findByRole("button", { name }, WAIT);
  await userEvent.click(row);
  return screen.findByRole("region", { name }, WAIT);
}

describe("interop: messages from apps/web / Qwalla decrypt in the site-next chat", () => {
  it("opens a 1:1 message encrypted with core's encryptMessage (apps/web's path), verifies the signature and sends a read receipt", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const { encryptedPackage, signature } = await encryptMessage(buildMsgEnvelope("hello from apps/web"), me.encryptionPublicKey, bob.signingPrivateKey, bob.encryptionPublicKey);
    const node = mockNode({ me, directory: directory(), conversations: [oneToOne()], messages: { c1: [incoming("m1", "c1", bob, encryptedPackage, signature)] } });
    renderRoute("/messenger");
    const chat = await openChat(/Bob/);
    expect(await within(chat).findByText("hello from apps/web", {}, WAIT)).toBeInTheDocument();
    expect(within(chat).getByLabelText("Valid")).toBeInTheDocument();
    await waitFor(() => expect(node.postsTo("/v2/messenger/messages/read")).toHaveLength(1), WAIT);
    const read = node.postsTo("/v2/messenger/messages/read")[0].body;
    expect(read.valid).toBe(true);
    expect(read.public_key).toBe(me.signingPublicKey);
    expect(read.payload).toMatchObject({ messageId: "m1", conversationId: "c1" });
  });

  it("opens a Qwalla v2 group package and marks the sender's signature valid", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const pkg = qwallaEncryptV2(buildMsgEnvelope("gm group from Qwalla"), [me.encryptionPublicKey, bob.encryptionPublicKey], carol.encryptionPublicKey);
    mockNode({ me, directory: directory(), conversations: [group()], messages: { g1: [incoming("q1", "g1", carol, pkg, signMessage(pkg, carol.signingPrivateKey))] } });
    renderRoute("/messenger");
    const chat = await openChat(/Crew/);
    expect(await within(chat).findByText("gm group from Qwalla", {}, WAIT)).toBeInTheDocument();
    expect(within(chat).getByLabelText("Valid")).toBeInTheDocument();
    expect(within(chat).getByText("3 members")).toBeInTheDocument();
  });

  it("renders reactions, replies and payments sent as Qwalla / apps/web envelopes", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const enc = (pt: string) => encryptMessage(pt, me.encryptionPublicKey, bob.signingPrivateKey, bob.encryptionPublicKey);
    const a = await enc(buildMsgEnvelope("original"));
    const b = await enc(buildMsgEnvelope("a reply", { replyTo: "m1" }));
    const c = await enc(JSON.stringify({ v: 1, k: "rx", t: "m1", e: "🔥" }));
    const d = await enc(buildMsgEnvelope("💸 Sent 5 XRGE", { pay: { token: "XRGE", amount: 5, status: "sent" } }));
    const e = await enc(buildMsgEnvelope("[tip:2:XRGE]"));
    const msgs = [
      incoming("m1", "c1", bob, a.encryptedPackage, a.signature),
      incoming("m2", "c1", bob, b.encryptedPackage, b.signature),
      incoming("m3", "c1", bob, c.encryptedPackage, c.signature),
      incoming("m4", "c1", bob, d.encryptedPackage, d.signature),
      incoming("m5", "c1", bob, e.encryptedPackage, e.signature),
    ];
    mockNode({ me, directory: directory(), conversations: [oneToOne()], messages: { c1: msgs } });
    renderRoute("/messenger");
    const chat = await openChat(/Bob/);
    expect(await within(chat).findByText("a reply", {}, WAIT)).toBeInTheDocument();
    expect(within(chat).getAllByText("original").length).toBeGreaterThanOrEqual(2); // bubble + quote
    expect(within(chat).getByRole("button", { name: "🔥" })).toBeInTheDocument();
    expect(within(chat).getByText("Received")).toBeInTheDocument();
    expect(within(chat).getByText(/Tip: 2 XRGE/)).toBeInTheDocument();
  });
});

describe("sending: endpoints and payloads match apps/web (core sendMessage)", () => {
  it("1:1: POST /v2/messenger/messages, signed by me; Bob decrypts it with core, I can re-open my copy", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const node = mockNode({ me, directory: directory(), conversations: [oneToOne()] });
    renderRoute("/messenger");
    const chat = await openChat(/Bob/);
    const input = within(chat).getByRole("textbox", { name: "Type a message…" });
    await userEvent.type(input, "hi bob{Enter}");
    await waitFor(() => expect(node.postsTo("/v2/messenger/messages")).toHaveLength(1), WAIT);
    const sent = node.postsTo("/v2/messenger/messages")[0].body;
    expect(sent.valid).toBe(true);
    expect(sent.public_key).toBe(me.signingPublicKey);
    expect(Object.keys(sent.payload).sort()).toEqual(["contentSignature", "conversationId", "encryptedContent", "from", "messageType", "nonce", "selfDestruct", "spoiler", "timestamp"]);
    expect(sent.payload).toMatchObject({ conversationId: "c1", messageType: "text", selfDestruct: false, spoiler: false, from: me.signingPublicKey });
    const pkg = String(sent.payload.encryptedContent);
    expect(isV2Package(pkg)).toBe(false);
    const forBob = await decryptMessage(pkg, bob.encryptionPrivateKey, me.signingPublicKey, String(sent.payload.contentSignature));
    expect(forBob).toEqual({ plaintext: "hi bob", signatureValid: true });
    const mine = await decryptMessage(pkg, me.encryptionPrivateKey, me.signingPublicKey, String(sent.payload.contentSignature), true);
    expect(mine.plaintext).toBe("hi bob");
    expect(await within(chat).findByText("hi bob", {}, WAIT)).toBeInTheDocument();
  });

  it("group: a Qwalla v2 package every member (and I) can open; reactions and replies go out as envelopes", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const pkg = qwallaEncryptV2(buildMsgEnvelope("first"), [me.encryptionPublicKey, bob.encryptionPublicKey], carol.encryptionPublicKey);
    const node = mockNode({ me, directory: directory(), conversations: [group()], messages: { g1: [incoming("q1", "g1", carol, pkg, signMessage(pkg, carol.signingPrivateKey))] } });
    renderRoute("/messenger");
    const chat = await openChat(/Crew/);
    await userEvent.type(within(chat).getByRole("textbox", { name: "Type a message…" }), "gm all{Enter}");
    await waitFor(() => expect(node.postsTo("/v2/messenger/messages")).toHaveLength(1), WAIT);
    const sent = node.postsTo("/v2/messenger/messages")[0].body;
    const out = String(sent.payload.encryptedContent);
    expect(isV2Package(out)).toBe(true);
    expect(Object.keys(JSON.parse(out).wrappedKeys).sort()).toEqual([me.encryptionPublicKey, bob.encryptionPublicKey, carol.encryptionPublicKey].sort());
    expect(qwallaDecryptV2(out, bob.encryptionPrivateKey, bob.encryptionPublicKey)).toBe("gm all");
    expect(qwallaDecryptV2(out, carol.encryptionPrivateKey, carol.encryptionPublicKey)).toBe("gm all");
    expect(ml_dsa65.verify(unhex(String(sent.payload.contentSignature)), new TextEncoder().encode(out), unhex(me.signingPublicKey))).toBe(true);

    // React to Carol's message: a Qwalla rx envelope.
    await userEvent.click(await within(chat).findByText("first", {}, WAIT));
    await userEvent.click(within(chat).getByRole("button", { name: "React" }));
    await userEvent.click(within(chat).getByRole("menuitem", { name: "React 👍" }));
    await waitFor(() => expect(node.postsTo("/v2/messenger/messages")).toHaveLength(2), WAIT);
    const rx = qwallaDecryptV2(String(node.postsTo("/v2/messenger/messages")[1].body.payload.encryptedContent), bob.encryptionPrivateKey, bob.encryptionPublicKey);
    expect(JSON.parse(rx)).toEqual({ v: 1, k: "rx", t: "q1", e: "👍" });

    // Reply: a msg envelope with "r".
    await userEvent.click(within(chat).getByText("first"));
    await userEvent.click(within(chat).getByRole("button", { name: "Reply" }));
    await userEvent.type(within(chat).getByRole("textbox", { name: "Type your reply…" }), "same{Enter}");
    await waitFor(() => expect(node.postsTo("/v2/messenger/messages")).toHaveLength(3), WAIT);
    const reply = qwallaDecryptV2(String(node.postsTo("/v2/messenger/messages")[2].body.payload.encryptedContent), carol.encryptionPrivateKey, carol.encryptionPublicKey);
    expect(JSON.parse(reply)).toEqual({ v: 1, k: "msg", b: "same", r: "q1" });
  });

  it("self-destruct and spoiler options are sent as apps/web does (30 s)", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const node = mockNode({ me, directory: directory(), conversations: [oneToOne()] });
    renderRoute("/messenger");
    const chat = await openChat(/Bob/);
    await userEvent.click(within(chat).getByRole("button", { name: "Options" }));
    await userEvent.click(within(chat).getByRole("switch", { name: "Self-destruct" }));
    await userEvent.click(within(chat).getByRole("switch", { name: "Spoiler" }));
    await userEvent.type(within(chat).getByRole("textbox", { name: "Type a message…" }), "secret{Enter}");
    await waitFor(() => expect(node.postsTo("/v2/messenger/messages")).toHaveLength(1), WAIT);
    expect(node.postsTo("/v2/messenger/messages")[0].body.payload).toMatchObject({ selfDestruct: true, destructAfterSeconds: 30, spoiler: true });
  });
});

describe("real time", () => {
  it("authenticates the private socket as the messaging identity and refetches the open chat on new_message", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const node = mockNode({ me, directory: directory(), conversations: [oneToOne()] });
    renderRoute("/messenger");
    await openChat(/Bob/);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), WAIT);
    const ws = FakeWebSocket.instances.at(-1)!;
    expect(ws.url).toBe("ws://localhost:5101/api/ws");
    await waitFor(() => expect(ws.sent.length).toBeGreaterThan(0), WAIT);
    const auth = JSON.parse(ws.sent[0]).auth;
    expect(auth.payload.action).toBe("messenger_ws_subscribe");
    expect(signedBody({ body: JSON.stringify(auth) }).valid).toBe(true);
    expect(auth.public_key).toBe(me.signingPublicKey);

    act(() => ws.emit({ type: "subscribed", topics: ["messenger"] }));
    const before = node.postsTo("/v2/messenger/messages/list").length;
    const { encryptedPackage, signature } = await encryptMessage("pushed", me.encryptionPublicKey, bob.signingPrivateKey, bob.encryptionPublicKey);
    node.messages.c1 = [incoming("live1", "c1", bob, encryptedPackage, signature)];
    act(() => ws.emit({ type: "new_message", conversation_id: "c1", message_id: "live1", created_at: now(), sender_wallet_id: bob.signingPublicKey, participant_ids: [] }));
    await waitFor(() => expect(node.postsTo("/v2/messenger/messages/list").length).toBeGreaterThan(before), WAIT);
    expect(await screen.findByText("pushed", {}, WAIT)).toBeInTheDocument(); // after the decrypt reveal
  });
});

describe("requests, blocking and mute (device-local, apps/web's keys)", () => {
  it("a new 1:1 from someone else is a request: no read receipts until accepted", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    localStorage.setItem(REQUESTS_MIGRATED_KEY, "1");
    const { encryptedPackage, signature } = await encryptMessage("hey stranger", me.encryptionPublicKey, bob.signingPrivateKey, bob.encryptionPublicKey);
    const node = mockNode({
      me,
      directory: directory(),
      conversations: [oneToOne("r1", bob.signingPublicKey, { last_sender_id: bob.signingPublicKey })],
      messages: { r1: [incoming("rm1", "r1", bob, encryptedPackage, signature)] },
    });
    renderRoute("/messenger");
    await userEvent.click(await screen.findByRole("tab", { name: "Requests (1)" }, WAIT));
    const row = screen.getByText("Wants to message you").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /Bob/ }));
    const chat = await screen.findByRole("region", { name: /Bob/ }, WAIT);
    expect(await within(chat).findByText("hey stranger", {}, WAIT)).toBeInTheDocument();
    expect(node.postsTo("/v2/messenger/messages/read")).toHaveLength(0);
    await userEvent.click(within(chat).getByRole("button", { name: "Accept" }));
    expect(JSON.parse(localStorage.getItem(ACCEPTED_KEY)!)).toContain("r1");
    await waitFor(() => expect(node.postsTo("/v2/messenger/messages/read")).toHaveLength(1), WAIT);
  });

  it("existing chats are grandfathered on first load (Qwalla migration)", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    mockNode({ me, directory: directory(), conversations: [oneToOne("old", bob.signingPublicKey)] });
    renderRoute("/messenger");
    expect(await screen.findByRole("button", { name: /Bob/ }, WAIT)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Requests/ })).not.toBeInTheDocument();
    expect(localStorage.getItem(REQUESTS_MIGRATED_KEY)).toBe("1");
    expect(JSON.parse(localStorage.getItem(ACCEPTED_KEY)!)).toEqual(["old"]);
  });

  it("hides a 1:1 with a blocked wallet (apps/web block list) and mutes into pqc_muted_conversations", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    localStorage.setItem(BLOCKED_KEY, JSON.stringify([carol.signingPublicKey]));
    const withCarol = { ...oneToOne("cc"), participant_ids: [me.signingPublicKey, carol.signingPublicKey] };
    mockNode({ me, directory: directory(), conversations: [oneToOne(), withCarol] });
    renderRoute("/messenger");
    const chat = await openChat(/Bob/);
    expect(screen.queryByRole("button", { name: /Carol/ })).not.toBeInTheDocument();
    await userEvent.click(within(chat).getByRole("button", { name: "Conversation options" }));
    await userEvent.click(within(chat).getByRole("menuitem", { name: /Mute/ }));
    expect(JSON.parse(localStorage.getItem(MUTED_KEY)!)).toEqual(["c1"]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(within(chat).getByRole("button", { name: "Conversation options" }));
    await userEvent.click(within(chat).getByRole("menuitem", { name: /Block/ }));
    expect(JSON.parse(localStorage.getItem(BLOCKED_KEY)!)).toEqual([carol.signingPublicKey, bob.signingPublicKey]);
  });
});

describe("new chat, groups and note to self", () => {
  it("creates a group with core's createGroupConversation payload", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const node = mockNode({ me, directory: directory(), conversations: [] });
    renderRoute("/messenger");
    expect(await screen.findByText("No conversations yet", {}, WAIT)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Group" })[0]);
    const sheet = await screen.findByRole("dialog", { name: "New group" });
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Group name" }), "Crew");
    await userEvent.click(await within(sheet).findByRole("button", { name: /Bob/ }, WAIT));
    await userEvent.click(within(sheet).getByRole("button", { name: /Carol/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Create group (3)" }));
    await waitFor(() => expect(node.postsTo("/v2/messenger/conversations")).toHaveLength(1), WAIT);
    const b = node.postsTo("/v2/messenger/conversations")[0].body;
    expect(b.valid).toBe(true);
    expect(b.payload).toMatchObject({ isGroup: true, name: "Crew", participantIds: [me.signingPublicKey, bob.signingPublicKey, carol.signingPublicKey] });
  });

  it("Note to Self is reused, never duplicated (isNoteToSelf)", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const note = { id: "n1", participant_ids: [me.signingPublicKey], is_group: false, created_by: me.signingPublicKey, created_at: now() };
    const node = mockNode({ me, directory: directory(), conversations: [note] });
    renderRoute("/messenger");
    expect(await screen.findByRole("button", { name: /Note to Self/ }, WAIT)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    const sheet = await screen.findByRole("dialog", { name: "Start new chat" });
    await userEvent.click(within(sheet).getByRole("button", { name: /Note to Self/ }));
    expect(await screen.findByRole("region", { name: "Note to Self" }, WAIT)).toBeInTheDocument();
    expect(node.postsTo("/v2/messenger/conversations")).toHaveLength(0);
  });
});

describe("wallet states", () => {
  it("no wallet: points to the wallet", async () => {
    mockFetch();
    renderRoute("/messenger");
    expect(await screen.findByText("Create or connect a wallet to start messaging.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open wallet" })).toHaveAttribute("href", "/wallet");
  });

  it("locked: unlocks through the wallet provider, then loads conversations", async () => {
    const w = await seedAppsWebLockedWallet("pw-123456");
    me = w;
    mockNode({ me, directory: directory(), conversations: [oneToOne()] });
    renderRoute("/messenger");
    expect(await screen.findByText(/is locked/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Password"), "pw-123456");
    await userEvent.click(screen.getByRole("button", { name: "Unlock" }));
    // Generic name ("My Wallet") → apps/web's display-name prompt first.
    expect(await screen.findByRole("dialog", { name: "Set your display name" }, WAIT)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(await screen.findByRole("button", { name: /Bob/ }, WAIT)).toBeInTheDocument();
  });

  it("inside Qwalla: points to the Chats tab and creates no second identity until asked", async () => {
    const ext = makePeer("Ext");
    saveUnifiedWallet({ id: "ext-1", displayName: "Extension Wallet", createdAt: Date.now(), signingPublicKey: ext.signingPublicKey, signingPrivateKey: "", encryptionPublicKey: "", encryptionPrivateKey: "", version: 2 });
    Object.assign(window, { ethereum: { isQwalla: true, isMetaMask: true } });
    try {
      const node = mockNode({ me: { id: "ext-1", signingPublicKey: ext.signingPublicKey } as UnifiedWallet, directory: directory(), conversations: [] });
      renderRoute("/messenger");
      expect(await screen.findByRole("heading", { name: "Your chats are in Qwalla" }, WAIT)).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Set your display name" })).not.toBeInTheDocument();
      expect(node.postsTo("/v2/messenger/wallets/register")).toHaveLength(0);
      // the website messenger is still reachable on request
      await userEvent.click(screen.getByRole("button", { name: "Use the website messenger anyway" }));
      expect(await screen.findByText(/Extension wallet: messages are signed with a messaging key kept on this device/, {}, WAIT)).toBeInTheDocument();
    } finally {
      delete (window as { ethereum?: unknown }).ethereum;
    }
  });

  it("extension wallet: messages as the device-local key, pays through the extension (core secureTransfer)", async () => {
    const ext = makePeer("Ext");
    const local = makePeer("Alice (device)");
    saveUnifiedWallet({ id: "ext-1", displayName: "Alice", createdAt: Date.now(), signingPublicKey: ext.signingPublicKey, signingPrivateKey: "", encryptionPublicKey: "", encryptionPrivateKey: "", version: 2 });
    saveWalletLocally({ ...local, id: "local-1" });
    const signTransaction = vi.fn(async ({ serializedHex }: { serializedHex: string }) => ({ signature: hex(ml_dsa65.sign(unhex(serializedHex), unhex(ext.signingPrivateKey))) }));
    Object.assign(window, { rougechain: { isRougeChain: true, connect: vi.fn(), getBalance: vi.fn(), sendTransaction: vi.fn(), signTransaction } });
    me = { id: "local-1", signingPublicKey: local.signingPublicKey } as UnifiedWallet;
    const conv = { id: "c1", participant_ids: [local.signingPublicKey, bob.signingPublicKey], is_group: false, created_by: local.signingPublicKey, created_at: now() };
    const node = mockNode({ me, directory: [dirEntry({ ...local, id: "local-1" }), dirEntry(bob)], conversations: [conv] });
    renderRoute("/messenger");
    expect(await screen.findByText(/Extension wallet: messages are signed with a messaging key kept on this device/, {}, WAIT)).toBeInTheDocument();
    const chat = await openChat(/Bob/);
    const list = node.postsTo("/v2/messenger/conversations/list")[0].body;
    expect(list.public_key).toBe(local.signingPublicKey);
    expect(list.valid).toBe(true);

    await userEvent.click(within(chat).getByRole("button", { name: "Send payment" }));
    const sheet = await screen.findByRole("dialog", { name: /Send to/ });
    await userEvent.type(within(sheet).getByPlaceholderText("0"), "5");
    await userEvent.click(within(sheet).getByRole("button", { name: /Send 5 XRGE/ }));
    await waitFor(() => expect(signTransaction).toHaveBeenCalledTimes(1), WAIT);
    await waitFor(() => expect(node.postsTo("/v2/transfer")).toHaveLength(1), WAIT);
    const tx = node.postsTo("/v2/transfer")[0].body as unknown as { payload: Raw; public_key: string };
    expect(tx.public_key).toBe(ext.signingPublicKey);
    expect(tx.payload).toMatchObject({ type: "transfer", from: ext.signingPublicKey, to: bob.signingPublicKey, amount: 5, fee: WALLET_TRANSFER_FEE, token: "XRGE" });
    await waitFor(() => expect(node.postsTo("/v2/messenger/messages")).toHaveLength(1), WAIT);
    const sent = node.postsTo("/v2/messenger/messages")[0].body;
    expect(sent.public_key).toBe(local.signingPublicKey);
    const { plaintext } = await decryptMessage(String(sent.payload.encryptedContent), bob.encryptionPrivateKey, local.signingPublicKey, String(sent.payload.contentSignature));
    expect(parseEnvelope(plaintext)).toEqual({ kind: "msg", body: "💸 Sent 5 XRGE", replyTo: undefined, pay: { token: "XRGE", amount: 5, txHash: "feedbeefcafe0011", status: "sent" } });
  });
});

describe("media and GIFs", () => {
  it("GIF picker only with VITE_GIPHY_API_KEY", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    mockNode({ me, directory: directory(), conversations: [oneToOne()] });
    vi.stubEnv("VITE_GIPHY_API_KEY", "");
    const { unmount } = renderRoute("/messenger");
    let chat = await openChat(/Bob/);
    expect(within(chat).queryByRole("button", { name: "Send a GIF" })).not.toBeInTheDocument();
    unmount();
    vi.stubEnv("VITE_GIPHY_API_KEY", "test-key");
    renderRoute("/messenger");
    chat = await openChat(/Bob/);
    expect(within(chat).getByRole("button", { name: "Send a GIF" })).toBeInTheDocument();
    vi.unstubAllEnvs();
  });

  it("GIPHY and data: images load; other https images are click-to-load", async () => {
    mockFetch();
    const { container, rerender } = render(<RichBody body="https://media.giphy.com/media/x/giphy.gif" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "https://media.giphy.com/media/x/giphy.gif");
    rerender(<RichBody body="https://evil.example/pixel.png" />);
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Load image from evil.example/ }));
    expect(container.querySelector("img")).toHaveAttribute("src", "https://evil.example/pixel.png");
    rerender(<RichBody body="data:image/png;base64,iVBORw0KGgo=" />);
    expect(container.querySelector("img")).not.toBeNull();
  });
});

describe("phone width", () => {
  it("shows the list, then the chat full-screen with a back button", async () => {
    asPhone();
    me = seedAppsWebWallet({ displayName: "Alice" });
    mockNode({ me, directory: directory(), conversations: [oneToOne()] });
    renderRoute("/messenger");
    expect(await screen.findByRole("complementary", { name: "Conversations" }, WAIT)).toBeInTheDocument();
    expect(screen.queryByText("Select a conversation")).not.toBeInTheDocument();
    const chat = await openChat(/Bob/);
    expect(screen.queryByRole("complementary", { name: "Conversations" })).not.toBeInTheDocument();
    expect(within(chat).getByRole("textbox", { name: "Type a message…" })).toBeVisible();
    await userEvent.click(within(chat).getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("complementary", { name: "Conversations" })).toBeInTheDocument();
  });
});
