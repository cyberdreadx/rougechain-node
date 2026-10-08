/**
 * window.rougechain.signMessage end to end inside the extension: the injected provider method,
 * the service worker route (connected origin, approval every time, refusals, the signed bytes)
 * and what the approval popup renders.
 *
 * The service worker runs against a small fake `chrome` (callback style, like the real one); the
 * "user" answers by writing the approval response the popup would write.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { pubkeyToAddress } from "@rougechain/core/address";
import {
    createSignInMessage,
    messageSigningBytes,
    reviewSignMessageRequest,
    verifyMessage,
    verifySignIn,
    type SignMessageReview,
} from "@rougechain/core/message-signing";
import SignMessageView, { signMessageHasDanger } from "../src/approval/SignMessageView";
import vector from "../../../packages/core/test/fixtures/sign-message-vector.json";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(path.resolve(here, "../src", p), "utf8");

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const ch = (code: number) => String.fromCharCode(code);
const kp = ml_dsa65.keygen(unhex(vector.seedHex));
const PUB = hex(kp.publicKey);
const PRIV = hex(kp.secretKey);
const ORIGIN = "https://tickets.example.com";

// ─── fake chrome ─────────────────────────────────────────────────────────────

type Listener = (...args: any[]) => any;
const local: Record<string, unknown> = {};
const session: Record<string, unknown> = {};
const messageListeners: Listener[] = [];
const sessionChanged = new Set<Listener>();
const windowRemoved = new Set<Listener>();
/** Approval popups opened so far: the stored request each one would display. */
let approvals: { id: string; type: string; origin: string; stored: any }[] = [];
/** How the "user" answers the next popups. */
let answer: "approve" | "deny" | "close" = "approve";

function area(data: Record<string, unknown>, changed?: Set<Listener>) {
    const pick = (keys: string | string[] | null) => {
        if (keys === null) return { ...data };
        const out: Record<string, unknown> = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) out[k] = data[k];
        return out;
    };
    return {
        get: (keys: string | string[] | null, cb?: Listener) => { const r = pick(keys); cb?.(r); return Promise.resolve(r); },
        set: (items: Record<string, unknown>, cb?: Listener) => {
            Object.assign(data, items);
            const changes: Record<string, unknown> = {};
            for (const k of Object.keys(items)) changes[k] = { newValue: items[k] };
            queueMicrotask(() => changed?.forEach((l) => l(changes)));
            cb?.();
            return Promise.resolve();
        },
        remove: (keys: string | string[], cb?: Listener) => {
            for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
            cb?.();
            return Promise.resolve();
        },
        onChanged: { addListener: (l: Listener) => changed?.add(l), removeListener: (l: Listener) => changed?.delete(l) },
    };
}

const noopEvent = { addListener: () => undefined, removeListener: () => undefined };
const fakeChrome = {
    runtime: {
        id: "ext-id",
        getURL: (p: string) => `chrome-extension://ext-id/${p}`,
        onMessage: { addListener: (l: Listener) => messageListeners.push(l) },
        onConnect: noopEvent,
        onInstalled: noopEvent,
    },
    alarms: { onAlarm: noopEvent, create: () => undefined, clear: () => undefined, get: () => undefined },
    notifications: { onClicked: noopEvent, clear: () => undefined, create: () => undefined },
    action: {},
    tabs: { sendMessage: () => Promise.resolve() },
    storage: { local: area(local), session: area(session, sessionChanged) },
    windows: {
        onRemoved: { addListener: (l: Listener) => windowRemoved.add(l), removeListener: (l: Listener) => windowRemoved.delete(l) },
        create: (opts: { url: string }, cb: Listener) => {
            const q = new URL(opts.url).searchParams;
            const id = q.get("id")!;
            approvals.push({ id, type: q.get("type")!, origin: q.get("origin")!, stored: session[`approval-${id}`] });
            const windowId = approvals.length;
            cb({ id: windowId });
            // the user decides after the popup is open
            setTimeout(() => {
                if (answer === "close") { windowRemoved.forEach((l) => l(windowId)); return; }
                fakeChrome.storage.session.set({ [`approval-response-${id}`]: { approved: answer === "approve", timestamp: Date.now() } });
            }, 0);
        },
    },
};

