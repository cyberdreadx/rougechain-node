/**
 * Write-flow parity with apps/web's Bridge page: exact endpoints, request bodies, Base calldata
 * and signed-payload fields. The "apps/web" expectations below are apps/web's own expressions
 * (src/pages/Bridge.tsx) evaluated on the same inputs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMnemonic, keypairFromMnemonic } from "@rougechain/core/mnemonic";
import { serializePayload, verifyTransaction, type SignedTransaction } from "@rougechain/core/pqc-signer";
import { getBtcDepositAddress } from "@rougechain/core/bridge";
import { claimBtcDeposit, claimExistingDeposit, depositFromBase, withdrawFromRougeChain } from "./flows";
import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { WrongChainError, approveCalldata, bridgeDepositErc20Calldata, bridgeDepositEthCalldata, claimMessageHex, transferCalldata, vaultDepositCalldata } from "./evm";
import type { InflightDeposit } from "./inflight";
import { parseDepositAmount, parseWithdrawAmount } from "./validate";
import { API, instant, mockApi, mockProvider } from "./test-helpers";

const CUSTODY = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const VAULT = "0x2222222222222222222222222222222222222222";
const XRGE_TOKEN = "0xF9e744a43608AB7D64a106df84e52915e8Efa27E";
const EVM = "0x3333333333333333333333333333333333333333";
const BASE_SEPOLIA = 84532;

let keys: { publicKey: string; secretKey: string };
beforeAll(() => {
  keys = keypairFromMnemonic(generateMnemonic());
});
beforeEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(window, "rougechain");
  vi.stubEnv("VITE_EVM_DEPOSIT_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ETH / USDC deposits paused (VITE_EVM_DEPOSIT_ENABLED unset)", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_EVM_DEPOSIT_ENABLED", "");
  });
  for (const asset of ["ETH", "USDC"] as const) {
    it(`${asset}: refuses before any wallet request, nothing is sent or claimed`, async () => {
      const api = mockApi({});
      const w = mockProvider({});
      await expect(
        depositFromBase(
          { asset, provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep(asset, "1"), custodyAddress: CUSTODY, usdcAddress: USDC },
          { sleep: instant },
        ),
      ).rejects.toThrow(/temporarily paused/);
      expect(w.calls).toEqual([]);
      expect(api.posts()).toEqual([]);
    });
  }
  it("manual claim of an existing deposit is refused before signing", async () => {
    const api = mockApi({});
    const w = mockProvider({});
    await expect(
      claimExistingDeposit({ provider: w.provider, evmAddress: EVM, txHash: "0xabc", recipientPubkey: keys.publicKey, token: "ETH", chainId: BASE_SEPOLIA }, { sleep: instant }),
    ).rejects.toThrow(/temporarily paused/);
    expect(w.calls).toEqual([]);
    expect(api.posts()).toEqual([]);
  });
  it("XRGE deposits still run while ETH / USDC are paused", async () => {
    mockApi({ "POST /bridge/xrge/claim": () => ({ success: true, txId: "l1" }) });
    const w = mockProvider({});
    const out = await depositFromBase(
      { asset: "XRGE", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("XRGE", "5"), usdcAddress: USDC, xrge: { vaultAddress: VAULT, tokenAddress: XRGE_TOKEN } },
      { sleep: instant },
    );
    expect(out.kind).toBe("success");
    expect(w.sent()).toHaveLength(2);
  });
});

function dep(asset: "ETH" | "USDC" | "XRGE", amount: string) {
  const r = parseDepositAmount(asset, amount);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

// apps/web helpers, verbatim expressions
const webEthValue = (amountNum: number) => "0x" + BigInt(Math.round(amountNum * 1e18)).toString(16);
const webUsdcData = (custody: string, amountNum: number) => {
  const usdcAmount = "0x" + BigInt(Math.round(amountNum * 1e6)).toString(16);
  return `0xa9059cbb${custody.slice(2).padStart(64, "0")}${BigInt(usdcAmount).toString(16).padStart(64, "0")}`;
};
const webXrgeApprove = (vault: string, amountNum: number) => {
  const amountWei = "0x" + (BigInt(Math.floor(amountNum)) * 10n ** 18n).toString(16);
  return `0x095ea7b3${vault.slice(2).padStart(64, "0")}${BigInt(amountWei).toString(16).padStart(64, "0")}`;
};
const webXrgeDeposit = (pub: string, amountNum: number) => {
  const amountWei = "0x" + (BigInt(Math.floor(amountNum)) * 10n ** 18n).toString(16);
  const pubkeyHex = Array.from(new TextEncoder().encode(pub)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const paddedPubkey = pubkeyHex.padEnd(Math.ceil(pubkeyHex.length / 64) * 64, "0");
  return "0xf1215d25" + BigInt(amountWei).toString(16).padStart(64, "0") + (64).toString(16).padStart(64, "0") + pub.length.toString(16).padStart(64, "0") + paddedPubkey;
};
const webClaimMsgHex = (txHash: string, recipient: string) =>
  "0x" + Array.from(new TextEncoder().encode(`RougeChain bridge claim\nTx: ${txHash}\nRecipient: ${recipient}`)).map((b) => b.toString(16).padStart(2, "0")).join("");

describe("Base calldata matches apps/web byte for byte", () => {
  it("ETH value, USDC transfer, XRGE approve + vault deposit, claim message", () => {
    const pub = "ab".repeat(1952);
    expect("0x" + dep("ETH", "0.25").baseUnits.toString(16)).toBe(webEthValue(0.25));
    expect("0x" + dep("ETH", "1.5").baseUnits.toString(16)).toBe(webEthValue(1.5));
    expect(transferCalldata(CUSTODY, dep("USDC", "12.345678").baseUnits)).toBe(webUsdcData(CUSTODY, 12.345678));
    expect(approveCalldata(VAULT, dep("XRGE", "5").baseUnits)).toBe(webXrgeApprove(VAULT, 5));
    expect(vaultDepositCalldata(dep("XRGE", "5").baseUnits, pub)).toBe(webXrgeDeposit(pub, 5));
    expect(claimMessageHex("0xabc", pub)).toBe(webClaimMsgHex("0xabc", pub));
  });
});

const BRIDGE_ABI = parseAbi([
  "function depositETH(string rougechainPubkey) payable",
  "function depositERC20(address token, uint256 amount, string rougechainPubkey)",
  "function approve(address spender, uint256 amount)",
]);
const w64 = (hex: string) => hex.padStart(64, "0");
/** Decode the trailing ABI `string` of calldata whose head has `headWords` 32-byte words. */
function decodeString(data: string, headWords: number): string {
  const body = data.slice(10);
  const offset = parseInt(body.slice((headWords - 1) * 64, headWords * 64), 16) * 2;
  const len = parseInt(body.slice(offset, offset + 64), 16);
  return Buffer.from(body.slice(offset + 64, offset + 64 + len * 2), "hex").toString("utf8");
}

