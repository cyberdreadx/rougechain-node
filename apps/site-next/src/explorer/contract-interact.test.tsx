import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkId } from "@rougechain/chain-readonly";
import { ChainProvider } from "./chain";
import { KNOWN_CONTRACTS } from "../contracts/known";
import "../i18n";

const core = vi.hoisted(() => ({
  queryContract: vi.fn(),
  executeContract: vi.fn(),
  waitForTxReceipt: vi.fn(),
}));
vi.mock("@rougechain/core/contracts", async (orig) => ({
  ...(await orig<typeof import("@rougechain/core/contracts")>()),
  ...core,
}));

const walletState = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../wallet/WalletProvider", () => ({
  useOptionalWallet: () => walletState.current,
}));
vi.mock("../wallet/hooks", () => ({
  useRougeAddress: (pk: string | null) => ({ full: pk ? "rouge1me" : null, display: "" }),
}));

import { ContractInteract } from "./ContractInteract";

const ADDR = "c05cd63141da72a84f905065dd02acb3a55df991";
const MARKET = KNOWN_CONTRACTS.find((c) => c.id === "nft_marketplace")!.codeHash;
const UNKNOWN = "ac7c0b7a6d31346519ae9be142aabf6e19126d4af6ca491313f65f0694725e6d";
const PK = "ab".repeat(1952);

function unlocked(network: NetworkId = "mainnet") {
  return { status: "unlocked", publicKey: PK, needsPassword: false, network };
}

function renderPanel(codeHash: string, network: NetworkId = "mainnet") {
  try {
    window.localStorage.setItem("rougechain-network", network);
  } catch {
    /* ignore */
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChainProvider network={network}>
        <MemoryRouter>
          <ContractInteract addr={ADDR} codeHash={codeHash} />
        </MemoryRouter>
      </ChainProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  walletState.current = null;
  core.queryContract.mockReset();
  core.executeContract.mockReset();
  core.waitForTxReceipt.mockReset();
});
afterEach(() => window.localStorage.clear());

describe("contract Read / Write", () => {
  it("lists a recognised contract's read functions and queries for free", async () => {
    core.queryContract.mockResolvedValue({ success: true, returnData: { next: 3 }, gasUsed: 1200, events: [] });
    renderPanel(MARKET);
    expect(screen.getByText("Recognised")).toBeInTheDocument();
    expect(screen.getByText("NFT marketplace")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "listing_count" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "listing" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "buy" })).not.toBeInTheDocument();

    const [first] = screen.getAllByRole("button", { name: "Query" });
    await userEvent.click(first);
    expect(core.queryContract).toHaveBeenCalledWith(ADDR, "listing_count", {}, undefined);
    expect(await screen.findByText(/"next": 3/)).toBeInTheDocument();
    expect(core.executeContract).not.toHaveBeenCalled();
  });

  it("explains that writing needs a wallet where there is none", async () => {
    renderPanel(MARKET);
    await userEvent.click(screen.getByRole("tab", { name: "Write" }));
    expect(screen.getByRole("heading", { name: "buy" })).toBeInTheDocument();
    expect(screen.getByText(/Never send an NFT here without listing it first/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open this contract on the RougeChain site/ })).toHaveAttribute(
      "href",
      `https://rougechain.io/contract/${ADDR}`,
    );
    for (const b of screen.getAllByRole("button", { name: "Check call" })) expect(b).toBeDisabled();
  });

  it("asks a locked wallet to unlock", async () => {
    walletState.current = { ...unlocked(), status: "locked" };
    renderPanel(MARKET);
    await userEvent.click(screen.getByRole("tab", { name: "Write" }));
    expect(screen.getByText(/Unlock your wallet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to wallet" })).toHaveAttribute("href", "/wallet");
  });

  it("checks, shows the cost, and only signs after confirmation", async () => {
    walletState.current = unlocked();
    core.queryContract.mockResolvedValue({ success: true, returnData: null, gasUsed: 20_000, events: [{ topic: "sold", data: "{}" }] });
    core.executeContract.mockResolvedValue({ success: true, txId: "f".repeat(64) });
    core.waitForTxReceipt.mockResolvedValue({ tx_hash: "f".repeat(64), block_height: 263, status: "Success" });
    renderPanel(MARKET);
    await userEvent.click(screen.getByRole("tab", { name: "Write" }));

    const buy = screen.getByRole("heading", { name: "buy" }).closest("form")!;
    const checks = screen.getAllByRole("button", { name: "Check call" });
    const buyCheck = checks.find((b) => buy.contains(b))!;
    await userEvent.click(buyCheck);

    // Dry run as the wallet, with the payment converted exactly to quanta.
    expect(core.queryContract).toHaveBeenCalledWith(ADDR, "buy", { listing: 1 }, PK, { symbol: "XRGE", amount: 2_000_000_000 });
    expect(core.executeContract).not.toHaveBeenCalled();
    // gas 20,000 → limit 31,000 → 0.031 XRGE gas + 2 XRGE payment
    expect(await screen.findByText("2.031 XRGE")).toBeInTheDocument();
    expect(screen.getByText(/real transaction on Mainnet/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sign and send" }));
    expect(core.executeContract).toHaveBeenCalledWith(ADDR, "buy", { listing: 1 }, 31_000, { symbol: "XRGE", amount: 2_000_000_000 });
    expect(await screen.findByText(/Included in block #263/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /ffffffffff/ })).toHaveAttribute("href", `/tx/${"f".repeat(64)}`);
  });

  it("never signs a call whose dry run fails", async () => {
    walletState.current = unlocked();
    core.queryContract.mockResolvedValue({ success: false, gasUsed: 900, events: [], error: "not the seller" });
    renderPanel(MARKET);
    await userEvent.click(screen.getByRole("tab", { name: "Write" }));
    const cancel = screen.getByRole("heading", { name: "cancel" }).closest("form")!;
    await userEvent.click(screen.getAllByRole("button", { name: "Check call" }).find((b) => cancel.contains(b))!);
    expect(await screen.findByText("Not sent: this call would fail.")).toBeInTheDocument();
    expect(screen.getByText("not the seller")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign and send" })).not.toBeInTheDocument();
    expect(core.executeContract).not.toHaveBeenCalled();
  });

  it("offers a free-form call for unknown code and validates input before any request", async () => {
    walletState.current = unlocked("testnet");
    renderPanel(UNKNOWN, "testnet");
    expect(screen.getByText(/doesn't match a known template/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Write" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Method" }), "drop table");
    await userEvent.click(screen.getByRole("button", { name: "Check call" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/letters, digits and underscores/);
    expect(core.queryContract).not.toHaveBeenCalled();

    const method = screen.getByRole("textbox", { name: "Method" });
    await userEvent.clear(method);
    await userEvent.type(method, "roll");
    const args = screen.getByRole("textbox", { name: "Arguments (JSON)" });
    await userEvent.clear(args);
    await userEvent.type(args, "{{not json");
    await userEvent.click(screen.getByRole("button", { name: "Check call" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/valid JSON/);
    expect(core.queryContract).not.toHaveBeenCalled();
  });

  it("refuses to run when the wallet is on another network", async () => {
    walletState.current = unlocked("testnet");
    renderPanel(MARKET, "mainnet");
    await userEvent.click(screen.getByRole("tab", { name: "Write" }));
    expect(screen.getByText(/different network than this explorer/)).toBeInTheDocument();
    await waitFor(() => {
      for (const b of screen.getAllByRole("button", { name: "Check call" })) expect(b).toBeDisabled();
    });
  });
});
