import { describe, expect, it, vi } from "vitest";
import { buildReadPath, matchReadRoute, NotAllowlistedError } from "./allowlist";
import { readOnlyGet } from "./client";
import {
  bridgeTransferFromTx,
  externalAddressUrl,
  externalExplorer,
  externalTxUrl,
  missingExternalTxReason,
  normalizeBridgeActivityItem,
  normalizeBridgeActivityPage,
  normalizeBridgeConfig,
  normalizeBridgeWithdrawals,
  pendingIndex,
  readBridgeActivity,
  readBridgeTransfer,
  statusLabel,
  statusTone,
  directionLabel,
  type BridgeReads,
  type BridgeTransfer,
} from "./bridge";
import { normalizeTxDetail, normalizeTxs, NotFoundError, ShapeError } from "./normalize";
import config from "./fixtures/mainnet-bridge-config.json";
import testnetConfig from "./fixtures/testnet-bridge-config.json";
import evmList from "./fixtures/mainnet-bridge-withdrawals.json";
import btcList from "./fixtures/mainnet-bridge-btc-withdrawals.json";
import xrgeList from "./fixtures/mainnet-bridge-xrge-withdrawals.json";
import bridgeTxs from "./fixtures/mainnet-txs-bridge.json";
import bridgeTx from "./fixtures/mainnet-tx-bridge-withdraw.json";
import nodePage from "./fixtures/node-bridge-activity.json";
import nodeItem from "./fixtures/node-bridge-activity-item.json";

const QBTC_WITHDRAW =
  "d7df36b845ad0d147af6d717c2a8860026bbdb442c5375990a32e0efe6eb4c2c";
const BTC_PAYOUT =
  "91d306fcedfc15ce8cb8f1c547c5c2d403a20d138a74cc66fbb4a5e104259b84";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("bridge allowlist", () => {
  it("allows the public bridge GETs with validated parameters", () => {
    expect(matchReadRoute("/bridge/config")).toBe("bridgeConfig");
    expect(matchReadRoute("/bridge/activity")).toBe("bridgeActivity");
    expect(matchReadRoute("/bridge/activity?limit=25")).toBe("bridgeActivity");
    expect(matchReadRoute("/bridge/activity?limit=25&before=202-0")).toBe(
      "bridgeActivity",
    );
    expect(matchReadRoute("/bridge/activity?before=202")).toBe("bridgeActivity");
    expect(matchReadRoute(`/bridge/activity/${QBTC_WITHDRAW}`)).toBe(
      "bridgeActivityItem",
    );
    expect(matchReadRoute("/bridge/withdrawals")).toBe("bridgeWithdrawals");
    expect(matchReadRoute("/bridge/btc/withdrawals")).toBe("bridgeBtcWithdrawals");
    expect(matchReadRoute("/bridge/xrge/withdrawals")).toBe("bridgeXrgeWithdrawals");
    expect(buildReadPath("bridgeActivity", {}, { limit: 10, before: "41-0" })).toBe(
      "/bridge/activity?limit=10&before=41-0",
    );
    expect(buildReadPath("bridgeActivity", {}, { limit: 10, before: undefined })).toBe(
      "/bridge/activity?limit=10",
    );
  });

  it("refuses bad parameters and every write-side bridge route", () => {
    for (const bad of [
      "/bridge/activity?limit=0",
      "/bridge/activity?limit=101",
      "/bridge/activity?before=abc",
      "/bridge/activity?before=202-",
      "/bridge/activity?before=0202",
      "/bridge/activity?cursor=1",
      "/bridge/activity?limit=5&limit=6",
      `/bridge/activity/${QBTC_WITHDRAW.toUpperCase()}`,
      "/bridge/activity/xrge:" + QBTC_WITHDRAW,
      "/bridge/activity/123",
      "/bridge/withdraw",
      "/bridge/claim",
      "/bridge/btc/claim",
      "/bridge/xrge/claim",
      "/bridge/health",
      `/bridge/withdrawals/${QBTC_WITHDRAW}`,
      `/bridge/withdrawals/${QBTC_WITHDRAW}/refund`,
      `/bridge/btc/withdrawals/${QBTC_WITHDRAW}`,
      "/bridge/deposit/auto-claim",
      "/bridge/admin/reclaim",
    ])
      expect(() => matchReadRoute(bad), bad).toThrow(NotAllowlistedError);
  });

  it("reads bridge routes with GET only, no credentials, no redirects", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("error");
      return { ok: true, status: 200, json: async () => clone(config) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await readOnlyGet("/bridge/config");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.rougechain.io/api/bridge/config",
    );
    await expect(
      readOnlyGet("/bridge/withdraw", "POST" as "GET"),
    ).rejects.toThrow(NotAllowlistedError);
    vi.unstubAllGlobals();
  });
});