describe("RougeBridge deposit calldata (exact ABI encoding)", () => {
  it("hand-computed vectors", () => {
    expect(bridgeDepositEthCalldata("abc")).toBe("0x9b1c48e6" + w64("20") + w64("3") + "616263".padEnd(64, "0"));
    expect(bridgeDepositErc20Calldata(USDC, 1_000_000n, "abc")).toBe(
      "0x5a67cb87" + w64("036cbd53842c5426634e7929541ec2318f3dcf7e") + w64("f4240") + w64("60") + w64("3") + "616263".padEnd(64, "0"),
    );
    // exactly 32 bytes: no extra padding word; 33 bytes: padded to two words; multi-byte UTF-8 counts bytes
    expect(bridgeDepositEthCalldata("a".repeat(32))).toBe("0x9b1c48e6" + w64("20") + w64("20") + "61".repeat(32));
    expect(bridgeDepositEthCalldata("a".repeat(33))).toBe("0x9b1c48e6" + w64("20") + w64("21") + "61".repeat(33).padEnd(128, "0"));
    expect(bridgeDepositEthCalldata("é")).toBe("0x9b1c48e6" + w64("20") + w64("2") + "c3a9".padEnd(64, "0"));
  });

  it("matches viem's encoder, selectors included, for a real 3,904-character key", () => {
    expect(toFunctionSelector("depositETH(string)")).toBe("0x9b1c48e6");
    expect(toFunctionSelector("depositERC20(address,uint256,string)")).toBe("0x5a67cb87");
    for (const pub of [keys.publicKey, "ab".repeat(1952), "abc", "a".repeat(64), "é"]) {
      expect(bridgeDepositEthCalldata(pub)).toBe(encodeFunctionData({ abi: BRIDGE_ABI, functionName: "depositETH", args: [pub] }));
      expect(bridgeDepositErc20Calldata(USDC, 12_345_678n, pub)).toBe(
        encodeFunctionData({ abi: BRIDGE_ABI, functionName: "depositERC20", args: [USDC as `0x${string}`, 12_345_678n, pub] }),
      );
    }
    expect(keys.publicKey).toHaveLength(3904);
    expect(approveCalldata(CUSTODY, 5n)).toBe(encodeFunctionData({ abi: BRIDGE_ABI, functionName: "approve", args: [CUSTODY, 5n] }));
  });
});

