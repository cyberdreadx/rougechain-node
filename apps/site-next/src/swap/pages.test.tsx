/**
 * Swap / Pools / Pool detail / Buy pages against a mocked node (never a real one): real data, every
 * state (no wallet, locked, loading, empty, error, no route), and review → sign → submit.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyTransaction, type SignedTransaction } from "@rougechain/core/pqc-signer";
import type { UnifiedWallet } from "@rougechain/core/unified-wallet";
import { ChainProvider } from "../explorer/chain";
import { WalletProvider } from "../wallet/WalletProvider";
import { Toaster } from "../wallet/toast";
import { mockFetch, resetBrowserState, seedAppsWebLockedWallet, seedAppsWebWallet, type Handler } from "../wallet/test-utils";
import { swapArea, isSwapPath } from "../features/swap";

const POOLS = [
  { pool_id: "XRGE-qUSDC", token_a: "XRGE", token_b: "qUSDC", reserve_a: 10_000, reserve_b: 20_000_000_000, total_lp_supply: 14_141_135, fee_rate: 0.003 },
  { pool_id: "MTK-XRGE", token_a: "MTK", token_b: "XRGE", reserve_a: 500, reserve_b: 1_000, total_lp_supply: 707, fee_rate: 0.003 },
];

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ChainProvider>
        <WalletProvider autoRegister={false}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>{swapArea.routes}</Routes>
            <Toaster />
          </MemoryRouter>
        </WalletProvider>
      </ChainProvider>
    </QueryClientProvider>,
  );
}

function node(w: UnifiedWallet | null, extra: Record<string, Handler> = {}) {
  const defaults: Record<string, Handler> = {
    ...(w
      ? {
          [`/balance/${w.signingPublicKey}`]: () => ({
            success: true,
            balance: 1000,
            token_balances: { qUSDC: 50_000_000, MTK: 20 },
            lp_balances: { "XRGE-qUSDC": 50_000 },
          }),
        }
      : {}),
    "/swap/quote": (_u, init) => {
      const { amount_in } = JSON.parse(String(init?.body));
      return { success: true, amount_out: amount_in * 1_990_000, price_impact: 0.25, path: ["XRGE", "qUSDC"], pools: ["XRGE-qUSDC"] };
    },
    "/pools": () => ({ success: true, pools: POOLS }),
    "/tokens": () => ({ success: true, tokens: [{ symbol: "qUSDC", name: "USD Coin", decimals: 6, creator: "BRIDGE", created_at: 0, updated_at: 0 }] }),
    geckoterminal: () => ({}),
    "/price/xrge": () => ({ success: false }),
    coingecko: () => ({}),
  };
  // `extra` wins (and is matched first: more specific paths go there).
  return mockFetch({ ...extra, ...Object.fromEntries(Object.entries(defaults).filter(([k]) => !(k in extra))) });
}

const sent = (calls: { url: string; init?: RequestInit }[], endpoint: string) =>
  calls.filter((c) => c.url.endsWith(endpoint)).map((c) => JSON.parse(String(c.init?.body)) as SignedTransaction);

beforeEach(() => {
  resetBrowserState();
  vi.stubGlobal("WebSocket", undefined);
});

describe("routes", () => {
  it("owns apps/web's paths plus Anders' /swap views, all under the Swap header", () => {
    const paths = swapArea.routes.map((r) => (r.props as { path: string }).path);
    expect(paths).toEqual(["/swap", "/pools", "/swap/pools", "/swap/positions", "/pool/:poolId", "/buy"]);
    for (const p of ["/swap", "/swap/pools", "/swap/positions", "/pools", "/pool/XRGE-qUSDC", "/buy"]) expect(swapArea.headerProduct(p)).toBe("Swap");
    for (const p of ["/", "/wallet", "/poolside", "/buyer", "/explorer"]) expect(isSwapPath(p)).toBe(false);
  });
});

describe("swap", () => {
  it("quotes from the node with no wallet, and asks to connect instead of signing (no demo left)", async () => {
    const { calls } = node(null);
    renderAt("/swap");
    expect(await screen.findByRole("heading", { name: "Swap", level: 2 })).toBeInTheDocument();
    expect(screen.queryByText("DESIGN DEMO")).not.toBeInTheDocument();
    expect(screen.queryByText(/illustrative/i)).not.toBeInTheDocument();
    // Receive side defaults to the deepest XRGE pair once pools load.
    await screen.findByRole("button", { name: "Receive token: qUSDC" });
    await userEvent.type(screen.getByLabelText("You pay"), "2");
    expect(await screen.findByText("3.98")).toBeInTheDocument(); // 2 × 1,990,000 raw qUSDC (6 decimals)
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/swap/quote"))!.init!.body))).toEqual({ token_in: "XRGE", token_out: "qUSDC", amount_in: 2 });
    expect(screen.getByText("Connect a wallet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open wallet" })).toHaveAttribute("href", "/wallet");
    expect(screen.queryByRole("button", { name: /Review swap/ })).not.toBeInTheDocument();
  });

  it("reviews, then signs locally and submits the quoted swap with the slippage minimum", async () => {
    const w = seedAppsWebWallet();
    const { calls } = node(w, { "/v2/swap/execute": () => ({ success: true, tx_hash: "abc" }) });
    renderAt("/swap?tokenIn=XRGE&tokenOut=qUSDC");
    await userEvent.type(await screen.findByLabelText("You pay"), "100");
    const review = await screen.findByRole("button", { name: /Review swap/ });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    const dialog = screen.getByRole("dialog", { name: "Review swap" });
    expect(within(dialog).getByText("100 XRGE")).toBeInTheDocument();
    expect(within(dialog).getByText("Mainnet")).toBeInTheDocument();
    expect(within(dialog).getByText(/Signed in this browser/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign and swap" }));
    await screen.findByText(/Swap submitted: 100 XRGE/);
    const [tx] = sent(calls, "/v2/swap/execute");
    expect(verifyTransaction(tx)).toBe(true);
    expect(tx.public_key).toBe(w.signingPublicKey);
    expect(tx.payload).toMatchObject({ type: "swap", from: w.signingPublicKey, token_in: "XRGE", token_out: "qUSDC", amount_in: 100, min_amount_out: Math.floor(199_000_000 * 0.995) });
  });

  it("stops at insufficient balance, fractional XRGE, no route and high impact", async () => {
    const w = seedAppsWebWallet();
    let route = true;
    node(w, {
      "/swap/quote": (_u, init) => {
        const { amount_in } = JSON.parse(String(init?.body));
        return route ? { success: true, amount_out: amount_in * 10, price_impact: amount_in > 500 ? 8.2 : 0.1, path: ["XRGE", "qUSDC"], pools: [] } : { success: false, error: "No route found for swap" };
      },
    });
    renderAt("/swap?tokenIn=XRGE&tokenOut=qUSDC");
    const input = await screen.findByLabelText("You pay");
    await screen.findByText(/Balance 1,000/);
    await userEvent.type(input, "5000");
    expect(await screen.findByRole("button", { name: "Insufficient XRGE balance" })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "1.5");
    expect(await screen.findByRole("button", { name: "XRGE amounts must be whole numbers" })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "600");
    expect(await screen.findByText(/High price impact: 8.20%/)).toBeInTheDocument();
    route = false;
    await userEvent.clear(input);
    await userEvent.type(input, "7");
    expect(await screen.findByRole("button", { name: "No route" })).toBeDisabled();
    expect(screen.getByText("No route found for swap")).toBeInTheDocument();
  });

  it("picks tokens from the pool list and flips the pair", async () => {
    node(null);
    renderAt("/swap");
    await userEvent.click(await screen.findByRole("button", { name: "Receive token: qUSDC" }));
    const picker = screen.getByRole("dialog", { name: "Select a token" });
    await userEvent.type(within(picker).getByPlaceholderText("Search tokens"), "mt");
    await userEvent.click(within(picker).getByRole("button", { name: /MTK/ }));
    expect(screen.getByRole("button", { name: "Receive token: MTK" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reverse token pair" }));
    expect(screen.getByRole("button", { name: "Pay token: MTK" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Receive token: XRGE" })).toBeInTheDocument();
  });

  it("a locked wallet is asked to unlock before signing", async () => {
    const w = await seedAppsWebLockedWallet();
    node(w);
    renderAt("/swap");
    expect(await screen.findByText("Wallet locked")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("an extension wallet signs through the extension", async () => {
    const local = seedAppsWebWallet();
    resetBrowserState();
    const signTransaction = vi.fn(async () => ({ signature: "cd".repeat(8) }));
    Object.assign(window, { rougechain: { isRougeChain: true, connect: async () => ({ publicKey: local.signingPublicKey }), signTransaction } });
    const ext = seedAppsWebWallet({ signingPublicKey: local.signingPublicKey, signingPrivateKey: "", mnemonic: undefined });
    const { calls } = node(ext, { "/v2/swap/execute": () => ({ success: true }) });
    renderAt("/swap?tokenIn=XRGE&tokenOut=qUSDC");
    await userEvent.type(await screen.findByLabelText("You pay"), "3");
    const review = await screen.findByRole("button", { name: /Review swap/ });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    expect(screen.getByText(/extension will ask you to approve/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign and swap" }));
    await screen.findByText(/Swap submitted/);
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(sent(calls, "/v2/swap/execute")[0].signature).toBe("cd".repeat(8));
  });

  it("shows the active network (testnet) in the review", async () => {
    localStorage.setItem("rougechain-network", "testnet");
    const w = seedAppsWebWallet();
    node(w);
    renderAt("/swap?tokenIn=XRGE&tokenOut=qUSDC");
    await userEvent.type(await screen.findByLabelText("You pay"), "1");
    const review = await screen.findByRole("button", { name: /Review swap/ });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    expect(within(screen.getByRole("dialog", { name: "Review swap" })).getByText("Testnet")).toBeInTheDocument();
  });
});

describe("pools", () => {
  it("lists the node's pools; an offline node is an error, not fake data", async () => {
    node(null);
    renderAt("/pools");
    expect(await screen.findByRole("article", { name: "XRGE/qUSDC" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "MTK/XRGE" })).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Search pools by token symbol"), "mtk");
    expect(screen.queryByRole("article", { name: "XRGE/qUSDC" })).not.toBeInTheDocument();
  });

  it("empty and error states", async () => {
    mockFetch({ "/pools": () => ({ pools: [] }) });
    const { unmount } = renderAt("/swap/pools");
    expect(await screen.findByText("No pools yet")).toBeInTheDocument();
    unmount();
    mockFetch();
    renderAt("/pools");
    expect(await screen.findByText("Couldn't load pools from the node.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("positions show uncollected fees from the node's ledger and collect them", async () => {
    const w = seedAppsWebWallet();
    const { calls } = node(w, {
      "/earnings/": () => ({ success: true, earnings: { tracked: true, lpToCollect: 120, earnedA: 84, earnedB: 169_000_000, growth: 0.0024 } }),
      "/v2/pool/remove-liquidity": () => ({ success: true }),
    });
    renderAt("/swap/positions");
    const card = await screen.findByRole("article", { name: "XRGE/qUSDC" });
    expect(screen.queryByRole("article", { name: "MTK/XRGE" })).not.toBeInTheDocument();
    expect(await within(card).findByText("84 XRGE + 169.00 qUSDC")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: /Collect fees/ }));
    const dialog = screen.getByRole("dialog", { name: "Collect fees · XRGE/qUSDC" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign and collect" }));
    await screen.findByText("Fees collected");
    const [tx] = sent(calls, "/v2/pool/remove-liquidity");
    expect(verifyTransaction(tx)).toBe(true);
    expect(tx.payload).toMatchObject({ type: "remove_liquidity", pool_id: "XRGE-qUSDC", lp_amount: 120 });
    expect(calls.some((c) => c.url.endsWith(`/pool/XRGE-qUSDC/earnings/${w.signingPublicKey}`))).toBe(true);
  });

  it("add liquidity keeps the pool ratio and signs raw amounts", async () => {
    const w = seedAppsWebWallet();
    const { calls } = node(w, { "/earnings/": () => ({ earnings: null }), "/v2/pool/add-liquidity": () => ({ success: true }) });
    renderAt("/pools");
    const card = await screen.findByRole("article", { name: "XRGE/qUSDC" });
    await waitFor(() => expect(within(card).getByRole("button", { name: "Add · XRGE/qUSDC" })).toBeEnabled());
    await userEvent.click(within(card).getByRole("button", { name: "Add · XRGE/qUSDC" }));
    const dialog = screen.getByRole("dialog", { name: "Add liquidity · XRGE/qUSDC" });
    await userEvent.type(within(dialog).getByLabelText(/XRGE amount/), "10");
    expect(within(dialog).getByLabelText(/qUSDC amount/)).toHaveValue("20"); // 10 × (20,000 qUSDC / 10,000 XRGE)
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign and add" }));
    await screen.findByText("Liquidity added");
    expect(sent(calls, "/v2/pool/add-liquidity")[0].payload).toMatchObject({ type: "add_liquidity", pool_id: "XRGE-qUSDC", amount_a: 10, amount_b: 20_000_000 });
  });

  it("creates a pool and refuses an existing pair", async () => {
    const w = seedAppsWebWallet();
    const { calls } = node(w, { "/earnings/": () => ({ earnings: null }), "/v2/pool/create": () => ({ success: true, pool_id: "qUSDC-MTK" }) });
    renderAt("/pools");
    const create = await screen.findByRole("button", { name: "New pool" });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    const dialog = screen.getByRole("dialog", { name: "Create a pool" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Token B"), "MTK");
    expect(within(dialog).getByText(/Pool MTK-XRGE already exists/)).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText("Token A"), "qUSDC");
    await userEvent.type(within(dialog).getByLabelText(/qUSDC amount/), "1.5");
    await userEvent.type(within(dialog).getByLabelText(/MTK amount/), "10");
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign and create" }));
    await screen.findByText(/Pool created/);
    expect(sent(calls, "/v2/pool/create")[0].payload).toMatchObject({ type: "create_pool", token_a: "qUSDC", token_b: "MTK", amount_a: 1_500_000, amount_b: 10 });
  });
});

describe("pool detail and buy", () => {
  it("shows reserves, stats, the price chart and history", async () => {
    node(null, {
      "/pool/XRGE-qUSDC/prices": () => ({
        prices: [
          { pool_id: "XRGE-qUSDC", timestamp: 1_700_000_000, block_height: 1, reserve_a: 10_000, reserve_b: 20_000_000_000, price_a_in_b: 2_000_000, price_b_in_a: 0.0000005 },
          { pool_id: "XRGE-qUSDC", timestamp: 1_700_000_600, block_height: 2, reserve_a: 10_000, reserve_b: 22_000_000_000, price_a_in_b: 2_200_000, price_b_in_a: 0.00000045 },
        ],
      }),
      "/pool/XRGE-qUSDC/events": () => ({
        events: [{ id: "e1", pool_id: "XRGE-qUSDC", event_type: "Swap", user_pub_key: "ab".repeat(1952), timestamp: 1_700_000_600, block_height: 2, tx_hash: "h", token_in: "XRGE", token_out: "qUSDC", amount_in: 5, amount_out: 9_950_000, reserve_a_after: 10_000, reserve_b_after: 22_000_000_000 }],
      }),
      "/pool/XRGE-qUSDC/stats": () => ({ stats: { pool_id: "XRGE-qUSDC", total_swaps: 42, swap_count_24h: 3, total_volume_a: 0, total_volume_b: 0, volume_24h_a: 0, volume_24h_b: 0 } }),
      "/pool/XRGE-qUSDC": () => ({ pool: POOLS[0] }),
    });
    renderAt("/pool/XRGE-qUSDC");
    expect(await screen.findByRole("heading", { level: 1, name: /XRGE\/qUSDC/ })).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".dex-price strong")).toHaveTextContent("2.2")); // last price, qUSDC per XRGE, humanized
    expect(screen.getByText("+10.00%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Price/ })).toBeInTheDocument();
    expect(await screen.findByText("Swap 5 XRGE → 9.95 qUSDC")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Swap this pair/ })).toHaveAttribute("href", "/swap?tokenIn=XRGE&tokenOut=qUSDC");
  });

  it("unknown pool → not found", async () => {
    node(null, { "/pool/NOPE-X": () => ({ pool: null }) });
    renderAt("/pool/NOPE-X");
    expect(await screen.findByText("Pool not found")).toBeInTheDocument();
  });

  it("buy page shows the official contract and links out", async () => {
    mockFetch();
    renderAt("/buy");
    expect(await screen.findByRole("heading", { level: 1, name: "Buy XRGE" })).toBeInTheDocument();
    expect(screen.getByText("0x147120faEC9277ec02d957584CFCD92B56A24317")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Buy on Aerodrome/ })).toHaveAttribute("href", expect.stringContaining("aerodrome.finance/swap"));
    expect(screen.getByRole("link", { name: /Bridge XRGE/ })).toHaveAttribute("href", "/bridge");
  });
});
