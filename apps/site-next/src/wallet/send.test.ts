import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pubkeyToAddress } from "@rougechain/core/address";
import { setTokenDecimalsCache } from "@rougechain/core/token-decimals";
import type { WalletBalance } from "@rougechain/core/pqc-wallet";
import { verifyTransaction, type SignedTransaction } from "@rougechain/core/pqc-signer";
import { claimFaucet, maxFractionDigits, parseAmount, parseRecipient, resolveRecipient, submitTransfer } from "./send";
import { mockFetch, resetBrowserState, seedAppsWebWallet } from "./test-utils";

const bal = (symbol: string, balance: number): WalletBalance => ({ symbol, balance, name: symbol, icon: "" });
const balances = [bal("XRGE", 1000), bal("qBTC", 150_000_000), bal("qUSDC", 5_000_000), bal("MEME", 42)];
const HEX_KEY = "ab".repeat(1952);

beforeEach(() => {
  resetBrowserState();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recipient", () => {
  it("accepts rouge1 addresses and full hex public keys (optionally xrge:-prefixed)", async () => {
    const addr = await pubkeyToAddress(HEX_KEY);
    expect(parseRecipient(addr)).toEqual({ valid: true, address: addr, isRouge: true });
    expect(parseRecipient(HEX_KEY)).toEqual({ valid: true, address: HEX_KEY, isRouge: false });
    expect(parseRecipient(`xrge:${HEX_KEY}`)).toEqual({ valid: true, address: HEX_KEY, isRouge: false });
  });
  it("rejects empty, non-hex, short keys and bad bech32 checksums", async () => {
    expect(parseRecipient("  ")).toMatchObject({ valid: false, error: "Recipient address required" });
    expect(parseRecipient("0xdeadbeef")).toMatchObject({ valid: false });
    expect(parseRecipient("abcd")).toMatchObject({ valid: false, error: expect.stringContaining("too short") });
    const addr = await pubkeyToAddress(HEX_KEY);
    const broken = addr.slice(0, -1) + (addr.endsWith("q") ? "p" : "q");
    expect(parseRecipient(broken).valid).toBe(false);
  });
});

describe("amount + decimals", () => {
  it("converts human amounts to raw units with core's token decimals", () => {
    expect(parseAmount("1.5", "qBTC", balances)).toEqual({ valid: true, human: 1.5, raw: 150_000_000 });
    expect(parseAmount("0.000001", "qUSDC", balances)).toEqual({ valid: true, human: 0.000001, raw: 1 });
    expect(parseAmount("12", "XRGE", balances)).toEqual({ valid: true, human: 12, raw: 12 });
    // The node stores transfer amounts as whole numbers (v2 binding `amount as u64`): no fractional XRGE.
    expect(parseAmount("12.5", "XRGE", balances)).toMatchObject({ valid: false, error: "XRGE amounts must be whole numbers" });
    expect(parseAmount("42", "MEME", balances)).toEqual({ valid: true, human: 42, raw: 42 });
  });
  it("uses the daemon's decimals when known", () => {
    setTokenDecimalsCache({ MEME: 2 });
    expect(maxFractionDigits("MEME")).toBe(2);
    expect(parseAmount("0.42", "MEME", balances)).toEqual({ valid: true, human: 0.42, raw: 42 });
    expect(parseAmount("0.421", "MEME", balances)).toMatchObject({ valid: false, error: "MEME supports at most 2 decimal places" });
    setTokenDecimalsCache({ MEME: 0 });
  });
  it("rejects too many decimals, fractional whole-unit tokens, junk and non-positive amounts", () => {
    expect(parseAmount("0.000000001", "qBTC", balances)).toMatchObject({ valid: false, error: "qBTC supports at most 8 decimal places" });
    expect(parseAmount("1.5", "MEME", balances)).toMatchObject({ valid: false, error: "MEME amounts must be whole numbers" });
    for (const junk of ["", "abc", "1e3", "-1", "1.2.3", "0x10"]) expect(parseAmount(junk, "XRGE", balances).valid).toBe(false);
    expect(parseAmount("0", "XRGE", balances)).toMatchObject({ valid: false, error: "Amount must be greater than zero" });
  });
  it("checks the balance in raw units and reserves the 1 XRGE wallet-transfer fee", () => {
    expect(parseAmount("1.51", "qBTC", balances)).toMatchObject({ valid: false, error: expect.stringContaining("Insufficient qBTC") });
    expect(parseAmount("1000", "XRGE", balances)).toMatchObject({ valid: false, error: expect.stringContaining("fee") });
    expect(parseAmount("999", "XRGE", balances).valid).toBe(true);
    expect(parseAmount("1", "qUSDC", [bal("XRGE", 0.5), bal("qUSDC", 5_000_000)])).toMatchObject({ valid: false, error: "Insufficient XRGE for the fee. Sending needs 1 XRGE" });
    expect(parseAmount("1", "qUSDC", [bal("XRGE", 1), bal("qUSDC", 5_000_000)]).valid).toBe(true);
  });
});