describe("ETH deposit (Base → qETH)", () => {
  it("one bridge.depositETH(pubkey) transaction carrying the value — no signature, no claim", async () => {
    const api = mockApi({});
    const w = mockProvider({});
    const steps: string[] = [];
    const sent: InflightDeposit[] = [];
    const before = Date.now();
    const out = await depositFromBase(
      { asset: "ETH", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("ETH", "0.25"), custodyAddress: CUSTODY, usdcAddress: USDC },
      { sleep: instant, onStep: (s) => steps.push(s), onSent: (r) => sent.push(r) },
    );
    const txHash = `0x${"1".padStart(64, "a")}`;
    expect(out).toEqual({ kind: "pending", message: "Deposit sent. Your qETH will be credited automatically, usually in a few minutes — you can leave this page.", txHash });
    expect(w.calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_sendTransaction", "eth_getTransactionReceipt"]);
    const [tx] = w.sent() as { from: string; to: string; value: string; data: string; gas: string }[];
    expect(tx).toEqual({ from: EVM, to: CUSTODY, value: webEthValue(0.25), data: bridgeDepositEthCalldata(keys.publicKey), gas: "0x7A120" });
    expect(tx.data.slice(0, 10)).toBe("0x9b1c48e6");
    expect(decodeString(tx.data, 1)).toBe(keys.publicKey);
    expect(w.calls.some((c) => c.method === "personal_sign")).toBe(false);
    expect(api.calls).toEqual([]);
    expect(sent).toEqual([
      { baseTxHash: txHash, asset: "ETH", l1Symbol: "qETH", amountLabel: "0.25", expectedL1Units: "250000", recipientPubkey: keys.publicKey, startedAt: expect.any(Number), state: "sent" },
    ]);
    expect(sent[0].startedAt).toBeGreaterThanOrEqual(before);
    expect(steps).toEqual(["Checking your Base wallet network…", "Sending ETH to the bridge…", "Waiting for deposit confirmation…"]);
  });

  it("onSent fires with the deposit hash before the receipt wait resolves", async () => {
    mockApi({});
    let release!: (r: { status: string }) => void;
    const receipt = new Promise<{ status: string }>((r) => (release = r));
    const w = mockProvider({ eth_getTransactionReceipt: () => receipt });
    const onSent = vi.fn();
    let settled = false;
    const run = depositFromBase(
      { asset: "ETH", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("ETH", "0.1"), custodyAddress: CUSTODY, usdcAddress: USDC },
      { sleep: instant, onSent },
    ).finally(() => (settled = true));
    await vi.waitFor(() => expect(w.calls.some((c) => c.method === "eth_getTransactionReceipt")).toBe(true));
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent.mock.calls[0][0]).toMatchObject({ baseTxHash: `0x${"1".padStart(64, "a")}`, asset: "ETH" });
    expect(settled).toBe(false);
    release({ status: "0x1" });
    expect((await run).kind).toBe("pending");
  });

  it("a reverted deposit is a failure (and reported so it is no longer tracked)", async () => {
    const api = mockApi({});
    const w = mockProvider({ eth_getTransactionReceipt: () => ({ status: "0x0" }) });
    const onSent = vi.fn();
    const onReverted = vi.fn();
    await expect(
      depositFromBase(
        { asset: "ETH", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("ETH", "0.1"), custodyAddress: CUSTODY, usdcAddress: USDC },
        { sleep: instant, onSent, onReverted },
      ),
    ).rejects.toThrow(/deposit transaction failed on Base/);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onReverted).toHaveBeenCalledWith(`0x${"1".padStart(64, "a")}`);
    expect(api.calls).toEqual([]);
  });

  it("no receipt yet after the wait is pending, not failed — the deposit stays tracked", async () => {
    mockApi({});
    const w = mockProvider({ eth_getTransactionReceipt: () => null });
    const onReverted = vi.fn();
    const out = await depositFromBase(
      { asset: "ETH", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("ETH", "0.1"), custodyAddress: CUSTODY, usdcAddress: USDC },
      { sleep: instant, onReverted },
    );
    expect(out.kind).toBe("pending");
    expect(onReverted).not.toHaveBeenCalled();
  });

  it("refuses when the wallet is on the wrong chain — nothing is sent", async () => {
    const api = mockApi({});
    const w = mockProvider({}, "0x2105"); // Base mainnet while the bridge is on Base Sepolia
    await expect(
      depositFromBase({ asset: "ETH", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("ETH", "1"), custodyAddress: CUSTODY, usdcAddress: USDC }, { sleep: instant }),
    ).rejects.toBeInstanceOf(WrongChainError);
    expect(w.sent()).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it("refuses when the chain can't be read (fails closed)", async () => {
    mockApi({});
    const w = mockProvider({ eth_chainId: () => { throw new Error("nope"); } });
    await expect(
      depositFromBase({ asset: "USDC", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("USDC", "1"), custodyAddress: CUSTODY, usdcAddress: USDC }, { sleep: instant }),
    ).rejects.toBeInstanceOf(WrongChainError);
    expect(w.sent()).toHaveLength(0);
  });
});

describe("USDC deposit (Base → qUSDC)", () => {
  const params = () => ({ asset: "USDC" as const, provider: undefined as never, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("USDC", "12.345678"), custodyAddress: CUSTODY, usdcAddress: USDC });

  it("approve(bridge) → receipt → chain re-check → bridge.depositERC20(usdc, amount, pubkey) — no signature, no claim", async () => {
    const api = mockApi({});
    const w = mockProvider({});
    const sent: InflightDeposit[] = [];
    const out = await depositFromBase({ ...params(), provider: w.provider }, { sleep: instant, onSent: (r) => sent.push(r) });
    const depositHash = `0x${"2".padStart(64, "a")}`;
    expect(out).toMatchObject({ kind: "pending", txHash: depositHash });
    expect(w.calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_sendTransaction", "eth_getTransactionReceipt", "eth_chainId", "eth_sendTransaction", "eth_getTransactionReceipt"]);
    expect(w.calls[2].params).toEqual([`0x${"1".padStart(64, "a")}`]);
    const [approve, deposit] = w.sent() as { from: string; to: string; data: string; gas?: string; value?: string }[];
    expect(approve).toEqual({ from: EVM, to: USDC, data: `0x095ea7b3${CUSTODY.slice(2).padStart(64, "0")}${(12_345_678).toString(16).padStart(64, "0")}` });
    expect(deposit).toEqual({ from: EVM, to: CUSTODY, data: bridgeDepositErc20Calldata(USDC, 12_345_678n, keys.publicKey), gas: "0x7A120" });
    expect(deposit.data.slice(0, 10)).toBe("0x5a67cb87");
    expect(deposit.data.slice(10, 74)).toBe(w64(USDC.slice(2).toLowerCase()));
    expect(BigInt("0x" + deposit.data.slice(74, 138))).toBe(12_345_678n);
    expect(decodeString(deposit.data, 3)).toBe(keys.publicKey);
    expect(w.calls.some((c) => c.method === "personal_sign")).toBe(false);
    expect(api.calls).toEqual([]);
    // tracked by the deposit transaction, not the approval
    expect(sent).toEqual([expect.objectContaining({ baseTxHash: depositHash, asset: "USDC", l1Symbol: "qUSDC", amountLabel: "12.345678", expectedL1Units: "12345678", state: "sent" })]);
  });

  it("stops when the approval reverts: no deposit sent, nothing tracked", async () => {
    mockApi({});
    const w = mockProvider({ eth_getTransactionReceipt: () => ({ status: "0x0" }) });
    const onSent = vi.fn();
    await expect(depositFromBase({ ...params(), provider: w.provider }, { sleep: instant, onSent })).rejects.toThrow(/USDC approval failed/);
    expect(w.sent()).toHaveLength(1);
    expect(onSent).not.toHaveBeenCalled();
  });

  it("refuses to deposit when the wallet left the chain after the approval", async () => {
    mockApi({});
    let reads = 0;
    const w = mockProvider({ eth_chainId: () => (++reads === 1 ? "0x14a34" : "0x2105") });
    await expect(depositFromBase({ ...params(), provider: w.provider }, { sleep: instant })).rejects.toBeInstanceOf(WrongChainError);
    expect(w.sent()).toHaveLength(1);
  });

  it("a reverted deposit is a failure", async () => {
    mockApi({});
    let receipts = 0;
    const w = mockProvider({ eth_getTransactionReceipt: () => ({ status: ++receipts === 1 ? "0x1" : "0x0" }) });
    const onReverted = vi.fn();
    await expect(depositFromBase({ ...params(), provider: w.provider }, { sleep: instant, onReverted })).rejects.toThrow(/deposit transaction failed on Base/);
    expect(onReverted).toHaveBeenCalledWith(`0x${"2".padStart(64, "a")}`);
  });
});

describe("XRGE deposit (Base vault → XRGE)", () => {
  it("approve → deposit(amount, pubkey) with 500k gas → POST /bridge/xrge/claim", async () => {
    const api = mockApi({ "POST /bridge/xrge/claim": () => ({ success: true, txId: "l1" }) });
    const w = mockProvider({});
    const onSent = vi.fn();
    const out = await depositFromBase(
      {
        asset: "XRGE",
        provider: w.provider,
        evmAddress: EVM,
        chainId: BASE_SEPOLIA,
        recipientPubkey: keys.publicKey,
        amount: dep("XRGE", "5"),
        usdcAddress: USDC,
        xrge: { vaultAddress: VAULT, tokenAddress: XRGE_TOKEN },
      },
      { sleep: instant, onSent },
    );
    expect(out.kind).toBe("success");
    // tracked by the vault deposit (second transaction), in whole XRGE
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ baseTxHash: `0x${"2".padStart(64, "a")}`, asset: "XRGE", l1Symbol: "XRGE", amountLabel: "5", expectedL1Units: "5", state: "sent" }));
    expect(w.sent()).toEqual([
      { from: EVM, to: XRGE_TOKEN, data: webXrgeApprove(VAULT, 5) },
      { from: EVM, to: VAULT, data: webXrgeDeposit(keys.publicKey, 5), gas: "0x7A120" },
    ]);
    // the wallet chain is re-checked before the second transaction
    expect(w.calls.filter((c) => c.method === "eth_chainId")).toHaveLength(2);
    expect(api.posts()).toEqual([
      expect.objectContaining({
        url: `${API}/bridge/xrge/claim`,
        body: { evmTxHash: `0x${"2".padStart(64, "a")}`, evmAddress: EVM, amount: "5000000000000000000", recipientRougechainPubkey: keys.publicKey },
      }),
    ]);
  });

  it("stops when the approval reverts (no deposit sent)", async () => {
    mockApi({});
    const w = mockProvider({ eth_getTransactionReceipt: () => ({ status: "0x0" }) });
    const onSent = vi.fn();
    await expect(
      depositFromBase(
        { asset: "XRGE", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("XRGE", "1"), usdcAddress: USDC, xrge: { vaultAddress: VAULT, tokenAddress: XRGE_TOKEN } },
        { sleep: instant, onSent },
      ),
    ).rejects.toThrow(/approval failed/);
    expect(w.sent()).toHaveLength(1);
    expect(onSent).not.toHaveBeenCalled();
  });
});

