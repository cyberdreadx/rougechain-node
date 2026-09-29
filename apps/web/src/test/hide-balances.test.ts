import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHideBalances } from "@/hooks/use-hide-balances";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("hide balances toggle", () => {
  it("defaults to shown and persists the choice", () => {
    const { result, unmount } = renderHook(() => useHideBalances());
    expect(result.current.hidden).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.hidden).toBe(true);
    unmount();
    expect(renderHook(() => useHideBalances()).result.current.hidden).toBe(true);
  });

  it("still works when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { result } = renderHook(() => useHideBalances());
    expect(result.current.hidden).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.hidden).toBe(true);
  });
});
