// Ported from Anders' Trellis-era persistence.test.ts / model.test.ts to the dockview layout store.
import { it, expect, vi, beforeEach } from "vitest";
import {
  blockPanelId,
  dockLayoutKey,
  loadDockLayout,
  saveDockLayout,
  storageAvailable,
  validateDockLayout,
  MAX_LAYOUT_BYTES,
} from "./dockPersistence";

const KEY = dockLayoutKey();
const block = {
  height: 200,
  hash: "9fa0d198abc2329",
  transactions: 1,
  timestamp: 1_790_000_000_000,
  provenance: "live",
};
const leaf = (id: string, views: string[]) => ({
  type: "leaf",
  size: 300,
  data: { id, views, activeView: views[0] },
});
const panel = (id: string, component = id, params?: object) => ({
  id,
  contentComponent: component,
  title: id,
  ...(params ? { params } : {}),
});
function doc(overrides: Record<string, unknown> = {}) {
  return {
    schema: "rougechain-dockview",
    version: 1,
    hidden: [],
    layout: {
      grid: {
        root: {
          type: "branch",
          data: [
            leaf("1", ["Network"]),
            leaf("2", ["Explorer", blockPanelId(block.hash)]),
            leaf("3", ["Ecosystem"]),
          ],
        },
        width: 900,
        height: 600,
        orientation: "HORIZONTAL",
      },
      panels: {
        Network: panel("Network"),
        Explorer: panel("Explorer"),
        Ecosystem: panel("Ecosystem"),
        [blockPanelId(block.hash)]: panel(
          blockPanelId(block.hash),
          "BlockDetail",
          block,
        ),
      },
      activeGroup: "1",
    },
    ...overrides,
  };
}
const withLayout = (layout: Record<string, unknown>) =>
  doc({ layout: { ...doc().layout, ...layout } });

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
});

it("uses new versioned keys, separate for the embed and the full workspace", () => {
  expect(dockLayoutKey(true)).toBe("rougechain-dockview-embed-layout-v1");
  expect(dockLayoutKey(false)).toBe("rougechain-dockview-workspace-layout-v1");
});

it.each([
  "{broken",
  "{}",
  "null",
  '{"schema":"rougechain-dockview","version":0}',
  '{"schema":1,"version":2,"root":null,"views":{}}', // a Trellis v2 document
])("clears incompatible stored layout %s", (raw) => {
  localStorage.setItem(KEY, raw);
  expect(loadDockLayout(KEY, { allowFloating: true })).toBeNull();
  expect(localStorage.getItem(KEY)).toBeNull();
});

it("does not fail when browser storage is unavailable", () => {
  vi.stubGlobal("localStorage", {
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
  expect(() => loadDockLayout(KEY, { allowFloating: true })).not.toThrow();
  expect(saveDockLayout(KEY, doc().layout, [])).toBe(false);
  expect(storageAvailable()).toBe(false);
});

it("preserves a compatible workspace and round-trips it through save", () => {
  expect(saveDockLayout(KEY, doc().layout, ["Wallet"])).toBe(true);
  const loaded = loadDockLayout(KEY, { allowFloating: false });
  expect(loaded?.hidden).toEqual(["Wallet"]);
  expect(loaded?.layout.panels.Network).toBeTruthy();
  expect(localStorage.getItem(KEY)).not.toBeNull();
});

it("never touches the Trellis-era keys", () => {
  localStorage.setItem("rougechain-poc-explore-layout-v1", "preserve");
  localStorage.setItem("rougechain-poc-workspace-layout-v2", "preserve");
  localStorage.setItem(KEY, "{broken");
  loadDockLayout(KEY, { allowFloating: true });
  expect(localStorage.getItem("rougechain-poc-explore-layout-v1")).toBe(
    "preserve",
  );
  expect(localStorage.getItem("rougechain-poc-workspace-layout-v2")).toBe(
    "preserve",
  );
});

it("preserves hidden views and rejects duplicate singleton records", () => {
  expect(
    validateDockLayout(doc({ hidden: ["Wallet"] }), { allowFloating: false }),
  ).not.toBeNull();
  const opts = { allowFloating: true };
  // A second Network record under another id.
  expect(
    validateDockLayout(
      withLayout({
        panels: {
          ...doc().layout.panels,
          "Network-2": panel("Network-2", "Network"),
        },
      }),
      opts,
    ),
  ).toBeNull();
  // The same singleton referenced by two groups.
  const grid = doc().layout.grid;
  expect(
    validateDockLayout(
      withLayout({
        grid: {
          ...grid,
          root: {
            type: "branch",
            data: [...grid.root.data, leaf("4", ["Network"])],
          },
        },
      }),
      opts,
    ),
  ).toBeNull();
  // Open and hidden at the same time, or hidden twice.
  expect(validateDockLayout(doc({ hidden: ["Network"] }), opts)).toBeNull();
  expect(
    validateDockLayout(doc({ hidden: ["Wallet", "Wallet"] }), opts),
  ).toBeNull();
});

it("rejects malformed layout trees and invalid persisted block data", () => {
  const opts = { allowFloating: true };
  const grid = doc().layout.grid;
  for (const bad of [
    withLayout({ grid: { ...grid, root: { type: "bogus", data: [] } } }),
    withLayout({ grid: { ...grid, orientation: "DIAGONAL" } }),
    withLayout({ grid: { ...grid, root: leaf("1", ["Missing"]) } }),
    withLayout({
      panels: {
        ...doc().layout.panels,
        [blockPanelId(block.hash)]: panel(
          blockPanelId(block.hash),
          "BlockDetail",
          { ...block, timestamp: "bad" },
        ),
      },
    }),
    withLayout({
      panels: {
        ...doc().layout.panels,
        [blockPanelId(block.hash)]: panel("block-other", "BlockDetail", block),
      },
    }),
    withLayout({ panels: { ...doc().layout.panels, Rogue: panel("Rogue") } }),
    withLayout({ popoutGroups: [{ data: {} }] }),
  ])
    expect(validateDockLayout(bad, opts)).toBeNull();
  // Deeply nested trees are refused.
  let root: object = leaf("1", ["Network"]);
  for (let i = 0; i < 40; i++) root = { type: "branch", data: [root] };
  expect(
    validateDockLayout(
      withLayout({
        grid: { ...grid, root },
        panels: { Network: panel("Network") },
      }),
      opts,
    ),
  ).toBeNull();
});

it("accepts floating windows only where floating is allowed", () => {
  const grid = doc().layout.grid;
  const floating = withLayout({
    grid: {
      ...grid,
      root: { type: "branch", data: grid.root.data.slice(0, 2) },
    },
    floatingGroups: [
      {
        data: { id: "9", views: ["Ecosystem"], activeView: "Ecosystem" },
        position: { top: 40, left: 40, width: 400, height: 300 },
      },
    ],
  });
  expect(validateDockLayout(floating, { allowFloating: true })).not.toBeNull();
  expect(validateDockLayout(floating, { allowFloating: false })).toBeNull();
  localStorage.setItem(dockLayoutKey(true), JSON.stringify(floating));
  expect(
    loadDockLayout(dockLayoutKey(true), { allowFloating: false }),
  ).toBeNull();
  expect(localStorage.getItem(dockLayoutKey(true))).toBeNull();
});

it("discards oversized documents", () => {
  localStorage.setItem(KEY, " ".repeat(MAX_LAYOUT_BYTES + 1));
  expect(loadDockLayout(KEY, { allowFloating: true })).toBeNull();
  expect(localStorage.getItem(KEY)).toBeNull();
});