describe("claim an existing ETH/USDC deposit", () => {
  const tx = `0x${"f".repeat(64)}`;
  it("personal_signs the claim message and POSTs /bridge/claim", async () => {
    const api = mockApi({ "POST /bridge/claim": () => ({ success: true }) });
    const w = mockProvider({});
    const out = await claimExistingDeposit({ provider: w.provider, evmAddress: EVM, txHash: tx, recipientPubkey: keys.publicKey, token: "USDC", chainId: BASE_SEPOLIA }, { sleep: instant });
    expect(out.kind).toBe("success");
    expect(w.calls.find((c) => c.method === "personal_sign")!.params).toEqual([webClaimMsgHex(tx, keys.publicKey), EVM]);
    expect(api.posts()[0].body).toEqual({ evmTxHash: tx, evmAddress: EVM, evmSignature: "0xsig", recipientRougechainPubkey: keys.publicKey, token: "USDC" });
  });
  it("a rejected signature stops before any node call", async () => {
    const api = mockApi({});
    const w = mockProvider({ personal_sign: () => { throw Object.assign(new Error("denied"), { code: 4001 }); } });
    await expect(claimExistingDeposit({ provider: w.provider, evmAddress: EVM, txHash: tx, recipientPubkey: keys.publicKey, token: "ETH", chainId: BASE_SEPOLIA })).rejects.toThrow(/Signature rejected/);
    expect(api.calls).toHaveLength(0);
  });
});

