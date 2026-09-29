import { it, expect } from "vitest";
import {
  defaultLayout,
  floatingAllowed,
  launcherState,
  planOpen,
  planOpenBlock,
  withHidden,
  withoutHidden,
} from "./dockModel";

const snap = {
  open: ["Network", "Explorer", "Ecosystem"],
  hidden: ["Wallet" as const],
  active: "Network",
};

it("starts from the calm Network / Explorer / Ecosystem default", () => {
  expect(defaultLayout.map((p) => p.view)).toEqual([
    "Network",
    "Explorer",
    "Ecosystem",
  ]);
});

it("labels launcher entries Focused / Open / Hidden / Not opened", () => {
  expect(launcherState("Network", snap)).toBe("Focused");
  expect(launcherState("Explorer", snap)).toBe("Open");
  expect(launcherState("Wallet", snap)).toBe("Hidden");
  expect(launcherState("Swap", snap)).toBe("Not opened");
});

it("opens singletons by focusing, restoring or adding — never duplicating", () => {
  expect(planOpen("Explorer", snap)).toBe("focus");
  expect(planOpen("Wallet", snap)).toBe("restore");
  expect(planOpen("Swap", snap)).toBe("add");
});

it("keys Block Detail windows by hash and groups them with Explorer", () => {
  expect(planOpenBlock("abc", snap)).toEqual({
    id: "block-abc",
    plan: "add",
    groupWith: "Explorer",
  });
  expect(
    planOpenBlock("abc", { ...snap, open: [...snap.open, "block-abc"] }),
  ).toEqual({ id: "block-abc", plan: "focus" });
  expect(
    planOpenBlock("abc", { ...snap, open: ["Network"] }).groupWith,
  ).toBeUndefined();
});

it("tracks hidden views without duplicates", () => {
  expect(withHidden(["Wallet"], "Wallet")).toEqual(["Wallet"]);
  expect(withHidden([], "Swap")).toEqual(["Swap"]);
  expect(withoutHidden(["Wallet", "Swap"], "Wallet")).toEqual(["Swap"]);
});

it("allows floating only in the full workspace", () => {
  expect(floatingAllowed(true)).toBe(false);
  expect(floatingAllowed(false)).toBe(true);
});
