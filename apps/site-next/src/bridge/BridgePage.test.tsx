/** /bridge page: every gate state, and each write flow driven through the UI with mocked node + wallets. */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyTransaction, type SignedTransaction } from "@rougechain/core/pqc-signer";
import { NETWORK_STORAGE_KEY } from "@rougechain/core/network";
import { deriveBaseAddress } from "@rougechain/core/evm-wallet";
import { pubkeyToAddress } from "@rougechain/core/address";
import { WalletProvider } from "../wallet/WalletProvider";
import { Toaster } from "../wallet/toast";
import { resetBrowserState, seedAppsWebLockedWallet, seedAppsWebWallet } from "../wallet/test-utils";
import BridgePage from "./BridgePage";
import { flowTiming } from "./DepositPanels";
import { bridgeArea } from "../features/bridge";
import { API, instant, mockApi, mockProvider } from "./test-helpers";

const CUSTODY = "0x1111111111111111111111111111111111111111";
const EVM = "0x3333333333333333333333333333333333333333";
const BTC_CUSTODY = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
const SEPOLIA_CONFIG = {
  enabled: true,
  chainId: 84532,
  custodyAddress: CUSTODY,
  supportedTokens: ["ETH", "USDC", "BTC"],
  btcCustodyAddress: BTC_CUSTODY,
  btcNetwork: "testnet",
  btcMinWithdrawSats: 2000,
  btcMaxNetworkFeeSats: 10000,
};
const XRGE_CONFIG = { enabled: true, chainId: 84532, vaultAddress: "0x2222222222222222222222222222222222222222", tokenAddress: "0xF9e744a43608AB7D64a106df84e52915e8Efa27E" };

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

function renderBridge() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <WalletProvider autoRegister={false}>
        <MemoryRouter initialEntries={["/bridge"]}>
          <Routes>
            <Route path="/bridge" element={<BridgePage />} />
            <Route path="*" element={<Where />} />
          </Routes>
          <Toaster />
        </MemoryRouter>
      </WalletProvider>
    </QueryClientProvider>,
  );
}

function nodeRoutes(pub: string | null, extra: Record<string, (body: unknown, url: string) => unknown> = {}, config: object = SEPOLIA_CONFIG, xrge: object = XRGE_CONFIG) {
  return mockApi({
    "GET /bridge/config": () => config,
    "GET /bridge/xrge/config": () => xrge,
    "GET /bridge/withdrawals": () => ({ withdrawals: [] }),
    "GET /bridge/xrge/withdrawals": () => ({ withdrawals: [] }),
    ...(pub
      ? {
          [`GET /balance/${pub}`]: () => ({ success: true, balance: 100, token_balances: { qETH: 2_000_000, qUSDC: 5_000_000, qBTC: 150_000 } }),
          [`GET /address/${pub}/transactions`]: () => ({ transactions: [] }),
        }
      : {}),
    ...extra,
  });
}

/** The main bridge panel (the side "claim" card has its own connect buttons). */
const panel = () => within(screen.getByRole("region", { name: "Bridge" }));

function testnet() {
  localStorage.setItem(NETWORK_STORAGE_KEY, "testnet");
}

beforeEach(() => {
  resetBrowserState();
  Reflect.deleteProperty(window, "ethereum");
  flowTiming.sleep = instant;
});
afterEach(() => {
  flowTiming.sleep = undefined;
  vi.unstubAllEnvs();
});

describe("feature slot", () => {
  it("owns /bridge with the Bridge header", () => {
    expect(bridgeArea.routes.map((r) => (r.props as { path: string }).path)).toEqual(["/bridge"]);
    expect(bridgeArea.headerProduct("/bridge")).toBe("Bridge");
    expect(bridgeArea.headerProduct("/explorer/bridge")).toBeNull();
    expect(bridgeArea.headerProduct("/swap")).toBeNull();
  });
});

