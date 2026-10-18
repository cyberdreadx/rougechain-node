/**
 * Signatures commit to the network: every payload a wallet signs for the node carries `chainId`
 * (the selected network's chain id) inside the signed bytes, and signing is refused when the node
 * reports another chain id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import {
  ChainIdMismatchError, MAINNET_CHAIN_ID, TESTNET_CHAIN_ID, chainIdForNetwork, getSigningChainId,
  networkForChainId, networkNameForChainId, resetChainIdChecks, verifyNodeChainId, withChainId,
} from "../src/chain-id";
import { createSignedTransfer, serializePayload, signTransaction, verifyTransaction } from "../src/pqc-signer";
import { buildSignedRequest } from "../src/pqc-messenger";
import { buildContractCallPayload } from "../src/contracts";
import { signViaExtension } from "../src/extension-bridge";
import { secureTransfer } from "../src/secure-api";
import { NETWORK_STORAGE_KEY } from "../src/network";
import { installStorage } from "./storage-shim";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const kp = ml_dsa65.keygen(new Uint8Array(32).fill(9));
const pub = hex(kp.publicKey);
const priv = hex(kp.secretKey);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** fetch mock: /health answers `chain_id`, everything else `{ success: true }`. */
function nodeReporting(chainId: string | null) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url).endsWith("/health")) {
      return new Response(JSON.stringify(chainId ? { status: "ok", chain_id: chainId, height: 1 } : { status: "ok" }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
}

beforeEach(() => {
  resetChainIdChecks();
  installStorage();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetChainIdChecks();
});

describe("network names", () => {
  it("maps chain ids to networks and names", () => {
    expect(chainIdForNetwork("mainnet")).toBe(MAINNET_CHAIN_ID);
    expect(chainIdForNetwork("testnet")).toBe(TESTNET_CHAIN_ID);
    expect(networkForChainId(MAINNET_CHAIN_ID)).toBe("mainnet");
    expect(networkForChainId(TESTNET_CHAIN_ID)).toBe("testnet");
    expect(networkForChainId("other-1")).toBeNull();
    expect(networkForChainId(undefined)).toBeNull();
    expect(networkNameForChainId(MAINNET_CHAIN_ID)).toBe("RougeChain Mainnet");
    expect(networkNameForChainId(TESTNET_CHAIN_ID)).toBe("RougeChain Testnet");
    expect(networkNameForChainId("other-1")).toBe("Unknown network (other-1)");
    expect(networkNameForChainId(undefined)).toBe("No network specified");
  });

  it("signs for the selected network", () => {
    expect(getSigningChainId()).toBe(MAINNET_CHAIN_ID);
    localStorage.setItem(NETWORK_STORAGE_KEY, "testnet");
    expect(getSigningChainId()).toBe(TESTNET_CHAIN_ID);
  });
});

describe("chainId is inside the signed bytes", () => {
  it("transfer", () => {
    const tx = createSignedTransfer(pub, priv, "ab".repeat(16), 5);
    expect(tx.payload.chainId).toBe(MAINNET_CHAIN_ID);
    expect(text(serializePayload(tx.payload))).toContain(`"chainId":"${MAINNET_CHAIN_ID}"`);
    expect(verifyTransaction(tx)).toBe(true);
    // the signature does not verify for the same payload on another network
    expect(verifyTransaction({ ...tx, payload: { ...tx.payload, chainId: TESTNET_CHAIN_ID } })).toBe(false);
  });

  it("testnet transfer names testnet", () => {
    localStorage.setItem(NETWORK_STORAGE_KEY, "testnet");
    const tx = createSignedTransfer(pub, priv, "ab".repeat(16), 5);
    expect(tx.payload.chainId).toBe(TESTNET_CHAIN_ID);
    expect(verifyTransaction(tx)).toBe(true);
  });

  it("signed request (messenger / mail / names)", () => {
    const req = buildSignedRequest({ action: "messenger_ws_subscribe" }, priv, pub);
    expect(req.payload.chainId).toBe(MAINNET_CHAIN_ID);
    const bytes = new TextEncoder().encode(JSON.stringify(req.payload));
    expect(text(bytes)).toContain(`"chainId":"${MAINNET_CHAIN_ID}"`);
    expect(ml_dsa65.verify(Uint8Array.from(Buffer.from(req.signature, "hex")), bytes, kp.publicKey)).toBe(true);
  });

  it("contract call", () => {
    const tx = signTransaction(buildContractCallPayload(pub, "ab".repeat(20), "play", { n: 1 }, 1000), priv, pub);
    expect(text(serializePayload(tx.payload))).toContain(`"chainId":"${MAINNET_CHAIN_ID}"`);
    expect(verifyTransaction(tx)).toBe(true);
  });
});

describe("refusals", () => {
  it("a payload that names another network is refused, never re-targeted", () => {
    expect(() => withChainId({ a: 1, chainId: TESTNET_CHAIN_ID })).toThrow(ChainIdMismatchError);
    expect(() => withChainId({ a: 1, chainId: TESTNET_CHAIN_ID })).toThrow(/request is for RougeChain Testnet/);
    expect(() => signTransaction({ type: "transfer", from: pub, timestamp: 1, nonce: "n", chainId: TESTNET_CHAIN_ID }, priv, pub))
      .toThrow(ChainIdMismatchError);
    expect(withChainId({ a: 1, chainId: MAINNET_CHAIN_ID })).toEqual({ a: 1, chainId: MAINNET_CHAIN_ID });
  });

  it("refuses to sign when the node reports another chain id", async () => {
    const fetchMock = nodeReporting(TESTNET_CHAIN_ID);
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyNodeChainId("https://node.example/api")).rejects.toMatchObject({ code: "CHAIN_ID_MISMATCH" });
    // every later signature for that network is refused, synchronously too
    expect(() => createSignedTransfer(pub, priv, "ab".repeat(16), 5)).toThrow(ChainIdMismatchError);
    expect(() => buildSignedRequest({}, priv, pub)).toThrow(ChainIdMismatchError);
  });

  it("secureTransfer does not post when the node is on another network", async () => {
    const fetchMock = nodeReporting(TESTNET_CHAIN_ID);
    vi.stubGlobal("fetch", fetchMock);
    await expect(secureTransfer(pub, priv, "ab".repeat(16), 5)).rejects.toThrow(ChainIdMismatchError);
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes("/v2/transfer"))).toBe(true);
  });

  it("checks the node once per session, and a matching node lets signing proceed", async () => {
    const fetchMock = nodeReporting(MAINNET_CHAIN_ID);
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyNodeChainId("https://node.example/api")).resolves.toBe(MAINNET_CHAIN_ID);
    await verifyNodeChainId("https://node.example/api");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/health"))).toHaveLength(1);
    const r = await secureTransfer(pub, priv, "ab".repeat(16), 5);
    expect(r.success).toBe(true);
    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/v2/transfer"))!;
    const body = JSON.parse(String((post[1] as RequestInit).body));
    expect(body.payload.chainId).toBe(MAINNET_CHAIN_ID);
    expect(verifyTransaction(body)).toBe(true);
  });

  it("a node that does not report a chain id does not block signing", async () => {
    vi.stubGlobal("fetch", nodeReporting(null));
    await expect(verifyNodeChainId("https://node.example/api")).resolves.toBe(MAINNET_CHAIN_ID);
  });
});

