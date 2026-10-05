/**
 * Write-flow parity with apps/web's Bridge page: exact endpoints, request bodies, Base calldata
 * and signed-payload fields. The "apps/web" expectations below are apps/web's own expressions
 * (src/pages/Bridge.tsx) evaluated on the same inputs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMnemonic, keypairFromMnemonic } from "@rougechain/core/mnemonic";
import { serializePayload, verifyTransaction, type SignedTransaction } from "@rougechain/core/pqc-signer";
import { getBtcDepositAddress } from "@rougechain/core/bridge";
import { claimBtcDeposit, claimExistingDeposit, depositFromBase, withdrawFromRougeChain, CLAIM_ATTEMPTS } from "./flows";
import { WrongChainError, approveCalldata, claimMessageHex, transferCalldata, vaultDepositCalldata } from "./evm";
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

describe("ETH deposit (Base → qETH)", () => {
  it("sends value to custody, signs the claim, polls POST /bridge/claim", async () => {
    let attempts = 0;
    const api = mockApi({
      "POST /bridge/claim": () => (++attempts < 3 ? { success: false, error: "pending confirmations" } : { success: true, txId: "l1tx" }),
    });
    const w = mockProvider({});
    const steps: string[] = [];
    const out = await depositFromBase(
      { asset: "ETH", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("ETH", "0.25"), custodyAddress: CUSTODY, usdcAddress: USDC },
      { sleep: instant, onStep: (s) => steps.push(s) },
    );
    expect(out.kind).toBe("success");
    expect(w.calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_sendTransaction", "personal_sign"]);
    const txHash = `0x${"1".padStart(64, "a")}`;
    expect(w.sent()).toEqual([{ from: EVM, to: CUSTODY, value: webEthValue(0.25) }]);
    expect(w.calls[2].params).toEqual([webClaimMsgHex(txHash, keys.publicKey), EVM]);
    const posts = api.posts();
    expect(posts).toHaveLength(3);
    for (const p of posts) {
      expect(p.url).toBe(`${API}/bridge/claim`);
      expect(p.body).toEqual({ evmTxHash: txHash, evmAddress: EVM, evmSignature: "0xsig", recipientRougechainPubkey: keys.publicKey, token: "ETH" });
    }
    expect(steps).toContain("Waiting for Base confirmations… (2/30)");
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

  it("an unconfirmed claim after 30 polls is reported as pending, not failed", async () => {
    const api = mockApi({ "POST /bridge/claim": () => ({ success: false, error: "waiting" }) });
    const w = mockProvider({ personal_sign: () => { throw new Error("smart wallet"); } });
    const out = await depositFromBase(
      { asset: "ETH", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("ETH", "0.1"), custodyAddress: CUSTODY, usdcAddress: USDC },
      { sleep: instant },
    );
    expect(out.kind).toBe("pending");
    expect(api.posts()).toHaveLength(CLAIM_ATTEMPTS);
    // personal_sign unsupported → empty signature, as apps/web
    expect((api.posts()[0].body as { evmSignature: string }).evmSignature).toBe("");
  });
});

describe("USDC deposit (Base → qUSDC)", () => {
  it("transfers USDC to custody (6 decimals) and claims with token USDC", async () => {
    const api = mockApi({ "POST /bridge/claim": () => ({ success: true }) });
    const w = mockProvider({});
    const out = await depositFromBase(
      { asset: "USDC", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("USDC", "12.345678"), custodyAddress: CUSTODY, usdcAddress: USDC },
      { sleep: instant },
    );
    expect(out).toMatchObject({ kind: "success", message: "Bridged 12.345678 USDC → qUSDC!" });
    expect(w.sent()).toEqual([{ from: EVM, to: USDC, data: webUsdcData(CUSTODY, 12.345678) }]);
    expect(api.posts()[0]).toMatchObject({ path: "/bridge/claim", body: { token: "USDC", evmAddress: EVM, recipientRougechainPubkey: keys.publicKey } });
  });
});

describe("XRGE deposit (Base vault → XRGE)", () => {
  it("approve → deposit(amount, pubkey) with 500k gas → POST /bridge/xrge/claim", async () => {
    const api = mockApi({ "POST /bridge/xrge/claim": () => ({ success: true, txId: "l1" }) });
    const w = mockProvider({});
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
      { sleep: instant },
    );
    expect(out.kind).toBe("success");
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
    await expect(
      depositFromBase(
        { asset: "XRGE", provider: w.provider, evmAddress: EVM, chainId: BASE_SEPOLIA, recipientPubkey: keys.publicKey, amount: dep("XRGE", "1"), usdcAddress: USDC, xrge: { vaultAddress: VAULT, tokenAddress: XRGE_TOKEN } },
        { sleep: instant },
      ),
    ).rejects.toThrow(/approval failed/);
    expect(w.sent()).toHaveLength(1);
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
    expect(Object.keys(payload).sort()).toEqual(["amount", "evmAddress", "fee", "from", "nonce", "timestamp", "tokenSymbol", "type"]);
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
