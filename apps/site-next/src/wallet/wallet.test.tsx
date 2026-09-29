import {
  render,
  screen,
  within,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  Link,
  Routes,
  Route,
  useLocation,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, it, expect, vi } from "vitest";
import {
  DemoWalletProvider,
  DEMO_WALLET_KEY,
  DEMO_ADDRESS,
  DEMO_SHORT_ADDRESS,
} from "./DemoWalletProvider";
import { WalletControl } from "./WalletControl";
import { WalletPreview } from "../explore/Previews";
import { AppSwitcher } from "../ecosystem/AppSwitcher";
import { MarketingHeader, AppHeader, WorkspaceHeader } from "../Shell";
import { NetworkProvider } from "../Network";
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  });
});
function wrap(content: React.ReactNode) {
  return render(
    <MemoryRouter>
      <DemoWalletProvider>{content}</DemoWalletProvider>
    </MemoryRouter>,
  );
}
async function connect(source = "RougeChain Wallet") {
  await userEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
  await userEvent.click(
    screen.getByRole("button", { name: `Preview connection with ${source}` }),
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
  ).toEqual([
    "Qwalla Mobile Wallet",
    "Web Wallet",
    "Wallet Extension",
    "Swap",
    "Bridge",
    "Rougee",
    "qWave",
    "Messenger",
    "Mail",
    "Explorer",
    "Validators",
  ]);
  expect(within(group).getByText("Arcade").parentElement).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(
    within(group).queryByRole("link", { name: /Arcade/ }),
  ).not.toBeInTheDocument();
  for (const text of [
    "Build",
    "Community",
    "Developer Portal",
    "Documentation",
    "SDK",
    "MCP / Agents",
    "Run a Node",
    "Regenerate",
    "RougeChain Community",
    "Liquidity",
    "Network Status",
  ])
    expect(
      within(dialog).queryByText(text, { exact: true }),
    ).not.toBeInTheDocument();
});
it.each(["RougeChain Wallet", "Qwalla"])(
  "previews %s without fetching or accessing wallet providers",
  async (source) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const providerAccess = vi.fn(() => {
      throw Error("Provider access forbidden");
    });
    Object.defineProperty(window, "rougechain", {
      configurable: true,
      get: providerAccess,
    });
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      get: providerAccess,
    });
    try {
      wrap(<WalletControl />);
      await connect(source);
      expect(
        screen.getByRole("button", {
          name: `Demo connected account ${DEMO_SHORT_ADDRESS}`,
        }),
      ).toBeInTheDocument();
      expect(
        JSON.parse(window.sessionStorage.getItem(DEMO_WALLET_KEY)!),
      ).toEqual({
        connected: true,
        address: DEMO_ADDRESS,
        source: source === "Qwalla" ? "qwalla" : "extension",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(providerAccess).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, "rougechain");
      Reflect.deleteProperty(window, "ethereum");
    }
  },
);
it("shares identity across routed product shells and clears it globally on disconnect", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Error("offline")));
  function Shell() {
    const { pathname } = useLocation();
    return (
      <>
        {pathname === "/" ? (
          <MarketingHeader />
        ) : pathname === "/workspace" ? (
          <WorkspaceHeader />
        ) : (
          <AppHeader
            product={pathname.startsWith("/swap") ? "Swap" : "Explorer"}
          />
        )}
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
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <NetworkProvider>
        <Shell />
      </NetworkProvider>
    </QueryClientProvider>,
  );
  await connect();
  for (const name of ["Go Explorer", "Go Swap", "Go Workspace"]) {
    await userEvent.click(screen.getByRole("link", { name }));
    expect(
      screen.getByRole("button", {
        name: `Demo connected account ${DEMO_SHORT_ADDRESS}`,
      }),
    ).toBeInTheDocument();
  }
  expect(
    screen.getByText("Demo connected · synthetic identity"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Receive" })).toBeDisabled();
  expect(screen.getAllByText("—")).toHaveLength(3);
  await userEvent.click(
    screen.getByRole("button", {
      name: `Demo connected account ${DEMO_SHORT_ADDRESS}`,
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(screen.getByText("No wallet connected.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("link", { name: "Go Home" }));
  expect(
    screen.getByRole("button", { name: "Connect Wallet" }),
  ).toBeInTheDocument();
  expect(window.sessionStorage.getItem(DEMO_WALLET_KEY)).toBeNull();
});
it("restores only canonical demo state after a provider remount", async () => {
  const first = wrap(<WalletControl />);
  await connect("Qwalla");
  first.unmount();
  wrap(<WalletControl />);
  await userEvent.click(
    screen.getByRole("button", {
      name: `Demo connected account ${DEMO_SHORT_ADDRESS}`,
    }),
  );
  expect(screen.getByText("Mainnet · Qwalla")).toBeInTheDocument();
});
it("ignores unexpected persisted addresses and sources", () => {
  window.sessionStorage.setItem(
    DEMO_WALLET_KEY,
    JSON.stringify({
      connected: true,
      address: "unexpected",
      source: "extension",
    }),
  );
  wrap(<WalletControl />);
  expect(
    screen.getByRole("button", { name: "Connect Wallet" }),
  ).toBeInTheDocument();
});
it("works with unavailable session storage", async () => {
  vi.stubGlobal("sessionStorage", {
    getItem: () => {
      throw Error("denied");
    },
    setItem: () => {
      throw Error("denied");
    },
    removeItem: () => {
      throw Error("denied");
    },
  });
  wrap(<WalletControl />);
  await connect();
  expect(
    screen.getByRole("button", {
      name: `Demo connected account ${DEMO_SHORT_ADDRESS}`,
    }),
  ).toBeInTheDocument();
});
it("provides safe account actions and returns focus on cancel", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  wrap(<WalletControl />);
  await connect();
  const trigger = screen.getByRole("button", {
    name: `Demo connected account ${DEMO_SHORT_ADDRESS}`,
  });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Copy address" }));
  expect(copy).toHaveBeenCalledWith(DEMO_ADDRESS);
  expect(screen.getByRole("link", { name: "Open Wallet" })).toHaveAttribute(
    "href",
    "/workspace?open=wallet",
  );
  await user.click(screen.getByRole("button", { name: "View in Explorer" }));
  expect(
    screen.getByText(/Explorer address view not implemented/),
  ).toBeInTheDocument();
  fireEvent(
    screen.getByRole("dialog", { name: "Demo account" }),
    new Event("cancel", { bubbles: true, cancelable: true }),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Demo account" })).toHaveAttribute(
    "open",
  );
});
