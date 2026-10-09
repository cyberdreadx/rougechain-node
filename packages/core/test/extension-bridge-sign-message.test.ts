/**
 * signMessageViaExtension: first-party pages ask the connected provider wallet (extension /
 * Qwalla) to sign a message, and only hand back a signature that verifies for the connected key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { pubkeyToAddress } from "../src/address";
import { providerSupportsSignMessage, signMessageViaExtension, signViaExtension } from "../src/extension-bridge";
import { signMessage, verifyMessage } from "../src/message-signing";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const a = ml_dsa65.keygen(new Uint8Array(32).fill(21));
const b = ml_dsa65.keygen(new Uint8Array(32).fill(22));
const [aPub, aPriv, bPub, bPriv] = [hex(a.publicKey), hex(a.secretKey), hex(b.publicKey), hex(b.secretKey)];

function install(provider: Record<string, unknown> | undefined) {
  vi.stubGlobal("window", { rougechain: provider });
}
const honest = () => vi.fn(async ({ message }: { message: string }) => ({
  signature: signMessage(aPriv, message), publicKey: aPub, address: await pubkeyToAddress(aPub),
}));

afterEach(() => vi.unstubAllGlobals());

describe("signMessageViaExtension", () => {
  it("asks the provider with { message } and returns a verified { message, signature, publicKey, address }", async () => {
    const sm = honest();
    const signTransaction = vi.fn();
    install({ isRougeChain: true, signMessage: sm, signTransaction });
    expect(providerSupportsSignMessage()).toBe(true);
    const res = await signMessageViaExtension("hello", aPub);
    expect(sm).toHaveBeenCalledTimes(1);
    expect(sm).toHaveBeenCalledWith({ message: "hello" });
    expect(signTransaction).not.toHaveBeenCalled();
    expect(res).toEqual({ message: "hello", signature: expect.any(String), publicKey: aPub, address: await pubkeyToAddress(aPub) });
    expect(verifyMessage(aPub, "hello", res.signature)).toBe(true);
  });

  it("refuses when there is no provider, or the object is not a RougeChain provider", async () => {
    install(undefined);
    expect(providerSupportsSignMessage()).toBe(false);
    await expect(signMessageViaExtension("hello", aPub)).rejects.toThrow("not available");
    install({ signMessage: honest() }); // no isRougeChain
    await expect(signMessageViaExtension("hello", aPub)).rejects.toThrow("not available");
  });

  it("refuses an older wallet without signMessage and never falls back to signTransaction", async () => {
    const signTransaction = vi.fn(async () => ({ signature: "ab" }));
    install({ isRougeChain: true, signTransaction });
    expect(providerSupportsSignMessage()).toBe(false);
    await expect(signMessageViaExtension("hello", aPub)).rejects.toThrow("does not support message signing");
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("refuses a missing signature, another account's signature and a signature for another message", async () => {
    install({ isRougeChain: true, signMessage: async () => ({}) });
    await expect(signMessageViaExtension("hello", aPub)).rejects.toThrow("did not return a signature");

    install({ isRougeChain: true, signMessage: async ({ message }: { message: string }) => ({ signature: signMessage(bPriv, message), publicKey: bPub }) });
    await expect(signMessageViaExtension("hello", aPub)).rejects.toThrow("different account");

    // claims the right key but the signature is by another one
    install({ isRougeChain: true, signMessage: async ({ message }: { message: string }) => ({ signature: signMessage(bPriv, message), publicKey: aPub }) });
    await expect(signMessageViaExtension("hello", aPub)).rejects.toThrow("does not verify");

    install({ isRougeChain: true, signMessage: async () => ({ signature: signMessage(aPriv, "other text"), publicKey: aPub }) });
    await expect(signMessageViaExtension("hello", aPub)).rejects.toThrow("does not verify");

    // a transaction-style signature (bare bytes, no prefix) is not a message signature
    install({ isRougeChain: true, signMessage: async ({ message }: { message: string }) => ({ signature: hex(ml_dsa65.sign(new TextEncoder().encode(message), a.secretKey)), publicKey: aPub }) });
    await expect(signMessageViaExtension("hello", aPub)).rejects.toThrow("does not verify");
  });

  it("passes the user's refusal through", async () => {
    install({ isRougeChain: true, signMessage: async () => { throw new Error("User denied message signature request"); } });
    await expect(signMessageViaExtension("hello", aPub)).rejects.toThrow("User denied message signature request");
  });

  it("signViaExtension (transactions): { payload + chainId, serializedHex } to signTransaction", async () => {
    const signTransaction = vi.fn(async () => ({ signature: "ab" }));
    const sm = honest();
    install({ isRougeChain: true, signTransaction, signMessage: sm });
    const payload = { type: "transfer" as const, from: aPub, to: "x", amount: 1, timestamp: 1, nonce: "n" };
    const tx = await signViaExtension(payload, aPub);
    expect(sm).not.toHaveBeenCalled();
    // the payload sent and returned carries the network's chainId (inside serializedHex)
    const bound = { ...payload, chainId: "rougechain-mainnet-1" };
    expect(signTransaction).toHaveBeenCalledWith({ payload: bound, serializedHex: tx.payload_bytes_hex });
    expect(tx).toMatchObject({ payload: bound, signature: "ab", public_key: aPub });
  });
});
