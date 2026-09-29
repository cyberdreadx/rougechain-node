import { it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DockviewWorkspace from "./DockviewWorkspace";
import { wrap } from "./testWrap";

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

it("renders the default panes with real dockview", async () => {
  wrap(<DockviewWorkspace embedded={false} />);
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
    "Network",
    "Explorer",
    "Ecosystem",
  ]);
});

const launcherState = (name: string) =>
  within(screen.getByRole("navigation", { name: "Workspace launcher" }))
    .getByRole("button", { name: `Open ${name}` })
    .querySelector("small")?.textContent;

it("launcher opens, focuses and restores singleton views; hide keeps their state", async () => {
  const user = userEvent.setup();
  wrap(<DockviewWorkspace embedded={false} />);
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
  expect(launcherState("Swap")).toBe("Not opened");

  await user.click(screen.getByRole("button", { name: "Open Swap" }));
  await waitFor(() => expect(launcherState("Swap")).toBe("Focused"));
  const input = screen.getByRole("spinbutton");
  await user.clear(input);
  await user.type(input, "4242");

  await user.click(screen.getByRole("button", { name: "Hide Swap" }));
  await waitFor(() => expect(launcherState("Swap")).toBe("Hidden"));
  expect(screen.queryByRole("tab", { name: "Swap" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Open Swap" }));
  await waitFor(() => expect(launcherState("Swap")).toBe("Focused"));
  expect(screen.getByRole("spinbutton")).toHaveValue(4242); // same mounted content
  await user.click(screen.getByRole("button", { name: "Open Swap" }));
  expect(screen.getAllByRole("tab", { name: "Swap" })).toHaveLength(1);
});

it("keys Block Detail windows by hash, grouped with Explorer", async () => {
  const user = userEvent.setup();
  wrap(<DockviewWorkspace embedded={false} />);
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
  const first = await screen.findAllByRole("button", { name: /#\d+/ });
  await user.click(first[0]);
  const block = await screen.findByRole("tab", { name: /Block #/ });
  const explorer = screen.getByRole("tab", { name: "Explorer" });
  expect(block.parentElement).toBe(explorer.parentElement);
  await user.click(screen.getByRole("tab", { name: "Explorer" }));
  await user.click((await screen.findAllByRole("button", { name: /#\d+/ }))[0]);
  expect(screen.getAllByRole("tab", { name: /Block #/ })).toHaveLength(1);
});

it("the full workspace offers floating; the homepage embed does not", async () => {
  const user = userEvent.setup();
  const full = wrap(<DockviewWorkspace embedded={false} />);
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
  await user.click(screen.getByRole("button", { name: "Network panel menu" }));
  expect(screen.getByRole("menuitem", { name: "Float" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  full.unmount();

  wrap(<DockviewWorkspace embedded />);
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
  await user.click(screen.getByRole("button", { name: "Network panel menu" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Float" }),
  ).not.toBeInTheDocument();
});

it("maximize, overview and reset restore the default workspace", async () => {
  const user = userEvent.setup();
  wrap(<DockviewWorkspace embedded={false} />);
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
  await user.click(screen.getByRole("button", { name: "Maximize Explorer" }));
  expect(
    screen.getByRole("button", { name: "Restore Explorer" }),
  ).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "Overview" }));
  expect(
    screen.getByRole("button", { name: "Maximize Explorer" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Hide Network" }));
  await waitFor(() => expect(launcherState("Network")).toBe("Hidden"));
  await user.click(screen.getByRole("button", { name: "Reset workspace" }));
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
  expect(launcherState("Network")).not.toBe("Hidden");
});

it("saves the layout under the new versioned key", async () => {
  wrap(<DockviewWorkspace embedded />);
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
  await waitFor(() =>
    expect(
      localStorage.getItem("rougechain-dockview-embed-layout-v1"),
    ).not.toBeNull(),
  );
  const saved = JSON.parse(
    localStorage.getItem("rougechain-dockview-embed-layout-v1")!,
  );
  expect(saved).toMatchObject({ schema: "rougechain-dockview", version: 1 });
  expect(Object.keys(saved.layout.panels).sort()).toEqual([
    "Ecosystem",
    "Explorer",
    "Network",
  ]);
});
