import { describe, it, expect } from "vitest";
import * as n from "./normalize";
import {
  formatUnits,
  formatTokenAmount,
  isRougeAddress,
  pubkeyToAddress,
  safeImageUrl,
  safeExternalUrl,
  sha256,
  txTypeLabel,
} from "./format";
import mainnetStats from "./fixtures/mainnet-stats.json";
import testnetStats from "./fixtures/testnet-stats.json";
import blocksPage from "./fixtures/mainnet-blocks-page.json";
import block200 from "./fixtures/mainnet-block-200.json";
import txs from "./fixtures/mainnet-txs.json";
import txSwap from "./fixtures/mainnet-tx-swap.json";
import txTransfer from "./fixtures/mainnet-tx-transfer.json";
import resolve from "./fixtures/mainnet-resolve.json";
import balance from "./fixtures/mainnet-balance.json";
import addressTxs from "./fixtures/mainnet-address-txs.json";
import ownerNfts from "./fixtures/mainnet-nft-owner.json";
import tokens from "./fixtures/mainnet-tokens.json";
import tokenMeta from "./fixtures/mainnet-token-metadata.json";
import holders from "./fixtures/mainnet-token-holders.json";
import tokenTxs from "./fixtures/mainnet-token-txs.json";
import pools from "./fixtures/mainnet-pools.json";
import prices from "./fixtures/mainnet-pool-prices.json";
import collections from "./fixtures/mainnet-nft-collections.json";
import collection from "./fixtures/mainnet-nft-collection.json";
import collectionTokens from "./fixtures/mainnet-nft-collection-tokens.json";
import contracts from "./fixtures/mainnet-contracts.json";
import contract from "./fixtures/mainnet-contract.json";
import contractState from "./fixtures/mainnet-contract-state.json";
import contractEvents from "./fixtures/mainnet-contract-events.json";

const MAIN = "rougechain-mainnet-1";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("normalizers accept real node responses", () => {
  it("stats (mainnet and testnet)", () => {
    expect(n.normalizeStats(mainnetStats, MAIN)).toMatchObject({
      height: 200,
      peers: 2,
      finalizedHeight: 200,
    });
    expect(n.normalizeStats(testnetStats, "rougechain-devnet-1").height).toBe(
      1345,
    );
  });
  it("blocks page", () => {
    const page = n.normalizeBlocksPage(blocksPage, MAIN);
    expect(page).toMatchObject({ page: 1, totalHeight: 200, totalPages: 67 });
    expect(page.blocks[0]).toMatchObject({ height: 200, txCount: 1 });
    expect(page.blocks[0].proposer).toHaveLength(3904);
  });
  it("block detail with its transactions", () => {
    const block = n.normalizeBlockDetail(block200);
    expect(block).toMatchObject({ height: 200, txCount: 1, totalFees: 1 });
    expect(block.transactions[0]).toMatchObject({
      type: "swap",
      symbol: "qBTC",
      amount: 3000,
      blockHeight: 200,
    });
  });
  it("transaction list and details with receipts", () => {
    const page = n.normalizeTxs(txs);
    expect(page.total).toBe(200);
    expect(page.txs.map((t) => t.type)).toEqual([
      "transfer",
      "swap",
      "contract_call",
    ]);
    const swap = n.normalizeTxDetail(txSwap);
    expect(swap.receipt).toMatchObject({ status: "success", feePaid: 1 });
    expect(swap.receipt?.logs[0].event).toBe("swap");
    const transfer = n.normalizeTxDetail(txTransfer);
    expect(transfer).toMatchObject({
      type: "transfer",
      symbol: "XRGE",
      amount: 5,
    });
    expect(transfer.to).toMatch(/^rouge1/);
  });
  it("address reads", () => {
    expect(n.normalizeResolve(resolve).address).toMatch(/^rouge1/);
    const b = n.normalizeBalance(balance);
    expect(b.xrge).toBe(8812403.4);
    expect(Object.fromEntries(b.tokens)).toMatchObject({
      qBTC: 3100,
      qUSDC: 128660,
    });
    const a = n.normalizeAddressTxs(addressTxs);
    expect(a.total).toBe(124);
    expect(a.txs[0].direction).toBe("out");
    expect(n.normalizeOwnerNfts(ownerNfts)[0]).toMatchObject({
      tokenId: 1,
      name: "QTEK",
    });
  });
  it("tokens, holders, activity and pools", () => {
    const list = n.normalizeTokens(tokens);
    expect(list.map((t) => [t.symbol, t.decimals])).toContainEqual(["qBTC", 8]);
    expect(n.normalizeTokenMetadata(tokenMeta).symbol).toBe("QTEK");
    expect(n.normalizeTokenHolders(holders)).toMatchObject({
      totalSupply: 0,
      circulatingSupply: 100800000,
    });
    const activity = n.normalizeTokenTxs(tokenTxs);
    expect(activity.transactions[0].hashPrefix).not.toContain(".");
    expect(n.normalizePools(pools)[0].poolId).toBe("QTEK-XRGE");
    expect(n.normalizePoolPrices(prices)[0].blockHeight).toBe(148);
  });
  it("NFT collections and tokens", () => {
    expect(n.normalizeCollections(collections)).toHaveLength(4);
    expect(n.normalizeCollection(collection)).toMatchObject({
      symbol: "QTEKNFT",
      minted: 1,
      royaltyBps: 6000,
    });
    expect(n.normalizeCollectionTokens(collectionTokens).total).toBe(1);
  });
  it("contracts, storage and events", () => {
    expect(n.normalizeContracts(contracts)[0].wasmSize).toBe(3539);
    expect(n.normalizeContract(contract).codeHash).toHaveLength(64);
    expect(n.normalizeContractState(contractState)).toEqual({
      entries: [],
      count: 0,
    });
    expect(n.normalizeContractEvents(contractEvents)[0]).toMatchObject({
      blockHeight: 178,
      topic: "roll",
    });
  });
});

