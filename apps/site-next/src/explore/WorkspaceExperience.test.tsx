import { it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WorkspaceExperience from "./WorkspaceExperience";
import { setDesktop, wrap } from "./testWrap";

vi.mock("./DockviewWorkspace", () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="dockview" data-embedded={String(embedded)} />
  ),
}));
const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

it("uses the interactive dockview workspace on desktop and toggles Simple view", async () => {
  setDesktop(true);
  const user = userEvent.setup();
  wrap(<WorkspaceExperience embedded />);
  expect(await screen.findByTestId("dockview")).toHaveAttribute(
    "data-embedded",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Simple view" }));
  expect(screen.queryByTestId("dockview")).not.toBeInTheDocument();
  expect(
    screen.getByRole("tablist", { name: "Workspace panels" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Interactive view" }));
  expect(await screen.findByTestId("dockview")).toBeInTheDocument();
});

it("uses the compact workspace below 900px, without the toggle", () => {
  setDesktop(false);
  wrap(<WorkspaceExperience />);
  expect(screen.queryByTestId("dockview")).not.toBeInTheDocument();
  expect(
    screen.getByRole("tablist", { name: "Workspace panels" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Simple view" }),
  ).not.toBeInTheDocument();
});
