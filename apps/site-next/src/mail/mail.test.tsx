/**
 * Mail on site-next against a mocked node: mail sent with core's sendMail (apps/web's path) opens
 * with its ML-DSA-65 verdict, compose / reply payloads, attachments, the name claim (both
 * domains), threads and the settings key shared with apps/web.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMail, type MailItem } from "@rougechain/core/pqc-mail";
import type { UnifiedWallet } from "@rougechain/core/unified-wallet";
import { mockFetch, resetBrowserState, seedAppsWebWallet } from "../wallet/test-utils";
import { FakeWebSocket, asPhone, dirEntry, makePeer, qwallaDecryptV2, renderRoute, signedBody, type Peer } from "../messenger/test-helpers";
import i18n from "../i18n";
import { MAIL_SETTINGS_KEY, buildThread, groupByThread, loadMailSettings, signatureBlock } from "./threads";

const WAIT = { timeout: 30_000 };
type Raw = Record<string, unknown>;

let me: UnifiedWallet;
let bob: Peer;

beforeEach(() => {
  resetBrowserState();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  bob = makePeer("Bob");
});

/** Mail as apps/web sends it: core sendMail, captured at POST /v2/mail/send, stored as the node would. */
async function mailFromBob(subject: string, body: string, id = "mail-1", extra: Raw = {}): Promise<Raw> {
  let captured: Raw | null = null;
  mockFetch({
    "/v2/mail/send": (_u, init) => {
      captured = signedBody(init).payload;
      return { success: true, message: { id } };
    },
    "/messenger/wallets": () => ({ wallets: [dirEntry({ ...me, id: me.id }), dirEntry(bob)] }),
  });
  await sendMail({ ...bob }, [me.id], subject, body);
  const p = captured as unknown as Raw;
  return {
    message: {
      id,
      from_wallet_id: bob.id,
      to_wallet_ids: [me.id],
      subject_encrypted: p.subjectEncrypted,
      body_encrypted: p.bodyEncrypted,
      signature: p.contentSignature,
      created_at: new Date().toISOString(),
      has_attachment: false,
      ...extra,
    },
    label: { message_id: id, wallet_id: me.id, folder: "inbox", is_read: false },
  };
}

function mailNode(folders: Partial<Record<"inbox" | "sent" | "trash", Raw[]>>, opts: { name?: string | null; bobNameOwner?: { id: string } } = {}) {
  const posts: { url: string; body: ReturnType<typeof signedBody> }[] = [];
  let name = opts.name ?? null;
  const rec = (u: string, i?: RequestInit) => {
    const body = signedBody(i);
    posts.push({ url: u, body });
    return body;
  };
  mockFetch({
    "/v2/messenger/wallets/register": (u, i) => (rec(u, i), { success: true }),
    "/v2/mail/folder": (u, i) => {
      const b = rec(u, i);
      return { success: true, messages: folders[b.payload.folder as "inbox"] ?? [] };
    },
    "/v2/mail/read": (u, i) => (rec(u, i), { success: true }),
    "/v2/mail/move": (u, i) => (rec(u, i), { success: true }),
    "/v2/mail/send": (u, i) => (rec(u, i), { success: true, message: { id: "out-1" } }),
    "/v2/names/register": (u, i) => {
      const b = rec(u, i);
      name = String(b.payload.name);
      return { success: true };
    },
    "/names/reverse/": () => ({ success: true, name }),
    "/names/resolve/bob": () =>
      opts.bobNameOwner
        ? { success: true, entry: { name: "bob", wallet_id: opts.bobNameOwner.id } }
        : { success: true, entry: { name: "bob", wallet_id: bob.id }, wallet: dirEntry(bob) },
    "/names/resolve/": () => ({ success: false }),
    "/messenger/wallets": () => ({ wallets: [dirEntry({ ...me, id: me.id }), dirEntry(bob)] }),
  });
  return { posts, postsTo: (s: string) => posts.filter((p) => p.url.endsWith(s)) };
}

