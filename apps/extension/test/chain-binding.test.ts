/**
 * Network binding: everything the extension signs for a node carries the selected network's
 * `chainId` inside the signed bytes, and dApp requests for another network are refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { installChromeShim, resetChromeData } from "./chrome-shim";
import {
    checkNodeChainId,
    resetChainIdChecks,
    reviewPayloadChainId,
    withChainId,
    ChainIdMismatchError,
} from "../src/lib/chain-binding";
import { prepareSignRequest, bindSendPayload, serializePayload, bytesToHex } from "../src/lib/sign-request";
import * as ext from "../src/lib/chain-binding";
import * as core from "@rougechain/core/chain-id";

const MAIN = "rougechain-mainnet-1";
const TEST = "rougechain-devnet-1";
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const kp = ml_dsa65.keygen(new Uint8Array(32).fill(7));
const pub = hex(kp.publicKey);
const priv = hex(kp.secretKey);

function health(chainId: string | null, status = 200) {
    return vi.fn(async () => new Response(JSON.stringify(chainId ? { status: "ok", chain_id: chainId, height: 1 } : {}), { status }));
}

afterEach(() => {
    resetChainIdChecks();
    vi.unstubAllGlobals();
});

describe("chain ids", () => {
    it("agree with the website's (@rougechain/core/chain-id)", () => {
        expect(ext.MAINNET_CHAIN_ID).toBe(core.MAINNET_CHAIN_ID);
        expect(ext.TESTNET_CHAIN_ID).toBe(core.TESTNET_CHAIN_ID);
        for (const n of ["mainnet", "testnet"] as const) expect(ext.chainIdForNetwork(n)).toBe(core.chainIdForNetwork(n));
        for (const id of [MAIN, TEST, "other-1", undefined]) expect(ext.networkNameForChainId(id)).toBe(core.networkNameForChainId(id));
    });
});

describe("reviewPayloadChainId", () => {
    it("accepts the selected network and names it", () => {
        const r = reviewPayloadChainId({ chainId: MAIN }, MAIN);
        expect(r).toMatchObject({ chainId: MAIN, name: "RougeChain Mainnet", missing: false });
    });
    it("refuses another network with a coded error", () => {
        const r = reviewPayloadChainId({ chainId: TEST }, MAIN);
        expect("error" in r && r.error).toMatch(/^CHAIN_ID_MISMATCH: .*RougeChain Testnet.*RougeChain Mainnet/);
        expect("error" in reviewPayloadChainId({ chainId: 5 }, MAIN)).toBe(true);
        expect("error" in reviewPayloadChainId({ chainId: "" }, MAIN)).toBe(true);
    });
    it("flags a payload without a network", () => {
        expect(reviewPayloadChainId({}, TEST)).toMatchObject({ chainId: null, missing: true, selectedName: "RougeChain Testnet" });
    });
    it("withChainId never re-targets a payload", () => {
        expect(withChainId({ a: 1 }, MAIN)).toEqual({ a: 1, chainId: MAIN });
        expect(() => withChainId({ chainId: TEST }, MAIN)).toThrow(/CHAIN_ID_MISMATCH/);
    });
});

describe("prepareSignRequest (dApp signTransaction)", () => {
    const base = { type: "transfer", from: pub, to: "ab".repeat(16), amount: 1, timestamp: 1, nonce: "n".repeat(16) };
    const envelope = (payload: Record<string, unknown>) => ({
        payload,
        serializedHex: bytesToHex(new TextEncoder().encode(serializePayload(payload))),
    });

    it("envelope for the selected network: signed bytes include chainId", () => {
        const p = { ...base, chainId: MAIN };
        const r = prepareSignRequest(envelope(p), pub, MAIN);
        expect("error" in r).toBe(false);
        if ("error" in r) return;
        expect(r.payload).toEqual(p);
        expect(r.network).toMatchObject({ name: "RougeChain Mainnet", missing: false });
        expect(serializePayload(r.payload)).toContain(`"chainId":"${MAIN}"`);
    });

    it("envelope for another network is refused before any approval", () => {
        const r = prepareSignRequest(envelope({ ...base, chainId: TEST }), pub, MAIN);
        expect("error" in r && r.error).toMatch(/^CHAIN_ID_MISMATCH/);
    });

    it("envelope without chainId: allowed for now, flagged for the warning, bytes untouched", () => {
        const r = prepareSignRequest(envelope(base), pub, MAIN);
        expect("error" in r).toBe(false);
        if ("error" in r) return;
        expect(r.payload).toEqual(base);
        expect(r.network.missing).toBe(true);
    });

    it("tampered envelope bytes are still refused", () => {
        const env = envelope({ ...base, chainId: MAIN });
        const r = prepareSignRequest({ ...env, payload: { ...base, chainId: TEST } }, pub, MAIN);
        expect("error" in r && r.error).toBe("serializedHex does not match the payload");
    });

    it("plain payload without chainId gets the selected network's", () => {
        const r = prepareSignRequest(base, pub, TEST);
        expect("error" in r).toBe(false);
        if ("error" in r) return;
        expect(r.payload.chainId).toBe(TEST);
        expect(r.network).toMatchObject({ chainId: TEST, missing: false, name: "RougeChain Testnet" });
    });

    it("plain payload for another network is refused", () => {
        const r = prepareSignRequest({ ...base, chainId: MAIN }, pub, TEST);
        expect("error" in r && r.error).toMatch(/^CHAIN_ID_MISMATCH/);
    });

    it("bindSendPayload binds or refuses", () => {
        const ok = bindSendPayload({ type: "transfer", to: "x", amount: 1 }, MAIN);
        expect("error" in ok ? null : ok.payload.chainId).toBe(MAIN);
        expect("error" in bindSendPayload({ type: "transfer", chainId: TEST }, MAIN)).toBe(true);
    });
});

describe("checkNodeChainId (once per session)", () => {
    it("passes when the node agrees and asks only once", async () => {
        const f = health(MAIN);
        await checkNodeChainId("http://n/api", MAIN, f as unknown as typeof fetch);
        await checkNodeChainId("http://n/api", MAIN, f as unknown as typeof fetch);
        expect(f).toHaveBeenCalledTimes(1);
        expect(f.mock.calls[0][0]).toBe("http://n/api/health");
    });
    it("throws on a different chain id and keeps refusing", async () => {
        const f = health(TEST);
        await expect(checkNodeChainId("http://n/api", MAIN, f as unknown as typeof fetch)).rejects.toBeInstanceOf(ChainIdMismatchError);
        await expect(checkNodeChainId("http://other/api", MAIN, health(MAIN) as unknown as typeof fetch)).rejects.toBeInstanceOf(ChainIdMismatchError);
    });
    it("an unreachable node does not block (the node still refuses a wrong chain id)", async () => {
        const f = vi.fn(async () => { throw new Error("offline"); });
        await expect(checkNodeChainId("http://n/api", MAIN, f as unknown as typeof fetch)).resolves.toBeUndefined();
    });
});

describe("popup signers bind the selected network", () => {
    beforeEach(async () => {
        installChromeShim();
        resetChromeData();
        const storage = await import("../src/lib/storage");
        await storage.initStorage();
    });

    it("buildSignedRequest (messenger/mail/names) signs chainId", async () => {
        const { setActiveNetwork } = await import("../src/lib/network");
        const { buildSignedRequest } = await import("../src/lib/pqc-messenger");
        setActiveNetwork("testnet");
        const s = buildSignedRequest({ action: "x" }, priv, pub);
        expect(s.payload.chainId).toBe(TEST);
        const bytes = new TextEncoder().encode(JSON.stringify(s.payload));
        expect(new TextDecoder().decode(bytes)).toContain(`"chainId":"${TEST}"`);
        expect(ml_dsa65.verify(Uint8Array.from(Buffer.from(s.signature, "hex")), bytes, kp.publicKey)).toBe(true);
        setActiveNetwork("mainnet");
        expect(buildSignedRequest({}, priv, pub).payload.chainId).toBe(MAIN);
    });

    it("buildSignedV2 checks the node and signs chainId; refuses on mismatch", async () => {
        const { setActiveNetwork } = await import("../src/lib/network");
        const { buildSignedV2 } = await import("../src/lib/tx-signer");
        setActiveNetwork("mainnet");
        vi.stubGlobal("fetch", health(MAIN));
        const body = await buildSignedV2({ signingPublicKey: pub, signingPrivateKey: priv }, { type: "transfer", to: "a", amount: 1 }, { baseUrl: "http://n/api" });
        expect(body.payload.chainId).toBe(MAIN);
        const bytes = new TextEncoder().encode(JSON.stringify(body.payload));
        expect(ml_dsa65.verify(Uint8Array.from(Buffer.from(body.signature, "hex")), bytes, kp.publicKey)).toBe(true);

        resetChainIdChecks();
        vi.stubGlobal("fetch", health(TEST));
        await expect(buildSignedV2({ signingPublicKey: pub, signingPrivateKey: priv }, { type: "transfer" }, { baseUrl: "http://n/api" }))
            .rejects.toBeInstanceOf(ChainIdMismatchError);
        // and the synchronous signers refuse too, for the rest of the session
        const { buildSignedRequest } = await import("../src/lib/pqc-messenger");
        expect(() => buildSignedRequest({}, priv, pub)).toThrow(ChainIdMismatchError);
    });
});