describe("bridge normalizers", () => {
  it("normalizes the live /bridge/config (mainnet and testnet)", () => {
    expect(normalizeBridgeConfig(config)).toEqual({
      enabled: true,
      chainId: 8453,
      btcNetwork: "mainnet",
      supportedTokens: ["ETH", "USDC", "BTC"],
    });
    expect(normalizeBridgeConfig(testnetConfig)).toMatchObject({
      enabled: false,
      chainId: null,
      btcNetwork: "testnet",
    });
    expect(() => normalizeBridgeConfig({ ...config, chainId: 1 })).toThrow(
      ShapeError,
    );
    expect(() => normalizeBridgeConfig({ ...config, btcNetwork: "regtest!" })).toThrow(
      ShapeError,
    );
  });

  it("normalizes the live pending-payout lists and keeps only id + status", () => {
    expect(normalizeBridgeWithdrawals(evmList)).toEqual({ items: [], degraded: false });
    expect(normalizeBridgeWithdrawals(xrgeList).items).toEqual([]);
    const btc = normalizeBridgeWithdrawals(btcList);
    expect(btc.items).toEqual([{ txId: QBTC_WITHDRAW, status: "pending" }]);
    expect(JSON.stringify(btc)).not.toContain("ownerPubkey");
    // XRGE list: snake_case with the legacy "xrge:" prefix
    const xrge = normalizeBridgeWithdrawals({
      withdrawals: [
        {
          tx_id: `xrge:${"a".repeat(64)}`,
          evm_address: "0x1cf7f96f871de10f325dd0b80bbc75c1e9734c2e",
          amount: 100,
          status: "failed",
          last_error: "RPC key leaked",
        },
      ],
    });
    expect(xrge.items).toEqual([{ txId: "a".repeat(64), status: "failed" }]);
    expect(normalizeBridgeWithdrawals({ withdrawals: [], degraded: true }).degraded).toBe(
      true,
    );
    expect(() =>
      normalizeBridgeWithdrawals({ withdrawals: [{ txId: "nope", status: "pending" }] }),
    ).toThrow(ShapeError);
  });

  it("normalizes a /bridge/activity page (fixture matches the Rust serializer)", () => {
    const page = normalizeBridgeActivityPage(nodePage);
    expect(page.items).toHaveLength(8);
    expect(page.nextCursor).toBe("41-0");
    expect(page.items.map((i) => i.status)).toEqual([
      "pending",
      "paid",
      "queued",
      "paid",
      "refunded",
      "failed",
      "paid",
      "paid",
    ]);
    expect(page.items[0]).toMatchObject({
      blockHeight: null,
      timestamp: null,
      cursor: null,
      statusReason: "in_mempool",
    });
    expect(page.items.every((i) => i.source === "node")).toBe(true);
  });

  it("normalizes the real qBTC withdrawal item", () => {
    const item = normalizeBridgeActivityItem(nodeItem);
    expect(item).toMatchObject({
      kind: "withdrawal",
      asset: "qBTC",
      externalAsset: "BTC",
      amountUnits: 5000,
      decimals: 8,
      fromChain: "rougechain",
      toChain: "bitcoin",
      rougechainTxId: QBTC_WITHDRAW,
      blockHeight: 202,
      externalChainId: "bitcoin",
      externalNetwork: "mainnet",
      externalAddress: "bc1qvt4r5dazmystwspgp62vh9ve5tutw5av4atjcz",
      externalTxHash: BTC_PAYOUT,
      status: "paid",
      statusReason: "payout_verified",
      cursor: "202-0",
    });
  });

  it("rejects malformed items instead of rendering them", () => {
    const bad: [string, unknown][] = [
      ["status", "completed"],
      ["status", "PAID"],
      ["statusReason", "RPC error: key 0xabc"],
      ["kind", "swap"],
      ["fromChain", "ethereum"],
      ["externalChainId", "1"],
      ["externalTxHash", "0x" + "1".repeat(64)], // an EVM hash on a Bitcoin item
      ["externalAddress", "<img src=x>"],
      ["rougechainTxId", "xrge:" + QBTC_WITHDRAW],
      ["rougechainAddress", "0xabc"],
      ["amountUnits", -1],
      ["amountUnits", "5000"],
      ["decimals", 40],
      ["cursor", "202:0"],
      ["asset", "<b>"],
    ];
    for (const [k, v] of bad)
      expect(() => normalizeBridgeActivityItem({ ...clone(nodeItem), [k]: v }), k).toThrow(
        ShapeError,
      );
    expect(() => normalizeBridgeActivityPage({ items: {} })).toThrow(ShapeError);
    // unknown extra fields are ignored, not rendered
    expect(
      normalizeBridgeActivityItem({ ...clone(nodeItem), lastError: "secret" }),
    ).not.toHaveProperty("lastError");
  });
});

