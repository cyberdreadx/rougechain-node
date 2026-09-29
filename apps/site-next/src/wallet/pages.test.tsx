import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pubkeyToAddress } from "@rougechain/core/address";
import { verifyTransaction, type SignedTransaction } from "@rougechain/core/pqc-signer";
import { lockUnifiedWallet, type UnifiedWallet } from "@rougechain/core/unified-wallet";
import { ChainProvider } from "../explorer/chain";
import { WalletProvider } from "./WalletProvider";
import WalletPage from "./WalletPage";
import SettingsPage from "./SettingsPage";
import { TourHost } from "./TourHost";
import { Toaster } from "./toast";
import { TOUR_SEEN_KEY } from "./tour";
import { HIDE_BALANCES_KEY } from "./hooks";
import { mockFetch, resetBrowserState, seedAppsWebWallet, type Handler } from "./test-utils";

const OTHER = "cd".repeat(1952);

function renderApp(path = "/wallet") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ChainProvider>
        <WalletProvider autoRegister={false}>
          <MemoryRouter initialEntries={[path]}>
            <TourHost />
            <Routes>
              <Route path="/wallet" element={<WalletPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
            <Toaster />
          </MemoryRouter>
        </WalletProvider>
      </ChainProvider>
    </QueryClientProvider>,
  );
}

function nodeRoutes(w: UnifiedWallet, extra: Record<string, Handler> = {}) {
  return mockFetch({
    [`/balance/${w.signingPublicKey}`]: () => ({ success: true, balance: 1234.5, token_balances: { qBTC: 150_000_000, MEME: 0 } }),
    "/blocks": () => ({
      blocks: [
        {
          hash: "blockhash01",
          header: { height: 7, time: Date.now() - 60_000, prevHash: "", proposerPubKey: "val" },
          txs: [{ type: "transfer", fromPubKey: OTHER, fee: 0.1, payload: { toPubKeyHex: w.signingPublicKey, amount: 25 } }],
        },
      ],
    }),
    "/tokens": () => ({ success: true, tokens: [{ symbol: "qBTC", name: "Quantum BTC", creator: "BRIDGE", decimals: 8, created_at: 0, updated_at: 0 }] }),
    "/pools": () => ({ pools: [] }),
    "geckoterminal": () => ({}),
    "/price/xrge": () => ({ success: false }),
    "coingecko": () => ({ ethereum: { usd: 3000 }, bitcoin: { usd: 60000 } }),
    ...extra,
  });
}

beforeEach(() => {
  resetBrowserState();
  vi.stubGlobal("WebSocket", undefined);
  localStorage.setItem(TOUR_SEEN_KEY, "1"); // keep the auto-tour out of unrelated tests
});

