/**
 * Header wallet control + shared identity across shells. Replaces the POC's demo-wallet tests
 * (DemoWalletProvider / synthetic identity) now that the control drives the real wallet.
 */
import { act, render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Link, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, it, expect, vi } from "vitest";
import { pubkeyToAddress, formatAddress } from "@rougechain/core/address";
import { lockUnifiedWallet, unlockUnifiedWallet } from "@rougechain/core/unified-wallet";
import { WalletProvider } from "./WalletProvider";
import { WalletControl } from "./WalletControl";
import { WalletPreview } from "../explore/Previews";
import { AppSwitcher } from "../ecosystem/AppSwitcher";
import { MarketingHeader, AppHeader, WorkspaceHeader } from "../Shell";
import { NetworkProvider } from "../Network";
import { mockFetch, resetBrowserState, seedAppsWebWallet } from "./test-utils";

beforeEach(() => {
  resetBrowserState();
  mockFetch();
});

function wrap(content: React.ReactNode, path = "/") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <WalletProvider autoRegister={false}>
        <MemoryRouter initialEntries={[path]}>{content}</MemoryRouter>
      </WalletProvider>
    </QueryClientProvider>,
  );
}

it("global Apps exposes apps in the requested group order without resource or utility entries", async () => {
  wrap(<AppSwitcher />);
  await userEvent.click(screen.getByRole("button", { name: "Apps" }));
  const dialog = screen.getByRole("dialog", { name: "RougeChain apps" });
  const group = within(dialog).getByLabelText("Global applications");
  expect(
    within(group)
      .getAllByRole("link")
      .map((a) => a.querySelector("span")?.textContent?.replace(" ↗", "")),
  ).toEqual(["Qwalla Mobile Wallet", "Web Wallet", "Wallet Extension", "Swap", "Bridge", "Rougee", "qWave", "Messenger", "Mail", "Explorer", "Validators"]);
  expect(within(group).getByText("Arcade").parentElement).toHaveAttribute("aria-disabled", "true");
  expect(within(group).getByRole("link", { name: /Web Wallet/ })).toHaveAttribute("href", "/wallet");
});

it("offers create / import / extension while disconnected, without touching a provider or the network", async () => {
  const { fn } = mockFetch();
  wrap(<WalletControl />);
  await userEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
  const dialog = screen.getByRole("dialog", { name: "Connect to RougeChain" });
  expect(within(dialog).getByRole("button", { name: /Create a new wallet/ })).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: /Import a wallet/ })).toBeInTheDocument();
  expect(within(dialog).getByText("Browser extension · not detected")).toBeInTheDocument();
  expect(fn).not.toHaveBeenCalled();
});

it("connects the injected RougeChain extension", async () => {
  const pk = "ef".repeat(1952);
  Object.defineProperty(window, "rougechain", {
    configurable: true,
    value: { isRougeChain: true, connect: vi.fn(async () => ({ publicKey: pk, displayName: "Ext" })) },
  });
  wrap(<WalletControl />);
  await userEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
  await userEvent.click(screen.getByRole("button", { name: /RougeChain Wallet/ }));
  const address = await pubkeyToAddress(pk);
  expect(await screen.findByRole("button", { name: `Wallet ${address}` })).toBeInTheDocument();
});