describe("BTC deposits", () => {
  it("deposit address: POST /bridge/btc/deposit-address { recipient: rouge1… }", async () => {
    const api = mockApi({ "POST /bridge/btc/deposit-address": () => ({ success: true, address: "tb1qexample" }) });
    const r = await getBtcDepositAddress("rouge1abc");
    expect(r.address).toBe("tb1qexample");
    expect(api.posts()).toEqual([expect.objectContaining({ url: `${API}/bridge/btc/deposit-address`, body: { recipient: "rouge1abc" } })]);
  });
  it("OP_RETURN claim: POST /bridge/btc/claim { btcTxid, recipientRougechainPubkey: rouge1… }", async () => {
    let n = 0;
    const api = mockApi({ "POST /bridge/btc/claim": () => (++n < 2 ? { success: false, error: "1/3 confirmations" } : { success: true }) });
    const txid = "e".repeat(64);
    const out = await claimBtcDeposit({ txid, rougeAddress: "rouge1abc" }, { sleep: instant });
    expect(out.kind).toBe("success");
    expect(api.posts().map((p) => p.body)).toEqual([
      { btcTxid: txid, recipientRougechainPubkey: "rouge1abc" },
      { btcTxid: txid, recipientRougechainPubkey: "rouge1abc" },
    ]);
  });
});

