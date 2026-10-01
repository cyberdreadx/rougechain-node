/** Wallet page "Base wallet" card: phrase-derived account, injected wallet (Qwalla in-app browser), none. */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMnemonic } from "@rougechain/core/mnemonic";
import { deriveBaseAddress } from "@rougechain/core/evm-wallet";
import { getBaseAssets, getBaseChain } from "@rougechain/core/base-wallet";
import { BaseWalletCard } from "./BaseWallet";
import { mockProvider } from "../bridge/test-helpers";
import { transferCalldata } from "../bridge/evm";

const chain = getBaseChain("testnet"); // Base Sepolia, 84532 = 0x14a34
const usdc = getBaseAssets(chain.chainId).find((a) => a.symbol === "USDC")!.token!;
const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const RECIPIENT = "0x00000000000000000000000000000000000000b2";

/** Base JSON-RPC (the public RPC the card reads balances / fee quotes from). */
function mockBaseRpc() {
  const methods: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== chain.rpcUrl) throw new TypeError(`offline: ${url}`);
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    methods.push(method);
    const result = (() => {
      switch (method) {
        case "eth_getBalance":
          return "0x14d1120d7b160000"; // 1.5 ETH
        case "eth_call": {
          const to = String((params[0] as { to: string }).to).toLowerCase();
          if (to === usdc.toLowerCase()) return "0x" + (25_000_000).toString(16); // 25 USDC
          if (to.startsWith("0x4200")) return "0x3e8"; // L1 fee oracle
          return "0x0";
        }
        case "eth_estimateGas":
          return "0x5208";
        case "eth_getBlockByNumber":
          return { baseFeePerGas: "0x3b9aca00" };
        case "eth_maxPriorityFeePerGas":
          return "0xf4240";
        default:
          throw new Error(`unexpected rpc ${method}`);
      }
    })();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, methods };
}

function injectQwalla(handlers: Record<string, (params: unknown[]) => unknown>, chainId = "0x14a34") {
  const m = mockProvider(handlers, chainId);
  Object.assign(window, { ethereum: Object.assign(m.provider, { isQwalla: true, isMetaMask: true }) });
  return m;
}

function renderCard(mnemonic: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <BaseWalletCard mnemonic={mnemonic} network="testnet" ethPriceUsd={null} xrgePriceUsd={null} hidden={false} />
    </QueryClientProvider>,
  );
}

const card = () => within(screen.getByRole("region", { name: "Base wallet" }));

async function openSendAndReview(user: ReturnType<typeof userEvent.setup>, amount: string, symbol?: string) {
  await user.click(await card().findByRole("button", { name: "Send" }));
  const dialog = await screen.findByRole("dialog");
  if (symbol) await user.click(within(dialog).getByRole("button", { name: new RegExp(`^${symbol} ·`) }));
  await user.type(within(dialog).getByLabelText("Recipient address"), RECIPIENT);
  await user.type(within(dialog).getByPlaceholderText("0.0"), amount);
  await user.click(within(dialog).getByRole("button", { name: "Review" }));
  await within(dialog).findByRole("button", { name: "Confirm in Qwalla Wallet" });
  return dialog;
}

