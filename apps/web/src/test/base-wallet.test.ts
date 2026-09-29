/**
 * Base (EVM) wallet: derivation parity with Qwalla + offline send plumbing.
 *
 * Test vectors were produced by running Qwalla's OWN code path
 * (Qwalla origin/master `packages/qwalla-core/wallet/evm-wallet.ts`,
 * `deriveEvmAccount`, bundled with esbuild and run in node against Qwalla's
 * node_modules). They are the public, well-known BIP-39 "abandon" test phrases —
 * never use them for real funds. No test here touches the network: fetch is stubbed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseTransaction, recoverTransactionAddress, verifyMessage, type Hex } from "viem";
import { deriveBaseAddress, hasBaseAccount, normalizeMnemonic, signBaseTransaction, BASE_DERIVATION_PATH } from "@/lib/evm-wallet";
import {
  buildSendCall,
  checkBaseAddress,
  erc20TransferData,
  formatBaseUnits,
  getBaseAssets,
  getBaseChain,
  maxSendableEth,
  quoteBaseFee,
  signAndSendBase,
  toBaseUnits,
  GAS_PRICE_ORACLE,
} from "@/lib/base-wallet";
import { createLocalBaseProvider } from "@/lib/base-local-provider";

const M12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const M24 = `${"abandon ".repeat(23)}art`;
// Output of Qwalla deriveEvmAccount(M12).address / deriveEvmAccount(M24).address
const A12 = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const A24 = "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb";

describe("Base derivation (Qwalla parity)", () => {
  it("uses the standard Ethereum path", () => {
    expect(BASE_DERIVATION_PATH).toBe("m/44'/60'/0'/0/0");
  });

  it("matches Qwalla for the 12- and 24-word vectors", () => {
    expect(deriveBaseAddress(M12)).toBe(A12);
    expect(deriveBaseAddress(M24)).toBe(A24);
  });

  it("normalises like Qwalla (trim + lowercase)", () => {
    expect(normalizeMnemonic(`  ${M12.toUpperCase()} \n`)).toBe(M12);
    expect(deriveBaseAddress(`  ${M12.replace("abandon", "ABANDON")} `)).toBe(A12);
  });

  it("returns null (no Base account) for wallets without a valid mnemonic", () => {
    expect(deriveBaseAddress(undefined)).toBeNull();
    expect(deriveBaseAddress("")).toBeNull();
    expect(deriveBaseAddress("not a real phrase at all")).toBeNull();
    expect(hasBaseAccount(null)).toBe(false);
    expect(hasBaseAccount(M12)).toBe(true);
  });

  it("signs an EIP-1559 tx recoverable to the derived address", async () => {
    const raw = await signBaseTransaction(M12, {
      chainId: 8453, nonce: 3, to: A24, value: 1n, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    });
    const tx = parseTransaction(raw);
    expect(tx.type).toBe("eip1559");
    expect(tx.chainId).toBe(8453);
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(A12);
  });
});

describe("Base amounts / addresses", () => {
  it("parses decimal amounts exactly", () => {
    expect(toBaseUnits("1.5", 6)).toBe(1_500_000n);
    expect(toBaseUnits("0.000000000000000001", 18)).toBe(1n);
    expect(() => toBaseUnits("1.0000001", 6)).toThrow(/decimals/);
    expect(() => toBaseUnits("abc", 18)).toThrow();
    expect(formatBaseUnits(1_234_567_890_000_000_000n, 18, 4)).toBe("1.2345");
    expect(formatBaseUnits(5_000_000n, 6)).toBe("5");
  });

  it("validates recipients with EIP-55 checksums", () => {
    expect(checkBaseAddress("")).toBe("empty");
    expect(checkBaseAddress("0x123")).toBe("invalid");
    expect(checkBaseAddress(A12)).toBe("ok");
    expect(checkBaseAddress(A12.toLowerCase())).toBe("ok");
    expect(checkBaseAddress(A12.replace("E", "e"))).toBe("bad-checksum");
  });

  it("builds ERC-20 transfer calldata", () => {
    const data = erc20TransferData(A12, 1_000_000n);
    expect(data.slice(0, 10)).toBe("0xa9059cbb");
    expect(data).toHaveLength(2 + 8 + 64 + 64);
    const usdc = getBaseAssets(8453).find((a) => a.symbol === "USDC")!;
    expect(usdc.token).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(usdc.decimals).toBe(6);
    const xrge = getBaseAssets(8453).find((a) => a.symbol === "XRGE")!;
    expect(xrge.token).toBe("0x147120faEC9277ec02d957584CFCD92B56A24317");
    const call = buildSendCall(usdc, A24.toLowerCase(), 1n);
    expect(call.to).toBe(usdc.token);
    expect(call.value).toBe(0n);
  });

  it("pairs RougeChain mainnet with Base and testnet with Base Sepolia", () => {
    expect(getBaseChain("mainnet").chainId).toBe(8453);
    expect(getBaseChain("mainnet").rpcUrl).toBe("https://mainnet.base.org");
    expect(getBaseChain("testnet").chainId).toBe(84532);
    expect(getBaseChain("testnet").rpcUrl).toBe("https://sepolia.base.org");
  });
});

// ── Offline RPC stub ──────────────────────────────────────────────────────

type Call = { method: string; params: unknown[] };

function stubRpc(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const results: Record<string, unknown> = {
    eth_estimateGas: "0x5208", // 21000
    eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" }, // 1 gwei
    eth_maxPriorityFeePerGas: "0x5f5e100", // 0.1 gwei
    eth_getTransactionCount: "0x7",
    eth_call: "0x" + (1000n).toString(16).padStart(64, "0"),
    eth_sendRawTransaction: "0x" + "ab".repeat(32),
    ...overrides,
  };
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ method: body.method, params: body.params });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: results[body.method] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("Base fee quote + send (stubbed RPC)", () => {
  const chain = getBaseChain("mainnet");

  it("quotes gas ×1.2, maxFee = 2×base + tip, plus L1 fee with headroom", async () => {
    const { calls } = stubRpc();
    const eth = getBaseAssets(8453)[0];
    const q = await quoteBaseFee(chain, A12, buildSendCall(eth, A24, 10n));
    expect(q.gasLimit).toBe(25200n);
    expect(q.maxPriorityFeePerGas).toBe(100_000_000n);
    expect(q.maxFeePerGas).toBe(2_100_000_000n);
    expect(q.l1FeeWei).toBe(1500n);
    expect(q.totalFeeWei).toBe(25200n * 2_100_000_000n + 1500n);
    const oracle = calls.find((c) => c.method === "eth_call")!;
    expect((oracle.params[0] as { to: string }).to).toBe(GAS_PRICE_ORACLE);
    expect(maxSendableEth(10n ** 18n, q)).toBe(10n ** 18n - (q.totalFeeWei * 3n) / 2n);
    expect(maxSendableEth(1n, q)).toBe(0n);
  });

  it("signs with the confirmed fee values and broadcasts on the right chain", async () => {
    const { calls } = stubRpc();
    const xrge = getBaseAssets(8453)[1];
    const call = buildSendCall(xrge, A24, 5n * 10n ** 18n);
    const fee = { gasLimit: 60000n, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n };
    const hash = await signAndSendBase({ chain, mnemonic: M12, from: A12, call, fee });
    expect(hash).toBe("0x" + "ab".repeat(32));
    const raw = calls.find((c) => c.method === "eth_sendRawTransaction")!.params[0] as Hex;
    const tx = parseTransaction(raw);
    expect(tx.chainId).toBe(8453);
    expect(tx.nonce).toBe(7);
    expect(tx.to).toBe(xrge.token!.toLowerCase());
    expect(tx.gas).toBe(60000n);
    expect(tx.maxFeePerGas).toBe(3n);
    expect(tx.data).toBe(erc20TransferData(A24, 5n * 10n ** 18n));
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(A12);
    // the mnemonic never leaves the page
    for (const c of calls) expect(JSON.stringify(c.params)).not.toContain("abandon");
  });
});

describe("Local EIP-1193 provider (bridge)", () => {
  const chain = getBaseChain("mainnet");

  it("returns null for wallets without a mnemonic", () => {
    expect(createLocalBaseProvider({ chain, getMnemonic: () => undefined, confirm: async () => true })).toBeNull();
  });

  it("is pinned to one chain and only proxies read-only methods", async () => {
    stubRpc();
    const p = createLocalBaseProvider({ chain, getMnemonic: () => M12, confirm: async () => true })!;
    expect(await p.request({ method: "eth_requestAccounts" })).toEqual([A12]);
    expect(await p.request({ method: "eth_chainId" })).toBe("0x2105");
    await expect(p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] })).resolves.toBeNull();
    await expect(p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] })).rejects.toMatchObject({ code: 4902 });
    await expect(p.request({ method: "eth_sign", params: [] })).rejects.toMatchObject({ code: 4200 });
    await expect(p.request({ method: "eth_getTransactionReceipt", params: ["0x00"] })).resolves.toBeUndefined();
  });

  it("requires confirmation, the right sender, and an unlocked wallet", async () => {
    const { calls } = stubRpc();
    const confirm = vi.fn(async () => false);
    let mnemonic: string | null = M12;
    const p = createLocalBaseProvider({ chain, getMnemonic: () => mnemonic, confirm })!;
    await expect(p.request({ method: "eth_sendTransaction", params: [{ from: A12, to: A24, value: "0x1" }] })).rejects.toMatchObject({ code: 4001 });
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(false);
    await expect(p.request({ method: "eth_sendTransaction", params: [{ from: A24, to: A12 }] })).rejects.toMatchObject({ code: 4100 });
    mnemonic = null; // vault locked
    await expect(p.request({ method: "eth_sendTransaction", params: [{ from: A12, to: A24 }] })).rejects.toMatchObject({ code: 4100 });
  });

  it("signs personal_sign / sends after approval, honouring a higher caller gas", async () => {
    const { calls } = stubRpc();
    const p = createLocalBaseProvider({ chain, getMnemonic: () => M12, confirm: async () => true })!;
    const msg = "RougeChain bridge claim\nTx: 0x1\nRecipient: abc";
    const msgHex = "0x" + Array.from(new TextEncoder().encode(msg)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const sig = await p.request({ method: "personal_sign", params: [msgHex, A12] }) as Hex;
    expect(await verifyMessage({ address: A12, message: msg, signature: sig })).toBe(true);

    await p.request({ method: "eth_sendTransaction", params: [{ from: A12, to: A24, data: "0x1234", gas: "0x7A120" }] });
    const raw = calls.find((c) => c.method === "eth_sendRawTransaction")!.params[0] as Hex;
    expect(parseTransaction(raw).gas).toBe(500000n);
  });
});