describe("normalizers reject malformed responses", () => {
  it.each([
    [
      "stats without height",
      () => n.normalizeStats({ ...mainnetStats, network_height: "200" }, MAIN),
    ],
    ["stats on the wrong chain", () => n.normalizeStats(testnetStats, MAIN)],
    [
      "blocks that are not an array",
      () => n.normalizeBlocksPage({ ...blocksPage, blocks: {} }, MAIN),
    ],
    [
      "a block with a non-hex hash",
      () => {
        const b = clone(blocksPage);
        b.blocks[0].hash = "<img src=x>";
        return n.normalizeBlocksPage(b, MAIN);
      },
    ],
    [
      "a block whose txCount disagrees",
      () => {
        const b = clone(block200);
        b.block.txCount = 5;
        return n.normalizeBlockDetail(b);
      },
    ],
    ["a failed block read", () => n.normalizeBlockDetail({ success: false })],
    [
      "a tx with a negative fee",
      () => {
        const t = clone(txSwap);
        t.tx.fee = -1;
        return n.normalizeTxDetail(t);
      },
    ],
    [
      "a tx with an unknown receipt status",
      () => {
        const t = clone(txSwap);
        (t.receipt as { status: unknown }).status = "Maybe";
        return n.normalizeTxDetail(t);
      },
    ],
    [
      "a tx with a hostile type",
      () => {
        const t = clone(txSwap);
        t.tx.tx_type = "<script>";
        return n.normalizeTxDetail(t);
      },
    ],
    [
      "balances as strings",
      () => n.normalizeBalance({ ...balance, balance: "8812403" }),
    ],
    [
      "token decimals out of range",
      () =>
        n.normalizeTokens({
          success: true,
          tokens: [{ ...tokens.tokens[0], decimals: 99 }],
        }),
    ],
    ["tokens without success", () => n.normalizeTokens({ tokens: [] })],
    [
      "contract address of the wrong length",
      () =>
        n.normalizeContracts({
          contracts: [{ ...contracts.contracts[0], address: "abc" }],
        }),
    ],
    [
      "collections as an object",
      () => n.normalizeCollections({ collections: {} }),
    ],
    ["non-object bodies", () => n.normalizeTxs(null)],
  ])("%s", (_name, run) => {
    expect(run).toThrow();
  });

  it("reports missing resources as not found", () => {
    expect(() =>
      n.normalizeResolve({ success: false, error: "Address not found" }),
    ).toThrow(n.NotFoundError);
    expect(() =>
      n.normalizeContract({ success: false, error: "Contract not found" }),
    ).toThrow(n.NotFoundError);
    expect(() => n.normalizeTokenMetadata({ success: false })).toThrow(
      n.NotFoundError,
    );
  });
});

describe("formatting", () => {
  it("derives rouge1 addresses exactly like the node", () => {
    const r = n.normalizeResolve(resolve);
    expect(pubkeyToAddress(r.publicKey)).toBe(r.address);
    expect(
      Array.from(sha256(new TextEncoder().encode("abc")))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    ).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(isRougeAddress(r.address)).toBe(true);
    expect(
      isRougeAddress(
        r.address.slice(0, -1) + (r.address.endsWith("q") ? "p" : "q"),
      ),
    ).toBe(false);
    expect(isRougeAddress("rouge1short")).toBe(false);
  });
  it("shows raw token units with the right decimals", () => {
    expect(formatTokenAmount(3100, "qBTC")).toBe("0.000031");
    expect(formatTokenAmount(128660, "qUSDC")).toBe("0.12866");
    expect(formatTokenAmount(1_250_000_000, "qBTC")).toBe("12.5");
    expect(formatTokenAmount(911624, "QTEK")).toBe("911,624");
    expect(formatTokenAmount(1, "qBTC")).toBe("0.00000001");
    expect(formatTokenAmount(5, "NEW", new Map([["NEW", 2]]))).toBe("0.05");
    expect(formatUnits(0, 8)).toBe("0");
  });
  it("labels transaction types", () => {
    expect(txTypeLabel("contract_call")).toBe("Contract call");
    expect(txTypeLabel("some_new_type")).toBe("Some new type");
  });
  it("allows only https or inline raster images", () => {
    expect(safeImageUrl("https://x.mypinata.cloud/ipfs/Qm/cover.jpeg")).toMatch(
      /^https:/,
    );
    expect(safeImageUrl("data:image/png;base64,iVBORw0KGgo=")).toMatch(
      /^data:image\/png/,
    );
    for (const bad of [
      "http://example.com/a.png",
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "ipfs://Qm",
      "https://user:pw@example.com/a.png",
      "",
      null,
      42,
    ])
      expect(safeImageUrl(bad)).toBeNull();
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("https://rougechain.io")).toBe(
      "https://rougechain.io/",
    );
  });
});
