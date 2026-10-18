/**
 * TOKEN_MINTING client UI: the create-token Mintable / Max supply fields and the creator's Mint
 * action exist only once the node reports the upgrade active (`/stats` upgrade_schedule.token_minting),
 * and they sign the exact payloads the node reads.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyTransaction, type SignedTransaction } from "@rougechain/core/pqc-signer";
import type { WalletBalance } from "@rougechain/core/pqc-wallet";
import { WalletProvider } from "./WalletProvider";
import { CreateTokenDialog, checkTokenForm, tokenFormMintOptions } from "./CreateTokenDialog";
import { TokenMintAction, checkMintAmount } from "./MintTokenDialog";
import { Toaster } from "./toast";
import { mockFetch, resetBrowserState, seedAppsWebWallet, type Handler } from "./test-utils";

const INACTIVE = { network_height: 500, upgrade_schedule: { network: "mainnet", token_minting: null } };
const SCHEDULED_LATER = { network_height: 500, upgrade_schedule: { network: "mainnet", token_minting: 900 } };
const ACTIVE = { network_height: 500, upgrade_schedule: { network: "testnet", token_minting: 400 } };
const BALANCES: WalletBalance[] = [{ symbol: "XRGE", balance: 1000, name: "XRGE", icon: "" }];

function wrap(content: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <WalletProvider autoRegister={false}>
        <MemoryRouter>
          {content}
          <Toaster />
        </MemoryRouter>
      </WalletProvider>
    </QueryClientProvider>,
  );
}

function node(stats: unknown, extra: Record<string, Handler> = {}) {
  return mockFetch({ "/stats": () => stats, ...extra });
}

const statsRead = async (calls: { url: string }[]) =>
  waitFor(() => expect(calls.some((c) => c.url.endsWith("/stats"))).toBe(true));
/** Let the stats query settle and the component re-render. */
const settle = () => new Promise((r) => setTimeout(r, 30));

function posted(calls: { url: string; init?: RequestInit }[], path: string): SignedTransaction {
  const call = calls.find((c) => c.url.endsWith(path) && c.init?.method === "POST");
  expect(call, `POST ${path}`).toBeTruthy();
  return JSON.parse(String(call!.init!.body));
}

beforeEach(() => resetBrowserState());