describe("status pills", () => {
  const t = (status: BridgeTransfer["status"], kind: BridgeTransfer["kind"] = "withdrawal") =>
    ({ status, kind }) as BridgeTransfer;
  it("labels and tones every status", () => {
    expect(statusLabel(t("pending"))).toBe("Pending");
    expect(statusLabel(t("queued"))).toBe("Queued");
    expect(statusLabel(t("paid"))).toBe("Paid");
    expect(statusLabel(t("paid", "deposit"))).toBe("Minted");
    expect(statusLabel(t("failed"))).toBe("Failed");
    expect(statusLabel(t("refunded"))).toBe("Refunded");
    expect(statusLabel(t("unknown"))).toBe("Unknown");
    expect(statusLabel(t("completed"))).toBe("Completed");
    expect(statusTone("paid")).toBe("good");
    expect(statusTone("completed")).toBe("good");
    expect(statusTone("pending")).toBe("wait");
    expect(statusTone("queued")).toBe("wait");
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("refunded")).toBe("neutral");
    expect(statusTone("unknown")).toBe("neutral");
  });
});

describe("external links", () => {
  const item = normalizeBridgeActivityItem(nodeItem);
  const base = (over: Partial<BridgeTransfer> = {}): BridgeTransfer => ({
    ...item,
    asset: "qETH",
    externalAsset: "ETH",
    decimals: 6,
    toChain: "base",
    externalChainId: "8453",
    externalNetwork: "base",
    externalAddress: "0x6776cdaa2b24950ba15cffbbce983be73aeb7275",
    externalTxHash: "0x" + "ab".repeat(32),
    ...over,
  });
  const main = { network: "mainnet" as const };

  it("Bitcoin → mempool.space (mainnet / testnet / signet)", () => {
    expect(externalTxUrl(item, main)).toBe(`https://mempool.space/tx/${BTC_PAYOUT}`);
    expect(externalAddressUrl(item, main)).toBe(
      "https://mempool.space/address/bc1qvt4r5dazmystwspgp62vh9ve5tutw5av4atjcz",
    );
    const tb = { ...item, externalNetwork: "testnet" };
    expect(externalTxUrl(tb, main)).toBe(`https://mempool.space/testnet/tx/${BTC_PAYOUT}`);
    const sig = { ...item, externalNetwork: null, externalChainId: null };
    expect(externalTxUrl(sig, { network: "testnet", btcNetwork: "signet" })).toBe(
      `https://mempool.space/signet/tx/${BTC_PAYOUT}`,
    );
    expect(externalExplorer(item, main)?.name).toBe("mempool.space");
  });

  it("Base mainnet → basescan.org, Base Sepolia → sepolia.basescan.org", () => {
    expect(externalTxUrl(base(), main)).toBe(`https://basescan.org/tx/0x${"ab".repeat(32)}`);
    expect(externalAddressUrl(base(), main)).toBe(
      "https://basescan.org/address/0x6776cdaa2b24950ba15cffbbce983be73aeb7275",
    );
    const sepolia = base({ externalChainId: "84532", externalNetwork: "base-sepolia" });
    expect(externalTxUrl(sepolia, main)).toBe(
      `https://sepolia.basescan.org/tx/0x${"ab".repeat(32)}`,
    );
    // no chain id on the item: /bridge/config decides, then the RougeChain network
    const bare = base({ externalChainId: null, externalNetwork: null });
    expect(externalTxUrl(bare, { network: "mainnet", baseChainId: 84532 })).toContain(
      "sepolia.basescan.org",
    );
    expect(externalTxUrl(bare, { network: "mainnet" })).toContain("//basescan.org");
    expect(externalTxUrl(bare, { network: "testnet" })).toContain("sepolia.basescan.org");
  });

  it("builds no link from a missing or malformed value", () => {
    expect(externalTxUrl(base({ externalTxHash: null }), main)).toBeNull();
    expect(externalTxUrl(base({ externalTxHash: BTC_PAYOUT }), main)).toBeNull();
    expect(externalTxUrl({ ...item, externalTxHash: "0x" + "ab".repeat(32) }, main)).toBeNull();
    expect(externalAddressUrl(base({ externalAddress: "javascript:alert(1)" }), main)).toBeNull();
    const unsupported = base({ asset: "QTEK", externalChainId: null, externalNetwork: null });
    expect(externalExplorer(unsupported, main)).toBeNull();
  });

  it("explains a missing external tx truthfully", () => {
    expect(missingExternalTxReason({ ...item, kind: "deposit" })).toMatch(/not recorded/);
    expect(missingExternalTxReason({ ...item, source: "chain" })).toBe(
      "External tx link available after node update",
    );
    expect(missingExternalTxReason({ ...item, status: "queued" })).toBe("Not paid out yet");
    expect(missingExternalTxReason({ ...item, status: "refunded" })).toMatch(/refunded/);
  });

  it("labels directions", () => {
    expect(directionLabel(item)).toBe("RougeChain → Bitcoin");
    expect(directionLabel(base({ fromChain: "base-sepolia", toChain: "rougechain" }))).toBe(
      "Base Sepolia → RougeChain",
    );
  });
});