describe("reading mail", () => {
  it("opens mail sent with core's sendMail, shows the signature verdict and marks it read", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const item = await mailFromBob("Quarterly keys", "Rotate them on Friday.");
    const node = mailNode({ inbox: [item] });
    renderRoute("/mail");
    const row = await screen.findByRole("button", { name: /Quarterly keys/ }, WAIT);
    expect(within(screen.getByRole("tablist")).getByRole("tab", { name: /Inbox/ })).toHaveTextContent("1");
    await userEvent.click(row);
    expect(await screen.findByText("Rotate them on Friday.", {}, WAIT)).toBeInTheDocument();
    expect(screen.getByText("Signature verified (ML-DSA-65)")).toBeInTheDocument();
    await waitFor(() => expect(node.postsTo("/v2/mail/read")).toHaveLength(1), WAIT);
    expect(node.postsTo("/v2/mail/read")[0].body).toMatchObject({ valid: true, public_key: me.signingPublicKey, payload: { messageId: "mail-1" } });
  });

  it("flags a tampered signature", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const item = await mailFromBob("Hi", "Body");
    const msg = item.message as Raw;
    msg.signature = String(msg.signature).replace(/^../, (h) => (h === "00" ? "11" : "00"));
    mailNode({ inbox: [item] });
    renderRoute("/mail");
    await userEvent.click(await screen.findByRole("button", { name: /Hi/ }, WAIT));
    expect(await screen.findByText("Signature invalid — this mail may be forged", {}, WAIT)).toBeInTheDocument();
  });
});

describe("compose", () => {
  it("resolves name@rouge.quant and POSTs /v2/mail/send; Bob opens the v2 package", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const node = mailNode({});
    renderRoute("/mail");
    await userEvent.click(await screen.findByRole("button", { name: "Compose" }, WAIT));
    await userEvent.type(screen.getByLabelText("To"), "bob@rouge.quant");
    expect(await screen.findByText(/Resolved:/, {}, WAIT)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Subject"), "Lunch?");
    await userEvent.type(screen.getByLabelText("Message"), "Noon at the usual place.");
    await userEvent.click(screen.getByRole("button", { name: /Send mail/ }));
    await waitFor(() => expect(node.postsTo("/v2/mail/send")).toHaveLength(1), WAIT);
    const sent = node.postsTo("/v2/mail/send")[0].body;
    expect(sent.valid).toBe(true);
    expect(Object.keys(sent.payload).sort()).toEqual(["bodyEncrypted", "contentSignature", "from", "fromWalletId", "hasAttachment", "nonce", "subjectEncrypted", "timestamp", "toWalletIds"]);
    expect(sent.payload).toMatchObject({ fromWalletId: me.id, toWalletIds: [bob.id], hasAttachment: false });
    expect(qwallaDecryptV2(String(sent.payload.subjectEncrypted), bob.encryptionPrivateKey, bob.encryptionPublicKey)).toBe("Lunch?");
    expect(qwallaDecryptV2(String(sent.payload.bodyEncrypted), bob.encryptionPrivateKey, bob.encryptionPublicKey)).toBe("Noon at the usual place.");
    expect(await screen.findByText("Mail sent!", {}, WAIT)).toBeInTheDocument();
  });

  it("reply carries replyToId, 'Re:' subject and the saved signature (apps/web's pqc_mail_settings)", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    localStorage.setItem(MAIL_SETTINGS_KEY, JSON.stringify({ signature: "— Alice", signatureEnabled: true }));
    const item = await mailFromBob("Plans", "Thoughts?");
    const node = mailNode({ inbox: [item] });
    renderRoute("/mail");
    await userEvent.click(await screen.findByRole("button", { name: /Plans/ }, WAIT));
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }, WAIT));
    expect(screen.getByLabelText("Subject")).toHaveValue("Re: Plans");
    expect(screen.getByLabelText("Message")).toHaveValue("\n\n--\n— Alice");
    await userEvent.click(screen.getByRole("button", { name: /Send mail/ }));
    await waitFor(() => expect(node.postsTo("/v2/mail/send")).toHaveLength(1), WAIT);
    expect(node.postsTo("/v2/mail/send")[0].body.payload).toMatchObject({ replyToId: "mail-1", toWalletIds: [bob.id] });
  });
});

describe("reply addressing", () => {
  it("replies to the sender's wallet even when their display name is someone else's mail name", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const item = await mailFromBob("Invoice", "Please confirm.");
    // Bob has no mail name; the mail name "bob" belongs to another wallet.
    const node = mailNode({ inbox: [item] }, { bobNameOwner: { id: "someone-else" } });
    renderRoute("/mail");
    await userEvent.click(await screen.findByRole("button", { name: /Invoice/ }, WAIT));
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }, WAIT));
    expect(await screen.findByText(/Resolved:/, {}, WAIT)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Send mail/ }));
    await waitFor(() => expect(node.postsTo("/v2/mail/send")).toHaveLength(1), WAIT);
    expect(node.postsTo("/v2/mail/send")[0].body.payload).toMatchObject({ replyToId: "mail-1", toWalletIds: [bob.id] });
  });

  it("an edited To field is looked up as an address again", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const item = await mailFromBob("Invoice", "Please confirm.");
    const node = mailNode({ inbox: [item] }, { bobNameOwner: { id: "someone-else" } });
    renderRoute("/mail");
    await userEvent.click(await screen.findByRole("button", { name: /Invoice/ }, WAIT));
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }, WAIT));
    const to = screen.getByLabelText("To");
    await userEvent.clear(to);
    await userEvent.type(to, "bob@rouge.quant");
    // the typed address resolves through the name registry, not to the original sender
    await waitFor(() => expect(screen.getByText(/Resolved: someone-else/)).toBeInTheDocument(), WAIT);
    expect(node.postsTo("/v2/mail/send")).toHaveLength(0);
  });
});

