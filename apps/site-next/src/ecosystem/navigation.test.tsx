import { WalletProvider } from "../wallet/WalletProvider";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, it, expect } from "vitest";
import { NetworkProvider } from "../Network";
import { AppHeader, MarketingHeader, WorkspaceHeader } from "../Shell";
import WorkspacePage from "../WorkspacePage";
import CompactWorkspace from "../explore/CompactWorkspace";
import { explorerRoutes } from "../explorer/routes";
import Pools from "../pages/Pools";
function wrap(child: React.ReactNode, path = "/") {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Error("offline")));
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <WalletProvider autoRegister={false}>
        <NetworkProvider>
          <MemoryRouter initialEntries={[path]}>{child}</MemoryRouter>
        </NetworkProvider>
      </WalletProvider>
    </QueryClientProvider>,
  );
}
it.each(["marketing", "Explorer", "Swap", "Workspace"])(
  "opens global navigation and restores focus on %s",
  async (product) => {
    wrap(
      product === "marketing" ? (
        <MarketingHeader />
      ) : product === "Workspace" ? (
        <WorkspaceHeader />
      ) : (
        <AppHeader product={product} />
      ),
    );
    const trigger = screen.getByRole("button", { name: "Apps" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "RougeChain apps" });
    expect(
      within(dialog).getByRole("link", { name: /Web Wallet/ }),
    ).toHaveAttribute("href", "/wallet");
    expect(
      within(dialog).getByRole("link", { name: /Qwalla/ }),
    ).toHaveAttribute("href", "https://qwalla.io");
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);
it("shares local route and proposed-host state through the shell", () => {
  wrap(<AppHeader product="Explorer" />, "/explorer/blocks");
  expect(screen.getByRole("link", { name: "Blocks" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.queryByText(/PROPOSED/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Connect Wallet" })).toBeEnabled();
});
it("opens a preview from a reloadable query parameter", async () => {
  wrap(
    <Routes>
      <Route path="/workspace" element={<WorkspacePage />} />
    </Routes>,
    "/workspace?open=mail",
  );
  expect(screen.getByRole("tab", { name: "Mail" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByText("No mail account connected.")).toBeInTheDocument();
});
it("preserves compact preview state across hide and singleton restore", async () => {
  wrap(<CompactWorkspace />);
  await userEvent.click(screen.getByRole("button", { name: "Open Mail" }));
  await userEvent.click(screen.getByRole("button", { name: "Sent" }));
  await userEvent.click(screen.getByRole("button", { name: "Hide Mail" }));
  expect(screen.queryByText("Sent is empty")).not.toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open Mail" }));
  await userEvent.click(screen.getByRole("button", { name: "Open Mail" }));
  expect(screen.getByText("Sent is empty")).toBeVisible();
  expect(screen.getAllByRole("tab", { name: "Mail" })).toHaveLength(1);
  await userEvent.click(
    screen.getByRole("button", { name: "Reset workspace" }),
  );
  expect(screen.queryByRole("tab", { name: "Mail" })).not.toBeInTheDocument();
});
it("opens captured block data locally in compact mode", async () => {
  wrap(<CompactWorkspace requested="Explorer" />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /#200/ })).toBeInTheDocument(),
  );
  await userEvent.click(screen.getByRole("button", { name: /#200/ }));
  expect(
    screen.getByRole("heading", { name: "Block #200" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/No detail endpoint requested/)).toBeInTheDocument();
});
it.each(["blocks", "transactions", "tokens", "nfts", "contracts"])(
  "renders explorer %s with scoped content",
  async (section) => {
    wrap(<Routes>{explorerRoutes}</Routes>, `/explorer/${section}`);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      new RegExp(section, "i"),
    );
    expect(
      screen.queryByLabelText("Filter recent blocks by height or hash"),
    ).not.toBeInTheDocument();
  },
);
it.each(["pools", "positions"] as const)(
  "renders swap %s with no write enabled without a wallet",
  async (section) => {
    wrap(<Pools view={section} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      section === "pools" ? "Liquidity pools" : "Your positions",
    );
    expect(screen.getByRole("button", { name: "New pool" })).toBeDisabled();
    // Offline node: an honest error, never synthetic pools.
    await screen.findByText("Couldn't load pools from the node.");
  },
);

it("supports keyboard navigation in the compact workspace", async () => {
  wrap(<CompactWorkspace />);
  screen.getByRole("tab", { name: "Network" }).focus();
  await userEvent.keyboard("{End}");
  expect(screen.getByRole("tab", { name: "Ecosystem" })).toHaveFocus();
  await userEvent.keyboard("{Home}");
  expect(screen.getByRole("tab", { name: "Network" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
