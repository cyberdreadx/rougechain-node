import { it, expect, vi, beforeEach } from "vitest";
import { STORAGE_KEY, prepareStoredLayout } from "./persistence";
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
});
it.each(["{broken", "{}", "null", '{"schema":1,"version":0}'])(
  "clears incompatible stored layout %s",
  (raw) => {
    window.localStorage.setItem(STORAGE_KEY, raw);
    prepareStoredLayout();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  },
);
it("does not fail when browser storage is unavailable", () => {
  vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
    throw new Error("Denied");
  });
  vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
    throw new Error("Denied");
  });
  expect(() => prepareStoredLayout()).not.toThrow();
});
it("preserves a compatible singleton workspace", () => {
  const raw = JSON.stringify({
    schema: 1,
    version: 1,
    root: { type: "split" },
    views: Object.fromEntries(
      ["Network", "Explorer", "Ecosystem", "Build", "Security"].map((type) => [
        type,
        { type },
      ]),
    ),
  });
  window.localStorage.setItem(STORAGE_KEY, raw);
  prepareStoredLayout();
  expect(window.localStorage.getItem(STORAGE_KEY)).toBe(raw);
  window.localStorage.removeItem(STORAGE_KEY);
});