describe("mail name", () => {
  it("claims a name and shows both addresses", async () => {
    me = seedAppsWebWallet({ displayName: "Alice" });
    const node = mailNode({});
    renderRoute("/mail");
    expect(await screen.findByText("Claim a name to get your @rouge.quant and @qwalla.mail addresses", {}, WAIT)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Claim your @rouge.quant / @qwalla.mail address" }));
    await userEvent.type(await screen.findByLabelText("Mail name", {}, WAIT), "alice");
    expect(screen.getByText("alice@rouge.quant · alice@qwalla.mail")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Claim name" }));
    await waitFor(() => expect(node.postsTo("/v2/names/register")).toHaveLength(1), WAIT);
    expect(node.postsTo("/v2/names/register")[0].body.payload).toMatchObject({ name: "alice", walletId: me.id });
    expect(await screen.findByText("Your addresses: alice@rouge.quant · alice@qwalla.mail", {}, WAIT)).toBeInTheDocument();
  });
});

describe("threads + settings", () => {
  const item = (id: string, replyToId: string | undefined, at: number, isRead = true): MailItem => ({
    message: { id, fromWalletId: "w", toWalletIds: [], subjectEncrypted: "", bodyEncrypted: "", signature: "", createdAt: new Date(at).toISOString(), replyToId, hasAttachment: false, subject: `s-${id}`, senderName: id === "b" ? "Bob" : "Alice" },
    label: { messageId: id, walletId: "w", folder: "inbox", isRead },
  });
  it("groups replies under their root, newest thread first", () => {
    const a = item("a", undefined, 1);
    const b = item("b", "a", 3, false);
    const c = item("c", undefined, 2);
    const threads = groupByThread([a, b, c]);
    expect(threads.map((t) => t.rootId)).toEqual(["a", "c"]);
    expect(threads[0]).toMatchObject({ subject: "s-a", hasUnread: true, participants: ["Alice", "Bob"] });
    expect(buildThread([a, b, c], b).map((i) => i.message.id)).toEqual(["a", "b"]);
  });
  it("reads apps/web's settings and builds the same signature block", () => {
    localStorage.setItem(MAIL_SETTINGS_KEY, JSON.stringify({ signature: "  Sig  ", signatureEnabled: true }));
    expect(signatureBlock(loadMailSettings())).toBe("\n\n--\nSig");
    localStorage.setItem(MAIL_SETTINGS_KEY, "{broken");
    expect(loadMailSettings()).toEqual({ signature: "", signatureEnabled: false });
  });
});

describe("states", () => {
  it("no wallet → wallet link; phone width renders the inbox", async () => {
    mockFetch();
    const { unmount } = renderRoute("/mail");
    expect(await screen.findByText("Create or connect a wallet to use RougeChain Mail.")).toBeInTheDocument();
    unmount();
    asPhone();
    me = seedAppsWebWallet({ displayName: "Alice" });
    mailNode({});
    renderRoute("/mail");
    expect(await screen.findByText("Inbox zero", {}, WAIT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compose" })).toBeVisible();
  });
});

describe("language", () => {
  it("renders the gate and the empty inbox in the selected language (ja / es)", async () => {
    await i18n.changeLanguage("ja");
    mockFetch();
    const { unmount } = renderRoute("/mail");
    expect(await screen.findByText("RougeChain Mail を使うには、ウォレットを作成または接続してください。")).toBeInTheDocument();
    unmount();
    await i18n.changeLanguage("es");
    me = seedAppsWebWallet({ displayName: "Alice" });
    mailNode({});
    renderRoute("/mail");
    expect(await screen.findByText("Bandeja vacía", {}, WAIT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Redactar" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /Recibidos/ })).toBeInTheDocument();
  });
});