describe("fallback: rebuilt from on-chain bridge transactions", () => {
  const txs = normalizeTxs(bridgeTxs).txs;
  const ctx = { network: "mainnet" as const, baseChainId: 8453 as const, btcNetwork: "mainnet" as const };
  const pending = pendingIndex([
    normalizeBridgeWithdrawals(evmList),
    normalizeBridgeWithdrawals(btcList),
    normalizeBridgeWithdrawals(xrgeList),
  ]);

  it("marks withdrawals still in the pending lists as Pending, others Completed, never a hash", () => {
    const items = txs
      .map((t) => bridgeTransferFromTx(t, pending, ctx))
      .filter((t): t is BridgeTransfer => t !== null);
    expect(items).toHaveLength(7); // the transfer in the fixture is not bridge activity
    const qbtc = items.find((i) => i.rougechainTxId === QBTC_WITHDRAW)!;
    expect(qbtc).toMatchObject({
      kind: "withdrawal",
      asset: "qBTC",
      decimals: 8,
      amountUnits: 5000,
      toChain: "bitcoin",
      status: "pending",
      statusReason: "awaiting_payout",
      externalAddress: "bc1qvt4r5dazmystwspgp62vh9ve5tutw5av4atjcz",
      externalTxHash: null,
      source: "chain",
    });
    expect(qbtc.rougechainAddress).toMatch(/^rouge1/);
    const others = items.filter((i) => i.rougechainTxId !== QBTC_WITHDRAW);
    expect(new Set(others.map((i) => i.status))).toEqual(new Set(["completed"]));
    expect(items.every((i) => i.externalTxHash === null)).toBe(true);
    const deposits = items.filter((i) => i.kind === "deposit");
    expect(deposits.map((d) => d.asset).sort()).toEqual(["XRGE", "qBTC", "qUSDC"]);
    expect(deposits.every((d) => d.toChain === "rougechain" && d.externalAddress === null)).toBe(
      true,
    );
    // a rouge1 recipient on a mint passes through
    expect(deposits.find((d) => d.asset === "qBTC")!.rougechainAddress).toMatch(/^rouge1aw424/);
    expect(missingExternalTxReason(qbtc)).toBe("External tx link available after node update");
  });

  it("reports Unknown when the pending lists are unreadable or degraded", () => {
    const degraded = pendingIndex([{ items: [], degraded: true }]);
    expect(degraded).toBeNull();
    const t = bridgeTransferFromTx(txs[0], null, ctx)!;
    expect(t.status).toBe("unknown");
    expect(t.statusReason).toBe("payout_lists_unavailable");
  });

  it("uses Sepolia / Bitcoin testnet chains on the testnet", () => {
    const tctx = { network: "testnet" as const, baseChainId: null, btcNetwork: "testnet" as const };
    const items = txs.map((t) => bridgeTransferFromTx(t, pending, tctx)).filter(Boolean) as BridgeTransfer[];
    expect(items.find((i) => i.asset === "qBTC" && i.kind === "withdrawal")!.toChain).toBe(
      "bitcoin-testnet",
    );
    expect(items.find((i) => i.asset === "qUSDC" && i.kind === "withdrawal")!.toChain).toBe(
      "base-sepolia",
    );
  });

  function reads(over: Partial<BridgeReads> = {}): BridgeReads {
    return {
      network: "mainnet",
      bridgeConfig: async () => normalizeBridgeConfig(config),
      bridgeActivity: async () => {
        throw new NotFoundError();
      },
      bridgeActivityItem: async () => {
        throw new NotFoundError();
      },
      bridgeWithdrawals: async () => normalizeBridgeWithdrawals(evmList),
      bridgeBtcWithdrawals: async () => normalizeBridgeWithdrawals(btcList),
      bridgeXrgeWithdrawals: async () => normalizeBridgeWithdrawals(xrgeList),
      txs: async () => normalizeTxs(bridgeTxs),
      tx: async () => normalizeTxDetail(bridgeTx),
      ...over,
    };
  }

  it("falls back only on 404 and returns the node's page otherwise", async () => {
    const fb = await readBridgeActivity(reads(), { limit: 25 });
    expect(fb.source).toBe("chain");
    expect(fb.items).toHaveLength(7);
    expect(fb.items[0].rougechainTxId).toBe(QBTC_WITHDRAW); // newest first
    expect(fb.pendingListsRead).toBe(true);
    expect(fb.config?.chainId).toBe(8453);

    const node = await readBridgeActivity(
      reads({ bridgeActivity: async () => normalizeBridgeActivityPage(nodePage) }),
      { limit: 25 },
    );
    expect(node.source).toBe("node");
    expect(node.nextCursor).toBe("41-0");

    await expect(
      readBridgeActivity(
        reads({
          bridgeActivity: async () => {
            throw new Error("503");
          },
        }),
        { limit: 25 },
      ),
    ).rejects.toThrow("503");

    const noLists = await readBridgeActivity(
      reads({
        bridgeBtcWithdrawals: async () => {
          throw new Error("down");
        },
        bridgeConfig: async () => {
          throw new Error("down");
        },
      }),
      { limit: 25 },
    );
    expect(noLists.pendingListsRead).toBe(false);
    expect(noLists.config).toBeNull();
    expect(noLists.items.find((i) => i.kind === "withdrawal")!.status).toBe("unknown");
  });

  it("reads one transfer from the node, or rebuilds it from the tx", async () => {
    const fromNode = await readBridgeTransfer(
      reads({ bridgeActivityItem: async () => normalizeBridgeActivityItem(nodeItem) }),
      QBTC_WITHDRAW,
    );
    expect(fromNode.transfer.externalTxHash).toBe(BTC_PAYOUT);
    const rebuilt = await readBridgeTransfer(reads(), QBTC_WITHDRAW);
    expect(rebuilt.transfer).toMatchObject({ source: "chain", status: "pending", externalTxHash: null });
    const transfer = normalizeTxDetail(bridgeTx);
    await expect(
      readBridgeTransfer(reads({ tx: async () => ({ ...transfer, type: "transfer" }) }), QBTC_WITHDRAW),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
