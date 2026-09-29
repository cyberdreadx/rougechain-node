import { it, expect, vi, beforeEach } from "vitest";
import {
  defaultViews,
  resolveWorkspaceView,
  prepareV2Layout,
  workspaceKey,
} from "./model";
beforeEach(() => {
  const data = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  });
});
it("resolves route parameters through registry and keeps the default calm", () => {
  expect(defaultViews).toEqual(["Network", "Explorer", "Ecosystem"]);
  expect(resolveWorkspaceView("wallet")).toBe("Wallet");
  expect(resolveWorkspaceView("sdk")).toBe("Build");
  expect(resolveWorkspaceView("unknown")).toBeUndefined();
});
it("discards invalid and old documents without touching v1", () => {
  localStorage.setItem("rougechain-poc-explore-layout-v1", "preserve");
  localStorage.setItem(workspaceKey(), "{broken");
  prepareV2Layout(workspaceKey());
  expect(localStorage.getItem(workspaceKey())).toBeNull();
  expect(localStorage.getItem("rougechain-poc-explore-layout-v1")).toBe(
    "preserve",
  );
});
it("preserves hidden views and rejects duplicate singleton records", () => {
  const doc = {
    schema: 1,
    version: 2,
    root: null,
    views: { a: { type: "Wallet" } },
    hidden: [
      {
        panel: { kind: "panel", id: "p", views: ["a"], selected: "a" },
        restore: { kind: "docked", beside: "b", edge: "right", share: 0.5 },
      },
    ],
    floating: [],
  };
  localStorage.setItem(workspaceKey(), JSON.stringify(doc));
  prepareV2Layout(workspaceKey());
  expect(localStorage.getItem(workspaceKey())).not.toBeNull();
  localStorage.setItem(
    workspaceKey(),
    JSON.stringify({
      ...doc,
      views: { a: { type: "Wallet" }, b: { type: "Wallet" } },
    }),
  );
  prepareV2Layout(workspaceKey());
  expect(localStorage.getItem(workspaceKey())).toBeNull();
});

it("rejects malformed layout trees and invalid persisted block data", () => {
  for (const doc of [
    {
      schema: 1,
      version: 2,
      root: { kind: "bogus" },
      views: {},
      hidden: [],
      floating: [],
    },
    {
      schema: 1,
      version: 2,
      root: null,
      views: { a: { type: "BlockDetail", params: { timestamp: "bad" } } },
      hidden: [],
      floating: [],
    },
  ]) {
    localStorage.setItem(workspaceKey(), JSON.stringify(doc));
    prepareV2Layout(workspaceKey());
    expect(localStorage.getItem(workspaceKey())).toBeNull();
  }
});
it("allows unavailable storage without crashing", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw Error("denied");
    },
    removeItem: () => {
      throw Error("denied");
    },
  });
  expect(() => prepareV2Layout(workspaceKey())).not.toThrow();
});