it("shares the real identity across routed shells and locks globally", async () => {
  const w = seedAppsWebWallet();
  await lockUnifiedWallet("shell-pass");
  await unlockUnifiedWallet("shell-pass");
  const address = await pubkeyToAddress(w.signingPublicKey);
  function Shell() {
    const { pathname } = useLocation();
    return (
      <>
        {pathname === "/" ? <MarketingHeader /> : pathname === "/workspace" ? <WorkspaceHeader /> : <AppHeader product={pathname.startsWith("/swap") ? "Swap" : "Explorer"} />}
        <nav aria-label="Test route links">
          <Link to="/explorer">Go Explorer</Link>
          <Link to="/swap">Go Swap</Link>
          <Link to="/workspace">Go Workspace</Link>
          <Link to="/">Go Home</Link>
        </nav>
        <Routes>
          <Route path="/workspace" element={<WalletPreview />} />
          <Route path="*" element={<p>Route fixture</p>} />
        </Routes>
      </>
    );
  }
  wrap(
    <NetworkProvider>
      <Shell />
    </NetworkProvider>,
  );
  const trigger = `Wallet ${address}`;
  await screen.findByRole("button", { name: trigger });
  for (const name of ["Go Explorer", "Go Swap", "Go Workspace"]) {
    await userEvent.click(screen.getByRole("link", { name }));
    expect(screen.getByRole("button", { name: trigger })).toBeInTheDocument();
  }
  expect(screen.getAllByText(formatAddress(address)).length).toBeGreaterThan(0); // workspace preview
  expect(screen.getByRole("link", { name: "Open Wallet" })).toHaveAttribute("href", "/wallet");

  await userEvent.click(screen.getByRole("button", { name: trigger }));
  await userEvent.click(screen.getByRole("button", { name: "Lock" }));
  expect(screen.getByText("Unlock your wallet to see balances.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("link", { name: "Go Home" }));
  expect(screen.getByRole("button", { name: "Wallet locked — unlock" })).toBeInTheDocument();
});

it("unlocks from the header and exposes safe account actions, returning focus on cancel", async () => {
  const w = seedAppsWebWallet();
  await lockUnifiedWallet("hdr-pass-1");
  const address = await pubkeyToAddress(w.signingPublicKey);
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  wrap(<WalletControl />);
  await user.click(screen.getByRole("button", { name: "Wallet locked — unlock" }));
  const dialog = screen.getByRole("dialog", { name: "Unlock wallet" });
  await user.type(within(dialog).getByLabelText("Password"), "hdr-pass-1");
  await user.click(within(dialog).getByRole("button", { name: "Unlock" }));
  const trigger = await screen.findByRole("button", { name: `Wallet ${address}` });

  await user.click(trigger);
  const menu = screen.getByRole("dialog", { name: "Your wallet" });
  await user.click(within(menu).getByRole("button", { name: "Copy address" }));
  expect(copy).toHaveBeenCalledWith(address);
  expect(within(menu).getByRole("link", { name: "Open Wallet" })).toHaveAttribute("href", "/wallet");
  expect(within(menu).getByRole("link", { name: "View in Explorer" })).toHaveAttribute("href", `/address/${address}`);
  fireEvent(menu, new Event("cancel", { bubbles: true, cancelable: true }));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps working with unavailable storage (no wallet, no crash)", async () => {
  const deny = () => {
    throw Error("denied");
  };
  vi.stubGlobal("localStorage", { getItem: deny, setItem: deny, removeItem: deny, key: deny, length: 0, clear: deny });
  vi.stubGlobal("sessionStorage", { getItem: deny, setItem: deny, removeItem: deny, key: deny, length: 0, clear: deny });
  wrap(<WalletControl />);
  expect(screen.getByRole("button", { name: "Connect Wallet" })).toBeInTheDocument();
});

// The extension injects window.rougechain a moment after the page starts and then fires
// `rougechain#initialized`; a fast page renders first. Detection must catch up.
function injectExtensionLater(connect = vi.fn(async () => ({ publicKey: "ab".repeat(1952), displayName: "Ext" }))) {
  act(() => {
    Object.defineProperty(window, "rougechain", { configurable: true, value: { isRougeChain: true, connect } });
    window.dispatchEvent(new Event("rougechain#initialized"));
  });
  return connect;
}

it("detects an extension that loads after the page has rendered", async () => {
  delete (window as { rougechain?: unknown }).rougechain;
  wrap(<WalletControl />);
  await userEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
  const dialog = screen.getByRole("dialog", { name: "Connect to RougeChain" });
  expect(within(dialog).getByText("Browser extension · not detected")).toBeInTheDocument();
  injectExtensionLater();
  expect(await within(dialog).findByText("Extension detected")).toBeInTheDocument();
  delete (window as { rougechain?: unknown }).rougechain;
});

it("never prompts the extension on page load — it connects only when the user clicks Connect", async () => {
  delete (window as { rougechain?: unknown }).rougechain;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <WalletProvider autoRegister>
        <MemoryRouter>
          <WalletControl />
        </MemoryRouter>
      </WalletProvider>
    </QueryClientProvider>,
  );
  const connect = injectExtensionLater();
  // Loaded, extension present, no local wallet: no approval prompt is opened.
  await new Promise((r) => setTimeout(r, 50));
  expect(connect).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Connect Wallet" })).toBeInTheDocument();
  // The user chooses the extension: now (and only now) it connects.
  await userEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
  await userEvent.click(screen.getByRole("button", { name: /RougeChain Wallet/ }));
  const address = await pubkeyToAddress("ab".repeat(1952));
  expect(await screen.findByRole("button", { name: `Wallet ${address}` })).toBeInTheDocument();
  expect(connect).toHaveBeenCalledTimes(1);
  delete (window as { rougechain?: unknown }).rougechain;
});