/** Send a dApp request the way the content script relays it; resolves with the service worker's response. */
function request(method: string, params: unknown, origin: string | null = ORIGIN): Promise<{ result?: any; error?: string }> {
    return new Promise((resolve) => {
        const sender = origin === null ? { id: "ext-id" } : { id: "ext-id", origin, url: `${origin}/page` };
        // `origin` inside the message is page-controlled and must be ignored by the worker
        const message = { type: "rougechain-request", id: 1, method, params, origin: "https://page-claimed.example" };
        for (const l of messageListeners) l(message, sender, resolve);
    });
}

function unlockWallet() {
    session["pqc-unified-wallet"] = JSON.stringify({ signingPublicKey: PUB, signingPrivateKey: PRIV });
}
function connect(origin = ORIGIN) {
    local["rougechain-connected-sites"] = JSON.stringify([{ origin, connectedAt: 1 }]);
}

let ADDRESS = "";
let nodeChainId = "rougechain-mainnet-1";
beforeAll(async () => {
    (globalThis as any).chrome = fakeChrome;
    // The worker checks the selected network's chain id against its node once per session; answer
    // locally (never reach a real node from tests). `nodeChainId` lets a test play a wrong node.
    vi.stubGlobal("fetch", async (url: string) => {
        if (String(url).endsWith("/health")) return new Response(JSON.stringify({ status: "ok", chain_id: nodeChainId, height: 1 }), { status: 200 });
        return new Response(JSON.stringify({ success: false, error: "offline in tests" }), { status: 503 });
    });
    ADDRESS = await pubkeyToAddress(PUB);
    await import("../src/background/service-worker");
});

beforeEach(() => {
    for (const k of Object.keys(local)) delete local[k];
    for (const k of Object.keys(session)) delete session[k];
    approvals = [];
    answer = "approve";
    unlockWallet();
    connect();
});

const signIn = (patch: Record<string, unknown> = {}) => createSignInMessage({
    domain: "tickets.example.com",
    address: ADDRESS,
    uri: "https://tickets.example.com/login",
    statement: "Sign in to see your tickets.",
    nonce: "4f9c2d1e8a7b6c5d",
    issuedAt: "2026-10-06T12:00:00.000Z",
    expirationTime: "2999-01-01T00:00:00.000Z",
    chainId: "rougechain-mainnet-1",
    ...patch,
} as any);

// ─── the injected provider ───────────────────────────────────────────────────

describe("injected provider (window.rougechain)", () => {
    it("exposes signMessage for feature detection and relays only { message }", async () => {
        const posted: any[] = [];
        const listeners: Listener[] = [];
        const win: any = {
            postMessage: (m: unknown) => posted.push(m),
            addEventListener: (_: string, l: Listener) => listeners.push(l),
            dispatchEvent: () => true,
        };
        (globalThis as any).window = win;
        (globalThis as any).Event = (globalThis as any).Event ?? class { constructor(public type: string) { } };
        try {
            await import("../src/content/provider");
            const provider = win.rougechain;
            expect(provider.isRougeChain).toBe(true);
            expect(typeof provider.signMessage).toBe("function");
            // the existing surface is still there, unchanged
            for (const m of ["connect", "getBalance", "signTransaction", "sendTransaction", "on", "removeListener"]) {
                expect(typeof provider[m], m).toBe("function");
            }
            const pending = provider.signMessage({ message: "hello", extra: "ignored" });
            expect(posted).toHaveLength(1);
            expect(posted[0]).toMatchObject({ source: "rougechain-provider", type: "rougechain-request", method: "signMessage", params: { message: "hello" } });
            expect(Object.keys(posted[0].params)).toEqual(["message"]);
            const reply = { signature: "aa", publicKey: "bb", address: "rouge1x" };
            for (const l of listeners) l({ source: win, data: { source: "rougechain-content-script", type: "rougechain-response", id: posted[0].id, result: reply } });
            expect(await pending).toEqual(reply);
        } finally {
            delete (globalThis as any).window;
        }
    });

    it("the content script relays every provider method, with the origin the worker ignores", () => {
        const inject = src("content/inject.ts");
        expect(inject).toContain("method: msg.method");
        // the worker keys everything on the sender's origin, not on the message's
        expect(src("background/service-worker.ts")).toContain("const origin = trustedOrigin(sender);");
    });
});

