import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, it, expect, describe, afterEach } from "vitest";
import { deriveReadState, type NetworkId } from "@rougechain/chain-readonly";
import { ChainProvider } from "./chain";
import { NetworkProvider } from "../Network";
import { explorerRoutes, isExplorerPath } from "./routes";
import { ExplorerSlotsProvider, type ExplorerTokenActionProps } from "./slots";
import { resolveSearch } from "./search";
import i18n from "../i18n";
import stats from "../../../../packages/chain-readonly/fixtures/mainnet-stats.json";
import testnetStats from "../../../../packages/chain-readonly/fixtures/testnet-stats.json";
import blocksPage from "../../../../packages/chain-readonly/fixtures/mainnet-blocks-page.json";
import block200 from "../../../../packages/chain-readonly/fixtures/mainnet-block-200.json";
import txs from "../../../../packages/chain-readonly/fixtures/mainnet-txs.json";
import txSwap from "../../../../packages/chain-readonly/fixtures/mainnet-tx-swap.json";
import resolve from "../../../../packages/chain-readonly/fixtures/mainnet-resolve.json";
import balance from "../../../../packages/chain-readonly/fixtures/mainnet-balance.json";
import addressTxs from "../../../../packages/chain-readonly/fixtures/mainnet-address-txs.json";
import ownerNfts from "../../../../packages/chain-readonly/fixtures/mainnet-nft-owner.json";
import tokens from "../../../../packages/chain-readonly/fixtures/mainnet-tokens.json";
import tokenMeta from "../../../../packages/chain-readonly/fixtures/mainnet-token-metadata.json";
import holders from "../../../../packages/chain-readonly/fixtures/mainnet-token-holders.json";
import tokenTxs from "../../../../packages/chain-readonly/fixtures/mainnet-token-txs.json";
import pools from "../../../../packages/chain-readonly/fixtures/mainnet-pools.json";
import collections from "../../../../packages/chain-readonly/fixtures/mainnet-nft-collections.json";
import collection from "../../../../packages/chain-readonly/fixtures/mainnet-nft-collection.json";
import collectionTokens from "../../../../packages/chain-readonly/fixtures/mainnet-nft-collection-tokens.json";
import contracts from "../../../../packages/chain-readonly/fixtures/mainnet-contracts.json";
import contract from "../../../../packages/chain-readonly/fixtures/mainnet-contract.json";
import contractState from "../../../../packages/chain-readonly/fixtures/mainnet-contract-state.json";
import contractEvents from "../../../../packages/chain-readonly/fixtures/mainnet-contract-events.json";

const CONTRACT = "51816c121ddbb113049795bd396dd5349ede60a6";
const COLLECTION = "col:df255dbddd5a257e:QTEKNFT";
const ADDRESS = resolve.address;
const SWAP = txSwap.txId;
const BLOCK_HASH = txSwap.blockHash;

/** Node routes → recorded responses. Any other URL is a 404, as on the real node. */
function nodeResponses(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    "/stats": stats,
    "/validators": { success: true, validators: [{}, {}, {}] },
    "/blocks?limit=8": blocksPage,
    "/blocks?page=1&per_page=20": blocksPage,
    "/block/200": block200,
    "/txs?limit=8&offset=0": txs,
    "/txs?limit=25&offset=0": txs,
    [`/tx/${SWAP}`]: txSwap,
    [`/tx/${BLOCK_HASH}`]: txSwap,
    [`/resolve/${ADDRESS}`]: resolve,
    [`/balance/${ADDRESS}`]: balance,
    [`/address/${ADDRESS}/transactions?limit=25&offset=0`]: addressTxs,
    [`/nft/owner/${resolve.publicKey}`]: ownerNfts,
    "/tokens": tokens,
    "/token/QTEK/metadata": tokenMeta,
    "/token/QTEK/holders": holders,
    "/token/QTEK/transactions?limit=50": tokenTxs,
    "/pools": pools,
    "/nft/collections": collections,
    [`/nft/collection/${encodeURIComponent(COLLECTION)}`]: collection,
    [`/nft/collection/${encodeURIComponent(COLLECTION)}/tokens?limit=24&offset=0`]:
      collectionTokens,
    "/contracts": contracts,
    [`/contract/${CONTRACT}`]: contract,
    [`/contract/${CONTRACT}/state`]: contractState,
    [`/contract/${CONTRACT}/events?limit=25`]: contractEvents,
    ...overrides,
  };
}

