import { vi, describe, it, expect } from "vitest";
import {
  readOnlyGet,
  normalizeNetwork,
  deriveNetworkState,
  ENDPOINTS,
  getNetwork,
} from "./index";
const stats = {
  network_height: 201,
  connected_peers: 2,
  chain_id: "rougechain-mainnet-1",
};
const validators = { success: true, validators: [{}, {}] };
const blocks = {
  blocks: [
    {
      header: {
        height: 200,
        time: 1790638511876,
        chain_id: "rougechain-mainnet-1",
      },
      txs: [],
      hash: "sample-hash",
    },
  ],
};
describe("read-only boundary", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
    "rejects %s before any request",
    async (method) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(readOnlyGet("/stats", method as "GET")).rejects.toThrow(
        "read-only",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(["/swap", "/bridge", "https://evil.example/stats", "/stats/../swap"])(
    "rejects unverified path %s",
    async (path) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        readOnlyGet(path as (typeof ENDPOINTS)[number]),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("uses only fixed-host GET requests without credentials", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => stats })
      .mockResolvedValueOnce({ ok: true, json: async () => validators })
      .mockResolvedValueOnce({ ok: true, json: async () => blocks });
    vi.stubGlobal("fetch", mock);
    const data = await getNetwork();
    expect(data.height).toBe(201);
    expect(mock).toHaveBeenCalledTimes(3);
    mock.mock.calls.forEach(([url, options]) => {
      expect(url).toMatch(/^https:\/\/api.rougechain.io\/api\//);
      expect(options).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "error",
      });
      expect(options).not.toHaveProperty("body");
    });
  });
  it("does not treat an HTTP error as data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    await expect(readOnlyGet("/stats")).rejects.toThrow(
      "Network data unavailable",
    );
  });
  it("validates shapes instead of inventing missing metrics", () => {
    expect(() => normalizeNetwork({}, validators, blocks)).toThrow();
    expect(() =>
      normalizeNetwork({ ...stats, network_height: "200" }, validators, blocks),
    ).toThrow();
    expect(() =>
      normalizeNetwork({ ...stats, chain_id: "testnet" }, validators, blocks),
    ).toThrow();
    expect(normalizeNetwork(stats, validators, blocks)).toMatchObject({
      height: 201,
      validators: 2,
      peers: 2,
    });
  });
  it("distinguishes pending, live, fallback and stale reads", () => {
    const base = {
      mode: "LIVE" as const,
      loading: false,
      error: false,
      hasData: true,
    };
    expect(deriveNetworkState(base)).toBe("live");
    expect(deriveNetworkState({ ...base, loading: true, hasData: false })).toBe(
      "loading",
    );
    expect(deriveNetworkState({ ...base, error: true, hasData: false })).toBe(
      "demo",
    );
    expect(deriveNetworkState({ ...base, error: true })).toBe("stale");
    expect(deriveNetworkState({ ...base, expired: true })).toBe("stale");
    expect(deriveNetworkState({ ...base, mode: "DEMO" })).toBe("demo");
  });
});
