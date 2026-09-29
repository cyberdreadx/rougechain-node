import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainProvider } from "./chain";
import { NetworkProvider } from "../Network";
import { explorerRoutes, isExplorerPath } from "./routes";
import stats from "../../../../packages/chain-readonly/fixtures/mainnet-stats.json";
import tokens from "../../../../packages/chain-readonly/fixtures/mainnet-tokens.json";
import config from "../../../../packages/chain-readonly/fixtures/mainnet-bridge-config.json";
import evmList from "../../../../packages/chain-readonly/fixtures/mainnet-bridge-withdrawals.json";
import btcList from "../../../../packages/chain-readonly/fixtures/mainnet-bridge-btc-withdrawals.json";
import xrgeList from "../../../../packages/chain-readonly/fixtures/mainnet-bridge-xrge-withdrawals.json";
import bridgeTxs from "../../../../packages/chain-readonly/fixtures/mainnet-txs-bridge.json";
import bridgeTx from "../../../../packages/chain-readonly/fixtures/mainnet-tx-bridge-withdraw.json";
import nodePage from "../../../../packages/chain-readonly/fixtures/node-bridge-activity.json";
import nodeItem from "../../../../packages/chain-readonly/fixtures/node-bridge-activity-item.json";

const QBTC =
  "d7df36b845ad0d147af6d717c2a8860026bbdb442c5375990a32e0efe6eb4c2c";
const PAYOUT =
  "91d306fcedfc15ce8cb8f1c547c5c2d403a20d138a74cc66fbb4a5e104259b84";
const ORIGIN = "https://api.rougechain.io/api";

/** Live-node responses without /bridge/activity (today's mainnet), plus overrides. */
function mockNode(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    "/stats": stats,
    "/tokens": tokens,
    "/bridge/config": config,
    "/bridge/withdrawals": evmList,
    "/bridge/btc/withdrawals": btcList,
    "/bridge/xrge/withdrawals": xrgeList,
    "/txs?limit=200&offset=0": bridgeTxs,
    [`/tx/${QBTC}`]: bridgeTx,
    ...overrides,
  };
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(url.startsWith(ORIGIN)).toBe(true);
    const body = responses[url.slice(ORIGIN.length)];
    if (body === undefined)
      return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const withNodeFeed = {
  "/bridge/activity?limit=25": nodePage,
  [`/bridge/activity/${QBTC}`]: nodeItem,
};

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ChainProvider network="mainnet">
        <NetworkProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              {explorerRoutes}
              <Route path="*" element={<p>Elsewhere</p>} />
            </Routes>
            <Where />
          </MemoryRouter>
        </NetworkProvider>
      </ChainProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("bridge routes on the main site", () => {
  it("serves /explorer/bridge and /bridge-activity, never /bridge", async () => {
    expect(isExplorerPath("/explorer/bridge")).toBe(true);
    expect(isExplorerPath(`/explorer/bridge/${QBTC}`)).toBe(true);
    expect(isExplorerPath("/bridge-activity")).toBe(true);
    expect(isExplorerPath("/bridge")).toBe(false);
    mockNode();
    renderAt("/bridge");
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument();
  });

  it("/bridge-activity is an alias of /explorer/bridge", async () => {
    mockNode();
    renderAt("/bridge-activity");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Bridge activity" }),
    ).toBeInTheDocument();
  });
});

describe("bridge activity page — node without /bridge/activity (fallback)", () => {
  it("rebuilds the list from on-chain bridge txs and says so", async () => {
    mockNode();
    renderAt("/explorer/bridge");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    expect(screen.getByText("Reduced detail.")).toBeInTheDocument();
    expect(screen.getByText(/8 transactions scanned/)).toBeInTheDocument();
    // newest first: the real qBTC withdrawal, still in the node's pending-payout list
    const first = within(rows[0]);
    expect(first.getByText("RougeChain → Bitcoin")).toHaveAttribute(
      "href",
      `/explorer/bridge/${QBTC}`,
    );
    expect(first.getByText("0.00005")).toBeInTheDocument();
    expect(first.getByText("Pending")).toBeInTheDocument();
    expect(
      first.getByText("External tx link available after node update"),
    ).toBeInTheDocument();
    expect(first.getByRole("link", { name: /bc1qvt4r/ })).toHaveAttribute(
      "href",
      "https://mempool.space/address/bc1qvt4r5dazmystwspgp62vh9ve5tutw5av4atjcz",
    );
    expect(first.getByRole("link", { name: /d7df36b845/ })).toHaveAttribute(
      "href",
      `/tx/${QBTC}`,
    );
    // everything else has left the queue → Completed; deposits never carry a source hash
    expect(screen.getAllByText("Completed")).toHaveLength(6);
    expect(
      screen.getAllByText("Source transaction not recorded by the node").length,
    ).toBe(3);
    // no external tx link is ever invented
    for (const a of screen.getAllByRole("link"))
      expect(a.getAttribute("href") ?? "").not.toMatch(
        /mempool\.space\/tx|basescan\.org\/tx/,
      );
  });

  it("shows Unknown when the pending lists cannot be read", async () => {
    mockNode({ "/bridge/btc/withdrawals": undefined });
    renderAt("/explorer/bridge");
    await screen.findByRole("table");
    expect(screen.getAllByText("Unknown").length).toBe(4); // the four withdrawals
    expect(screen.getByText(/withdrawal status is Unknown/)).toBeInTheDocument();
  });
});

