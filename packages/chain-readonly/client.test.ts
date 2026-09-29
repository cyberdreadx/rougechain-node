import { vi, describe, it, expect, afterEach } from "vitest";
import {
  buildReadPath,
  matchReadRoute,
  readOnlyGet,
  createReadClient,
  resolveNetwork,
  parseNetworkLock,
  networkConfig,
  NotFoundError,
  ChainMismatchError,
} from "./index";
import mainnetStats from "./fixtures/mainnet-stats.json";
import testnetStats from "./fixtures/testnet-stats.json";
import blocksPage from "./fixtures/mainnet-blocks-page.json";
import testnetBlocks from "./fixtures/testnet-blocks-page.json";

afterEach(() => vi.unstubAllGlobals());

function okJson(body: unknown) {
  return vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

describe("allowlist", () => {
  it.each([
    ["/stats", "stats"],
    ["/blocks?limit=8", "blocks"],
    ["/blocks?page=2&per_page=20", "blocks"],
    ["/block/0", "block"],
    ["/txs?limit=20&offset=40", "txs"],
    [`/tx/${"a".repeat(64)}`, "tx"],
    [
      "/resolve/rouge1aw424sfk3w9h2grllyhwpgjsngcu8cegyuksdfdgtye05lmwrpjqg8dk4n",
      "resolve",
    ],
    [`/balance/${"ab".repeat(976)}`, "balance"],
    [
      `/address/${"ab".repeat(976)}/transactions?limit=25&offset=0`,
      "addressTxs",
    ],
    ["/token/qBTC/metadata", "tokenMetadata"],
    ["/pool/XRGE-qBTC/prices", "poolPrices"],
    [
      "/nft/collection/col%3Adf255dbddd5a257e%3AQTEKNFT/tokens?limit=24&offset=0",
      "nftCollectionTokens",
    ],
    [
      "/contract/51816c121ddbb113049795bd396dd5349ede60a6/events?limit=25&before=178",
      "contractEvents",
    ],
  ])("accepts %s", (path, id) => {
    expect(matchReadRoute(path)).toBe(id);
  });

  it.each([
    "/swap",
    "/bridge/withdraw",
    "/v2/transfer",
    "/contract/51816c121ddbb113049795bd396dd5349ede60a6/query",
    "/messenger/messages",
    "/mail/inbox",
    "stats",
    "//evil.example/stats",
    "https://evil.example/stats",
    "/stats/../swap",
    "/stats/",
    "/block/-1",
    "/block/1.5",
    "/block/abc",
    "/block/01",
    "/tx/XYZ",
    `/tx/${"A".repeat(64)}`,
    `/tx/${"a".repeat(63)}`,
    "/blocks?limit=1000",
    "/blocks?from_height=0",
    "/blocks?limit=8&limit=9",
    "/txs?limit=20&api_key=x",
    "/resolve/0xabc",
    "/resolve/" + "ab".repeat(40),
    "/balance/rouge1<script>",
    "/token/%2e%2e/metadata",
    "/token/a%2Fb/metadata",
    "/token/has space/metadata",
    "/contract/xyz",
    "/stats#frag",
  ])("rejects %s", (path) => {
    expect(() => matchReadRoute(path)).toThrow(/read-only/);
  });

  it("validates builder parameters and encodes collection ids", () => {
    expect(buildReadPath("block", { height: 12 })).toBe("/block/12");
    expect(
      buildReadPath("nftCollection", { id: "col:df255dbddd5a257e:QTEKNFT" }),
    ).toBe("/nft/collection/col%3Adf255dbddd5a257e%3AQTEKNFT");
    expect(
      buildReadPath(
        "contractEvents",
        { addr: "51816c121ddbb113049795bd396dd5349ede60a6" },
        { limit: 5, before: undefined },
      ),
    ).toBe("/contract/51816c121ddbb113049795bd396dd5349ede60a6/events?limit=5");
    expect(() => buildReadPath("block", { height: "1; DROP" })).toThrow();
    expect(() => buildReadPath("tx", { hash: "../stats" })).toThrow();
    expect(() => buildReadPath("txs", {}, { limit: 5000 })).toThrow();
  });
});

describe("transport", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "refuses %s before any request",
    async (method) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        readOnlyGet("/stats", method as "GET", "testnet"),
      ).rejects.toThrow("read-only");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses non-allowlisted paths before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(readOnlyGet("/v2/transfer")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a credential-free, redirect-refusing, time-bounded GET to the selected network", async () => {
    const fetchMock = okJson(testnetStats);
    vi.stubGlobal("fetch", fetchMock);
    const stats = await createReadClient("testnet").stats();
    expect(stats.height).toBe(1345);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://testnet.rougechain.io/api/stats");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init).not.toHaveProperty("body");
  });

  it("maps 404 to NotFoundError and other failures to errors, never data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    await expect(
      createReadClient("mainnet").block(999999),
    ).rejects.toBeInstanceOf(NotFoundError);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    await expect(createReadClient("mainnet").block(1)).rejects.toThrow(
      "Network data unavailable",
    );
  });

  it("rejects a node that reports the other network's chain id", async () => {
    vi.stubGlobal("fetch", okJson(mainnetStats));
    await expect(createReadClient("testnet").stats()).rejects.toBeInstanceOf(
      ChainMismatchError,
    );
    vi.stubGlobal("fetch", okJson(testnetBlocks));
    await expect(
      createReadClient("mainnet").blocksPage(1, 1),
    ).rejects.toBeInstanceOf(ChainMismatchError);
    vi.stubGlobal("fetch", okJson(blocksPage));
    await expect(
      createReadClient("mainnet").blocksPage(1, 2),
    ).resolves.toMatchObject({ page: 1 });
  });
});

describe("network selection", () => {
  it("defaults to mainnet", () => {
    expect(resolveNetwork({ lock: null })).toBe("mainnet");
    expect(resolveNetwork({ lock: null, saved: "bogus" })).toBe("mainnet");
  });
  it("honours a saved choice when not locked", () => {
    expect(resolveNetwork({ lock: null, saved: "testnet" })).toBe("testnet");
  });
  it("a lock wins over any saved choice", () => {
    expect(resolveNetwork({ lock: "mainnet", saved: "testnet" })).toBe(
      "mainnet",
    );
    expect(resolveNetwork({ lock: "testnet", saved: "mainnet" })).toBe(
      "testnet",
    );
  });
  it("only exact lock values pin a deploy", () => {
    expect(parseNetworkLock("testnet")).toBe("testnet");
    expect(parseNetworkLock("Testnet")).toBeNull();
    expect(parseNetworkLock(undefined)).toBeNull();
  });
  it("pins distinct origins and chain ids per network", () => {
    expect(networkConfig("mainnet")).toMatchObject({
      apiBase: "https://api.rougechain.io/api",
      chainId: "rougechain-mainnet-1",
    });
    expect(networkConfig("testnet")).toMatchObject({
      apiBase: "https://testnet.rougechain.io/api",
      chainId: "rougechain-devnet-1",
    });
  });
});