describe("signViaExtension", () => {
  it("sends the payload WITH chainId and serializedHex over exactly those bytes", async () => {
    vi.stubGlobal("fetch", nodeReporting(MAINNET_CHAIN_ID));
    const signTx = vi.fn(async ({ serializedHex }: { serializedHex: string }) => ({
      signature: hex(ml_dsa65.sign(Uint8Array.from(Buffer.from(serializedHex, "hex")), kp.secretKey)),
    }));
    vi.stubGlobal("window", { rougechain: { isRougeChain: true, signTransaction: signTx } });
    const res = await signViaExtension({ type: "transfer", from: pub, to: "cd", amount: 1, timestamp: 1, nonce: "n" }, pub);
    const sent = signTx.mock.calls[0][0] as unknown as { payload: { chainId: string }; serializedHex: string };
    expect(sent.payload.chainId).toBe(MAINNET_CHAIN_ID);
    expect(sent.serializedHex).toBe(hex(serializePayload(sent.payload as never)));
    expect(text(Uint8Array.from(Buffer.from(sent.serializedHex, "hex")))).toContain(`"chainId":"${MAINNET_CHAIN_ID}"`);
    expect(res.payload.chainId).toBe(MAINNET_CHAIN_ID);
    expect(res.payload_bytes_hex).toBe(sent.serializedHex);
    expect(verifyTransaction(res)).toBe(true);
  });
});