describe("wallet page", () => {
  it("offers create / import / extension when there is no wallet", async () => {
    mockFetch();
    renderApp();
    expect(screen.getByRole("heading", { name: "Wallet", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create new wallet" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByRole("button", { name: "Recovery phrase" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Connect extension" })).toBeInTheDocument();
  });

  it("shows balances with decimals + USD, history, and masks them with apps/web's hide key", async () => {
    const w = seedAppsWebWallet();
    nodeRoutes(w);
    renderApp();
    const assets = await screen.findByRole("region", { name: "Assets" });
    await waitFor(() => expect(within(assets).getByText("1.5")).toBeInTheDocument()); // 150,000,000 sats → 1.5 qBTC
    expect(within(assets).getByText("$90,000.00")).toBeInTheDocument(); // 1.5 × $60,000 spot
    expect(within(assets).getByText("1,234.5")).toBeInTheDocument();
    expect(within(assets).queryByText("MEME")).not.toBeInTheDocument(); // zero balances hidden (core)
    const activity = screen.getByRole("region", { name: "Activity" });
    await waitFor(() => expect(within(activity).getByText("Received")).toBeInTheDocument());
    expect(within(activity).getByText("+25 XRGE")).toBeInTheDocument();
    const address = await pubkeyToAddress(w.signingPublicKey);
    await waitFor(() => expect(screen.getAllByText(address).length).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole("button", { name: "Hide balances" }));
    expect(localStorage.getItem(HIDE_BALANCES_KEY)).toBe("1");
    expect(within(assets).queryByText("1.5")).not.toBeInTheDocument();
    expect(within(assets).getAllByText("••••••").length).toBeGreaterThan(0);
    // Mainnet: no faucet.
    expect(screen.queryByRole("button", { name: /Get XRGE/ })).not.toBeInTheDocument();
  });

  it("sends: validate → review → sign (core) → POST /v2/transfer, then toasts", async () => {
    const w = seedAppsWebWallet();
    const { calls } = nodeRoutes(w, { "/v2/transfer": () => ({ success: true }) });
    renderApp();
    const user = userEvent.setup();
    await screen.findByText("1,234.5");
    await user.click(within(screen.getByRole("navigation", { name: "Wallet actions" })).getByRole("button", { name: "Send" }));
    const dialog = screen.getByRole("dialog", { name: "Send" });
    await user.selectOptions(within(dialog).getByRole("combobox"), "qBTC");
    await user.type(within(dialog).getByPlaceholderText("rouge1… or public key"), "not-an-address");
    expect(within(dialog).getByText(/Invalid address/)).toBeInTheDocument();
    await user.clear(within(dialog).getByPlaceholderText("rouge1… or public key"));
    await user.click(within(dialog).getByPlaceholderText("rouge1… or public key"));
    await user.paste(OTHER);
    const amount = within(dialog).getByPlaceholderText("0.0");
    await user.type(amount, "0.123456789");
    expect(within(dialog).getByText("qBTC supports at most 8 decimal places")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Review" })).toBeDisabled();
    await user.clear(amount);
    await user.type(amount, "0.5");
    await user.click(within(dialog).getByRole("button", { name: "Review" }));

    const review = screen.getByRole("dialog", { name: "Review and sign" });
    expect(within(review).getByText("0.5 qBTC")).toBeInTheDocument();
    expect(within(review).getByText("0.1 XRGE")).toBeInTheDocument();
    await user.click(within(review).getByRole("button", { name: "Sign and send" }));

    await screen.findByText("Sent 0.5 qBTC");
    const post = calls.find((c) => c.url.endsWith("/v2/transfer"))!;
    const signed = JSON.parse(String(post.init?.body)) as SignedTransaction;
    expect(signed.payload).toMatchObject({ type: "transfer", to: OTHER, amount: 50_000_000, token: "qBTC", fee: 0.1 });
    expect(verifyTransaction(signed)).toBe(true);
  });

  it("receive shows a QR code of the rouge1 address", async () => {
    const w = seedAppsWebWallet();
    nodeRoutes(w);
    renderApp();
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Wallet actions" })).getByRole("button", { name: "Receive" }));
    const dialog = screen.getByRole("dialog", { name: "Receive" });
    const qr = await within(dialog).findByAltText("QR code of your rouge1 address");
    expect(qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(within(dialog).getByText(await pubkeyToAddress(w.signingPublicKey))).toBeInTheDocument();
  });

  it("shows the testnet faucet only on testnet", async () => {
    localStorage.setItem("rougechain-network", "testnet");
    const w = seedAppsWebWallet();
    nodeRoutes(w);
    renderApp();
    expect(await screen.findByRole("button", { name: /Get XRGE/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Get qUSDC/ })).toBeInTheDocument();
  });

  it("unlocks a locked apps/web vault from the page", async () => {
    const w = seedAppsWebWallet({ displayName: "Vault" });
    await lockUnifiedWallet("open-sesame");
    nodeRoutes(w);
    renderApp();
    expect(screen.getByRole("heading", { name: "Vault is locked" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Password"), "open-sesame");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("region", { name: "Assets" })).toBeInTheDocument();
  });

  it("reveals the recovery phrase only on request (backup)", async () => {
    const w = seedAppsWebWallet();
    nodeRoutes(w);
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "Backup" }));
    const dialog = screen.getByRole("dialog", { name: "Backup & recovery" });
    const first = w.mnemonic!.split(" ")[0];
    expect(within(dialog).queryByText(first)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Reveal recovery phrase" }));
    expect(within(dialog).getAllByText(first).length).toBeGreaterThan(0);
  });
});

describe("create → onboarding → tour", () => {
  it("walks phrase → password → mail → profile → done and opens the tour once", async () => {
    localStorage.removeItem(TOUR_SEEN_KEY);
    mockFetch();
    renderApp();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create new wallet" }));
    expect(screen.getByRole("heading", { name: "Save your recovery phrase" })).toBeInTheDocument();
    const cont = screen.getByRole("button", { name: "Continue" });
    expect(cont).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(cont);

    await user.type(screen.getByLabelText("Password"), "abc123");
    await user.type(screen.getByLabelText("Confirm password"), "abc123");
    await user.click(screen.getByRole("button", { name: "Encrypt and continue" }));
    expect(await screen.findByRole("heading", { name: "Claim your mail name" })).toBeInTheDocument();
    expect(localStorage.getItem("pqc-unified-wallet-encrypted:mainnet")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.getByRole("heading", { name: "Add a profile photo" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.getByRole("heading", { name: "You're all set" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Take the tour" }));

    const tour = await screen.findByRole("dialog", { name: "How RougeChain works" }, { timeout: 3000 });
    expect(within(tour).getByText("Welcome to RougeChain")).toBeInTheDocument();
    await user.click(within(tour).getByRole("button", { name: "Skip" }));
    expect(localStorage.getItem(TOUR_SEEN_KEY)).toBe("1");
    expect(await screen.findByRole("region", { name: "Assets" })).toBeInTheDocument();
  });
});

describe("settings page", () => {
  it("renders every section and points a visitor without a wallet to /wallet", () => {
    mockFetch();
    renderApp("/settings");
    for (const name of ["Profile", "Mail name", "Security & backup", "Privacy", "Notifications", "Network", "Language", "Connected", "Help"])
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    expect(screen.getByText("Create or import a wallet to set up your profile.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock now" })).toBeDisabled();
  });

  it("sets a first password, then changes it (core vault)", async () => {
    const w = seedAppsWebWallet();
    nodeRoutes(w);
    renderApp("/settings");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New password"), "first-pass-1");
    await user.type(screen.getByLabelText("Confirm new password"), "first-pass-1");
    await user.click(screen.getByRole("button", { name: "Set a password" }));
    await screen.findByText("Password set — your wallet is encrypted");
    expect(screen.getByRole("button", { name: "Lock now" })).toBeEnabled();

    await user.type(screen.getByLabelText("Current password"), "first-pass-1");
    await user.type(screen.getByLabelText("New password"), "second-pass-2");
    await user.type(screen.getByLabelText("Confirm new password"), "second-pass-2");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await screen.findByText("Password changed");
  });
});