describe("BaseWalletCard", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "ethereum");
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "ethereum");
  });

  it("shows the injected Qwalla account and its balances without prompting on load", async () => {
    const rpc = mockBaseRpc();
    const q = injectQwalla({ eth_accounts: () => [ACCOUNT] });
    renderCard();
    expect((await card().findAllByText(ACCOUNT))[0]).toBeInTheDocument();
    expect(card().getByText(/Base account via Qwalla Wallet/)).toBeInTheDocument();
    expect(await card().findByText("1.5")).toBeInTheDocument();
    expect(card().getByText("25")).toBeInTheDocument();
    expect(rpc.methods).toContain("eth_getBalance");
    expect(q.calls.map((c) => c.method)).not.toContain("eth_requestAccounts");
    expect(card().queryByText("No Base account for this wallet")).not.toBeInTheDocument();
  });

  it("offers a connect button when the wallet hasn't shared an account, and connects on click", async () => {
    mockBaseRpc();
    const user = userEvent.setup();
    const q = injectQwalla({ eth_accounts: () => [], eth_requestAccounts: () => [ACCOUNT] });
    renderCard();
    const button = await card().findByRole("button", { name: "Connect Qwalla Wallet Base account" });
    expect(q.calls.map((c) => c.method)).toEqual(["eth_accounts"]);
    await user.click(button);
    expect((await card().findAllByText(ACCOUNT))[0]).toBeInTheDocument();
    expect(q.calls.map((c) => c.method)).toContain("eth_requestAccounts");
  });

  it("shows a rejected connect request", async () => {
    mockBaseRpc();
    const user = userEvent.setup();
    injectQwalla({
      eth_accounts: () => [],
      eth_requestAccounts: () => {
        throw Object.assign(new Error("User rejected the request"), { code: 4001 });
      },
    });
    renderCard();
    await user.click(await card().findByRole("button", { name: "Connect Qwalla Wallet Base account" }));
    expect(await card().findByRole("alert")).toHaveTextContent("The request was rejected in the wallet.");
  });

  it("sends ETH through the wallet's eth_sendTransaction with the quoted fee", async () => {
    mockBaseRpc();
    const user = userEvent.setup();
    const q = injectQwalla({ eth_accounts: () => [ACCOUNT] });
    renderCard();
    await card().findByText("1.5");
    const dialog = await openSendAndReview(user, "0.1");
    expect(within(dialog).getByText(/Qwalla Wallet will ask you to approve/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Confirm in Qwalla Wallet" }));
    expect(await within(dialog).findByText(/It will confirm on/)).toBeInTheDocument();
    const sent = q.sent();
    expect(sent).toHaveLength(1);
    const tx = sent[0] as { from: string; to: string; value: string; data: string; gas: string };
    expect(tx).toMatchObject({ from: ACCOUNT, value: "0x16345785d8a0000", data: "0x" });
    expect(tx.to.toLowerCase()).toBe(RECIPIENT);
    expect(tx.gas).toBe("0x6270"); // 21000 × 1.2
    expect(q.calls.map((c) => c.method)).not.toContain("wallet_switchEthereumChain");
  });

  it("sends USDC as an ERC-20 transfer call to the token contract", async () => {
    mockBaseRpc();
    const user = userEvent.setup();
    const q = injectQwalla({ eth_accounts: () => [ACCOUNT] });
    renderCard();
    await card().findByText("25");
    const dialog = await openSendAndReview(user, "2.5", "USDC");
    await user.click(within(dialog).getByRole("button", { name: "Confirm in Qwalla Wallet" }));
    await within(dialog).findByText(/It will confirm on/);
    const [tx] = q.sent() as { to: string; value: string; data: string }[];
    expect(tx.to.toLowerCase()).toBe(usdc.toLowerCase());
    expect(tx.value).toBe("0x0");
    expect(tx.data.toLowerCase()).toBe(transferCalldata(RECIPIENT, 2_500_000n));
  });

  it("asks the wallet to switch to Base Sepolia, then sends", async () => {
    mockBaseRpc();
    const user = userEvent.setup();
    let current = "0x2105"; // Base mainnet
    const q = injectQwalla({
      eth_accounts: () => [ACCOUNT],
      eth_chainId: () => current,
      wallet_switchEthereumChain: (p) => {
        current = (p[0] as { chainId: string }).chainId;
        return null;
      },
    });
    renderCard();
    await card().findByText("1.5");
    const dialog = await openSendAndReview(user, "0.1");
    await user.click(within(dialog).getByRole("button", { name: "Confirm in Qwalla Wallet" }));
    await within(dialog).findByText(/It will confirm on/);
    expect(q.calls.find((c) => c.method === "wallet_switchEthereumChain")?.params).toEqual([{ chainId: "0x14a34" }]);
    expect(q.sent()).toHaveLength(1);
  });

  it("refuses to send when the wallet stays on another chain", async () => {
    mockBaseRpc();
    const user = userEvent.setup();
    const q = injectQwalla(
      {
        eth_accounts: () => [ACCOUNT],
        wallet_switchEthereumChain: () => {
          throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
        },
      },
      "0x2105",
    );
    renderCard();
    await card().findByText("1.5");
    const dialog = await openSendAndReview(user, "0.1");
    await user.click(within(dialog).getByRole("button", { name: "Confirm in Qwalla Wallet" }));
    expect(await within(dialog).findByText(/Qwalla Wallet is on chain 8453, not Base Sepolia \(84532\)/)).toBeInTheDocument();
    expect(q.sent()).toHaveLength(0);
  });

  it("keeps phrase wallets on the derived address and never touches the injected wallet", async () => {
    mockBaseRpc();
    const q = injectQwalla({ eth_accounts: () => [ACCOUNT] });
    const mnemonic = generateMnemonic();
    renderCard(mnemonic);
    expect((await card().findAllByText(deriveBaseAddress(mnemonic)!))[0]).toBeInTheDocument();
    expect(card().getByText(/Same recovery phrase as Qwalla/)).toBeInTheDocument();
    await card().findByText("1.5");
    expect(q.calls).toHaveLength(0);
  });

  it("explains how to get a Base account when there is no phrase and no injected wallet", async () => {
    const rpc = mockBaseRpc();
    renderCard();
    expect(card().getByText("No Base account for this wallet")).toBeInTheDocument();
    expect(card().getByText(/open rougechain\.io in Qwalla's in-app browser/)).toBeInTheDocument();
    await waitFor(() => expect(rpc.fn).not.toHaveBeenCalled());
  });
});