describe("gates", () => {
  it("loading, then not enabled", async () => {
    nodeRoutes(null, {}, { enabled: false }, { enabled: false });
    renderBridge();
    expect(screen.getByText(/Loading bridge configuration/)).toBeInTheDocument();
    expect(await screen.findByText("The bridge is not enabled on this node.")).toBeInTheDocument();
  });

  it("offline node is treated as not enabled (apps/web fallback)", async () => {
    mockApi({});
    renderBridge();
    expect(await screen.findByText("The bridge is not enabled on this node.")).toBeInTheDocument();
  });

  it("fails closed when the node reports no recognized Base chain", async () => {
    testnet();
    nodeRoutes(null, {}, { ...SEPOLIA_CONFIG, chainId: 1 }, { enabled: false });
    renderBridge();
    expect(await screen.findByText("Network not confirmed")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("fails closed on mainnet RougeChain + Base Sepolia (and testnet + Base mainnet)", async () => {
    nodeRoutes(null); // mainnet is the default network
    const { unmount } = renderBridge();
    expect(await screen.findByText("Network mismatch — bridge disabled")).toBeInTheDocument();
    unmount();
    resetBrowserState();
    testnet();
    nodeRoutes(null, {}, { ...SEPOLIA_CONFIG, chainId: 8453 }, { ...XRGE_CONFIG, chainId: 8453 });
    renderBridge();
    expect(await screen.findByText(/must not bridge real mainnet assets/)).toBeInTheDocument();
  });

  it("no wallet: asks to create or import one", async () => {
    testnet();
    nodeRoutes(null);
    renderBridge();
    expect(await screen.findByText(/Create or import a RougeChain wallet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Open wallet" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/wallet");
  });

  it("locked wallet: offers unlock; status cards still read by public key", async () => {
    testnet();
    const w = await seedAppsWebLockedWallet();
    nodeRoutes(w.signingPublicKey);
    renderBridge();
    expect(await screen.findByText(/Your wallet is locked/)).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(await screen.findByText("No bridge activity yet")).toBeInTheDocument();
  });
});

describe("deposit Base → RougeChain", () => {
  it("ETH with an injected wallet: connect, review, send, claim", async () => {
    testnet();
    const w = seedAppsWebWallet();
    const api = nodeRoutes(w.signingPublicKey, { "POST /bridge/claim": () => ({ success: true, txId: "l1" }) });
    const eth = mockProvider({
      wallet_switchEthereumChain: () => null,
      eth_requestAccounts: () => [EVM],
      eth_getBalance: () => "0xde0b6b3a7640000", // 1 ETH
      eth_call: () => "0x0",
    });
    Object.assign(window, { ethereum: { ...eth.provider, isMetaMask: true } });
    renderBridge();
    await screen.findByRole("region", { name: "Bridge" });
    await userEvent.click(await panel().findByRole("button", { name: /Connect MetaMask \(Base Sepolia\)/ }));
    expect(await screen.findByText(`Connected 0x3333…3333`)).toBeInTheDocument();
    expect(await screen.findByText("Balance: 1 ETH")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Amount (ETH)"), "0.0000001");
    expect(screen.getByText("ETH supports at most 6 decimal places")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Amount (ETH)"));
    await userEvent.type(screen.getByLabelText("Amount (ETH)"), "2");
    expect(screen.getByText("Insufficient ETH balance on Base")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Amount (ETH)"));
    await userEvent.type(screen.getByLabelText("Amount (ETH)"), "0.25");
    await userEvent.click(screen.getByRole("button", { name: "Review" }));

    const review = screen.getByText("You send").closest("dl")!;
    expect(within(review).getByText("0.25 ETH · Base Sepolia")).toBeInTheDocument();
    expect(within(review).getByText("0.25 qETH · RougeChain")).toBeInTheDocument();
    expect(within(review).getByText("Base Sepolia (84532) → RougeChain Testnet")).toBeInTheDocument();
    expect(await within(review).findByText(await pubkeyToAddress(w.signingPublicKey))).toBeInTheDocument();
    expect(api.posts()).toHaveLength(0); // nothing sent before confirming

    await userEvent.click(screen.getByRole("button", { name: "Confirm and open wallet" }));
    expect(await screen.findByText("Bridged 0.25 ETH → qETH!")).toBeInTheDocument();
    expect(eth.sent()).toEqual([{ from: EVM, to: CUSTODY, value: "0x3782dace9d90000" }]);
    expect(api.posts().map((p) => [p.url, p.body])).toEqual([
      [`${API}/bridge/claim`, { evmTxHash: `0x${"1".padStart(64, "a")}`, evmAddress: EVM, evmSignature: "0xsig", recipientRougechainPubkey: w.signingPublicKey, token: "ETH" }],
    ]);
  });

  it("refuses to connect a wallet that stays on the wrong chain", async () => {
    testnet();
    const w = seedAppsWebWallet();
    nodeRoutes(w.signingPublicKey);
    const eth = mockProvider({ wallet_switchEthereumChain: () => null, eth_requestAccounts: () => [EVM] }, "0x2105");
    Object.assign(window, { ethereum: eth.provider });
    renderBridge();
    await screen.findByRole("region", { name: "Bridge" });
    await userEvent.click(await panel().findByRole("button", { name: /Connect Base wallet \(Base Sepolia\)/ }));
    expect(await panel().findByText(/Your Base wallet is on chain 8453, not 84532/)).toBeInTheDocument();
    expect(screen.queryByText(/Connected 0x/)).toBeNull();
    expect(panel().getByRole("button", { name: "Review" })).toBeDisabled();
  });

  it("USDC via the RougeChain Base wallet: every transaction needs approval; rejecting sends nothing", async () => {
    testnet();
    const w = seedAppsWebWallet();
    const baseAddr = deriveBaseAddress(w.mnemonic)!;
    const rpc: string[] = [];
    const api = nodeRoutes(w.signingPublicKey, {
      "POST https://sepolia.base.org": (body) => {
        const { method, id } = body as { method: string; id: number };
        rpc.push(method);
        const results: Record<string, unknown> = {
          eth_getBalance: "0x0",
          eth_call: "0x" + (50_000_000).toString(16).padStart(64, "0"), // 50 USDC
          eth_estimateGas: "0x5208",
          eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" },
          eth_maxPriorityFeePerGas: "0x3b9aca00",
        };
        return { jsonrpc: "2.0", id, result: results[method] ?? null };
      },
    });
    renderBridge();
    await userEvent.click(await screen.findByRole("tab", { name: /Deposit/ }));
    await userEvent.click(screen.getByRole("button", { name: "USDC" }));
    await userEvent.click(await panel().findByRole("button", { name: /Use my RougeChain Base wallet/ }));
    expect(await screen.findByText(`RougeChain Base wallet · ${baseAddr.slice(0, 6)}…${baseAddr.slice(-4)}`)).toBeInTheDocument();
    expect(await screen.findByText("Balance: 50 USDC")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Amount (USDC)"), "10");
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm and open wallet" }));

    const dialog = await screen.findByRole("dialog", { name: "Approve Base Sepolia transaction" });
    expect(within(dialog).getByText("Token transfer")).toBeInTheDocument();
    expect(within(dialog).getByText("0x036CbD53842c5426634e7929541eC2318f3dCF7e")).toBeInTheDocument();
    expect(within(dialog).getByText(/Base Sepolia testnet/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Request rejected in your wallet")).toBeInTheDocument();
    expect(rpc).not.toContain("eth_sendRawTransaction");
    expect(api.posts().filter((p) => p.url.startsWith(API))).toHaveLength(0);
  });
});

describe("BTC deposit", () => {
  it("fetches the per-user address, shows a QR, and the OP_RETURN fallback claims by txid", async () => {
    testnet();
    const w = seedAppsWebWallet();
    const rouge = await pubkeyToAddress(w.signingPublicKey);
    const api = nodeRoutes(w.signingPublicKey, {
      "POST /bridge/btc/deposit-address": () => ({ success: true, address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" }),
      "POST /bridge/btc/claim": () => ({ success: true }),
    });
    renderBridge();
    await userEvent.click(await screen.findByRole("button", { name: "BTC" }));
    expect(await screen.findByText("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toBeInTheDocument();
    expect(await screen.findByAltText("Bitcoin deposit address QR code")).toBeInTheDocument();
    expect(screen.getAllByText("Testnet — send testnet BTC only.").length).toBeGreaterThan(0);
    expect(api.posts()[0]).toMatchObject({ path: "/bridge/btc/deposit-address", body: { recipient: rouge } });

    await userEvent.click(screen.getByRole("button", { name: /Advanced: deposit with OP_RETURN/ }));
    expect(screen.getByText(BTC_CUSTODY)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Bitcoin transaction id"), "nothex");
    await userEvent.click(screen.getByRole("button", { name: "Claim qBTC" }));
    expect(screen.getByText(/valid Bitcoin transaction id/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Bitcoin transaction id"));
    await userEvent.type(screen.getByLabelText("Bitcoin transaction id"), "c".repeat(64));
    await userEvent.click(screen.getByRole("button", { name: "Claim qBTC" }));
    expect(await screen.findByText("Claimed! qBTC minted to your RougeChain wallet.")).toBeInTheDocument();
    expect(api.posts().at(-1)).toMatchObject({ path: "/bridge/btc/claim", body: { btcTxid: "c".repeat(64), recipientRougechainPubkey: rouge } });
  });

  it("address pool warming up: explains and retries", async () => {
    testnet();
    const w = seedAppsWebWallet();
    let n = 0;
    nodeRoutes(w.signingPublicKey, {
      "POST /bridge/btc/deposit-address": () => (++n === 1 ? { success: false, error: "address pool empty" } : { success: true, address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" }),
    });
    renderBridge();
    await userEvent.click(await screen.findByRole("button", { name: "BTC" }));
    expect(await screen.findByText(/Setting up your deposit address/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toBeInTheDocument();
  });
});

describe("withdraw RougeChain → Base / Bitcoin", () => {
  it("qETH to Base: validates the address, reviews, signs with the local key, POSTs /bridge/withdraw", async () => {
    testnet();
    const w = seedAppsWebWallet();
    const api = nodeRoutes(w.signingPublicKey, { "POST /bridge/withdraw": () => ({ success: true, txId: "abc" }) });
    renderBridge();
    await userEvent.click(await screen.findByRole("tab", { name: /Withdraw/ }));
    expect(await screen.findByText("Balance: 2 qETH")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Amount (qETH)"), "0.5");
    await userEvent.type(screen.getByLabelText("Receive at (Base address)"), "0x1234");
    expect(screen.getByText(/Enter a valid Base address/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Receive at (Base address)"));
    await userEvent.type(screen.getByLabelText("Receive at (Base address)"), EVM);
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    const review = screen.getByText("You send").closest("dl")!;
    expect(within(review).getByText("0.5 qETH · RougeChain")).toBeInTheDocument();
    expect(within(review).getByText("0.5 ETH · Base Sepolia")).toBeInTheDocument();
    expect(within(review).getByText("0.1 XRGE")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    expect(await screen.findByText("Withdrawal submitted! The relayer will send ETH to your Base address.")).toBeInTheDocument();
    const post = api.posts().find((p) => p.path === "/bridge/withdraw")!;
    const body = post.body as { payload: SignedTransaction["payload"]; signature: string; amountUnits: number; evmAddress: string };
    expect(body).toMatchObject({ fromPublicKey: w.signingPublicKey, amountUnits: 500_000, evmAddress: EVM });
    expect(body.payload).toMatchObject({ type: "bridge_withdraw", amount: 500_000, fee: 0.1, tokenSymbol: "qETH", evmAddress: EVM, from: w.signingPublicKey });
    expect(verifyTransaction({ payload: body.payload, signature: body.signature, public_key: w.signingPublicKey })).toBe(true);
  });

  it("qBTC is paused unless VITE_BTC_WITHDRAW_ENABLED=true (apps/web gate)", async () => {
    testnet();
    const w = seedAppsWebWallet();
    nodeRoutes(w.signingPublicKey, { "GET https://mempool.space/testnet/api/v1/fees/recommended": () => ({ halfHourFee: 12 }) });
    renderBridge();
    await userEvent.click(await screen.findByRole("tab", { name: /Withdraw/ }));
    await userEvent.click(screen.getByRole("button", { name: "qBTC" }));
    expect(await screen.findByText(/BTC withdrawals are paused/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
  });

  it("qBTC with the new fee policy: minimum, estimated fee, receive ≈, blocks below minimum, then withdraws", async () => {
    vi.stubEnv("VITE_BTC_WITHDRAW_ENABLED", "true");
    testnet();
    const w = seedAppsWebWallet();
    const api = nodeRoutes(w.signingPublicKey, {
      "GET https://mempool.space/testnet/api/v1/fees/recommended": () => ({ halfHourFee: 12, fastestFee: 40 }),
      "POST /bridge/withdraw": () => ({ success: true, txId: "b1" }),
    });
    renderBridge();
    await userEvent.click(await screen.findByRole("tab", { name: /Withdraw/ }));
    await userEvent.click(screen.getByRole("button", { name: "qBTC" }));
    const feeBox = screen.getByLabelText("Bitcoin withdrawal fee");
    expect(within(feeBox).getByText("0.00002000 BTC")).toBeInTheDocument();
    expect(await within(feeBox).findByText("≈ 0.00001692 BTC")).toBeInTheDocument(); // ceil(12 × 141)
    expect(screen.queryByText(/paused/)).toBeNull();

    await userEvent.type(screen.getByLabelText("Amount (qBTC)"), "0.00001");
    expect(screen.getByRole("alert")).toHaveTextContent("Minimum qBTC withdrawal is 0.00002000 BTC");
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText("Amount (qBTC)"));
    await userEvent.type(screen.getByLabelText("Amount (qBTC)"), "0.001");
    expect(within(feeBox).getByText("≈ 0.00098308 BTC")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Receive at (Bitcoin address)"), "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    expect(screen.getByText("Enter a valid testnet Bitcoin address")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Receive at (Bitcoin address)"));
    await userEvent.type(screen.getByLabelText("Receive at (Bitcoin address)"), "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("≈ 0.00098308 BTC · Bitcoin")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    expect(await screen.findByText(/Withdrawal queued/)).toBeInTheDocument();
    const body = api.posts().find((p) => p.path === "/bridge/withdraw")!.body as { payload: Record<string, unknown>; amountUnits: number; evmAddress: string };
    expect(body).toMatchObject({ amountUnits: 100_000, evmAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" });
    expect(body.payload).toMatchObject({ tokenSymbol: "qBTC", amount: 100_000, evmAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", fee: 0.1 });
  });

  it("XRGE: whole units and the 0.1 XRGE fee on top", async () => {
    testnet();
    const w = seedAppsWebWallet();
    nodeRoutes(w.signingPublicKey);
    renderBridge();
    await userEvent.click(await screen.findByRole("tab", { name: /Withdraw/ }));
    await userEvent.click(screen.getByRole("button", { name: "XRGE" }));
    await userEvent.type(screen.getByLabelText("Amount (XRGE)"), "1.5");
    expect(screen.getByText(/whole number/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Amount (XRGE)"));
    await userEvent.type(screen.getByLabelText("Amount (XRGE)"), "100");
    expect(screen.getByText("You need 0.1 XRGE on RougeChain for the bridge fee")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Max 99 XRGE" }));
    expect(screen.getByLabelText("Amount (XRGE)")).toHaveValue("99");
  });

  it("extension wallet: says the extension will ask for approval", async () => {
    testnet();
    const w = seedAppsWebWallet({ signingPrivateKey: "", encryptionPrivateKey: "", mnemonic: undefined });
    nodeRoutes(w.signingPublicKey);
    renderBridge();
    expect(await screen.findByText(/Connected through the RougeChain extension/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Use my RougeChain Base wallet/ })).toBeNull();
  });
});

describe("status", () => {
  it("pending withdrawals link to the Explorer's bridge transfer page", async () => {
    testnet();
    const w = seedAppsWebWallet();
    const txId = "d".repeat(64);
    nodeRoutes(w.signingPublicKey, {
      "GET /bridge/withdrawals": () => ({
        withdrawals: [
          { txId, evmAddress: EVM, amountUnits: 1_500_000, tokenSymbol: "qETH", ownerPubkey: w.signingPublicKey, status: "pending", attempts: 0, createdAt: 1 },
          { txId: "e".repeat(64), evmAddress: "tb1qx", amountUnits: 5000, tokenSymbol: "qBTC", ownerPubkey: w.signingPublicKey, status: "fulfilled", payoutTxid: "f".repeat(64), attempts: 1, createdAt: 2 },
          { txId: "9".repeat(64), evmAddress: EVM, amountUnits: 1, tokenSymbol: "qETH", ownerPubkey: "someone-else", status: "pending", attempts: 0, createdAt: 3 },
        ],
      }),
    });
    renderBridge();
    const link = await screen.findByRole("link", { name: /1\.5 qETH →/ });
    expect(link).toHaveAttribute("href", `/explorer/bridge/${txId}`);
    expect(screen.getByRole("link", { name: /0\.00005 qBTC →/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on mempool.space/ })).toHaveAttribute("href", `https://mempool.space/testnet/tx/${"f".repeat(64)}`);
    expect(screen.getByText("Released")).toBeInTheDocument();
    expect(screen.queryByText(/someone-else/)).toBeNull();
    expect(screen.getAllByRole("link", { name: /qETH →/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "All bridge activity" })).toHaveAttribute("href", "/explorer/bridge");
  });

  it("claim an existing deposit needs a valid hash and a connected Base wallet", async () => {
    testnet();
    const w = seedAppsWebWallet();
    const api = nodeRoutes(w.signingPublicKey);
    renderBridge();
    const card = (await screen.findByRole("heading", { name: "Claim an existing deposit" })).closest("section")!;
    expect(within(card).getByRole("button", { name: "Claim deposit" })).toBeDisabled();
    await userEvent.type(within(card).getByLabelText("Base transaction hash"), "0x12");
    expect(within(card).getByRole("button", { name: "Claim deposit" })).toBeDisabled();
    expect(api.posts()).toHaveLength(0);
  });
});