describe("submit", () => {
  it("resolves rouge1 via GET /resolve and signs + POSTs /v2/transfer to the active network's API", async () => {
    const w = seedAppsWebWallet();
    const { calls } = mockFetch({
      "/resolve/": () => ({ success: true, publicKey: HEX_KEY }),
      "/v2/transfer": () => ({ success: true, tx_hash: "h" }),
    });
    const addr = await pubkeyToAddress(HEX_KEY);
    expect(await resolveRecipient(addr)).toBe(HEX_KEY);
    await submitTransfer({ wallet: w, recipientPublicKey: HEX_KEY, raw: 150_000_000, symbol: "qBTC" });

    const post = calls.find((c) => c.url.endsWith("/v2/transfer"))!;
    expect(post.url).toBe("http://localhost:5101/api/v2/transfer"); // core network base (jsdom = localhost)
    expect(post.init?.method).toBe("POST");
    const signed = JSON.parse(String(post.init?.body)) as SignedTransaction;
    expect(signed.payload).toMatchObject({ type: "transfer", from: w.signingPublicKey, to: HEX_KEY, amount: 150_000_000, fee: 1, token: "qBTC" });
    expect(verifyTransaction(signed)).toBe(true);
    expect(String(post.init?.body)).not.toContain(w.signingPrivateKey);
  });
  it("refuses a self-send and surfaces the node's error", async () => {
    const w = seedAppsWebWallet();
    mockFetch({ "/v2/transfer": () => ({ success: false, error: "nonce reused" }) });
    await expect(submitTransfer({ wallet: w, recipientPublicKey: w.signingPublicKey, raw: 1, symbol: "XRGE" })).rejects.toThrow("own address");
    await expect(submitTransfer({ wallet: w, recipientPublicKey: HEX_KEY, raw: 1, symbol: "XRGE" })).rejects.toThrow("nonce reused");
  });
  it("network safety: writes go only to the selected network's API base (core network)", async () => {
    vi.stubEnv("VITE_CORE_API_URL_MAINNET", "https://main.example/api");
    vi.stubEnv("VITE_CORE_API_URL_TESTNET", "https://test.example/api");
    const w = seedAppsWebWallet();
    localStorage.setItem("rougechain-network", "testnet");
    const { calls } = mockFetch({ "/faucet": () => ({ success: true }), "/v2/transfer": () => ({ success: true }) });
    await claimFaucet("pk");
    await claimFaucet("pk", "qUSDC");
    await submitTransfer({ wallet: w, recipientPublicKey: HEX_KEY, raw: 1, symbol: "XRGE" });
    localStorage.setItem("rougechain-network", "mainnet");
    await submitTransfer({ wallet: w, recipientPublicKey: HEX_KEY, raw: 1, symbol: "XRGE" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://test.example/api/faucet",
      "https://test.example/api/faucet/bridge",
      "https://test.example/api/v2/transfer",
      "https://main.example/api/v2/transfer",
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ recipientPublicKey: "pk", amount: 10000 });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ recipientPublicKey: "pk", token: "qUSDC" });
  });
});