// ─── the service worker route ────────────────────────────────────────────────

describe("service worker: signMessage", () => {
    it("signs after approval and returns { signature, publicKey, address } that verifyMessage accepts", async () => {
        const res = await request("signMessage", { message: "I am the holder of this wallet." });
        expect(res.error).toBeUndefined();
        expect(Object.keys(res.result).sort()).toEqual(["address", "publicKey", "signature"]);
        expect(res.result.publicKey).toBe(PUB);
        expect(res.result.address).toBe(ADDRESS);
        expect(verifyMessage(PUB, "I am the holder of this wallet.", res.result.signature)).toBe(true);
        // exactly the documented bytes, and NOT the bare message (that would be a transaction-style signature)
        expect(ml_dsa65.verify(unhex(res.result.signature), messageSigningBytes("I am the holder of this wallet."), kp.publicKey)).toBe(true);
        expect(ml_dsa65.verify(unhex(res.result.signature), new TextEncoder().encode("I am the holder of this wallet."), kp.publicKey)).toBe(false);
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({ type: "sign-message", origin: ORIGIN });
    });

    it("the shared vector: the extension's signature over the vector message verifies like the recorded one", async () => {
        const res = await request("signMessage", { message: vector.message });
        expect(verifyMessage(vector.publicKey, vector.message, res.result.signature)).toBe(true);
        expect(verifyMessage(vector.publicKey, vector.message, vector.signature)).toBe(true);
        expect(res.result.address).toBe(vector.address);
    });

    it("a sign-in message signed through the extension passes verifySignIn", async () => {
        const message = signIn();
        const res = await request("signMessage", { message });
        const verdict = await verifySignIn({
            message, signature: res.result.signature, publicKey: res.result.publicKey,
            expectedDomain: "tickets.example.com", expectedNonce: "4f9c2d1e8a7b6c5d", expectedChainId: "rougechain-mainnet-1",
            now: Date.parse("2026-10-06T12:01:00.000Z"),
        });
        expect(verdict).toMatchObject({ valid: true, address: ADDRESS });
    });

    it("ALWAYS asks: every call opens a new approval, even for the same message on a connected site", async () => {
        for (let i = 1; i <= 3; i++) {
            const res = await request("signMessage", { message: "same message" });
            expect(res.result?.signature).toBeTruthy();
            expect(approvals).toHaveLength(i);
        }
        expect(new Set(approvals.map((a) => a.id)).size).toBe(3);
    });

    it("requires the origin to be connected (and never opens a popup otherwise)", async () => {
        delete local["rougechain-connected-sites"];
        expect(await request("signMessage", { message: "hello" })).toEqual({ error: "Site not connected. Call connect() first." });
        connect("https://other.example");
        expect(await request("signMessage", { message: "hello" })).toEqual({ error: "Site not connected. Call connect() first." });
        expect(approvals).toHaveLength(0);
    });

    it("uses the sender's origin, not the origin the page writes into the message", async () => {
        connect("https://page-claimed.example"); // only the page-claimed origin is connected
        expect(await request("signMessage", { message: "hello" })).toEqual({ error: "Site not connected. Call connect() first." });
        expect(approvals).toHaveLength(0);
    });

    it("refuses when the wallet is locked", async () => {
        delete session["pqc-unified-wallet"];
        expect(await request("signMessage", { message: "hello" })).toEqual({ error: "Wallet is locked" });
        expect(approvals).toHaveLength(0);
    });

    it("refuses requests that do not come from an https site (or localhost)", async () => {
        const res = await request("signMessage", { message: "hello" }, "http://tickets.example.com");
        expect(res.error).toMatch(/only accepted from https/);
        expect(approvals).toHaveLength(0);
    });

    it("returns an error and no signature when the user denies or closes the popup", async () => {
        answer = "deny";
        expect(await request("signMessage", { message: "hello" })).toEqual({ error: "User denied message signature request" });
        answer = "close";
        expect(await request("signMessage", { message: "hello" })).toEqual({ error: "User denied message signature request" });
        expect(approvals).toHaveLength(2);
    });

    it("refuses a message that looks like a transaction payload, pointing to signTransaction, without asking", async () => {
        const txLike = [
            JSON.stringify({ type: "transfer", from: PUB, to: "rouge1x", amount: 5, fee: 1, token: "XRGE", timestamp: 1, nonce: "n" }),
            '{"tx_type":"stake","from":"aa","nonce":1,"fee":1,"payload":{"amount":5}}',
            '\n  {"type":"contract_call","contractAddr":"ab","method":"m"}  ',
            '{"from":"aa","timestamp":1,"nonce":"n"}',
        ];
        for (const message of txLike) {
            const res = await request("signMessage", { message });
            expect(res.result).toBeUndefined();
            expect(res.error).toMatch(/Use signTransaction/);
        }
        expect(approvals).toHaveLength(0);
    });

    it("refuses a missing, non-string, empty, ill-formed or oversized message without asking", async () => {
        const bad: unknown[] = [undefined, {}, { message: 5 }, { message: { text: "x" } }, { message: ["x"] }, { message: "" }, { message: "a" + ch(0xd800) }, { message: "a".repeat(4097) }];
        for (const params of bad) {
            const res = await request("signMessage", params);
            expect(res.result).toBeUndefined();
            expect(res.error).toBeTruthy();
        }
        expect(approvals).toHaveLength(0);
        // exactly at the cap is accepted
        expect((await request("signMessage", { message: "a".repeat(4096) })).result?.signature).toBeTruthy();
    });

    it("hands the popup the whole message, its visible form and the review flags", async () => {
        const message = "line 1\nline 2" + ch(0x0d) + "\n" + ch(0x202e) + "line 3";
        await request("signMessage", { message });
        const stored = approvals[0].stored;
        expect(stored.type).toBe("sign-message");
        expect(stored.origin).toBe(ORIGIN);
        expect(stored.payload.message).toBe(message);
        expect(stored.payload.display).toBe("line 1\nline 2" + ch(0x240d) + "\n" + ch(0x27e8) + "U+202E" + ch(0x27e9) + "line 3");
        expect(stored.payload).toMatchObject({ lineCount: 3, originHost: "tickets.example.com", signIn: null, domainMismatch: false });
    });

    it("flags a sign-in message for another domain (and another wallet) for the popup", async () => {
        await request("signMessage", { message: signIn({ domain: "bank.example" }) });
        expect(approvals[0].stored.payload).toMatchObject({ domainMismatch: true, claimedDomain: "bank.example", originHost: "tickets.example.com", addressMismatch: false });
        expect(approvals[0].stored.payload.signIn).toMatchObject({ domain: "bank.example", nonce: "4f9c2d1e8a7b6c5d" });

        const otherAddress = await pubkeyToAddress(hex(ml_dsa65.keygen(new Uint8Array(32).fill(9)).publicKey));
        await request("signMessage", { message: signIn({ address: otherAddress }) });
        expect(approvals[1].stored.payload).toMatchObject({ domainMismatch: false, addressMismatch: true });

        await request("signMessage", { message: signIn() });
        expect(approvals[2].stored.payload).toMatchObject({ domainMismatch: false, addressMismatch: false, signInMalformed: false, expired: false });
    });

    it("signTransaction is untouched: same route, same canonical-JSON signature, own approval type", async () => {
        const payload = { type: "transfer", from: PUB, to: "rouge1x", amount: 5, fee: 1, token: "XRGE", timestamp: 1, nonce: "n" };
        const res = await request("signTransaction", { payload });
        expect(approvals[0].type).toBe("sign");
        // network binding: a plain payload is signed for the wallet's selected network
        const bound = { ...payload, chainId: "rougechain-mainnet-1" };
        expect(res.result.payload).toEqual(bound);
        expect(approvals[0].stored.network).toMatchObject({ chainId: "rougechain-mainnet-1", name: "RougeChain Mainnet", missing: false });
        const sorted = JSON.stringify(Object.fromEntries(Object.entries(bound).sort(([a], [b]) => (a < b ? -1 : 1))));
        expect(res.result.signedPayload).toBe(sorted);
        expect(ml_dsa65.verify(unhex(res.result.signature), new TextEncoder().encode(sorted), kp.publicKey)).toBe(true);
        // a transaction signature is not a message signature
        expect(verifyMessage(PUB, sorted, res.result.signature)).toBe(false);
        // and signTransaction still only signs bytes that are the payload's canonical JSON
        const forged = await request("signTransaction", { payload: { payload, serializedHex: hex(messageSigningBytes("hello")) } });
        expect(forged.error).toBe("serializedHex does not match the payload");
    });

    it("signTransaction refuses a payload for another network, before any approval", async () => {
        const payload = { type: "transfer", from: PUB, to: "rouge1x", amount: 5, timestamp: 1, nonce: "n", chainId: "rougechain-devnet-1" };
        const res = await request("signTransaction", { payload });
        expect(res.error).toMatch(/^CHAIN_ID_MISMATCH: .*RougeChain Testnet.*RougeChain Mainnet/);
        expect(approvals).toHaveLength(0);
        // with testnet selected the same payload is fine
        local["rougechain-network"] = "testnet";
        nodeChainId = "rougechain-devnet-1";
        try {
            const ok = await request("signTransaction", { payload });
            expect(ok.result.payload.chainId).toBe("rougechain-devnet-1");
            expect(approvals[0].stored.network).toMatchObject({ name: "RougeChain Testnet", missing: false });
        } finally {
            nodeChainId = "rougechain-mainnet-1";
        }
    });

    it("signTransaction envelope without chainId: shown with the no-network warning, bytes unchanged", async () => {
        const payload = { type: "transfer", from: PUB, to: "rouge1x", amount: 5, timestamp: 1, nonce: "n" };
        const sorted = JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1))));
        const res = await request("signTransaction", { payload: { payload, serializedHex: hex(new TextEncoder().encode(sorted)) } });
        expect(res.result.signedPayload).toBe(sorted);
        expect(approvals[0].stored.network).toMatchObject({ chainId: null, missing: true });
    });

    it("signTransaction and sendTransaction refuse to sign when the node reports another chain id", async () => {
        local["rougechain-network"] = "testnet";
        local["rougechain-custom-node-url"] = "https://wrong-node.example"; // not checked yet this session
        nodeChainId = "rougechain-mainnet-1"; // the selected (testnet) node says it is mainnet
        try {
            const payload = { type: "transfer", from: PUB, to: "rouge1x", amount: 5, timestamp: 1, nonce: "n" };
            const res = await request("signTransaction", { payload });
            expect(res.error).toMatch(/Refusing to sign/);
            const sent = await request("sendTransaction", { payload: { type: "transfer", to: "rouge1x", amount: 1 } });
            expect(sent.error).toMatch(/Refusing to sign/);
            expect(approvals).toHaveLength(0);
        } finally {
            nodeChainId = "rougechain-mainnet-1";
        }
    });
});