describe("withdrawals (signed intent, 0.1 XRGE fee)", () => {
  function units(asset: "ETH" | "USDC" | "XRGE" | "BTC", s: string) {
    const r = parseWithdrawAmount(asset, s);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }
  function expectSigned(body: Record<string, unknown>, fields: Record<string, unknown>) {
    const payload = body.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["amount", "chainId", "evmAddress", "fee", "from", "nonce", "timestamp", "tokenSymbol", "type"]);
    expect(payload).toMatchObject({ type: "bridge_withdraw", from: keys.publicKey, fee: 0.1, ...fields });
    const signed: SignedTransaction = { payload: payload as unknown as SignedTransaction["payload"], signature: body.signature as string, public_key: keys.publicKey };
    expect(verifyTransaction(signed)).toBe(true);
  }

  it("qETH → Base: POST /bridge/withdraw with amountUnits (6 dp) and a signed payload", async () => {
    const api = mockApi({ "POST /bridge/withdraw": () => ({ success: true, txId: "t1" }) });
    const amountUnits = units("ETH", "0.5");
    expect(amountUnits).toBe(Math.round(0.5 * 1e6)); // apps/web humanToQeth
    const out = await withdrawFromRougeChain({ asset: "ETH", amountUnits, destination: EVM, wallet: { publicKey: keys.publicKey, privateKey: keys.secretKey } });
    expect(out.txId).toBe("t1");
    const [post] = api.posts();
    expect(post.url).toBe(`${API}/bridge/withdraw`);
    const body = post.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["amountUnits", "evmAddress", "fromPublicKey", "payload", "signature"]);
    expect(body).toMatchObject({ fromPublicKey: keys.publicKey, amountUnits: 500000, evmAddress: EVM });
    expectSigned(body, { amount: 500000, tokenSymbol: "qETH", evmAddress: EVM });
  });

  it("qUSDC → Base", async () => {
    const api = mockApi({ "POST /bridge/withdraw": () => ({ success: true }) });
    await withdrawFromRougeChain({ asset: "USDC", amountUnits: units("USDC", "2.5"), destination: EVM, wallet: { publicKey: keys.publicKey, privateKey: keys.secretKey } });
    const body = api.posts()[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ amountUnits: 2_500_000, evmAddress: EVM });
    expectSigned(body, { amount: 2_500_000, tokenSymbol: "qUSDC", evmAddress: EVM });
  });

  it("XRGE → Base: POST /bridge/xrge/withdraw { fromPublicKey, amount, evmAddress, signature, payload }", async () => {
    const api = mockApi({ "POST /bridge/xrge/withdraw": () => ({ success: true }) });
    await withdrawFromRougeChain({ asset: "XRGE", amountUnits: units("XRGE", "42"), destination: EVM, wallet: { publicKey: keys.publicKey, privateKey: keys.secretKey } });
    const [post] = api.posts();
    expect(post.url).toBe(`${API}/bridge/xrge/withdraw`);
    const body = post.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["amount", "evmAddress", "fromPublicKey", "payload", "signature"]);
    expect(body).toMatchObject({ fromPublicKey: keys.publicKey, amount: 42, evmAddress: EVM });
    expectSigned(body, { amount: 42, tokenSymbol: "XRGE", evmAddress: EVM });
  });

  it("qBTC → Bitcoin: sats, the Bitcoin address signed and sent verbatim (never 0x-prefixed)", async () => {
    const api = mockApi({ "POST /bridge/withdraw": () => ({ success: true }) });
    const btc = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    await withdrawFromRougeChain({ asset: "BTC", amountUnits: units("BTC", "0.0001"), destination: btc, wallet: { publicKey: keys.publicKey, privateKey: keys.secretKey } });
    const body = api.posts()[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ amountUnits: 10_000, evmAddress: btc });
    expectSigned(body, { amount: 10_000, tokenSymbol: "qBTC", evmAddress: btc });
  });

  it("a node rejection surfaces its error", async () => {
    mockApi({ "POST /bridge/withdraw": () => ({ success: false, error: "signed-intent rejected" }) });
    await expect(
      withdrawFromRougeChain({ asset: "ETH", amountUnits: 1, destination: EVM, wallet: { publicKey: keys.publicKey, privateKey: keys.secretKey } }),
    ).rejects.toThrow("signed-intent rejected");
  });

  it("extension wallet: the same payload is signed through window.rougechain (serialized bytes included)", async () => {
    const api = mockApi({ "POST /bridge/withdraw": () => ({ success: true }) });
    const signTransaction = vi.fn(async () => ({ signature: "extsig" }));
    Object.assign(window, { rougechain: { isRougeChain: true, signTransaction } });
    await withdrawFromRougeChain({ asset: "USDC", amountUnits: 1_000_000, destination: EVM, wallet: { publicKey: keys.publicKey } });
    const arg = (signTransaction.mock.calls[0] as unknown as [{ payload: Record<string, unknown>; serializedHex: string }])[0];
    expect(arg.payload).toMatchObject({ type: "bridge_withdraw", from: keys.publicKey, amount: 1_000_000, fee: 0.1, tokenSymbol: "qUSDC", evmAddress: EVM });
    expect(arg.serializedHex).toBe(Buffer.from(serializePayload(arg.payload as never)).toString("hex"));
    expect(api.posts()[0].body).toMatchObject({ signature: "extsig", payload: arg.payload });
  });
});
