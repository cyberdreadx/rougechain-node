import { it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import WorkspaceExperience from "./WorkspaceExperience";
import { setDesktop, wrap } from "./testWrap";

// The lazily loaded dockview chunk fails (e.g. a network error or a runtime throw).
vi.mock("./DockviewWorkspace", () => {
  throw new Error("chunk failed to load");
});
const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

it("falls back to the compact workspace when the dockview chunk throws", async () => {
  setDesktop(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  wrap(<WorkspaceExperience embedded />);
  expect(await screen.findByText(/Workspace unavailable/)).toBeInTheDocument();
  expect(
    screen.getByRole("tablist", { name: "Workspace panels" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Network" })).toBeEnabled();
});