// ─── the approval popup ──────────────────────────────────────────────────────

describe("approval popup: SignMessageView", () => {
    const review = (message: string, origin = ORIGIN, now = Date.parse("2026-10-06T12:01:00.000Z")): SignMessageReview => {
        const r = reviewSignMessageRequest(message, origin, ADDRESS, now);
        if ("error" in r) throw new Error(r.error);
        return r;
    };
    const html = (r: SignMessageReview) => renderToStaticMarkup(createElement(SignMessageView, { review: r }));
    const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

    it("shows the whole message, every line, with its line and byte counts (no truncation)", () => {
        const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`);
        const message = lines.join("\n");
        const r = review(message);
        const out = html(r);
        const shown = text(out.slice(out.indexOf('data-testid="message-text"')).replace(/^[^>]*>/, "").split("</pre>")[0]);
        expect(shown).toBe(message);
        expect(text(out)).toContain("400 lines");
        expect(text(out)).toContain(`${r.byteLength.toLocaleString("en-US")} bytes`);
        // scrollable, not clipped
        expect(out).toMatch(/max-h-\[220px\] overflow-auto/);
        expect(out).not.toMatch(/truncate|line-clamp|text-ellipsis/);
    });

    it("shows control and invisible characters as visible symbols", () => {
        const out = html(review("safe" + ch(0x0d) + ch(0x202e) + "evil" + ch(0x200b)));
        expect(out).toContain("safe" + ch(0x240d) + ch(0x27e8) + "U+202E" + ch(0x27e9) + "evil" + ch(0x27e8) + "U+200B" + ch(0x27e9));
        for (const c of [0x0d, 0x202e, 0x200b]) expect(out.includes(ch(c))).toBe(false);
    });

    it("a sign-in for this site: structured domain, address, nonce and expiry, no warning", () => {
        const r = review(signIn({ expirationTime: "2026-10-06T12:10:00.000Z" }));
        const out = html(r);
        expect(out).toContain('data-testid="sign-in-fields"');
        const t = text(out);
        for (const v of ["tickets.example.com", ADDRESS, "4f9c2d1e8a7b6c5d", "2026-10-06T12:10:00.000Z", "rougechain-mainnet-1"]) expect(t).toContain(v);
        expect(out).not.toContain('role="alert"');
        expect(signMessageHasDanger(r)).toBe(false);
        // no expiry is said plainly
        expect(text(html(review(signIn({ expirationTime: undefined }))))).toContain("never (no expiry in the message)");
    });

    it("RED warning when the message's domain is not the requesting site", () => {
        const r = review(signIn({ domain: "bank.example" }));
        const out = html(r);
        const alert = out.slice(out.indexOf('data-testid="domain-mismatch"'));
        expect(out).toContain('role="alert" data-testid="domain-mismatch"');
        expect(alert).toMatch(/^[^>]*border-red-500 bg-red-500\/15/);
        expect(text(alert)).toContain("bank.example");
        expect(text(alert)).toContain("tickets.example.com");
        expect(signMessageHasDanger(r)).toBe(true);
        // also for a look-alike of the real site, and for a non-canonical sign-in text
        expect(html(review(signIn(), "https://tickets.example.com.evil.example"))).toContain('data-testid="domain-mismatch"');
        const sloppy = html(review("bank.example wants you to sign in with your RougeChain account:\nanything"));
        expect(sloppy).toContain('data-testid="domain-mismatch"');
        expect(sloppy).toContain('data-testid="sign-in-malformed"');
        expect(sloppy).not.toContain('data-testid="sign-in-fields"');
    });

    it("warns about another wallet's address and about an expired sign-in", async () => {
        const otherAddress = await pubkeyToAddress(hex(ml_dsa65.keygen(new Uint8Array(32).fill(9)).publicKey));
        const r = review(signIn({ address: otherAddress }));
        expect(html(r)).toContain('data-testid="address-mismatch"');
        expect(signMessageHasDanger(r)).toBe(true);
        expect(html(review(signIn({ expirationTime: "2026-10-06T12:00:30.000Z" })))).toContain('data-testid="sign-in-expired"');
    });

    it("a plain message has no sign-in block and no warning", () => {
        const out = html(review("I agree to the terms of the raffle."));
        expect(out).not.toContain('data-testid="sign-in-fields"');
        expect(out).not.toContain('role="alert"');
        expect(text(out)).toContain("cannot send a transaction or move funds");
    });

    it("the popup routes sign-message to this view and disables Sign when the review is missing", () => {
        const app = src("approval/App.tsx");
        expect(app).toContain('{kind === "sign-message" && (');
        expect(app).toContain("<SignMessageView review={messageReview} />");
        expect(app).toContain('disabled={closing || (kind === "sign-message" && !messageReview) || ((kind === "sign" || kind === "send") && !request.network)}');
        expect(app).toContain("<NetworkBanner network={request.network} />");
        expect(app).toContain('{isSign && (messageDanger ? "Sign anyway" : "Sign")}');
    });
});

describe("version", () => {
    it("the manifests and package.json agree, at 1.9.0 (signMessage since 1.8.0; signatures name the network since 1.9.0)", () => {
        const root = (p: string) => JSON.parse(readFileSync(path.resolve(here, "..", p), "utf8")).version;
        expect([root("package.json"), root("manifest.json"), root("public/manifest.json")]).toEqual(["1.9.0", "1.9.0", "1.9.0"]);
    });
});