describe("bridge activity page — node with /bridge/activity", () => {
  it("shows statuses and links on both chains", async () => {
    mockNode(withNodeFeed);
    renderAt("/explorer/bridge");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(8);
    expect(screen.queryByText("Reduced detail.")).not.toBeInTheDocument();
    expect(within(rows[0]).getByText("In mempool")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Pending")).toBeInTheDocument();
    const paid = within(rows[1]);
    expect(paid.getByText("Paid")).toBeInTheDocument();
    expect(paid.getByRole("link", { name: `View ${PAYOUT} on mempool.space` })).toHaveAttribute(
      "href",
      `https://mempool.space/tx/${PAYOUT}`,
    );
    expect(within(rows[2]).getByText("Queued")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Not paid out yet")).toBeInTheDocument();
    expect(within(rows[2]).getByRole("link", { name: /0x1cf7f9/ })).toHaveAttribute(
      "href",
      "https://basescan.org/address/0x1cf7f96f871de10f325dd0b80bbc75c1e9734c2e",
    );
    expect(within(rows[3]).getByText("Minted")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Base → RougeChain")).toBeInTheDocument();
    expect(within(rows[4]).getByText("Refunded")).toBeInTheDocument();
    expect(within(rows[5]).getByText("Failed")).toBeInTheDocument();
    // qUSDC 500000 raw at 6 decimals
    expect(within(rows[4]).getByText("0.5")).toBeInTheDocument();
  });

  it("pages with the node's cursor", async () => {
    const fetchMock = mockNode({
      ...withNodeFeed,
      "/bridge/activity?limit=25&before=41-0": { items: [], nextCursor: null, limit: 25 },
    });
    renderAt("/explorer/bridge");
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: /Older/ }));
    expect(await screen.findByText("No bridge transfers")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/explorer/bridge?before=41-0");
    expect(fetchMock.mock.calls.some(([u]) => u.endsWith("before=41-0"))).toBe(true);
  });
});

describe("bridge transfer detail and the tx page panel", () => {
  it("shows both sides of the real qBTC withdrawal", async () => {
    mockNode(withNodeFeed);
    renderAt(`/explorer/bridge/${QBTC}`);
    expect(
      await screen.findByRole("link", { name: `View ${PAYOUT} on mempool.space` }),
    ).toHaveAttribute("href", `https://mempool.space/tx/${PAYOUT}`);
    expect(screen.getByText(PAYOUT)).toBeInTheDocument();
    expect(screen.getByText(/Bitcoin · chain id bitcoin · mempool\.space/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#202" })).toHaveAttribute("href", "/block/202");
  });

  it("falls back to the tx + pending lists before the node update", async () => {
    mockNode();
    renderAt(`/explorer/bridge/${QBTC}`);
    expect(await screen.findByText("Reduced detail.")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(
      screen.getByText("External tx link available after node update"),
    ).toBeInTheDocument();
  });

  it("refuses ids that are not a tx hash", async () => {
    mockNode();
    renderAt("/explorer/bridge/not-a-hash");
    expect(await screen.findByText("Not a transaction id")).toBeInTheDocument();
  });

  it("adds a Bridge transfer panel to bridge transactions", async () => {
    mockNode(withNodeFeed);
    renderAt(`/tx/${QBTC}`);
    expect(
      await screen.findByRole("heading", { name: "Bridge transfer" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: `View ${PAYOUT} on mempool.space` }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bridge details" })).toHaveAttribute(
      "href",
      `/explorer/bridge/${QBTC}`,
    );
  });
});

describe("bridge activity on explorer.rougechain.io (VITE_APP_MODE=explorer)", () => {
  afterEach(() => window.history.pushState({}, "", "/"));

  it("serves /bridge and /explorer/bridge, with Bridge in the local nav", async () => {
    const { default: ExplorerSite, activeExplorerItem } = await import("../ExplorerSite");
    const { appById } = await import("../ecosystem/apps");
    const items = appById("explorer")!.localNavigation ?? [];
    expect(activeExplorerItem("/bridge", items)).toBe("/explorer/bridge");
    expect(activeExplorerItem("/explorer/bridge", items)).toBe("/explorer/bridge");
    expect(activeExplorerItem(`/explorer/bridge/${QBTC}`, items)).toBe("/explorer/bridge");
    expect(activeExplorerItem("/bridge-activity", items)).toBe("/explorer/bridge");
    expect(activeExplorerItem("/explorer", items)).toBe("/explorer");

    for (const path of ["/bridge", "/explorer/bridge", "/bridge-activity"]) {
      mockNode();
      window.history.pushState({}, "", path);
      const view = render(<ExplorerSite />);
      expect(
        await screen.findByRole("heading", { level: 1, name: "Bridge activity" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Bridge" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      view.unmount();
      vi.unstubAllGlobals();
    }
  });
});