describe("create-token form", () => {
  for (const [label, stats] of [
    ["not scheduled", INACTIVE],
    ["scheduled for a later block", SCHEDULED_LATER],
  ] as const) {
    it(`hides Mintable / Max supply while token minting is ${label}`, async () => {
      seedAppsWebWallet();
      const { calls } = node(stats);
      wrap(<CreateTokenDialog open onClose={() => {}} balances={BALANCES} onCreated={() => {}} />);
      await statsRead(calls);
      await settle();
      expect(screen.getByRole("dialog", { name: "Create a token" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Mintable")).not.toBeInTheDocument();
      expect(screen.queryByText(/mint more later/)).not.toBeInTheDocument();
    });
  }

  it("a fixed-supply token signs no mint fields when minting is inactive", async () => {
    seedAppsWebWallet();
    const { calls } = node(INACTIVE, { "/v2/token/create": () => ({ success: true }) });
    wrap(<CreateTokenDialog open onClose={() => {}} balances={BALANCES} onCreated={() => {}} />);
    await statsRead(calls);
    await userEvent.type(screen.getByLabelText("Token name"), "Fixed");
    await userEvent.type(screen.getByLabelText("Symbol"), "FIX");
    await userEvent.type(screen.getByLabelText("Total supply"), "1000");
    await userEvent.click(screen.getByRole("button", { name: /Create token/ }));
    await waitFor(() => posted(calls, "/v2/token/create"));
    const tx = posted(calls, "/v2/token/create");
    expect("mintable" in tx.payload).toBe(false);
    expect("max_supply" in tx.payload).toBe(false);
  });

  it("shows Mintable once active and signs mintable + max_supply", async () => {
    const w = seedAppsWebWallet();
    const { calls } = node(ACTIVE, { "/v2/token/create": () => ({ success: true }) });
    wrap(<CreateTokenDialog open onClose={() => {}} balances={BALANCES} onCreated={() => {}} />);
    const box = await screen.findByLabelText("Mintable");
    expect(screen.getByText(/mint more later, up to the max supply/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Max supply (optional)")).not.toBeInTheDocument();
    await userEvent.click(box);
    await userEvent.type(screen.getByLabelText("Token name"), "Minty");
    await userEvent.type(screen.getByLabelText("Symbol"), "MNT");
    await userEvent.type(screen.getByLabelText("Total supply"), "1000");
    await userEvent.type(screen.getByLabelText("Max supply (optional)"), "999");
    await userEvent.click(screen.getByRole("button", { name: /Create token/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no lower than the total supply");
    expect(calls.some((c) => c.url.endsWith("/v2/token/create"))).toBe(false);
    await userEvent.clear(screen.getByLabelText("Max supply (optional)"));
    await userEvent.type(screen.getByLabelText("Max supply (optional)"), "5000");
    await userEvent.click(screen.getByRole("button", { name: /Create token/ }));
    await waitFor(() => posted(calls, "/v2/token/create"));
    const tx = posted(calls, "/v2/token/create");
    expect(tx.payload).toMatchObject({ type: "create_token", token_symbol: "MNT", initial_supply: 1000, mintable: true, max_supply: 5000 });
    expect(tx.public_key).toBe(w.signingPublicKey);
    expect(verifyTransaction(tx)).toBe(true);
  });

  it("validation and mint options", () => {
    const base = { name: "N", symbol: "S", supply: "100" };
    expect(checkTokenForm({ ...base, mintable: true, maxSupply: "" }, 1000)).toBeNull();
    expect(checkTokenForm({ ...base, mintable: true, maxSupply: "100" }, 1000)).toBeNull();
    expect(checkTokenForm({ ...base, mintable: true, maxSupply: "99" }, 1000)).toMatch(/no lower/);
    expect(checkTokenForm({ ...base, mintable: true, maxSupply: "1e6" }, 1000)).toMatch(/no lower/);
    expect(checkTokenForm({ ...base, mintable: true, maxSupply: "9007199254740992" }, 1000)).toMatch(/no lower/);
    // A max supply typed before unticking Mintable is ignored.
    expect(checkTokenForm({ ...base, mintable: false, maxSupply: "1" }, 1000)).toBeNull();
    expect(tokenFormMintOptions({ ...base, mintable: true, maxSupply: "500" }, true)).toEqual({ mintable: true, maxSupply: 500 });
    expect(tokenFormMintOptions({ ...base, mintable: true, maxSupply: " " }, true)).toEqual({ mintable: true });
    expect(tokenFormMintOptions({ ...base, mintable: true, maxSupply: "500" }, false)).toBeUndefined();
    expect(tokenFormMintOptions({ ...base, mintable: false, maxSupply: "500" }, true)).toBeUndefined();
  });
});

describe("Mint action", () => {
  const token = (creator: string, over: Record<string, unknown> = {}) => ({
    symbol: "MNT",
    creator,
    mintable: true,
    max_supply: 5000,
    total_minted: 250,
    initial_supply: 1000,
    ...over,
  });

  it("is shown to the creator of a mintable token once active, and signs mint_tokens", async () => {
    const w = seedAppsWebWallet();
    const { calls } = node(ACTIVE, { "/v2/token/mint": () => ({ success: true, symbol: "MNT", amount_minted: 3000 }) });
    wrap(<TokenMintAction token={token(w.signingPublicKey)} network="mainnet" />);
    await userEvent.click(await screen.findByRole("button", { name: "Mint more" }));
    const dialog = screen.getByRole("dialog", { name: "Mint MNT" });
    expect(within(dialog).getByTestId("mint-room")).toHaveTextContent("You can mint up to 3,750 more MNT (max supply 5,000).");
    expect(within(dialog).getByText(/Fee 1 XRGE/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Amount to mint"), "3751");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mint (1 XRGE)" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Only 3,750 more can be minted");
    expect(calls.some((c) => c.url.endsWith("/v2/token/mint"))).toBe(false);
    await userEvent.clear(within(dialog).getByLabelText("Amount to mint"));
    await userEvent.type(within(dialog).getByLabelText("Amount to mint"), "3000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mint (1 XRGE)" }));
    await waitFor(() => posted(calls, "/v2/token/mint"));
    const tx = posted(calls, "/v2/token/mint");
    expect(Object.keys(tx.payload).sort()).toEqual(["amount", "chainId", "fee", "from", "nonce", "timestamp", "token_symbol", "type"]);
    expect(tx.payload).toMatchObject({ type: "mint_tokens", token_symbol: "MNT", amount: 3000, fee: 1, from: w.signingPublicKey });
    expect(tx.public_key).toBe(w.signingPublicKey);
    expect(verifyTransaction(tx)).toBe(true);
    expect(await screen.findByText("Mint of 3,000 MNT submitted")).toBeInTheDocument();
  });

  it("is hidden while token minting is inactive", async () => {
    const w = seedAppsWebWallet();
    const { calls } = node(INACTIVE);
    const { container } = wrap(<TokenMintAction token={token(w.signingPublicKey)} network="mainnet" />);
    await statsRead(calls);
    await settle();
    expect(container.querySelector("[data-testid=token-mint-action]")).toBeNull();
  });

  it("is hidden for anyone but the creator, for a fixed-supply token, and on another network", async () => {
    const w = seedAppsWebWallet();
    const { calls } = node(ACTIVE);
    const cases = [
      token("cd".repeat(1952)),
      token(w.signingPublicKey, { mintable: false }),
    ];
    for (const tok of cases) {
      const { container, unmount } = wrap(<TokenMintAction token={tok} network="mainnet" />);
      await settle();
      expect(container.querySelector("[data-testid=token-mint-action]")).toBeNull();
      unmount();
    }
    const { container } = wrap(<TokenMintAction token={token(w.signingPublicKey)} network="testnet" />);
    await settle();
    expect(container.querySelector("[data-testid=token-mint-action]")).toBeNull();
    // Not eligible → the activation status is never even fetched.
    expect(calls.some((c) => c.url.endsWith("/stats"))).toBe(false);
  });

  it("is hidden with no wallet", async () => {
    const { calls } = node(ACTIVE);
    const { container } = wrap(<TokenMintAction token={token("ab".repeat(1952))} network="mainnet" />);
    await settle();
    expect(container.querySelector("[data-testid=token-mint-action]")).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("an uncapped token has no room limit; a full one disables Mint", async () => {
    const w = seedAppsWebWallet();
    node(ACTIVE);
    const { unmount } = wrap(<TokenMintAction token={token(w.signingPublicKey, { max_supply: null })} network="mainnet" />);
    await userEvent.click(await screen.findByRole("button", { name: "Mint more" }));
    expect(screen.getByTestId("mint-room")).toHaveTextContent("No max supply");
    unmount();
    wrap(<TokenMintAction token={token(w.signingPublicKey, { total_minted: 4000 })} network="mainnet" />);
    expect(await screen.findByRole("button", { name: "Mint more" })).toBeDisabled();
    expect(screen.getByText("Max supply reached. No more MNT can be minted.")).toBeInTheDocument();
  });

  it("validates amounts", () => {
    expect(checkMintAmount("10", 100)).toBeNull();
    expect(checkMintAmount("10", null)).toBeNull();
    expect(checkMintAmount("0", 100)).toMatch(/whole number/);
    expect(checkMintAmount("1.5", 100)).toMatch(/whole number/);
    expect(checkMintAmount("-3", 100)).toMatch(/whole number/);
    expect(checkMintAmount("9007199254740992", null)).toMatch(/whole number/);
    expect(checkMintAmount("101", 100)).toMatch(/Only 100 more/);
  });
});
