import { describe, it, expect } from "vitest";
import { apps, appHref, appById, globalApps, globalAppGroups } from "./apps";
describe("ecosystem registry", () => {
  it("uses unique identities and reachable destinations", () => {
    expect(new Set(apps.map((a) => a.id)).size).toBe(apps.length);
    for (const a of apps) {
      expect(appHref(a)).toMatch(/^(\/|https:\/\/)/);
      if (a.status === "preview")
        expect(appHref(a)).toBe(`/workspace?open=${a.id}`);
    }
  });
  it("keeps proposed hosts separate from destinations", () => {
    expect(appHref(appById("wallet")!)).not.toContain("wallet.rougechain.io");
    expect(appById("explorer")!.localNavigation).toHaveLength(6);
    expect(appById("swap")!.localNavigation).toHaveLength(3);
  });
});

it("classifies user-facing apps for global navigation", () => {
  expect(globalApps.map((a) => a.name)).toEqual([
    "Qwalla Mobile Wallet",
    "Web Wallet",
    "Wallet Extension",
    "Rougee",
    "qWave",
    "Arcade",
    "Messenger",
    "Mail",
    "Swap",
    "Bridge",
    "Explorer",
    "Validators",
  ]);
  expect(globalAppGroups).toEqual(["Hold", "Trade", "Play", "Talk", "Explore"]);
  expect(apps.filter((a) => a.kind === "developer-resource")).toHaveLength(5);
  expect(appById("liquidity")?.kind).toBe("utility");
  expect(appById("network")?.kind).toBe("utility");
});