function mockNode(
  overrides: Record<string, unknown> = {},
  origin = "https://api.rougechain.io/api",
) {
  const responses = nodeResponses(overrides);
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(url.startsWith(origin)).toBe(true);
    const body = responses[url.slice(origin.length)];
    if (body instanceof Error) throw body;
    if (body === undefined)
      return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}

function renderAt(path: string, network: NetworkId = "mainnet") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ChainProvider network={network}>
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

describe("search routing", () => {
  it.each([
    ["200", "/block/200"],
    ["#1,024", "/block/1024"],
    [SWAP, `/tx/${SWAP}`],
    [`0x${SWAP.toUpperCase()}`, `/tx/${SWAP}`],
    [ADDRESS, `/address/${ADDRESS}`],
    [resolve.publicKey, `/address/${resolve.publicKey}`],
    [CONTRACT, `/contract/${CONTRACT}`],
    [COLLECTION, `/nfts/${encodeURIComponent(COLLECTION)}`],
    ["qbtc", "/token/qBTC"],
    ["$QTEK", "/token/QTEK"],
  ])("%s → %s", (input, path) => {
    expect(resolveSearch(input, ["XRGE", "qBTC", "QTEK"])?.path).toBe(path);
  });
  it.each(["", "   ", "rouge1notanaddress!", "hello world", "<script>", "-1"])(
    "rejects %j",
    (input) => {
      expect(resolveSearch(input)).toBeNull();
    },
  );
  it("submits from the search box to the right page", async () => {
    mockNode();
    renderAt("/explorer");
    await userEvent.type(
      screen.getByLabelText(/Search by block height/),
      `${CONTRACT}{Enter}`,
    );
    expect(screen.getByTestId("where")).toHaveTextContent(
      `/contract/${CONTRACT}`,
    );
  });
  it("explains a search that matches nothing", async () => {
    mockNode();
    renderAt("/explorer");
    await userEvent.type(
      screen.getByLabelText(/Search by block height/),
      "not a thing{Enter}",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing matches");
    expect(screen.getByTestId("where")).toHaveTextContent("/explorer");
  });
});

describe("explorer pages", () => {
  it("overview shows live figures, blocks and transactions", async () => {
    mockNode();
    renderAt("/blockchain");
    expect(
      screen.getByRole("heading", { level: 1, name: "Explorer" }),
    ).toBeInTheDocument();
    await screen.findAllByText("Live API data");
    const blocks = screen.getByRole("region", { name: "Latest blocks" });
    expect(within(blocks).getByRole("link", { name: /^200$/ })).toHaveAttribute(
      "href",
      "/block/200",
    );
    const latest = screen.getByRole("region", { name: "Latest transactions" });
    expect(await within(latest).findByText("Transfer")).toBeInTheDocument();
    expect(within(latest).getByText("Contract call")).toBeInTheDocument();
  });

  it("blocks list pages through the chain", async () => {
    mockNode();
    renderAt("/explorer/blocks");
    expect(await screen.findByText("Chain height 200.")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Blocks pages" }),
    ).toHaveTextContent("Page 1 of 67");
  });

  it("transactions list shows amounts in token units", async () => {
    mockNode();
    renderAt("/transactions");
    await screen.findByText(
      /200 transactions in the node's recent-block index/,
    );
    expect(screen.getByText("0.00003")).toBeInTheDocument(); // 3000 qBTC sats
    expect(
      screen.getAllByRole("link", { name: /^[0-9a-f]{10}…/ })[0],
    ).toHaveAttribute("href", expect.stringMatching(/^\/tx\//));
  });

  it("block detail shows finality, proposer and its transactions", async () => {
    mockNode();
    renderAt("/block/200");
    expect(
      screen.getByRole("heading", { name: "Block #200" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(BLOCK_HASH)).toBeInTheDocument();
    expect(await screen.findByText("Finalized")).toBeInTheDocument();
    expect(screen.getByText("Swap")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /rouge1/ })[0]).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/address\/rouge1/),
    );
  });

  it("a block hash resolves to its block page", async () => {
    mockNode();
    renderAt(`/tx/${BLOCK_HASH}`);
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/block/200"),
    );
  });

  it("transaction detail shows receipt status, fee, parties and swap units", async () => {
    mockNode();
    renderAt(`/tx/${SWAP}`);
    expect(await screen.findByText("Success")).toBeInTheDocument();
    expect(screen.getByText(SWAP)).toBeInTheDocument();
    const swap = screen.getByRole("region", { name: "Swap" });
    expect(within(swap).getByText(/0\.00003/)).toBeInTheDocument();
    expect(within(swap).getByText("XRGE-qBTC")).toBeInTheDocument();
    expect(screen.getByText("1 XRGE")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Event logs" }),
    ).toHaveTextContent("swap");
  });

  it("address detail shows balances with decimals, NFTs and activity", async () => {
    mockNode();
    renderAt(`/address/${ADDRESS}`);
    expect(await screen.findByText("8,812,403.4")).toBeInTheDocument();
    expect(screen.getByText("0.000031")).toBeInTheDocument(); // qBTC 3100 sats
    expect(screen.getByText("0.12866")).toBeInTheDocument(); // qUSDC
    expect(await screen.findByText(/#1 QTEK/)).toBeInTheDocument();
    expect(await screen.findByText(/124 transactions/)).toBeInTheDocument();
    expect(screen.getAllByText("Out").length).toBeGreaterThan(0);
  });

  it("address detail accepts a public key and derives its rouge1 address", async () => {
    mockNode();
    renderAt(`/address/${resolve.publicKey}`);
    expect(await screen.findByText(ADDRESS)).toBeInTheDocument();
  });

  it("tokens list and token detail", async () => {
    mockNode();
    renderAt("/tokens");
    const row = (await screen.findAllByText("qBTC"))[0].closest("tr")!;
    expect(within(row).getByText("8")).toBeInTheDocument();
  });

  it("token detail shows supply, holders and activity", async () => {
    mockNode();
    renderAt("/token/QTEK");
    expect(
      await screen.findByRole("heading", { level: 1, name: /QTEK Token/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Liquidity Pool (qUSDC)"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/7 transactions involve QTEK/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Liquidity pools" }),
    ).toHaveTextContent("QTEK-XRGE");
  });

  it("NFT collections and a collection's tokens show images only", async () => {
    mockNode();
    const { container, unmount } = renderAt("/nfts");
    expect(await screen.findByText("QTEK — Unknown")).toBeInTheDocument();
    unmount();
    const view = renderAt(`/nfts/${encodeURIComponent(COLLECTION)}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "QTEK — Unknown" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/#1 QTEK/)).toBeInTheDocument();
    for (const el of view.container.querySelectorAll("img"))
      expect(el.getAttribute("src")).toMatch(/^https:\/\//);
    expect(
      view.container.querySelector("iframe, video, audio, object, embed"),
    ).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("never loads unsafe media", async () => {
    mockNode({
      "/nft/collections": {
        collections: [
          {
            ...collections.collections[0],
            name: "Hostile",
            image: "javascript:alert(1)",
          },
        ],
      },
    });
    const { container } = renderAt("/nfts");
    expect(await screen.findByText("Hostile")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("contracts list and read-only contract detail", async () => {
    mockNode();
    const list = renderAt("/contracts");
    expect(
      await screen.findByRole("link", { name: /51816c121d/ }),
    ).toHaveAttribute("href", `/contract/${CONTRACT}`);
    list.unmount();
    renderAt(`/contract/${CONTRACT}`);
    expect(
      await screen.findByText(contract.contract.code_hash),
    ).toBeInTheDocument();
    expect(await screen.findByText("No storage")).toBeInTheDocument();
    expect(await screen.findByText(/"roll":35/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /call|execute|query|deploy/i }),
    ).not.toBeInTheDocument();
  });
});

describe("empty, error and not-found states", () => {
  it("reports a missing block as not found", async () => {
    mockNode();
    renderAt("/block/999999");
    expect(await screen.findByText("Block not found")).toBeInTheDocument();
  });
  it("reports an unreachable API as unavailable instead of inventing data", async () => {
    mockNode({ [`/tx/${SWAP}`]: new Error("offline") });
    renderAt(`/tx/${SWAP}`);
    expect(
      await screen.findByText("Transaction unavailable", {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Transaction unavailable: the Mainnet API could not be read/,
      ),
    ).toBeInTheDocument();
  });
  it("rejects malformed route parameters without a request", async () => {
    const fetchMock = mockNode();
    renderAt("/contract/not-hex");
    expect(screen.getByText("Not a contract address")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/contract/")),
    ).toBe(false);
  });
  it("shows an empty collection list truthfully", async () => {
    mockNode({ "/nft/collections": { collections: [] } });
    renderAt("/nfts");
    expect(await screen.findByText("No collections yet")).toBeInTheDocument();
  });
  it("labels reads live, stale, unavailable and loading", () => {
    const base = {
      pending: false,
      error: false,
      hasData: true,
      updatedAt: 1000,
      now: 2000,
      staleAfterMs: 5000,
    };
    expect(deriveReadState(base)).toBe("live");
    expect(deriveReadState({ ...base, now: 10_000 })).toBe("stale");
    expect(deriveReadState({ ...base, error: true })).toBe("stale");
    expect(deriveReadState({ ...base, hasData: false, error: true })).toBe(
      "unavailable",
    );
    expect(deriveReadState({ ...base, hasData: false, pending: true })).toBe(
      "loading",
    );
    expect(
      deriveReadState({ ...base, hasData: false, error: true, notFound: true }),
    ).toBe("not-found");
  });
});

describe("network awareness", () => {
  it("reads testnet from the testnet origin and never offers the mainnet snapshot", async () => {
    const fetchMock = mockNode(
      {
        "/stats": testnetStats,
        "/blocks?limit=8": { blocks: [] },
        "/txs?limit=8&offset=0": { txs: [], total: 0 },
      },
      "https://testnet.rougechain.io/api",
    );
    renderAt("/explorer", "testnet");
    expect(await screen.findByText("1,345")).toBeInTheDocument();
    expect(screen.getAllByText(/testnet/i).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Snapshot" }),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });
  it("rejects a node reporting the wrong chain", async () => {
    mockNode({ "/stats": testnetStats });
    renderAt("/explorer");
    // mainnet overview with a devnet node: network summary falls back to the labelled snapshot
    expect(
      await screen.findByText(/From the saved snapshot/),
    ).toBeInTheDocument();
  });
  it("classifies explorer paths for the shell", () => {
    for (const p of [
      "/explorer",
      "/blockchain",
      "/block/1",
      "/tx/ab",
      "/address/x",
      "/token/X",
      "/nfts/c",
      "/contract/a",
    ])
      expect(isExplorerPath(p)).toBe(true);
    for (const p of [
      "/",
      "/swap",
      "/workspace",
      "/blocks-and-more",
      "/tokenomics",
    ])
      expect(isExplorerPath(p)).toBe(false);
  });
});

describe("explorer in other languages", () => {
  it("renders the blocks list in Chinese", async () => {
    await i18n.changeLanguage("zh");
    mockNode();
    renderAt("/explorer/blocks");
    expect(
      screen.getByRole("heading", { level: 1, name: "区块" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("链高度 200。")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "区块分页" }),
    ).toHaveTextContent("第 1 / 67 页");
    expect(screen.getByRole("columnheader", { name: "提议者" })).toBeInTheDocument();
  });

  it("renders the overview in Spanish, with translated transaction types", async () => {
    await i18n.changeLanguage("es");
    mockNode();
    renderAt("/explorer");
    expect(
      screen.getByRole("heading", { level: 1, name: "Explorador" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Una vista clara de RougeChain mainnet.")).toBeInTheDocument();
    const latest = screen.getByRole("region", { name: "Últimas transacciones" });
    expect(await within(latest).findByText("Transferencia")).toBeInTheDocument();
    expect(within(latest).getByText("Llamada a contrato")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buscar" })).toBeInTheDocument();
  });
});

describe("token minting (TOKEN_MINTING upgrade)", () => {
  const mintableMeta = {
    ...tokenMeta,
    mintable: true,
    max_supply: 5000,
    total_minted: 250,
    initial_supply: 1000,
  };
  const activeStats = {
    ...stats,
    upgrade_schedule: { ...stats.upgrade_schedule, token_minting: 150 },
  };

  function renderTokenWithSlot(network: NetworkId = "mainnet") {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const TokenActions = ({ token, network: net }: ExplorerTokenActionProps) => (
      <p>{`actions:${token.symbol}:${net}:${token.totalMinted}`}</p>
    );
    return render(
      <QueryClientProvider client={client}>
        <ChainProvider network={network}>
          <NetworkProvider>
            <ExplorerSlotsProvider value={{ TokenActions }}>
              <MemoryRouter initialEntries={["/token/QTEK"]}>
                <Routes>{explorerRoutes}</Routes>
              </MemoryRouter>
            </ExplorerSlotsProvider>
          </NetworkProvider>
        </ChainProvider>
      </QueryClientProvider>,
    );
  }

  it("shows supply cap rows and the host's token actions once active", async () => {
    mockNode({ "/stats": activeStats, "/token/QTEK/metadata": mintableMeta });
    renderTokenWithSlot();
    expect(await screen.findByText("actions:QTEK:mainnet:250")).toBeInTheDocument();
    expect(screen.getByText("Initial supply")).toBeInTheDocument();
    expect(screen.getByText("Minted since creation")).toBeInTheDocument();
    expect(screen.getByText("Max supply")).toBeInTheDocument();
    expect(screen.getByText("5,000")).toBeInTheDocument();
  });

  it("an uncapped mintable token reads No cap", async () => {
    mockNode({
      "/stats": activeStats,
      "/token/QTEK/metadata": { ...mintableMeta, max_supply: null },
    });
    renderTokenWithSlot();
    expect(await screen.findByText("No cap")).toBeInTheDocument();
  });

  it("hides them while the upgrade is not active", async () => {
    mockNode({ "/token/QTEK/metadata": mintableMeta });
    renderTokenWithSlot();
    expect(
      await screen.findByRole("heading", { level: 1, name: /QTEK Token/ }),
    ).toBeInTheDocument();
    await screen.findByText(/7 transactions involve QTEK/);
    expect(screen.queryByText(/^actions:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Max supply")).not.toBeInTheDocument();
    expect(screen.queryByText("Minted since creation")).not.toBeInTheDocument();
  });

  it("hides them for a fixed-supply token even when active", async () => {
    mockNode({ "/stats": activeStats });
    renderTokenWithSlot();
    await screen.findByText(/7 transactions involve QTEK/);
    expect(screen.queryByText(/^actions:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Max supply")).not.toBeInTheDocument();
  });

  it("the standalone explorer (no slots) shows supply rows but no actions", async () => {
    mockNode({ "/stats": activeStats, "/token/QTEK/metadata": mintableMeta });
    renderAt("/token/QTEK");
    expect(await screen.findByText("Max supply")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mint/i })).not.toBeInTheDocument();
  });
});
