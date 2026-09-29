import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_STORAGE_KEY, applyNetworkLock, getActiveNetwork, getNetworkLock, siteUrlFor } from "@/lib/network";

afterEach(() => { vi.unstubAllEnvs(); localStorage.clear(); });

describe("network lock (testnet.rougechain.io / rougechain.io)", () => {
  it("unset: the saved choice decides, as before", () => {
    vi.stubEnv("VITE_NETWORK_LOCK", "");
    localStorage.setItem(NETWORK_STORAGE_KEY, "testnet");
    expect(getNetworkLock()).toBeNull();
    expect(getActiveNetwork()).toBe("testnet");
  });

  it("a pinned deploy always reports its network and rewrites the saved choice", () => {
    vi.stubEnv("VITE_NETWORK_LOCK", "testnet");
    localStorage.setItem(NETWORK_STORAGE_KEY, "mainnet");
    expect(getActiveNetwork()).toBe("testnet");
    applyNetworkLock();
    expect(localStorage.getItem(NETWORK_STORAGE_KEY)).toBe("testnet");
  });

  it("links to the other network's site", () => {
    expect(siteUrlFor("mainnet")).toBe("https://rougechain.io");
    expect(siteUrlFor("testnet")).toBe("https://testnet.rougechain.io");
  });
});
