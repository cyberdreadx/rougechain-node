import { DemoWalletProvider } from "./wallet/DemoWalletProvider";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, it, expect } from "vitest";
import Home from "./Home";
import Explorer from "./Explorer";
import Swap, { quote } from "./Swap";
import DesignSystem from "./DesignSystem";
import { NetworkProvider, NetworkControls, DataNote } from "./Network";
import { WorkspaceBoundary as ExploreBoundary } from "./explore/WorkspaceExperience";
import MobileExplore from "./explore/CompactWorkspace";
function wrap(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unavailable")));
  return render(
    <QueryClientProvider client={client}>
      <DemoWalletProvider>
        <NetworkProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </NetworkProvider>
      </DemoWalletProvider>
    </QueryClientProvider>,
  );
}
it("renders the complete homepage with honest fallback", async () => {
  wrap(<Home />);
  expect(
    screen.getByRole("heading", { name: "Post-quantum from genesis." }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Building the next chapter." }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getAllByText("Demo · saved snapshot").length).toBeGreaterThan(
      0,
    ),
  );
  expect(screen.queryByText("MAINNET LIVE")).not.toBeInTheDocument();
});
it("renders the Explorer with a labelled snapshot and no synthetic data", async () => {
  wrap(<Explorer />);
  expect(screen.getByRole("heading", { name: "Explorer" })).toBeInTheDocument();
  await screen.findAllByText("200");
  expect(screen.getAllByText("Snapshot").length).toBeGreaterThan(0);
  expect(
    screen.getByText(/From the saved snapshot. Not live data./),
  ).toBeInTheDocument();
  expect(
    await screen.findByText("Transactions unavailable"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Synthetic demo")).not.toBeInTheDocument();
  expect(screen.queryByText(/rc_demo_/)).not.toBeInTheDocument();
});
it("renders the design system and its modal", async () => {
  wrap(<DesignSystem />);
  expect(
    screen.getByRole("heading", { name: /A shared language/ }),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Open modal specimen" }),
  );
  expect(screen.getByRole("dialog")).toHaveAttribute("open");
  await userEvent.click(screen.getByRole("button", { name: "Close specimen" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("uses keyboard-navigable mobile tabs and shared content", async () => {
  wrap(<MobileExplore />);
  const first = screen.getByRole("tab", { name: "Network" });
  first.focus();
  await userEvent.keyboard("{End}");
  expect(screen.getByRole("tab", { name: "Ecosystem" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.getByText("Your ecosystem. One workspace."),
  ).toBeInTheDocument();
  await userEvent.keyboard("{Home}{ArrowRight}");
  expect(screen.getByRole("tab", { name: "Explorer" })).toHaveFocus();
});
it("keeps the functional launcher if Trellis throws", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never {
    throw new Error("chunk failed");
  }
  wrap(
    <ExploreBoundary>
      <Broken />
    </ExploreBoundary>,
  );
  expect(
    screen.getByText(/Interactive layout unavailable/),
  ).toBeInTheDocument();
  for (const name of ["Network", "Explorer", "Ecosystem", "Build", "Security"])
    expect(
      screen.getByRole("button", { name: `Open ${name}` }),
    ).toBeInTheDocument();
});
it("switches to explicit snapshot mode", async () => {
  wrap(
    <>
      <NetworkControls />
      <DataNote />
    </>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Snapshot" }));
  expect(screen.getByRole("button", { name: "Snapshot" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByText("Demo · saved snapshot")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Refresh network data" }),
  ).toBeDisabled();
});
it("Swap review and token changes never perform a request", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<Swap />);
  expect(screen.getByRole("heading", { name: "Swap" })).toBeInTheDocument();
  await userEvent.selectOptions(
    screen.getByLabelText("Receive token"),
    "qUSDC",
  );
  await userEvent.click(screen.getByRole("button", { name: "Review swap" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText(/All values are synthetic/)).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Demo only — close preview" }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each(["Loading quote", "Insufficient balance", "Network unavailable"])(
  "disables review for %s",
  async (state) => {
    render(<Swap />);
    await userEvent.selectOptions(
      screen.getByLabelText("Preview an interface state"),
      state,
    );
    expect(screen.getByRole("button", { name: "Review swap" })).toBeDisabled();
  },
);
it("shows high impact warning both before and during review", async () => {
  render(<Swap />);
  await userEvent.selectOptions(
    screen.getByLabelText("Preview an interface state"),
    "High price impact",
  );
  await userEvent.click(screen.getByRole("button", { name: "Review swap" }));
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "High price impact: 8.2%",
  );
});
it.each(["-1", "NaN", "Infinity", "0", "1000000000001"])(
  "rejects invalid illustrative amount %s",
  (value) => {
    expect(quote(value, "XRGE", "qETH")).toBeNull();
  },
);
it("does not allow identical token pairs", () => {
  expect(quote("100", "XRGE", "XRGE")).toBeNull();
});

it("preserves a stale successful response when refresh fails", async () => {
  const { demoSnapshot } = await import("@rougechain/chain-readonly");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  client.setQueryData(
    ["network", "mainnet"],
    { ...demoSnapshot, height: 777 },
    { updatedAt: Date.now() - 120000 },
  );
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
  render(
    <QueryClientProvider client={client}>
      <DemoWalletProvider>
        <NetworkProvider>
          <MemoryRouter>
            <DataNote />
            <Explorer />
          </MemoryRouter>
        </NetworkProvider>
      </DemoWalletProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getAllByText("Stale · last successful read").length,
    ).toBeGreaterThan(0),
  );
  expect(screen.getByText("777")).toBeInTheDocument();
  expect(screen.queryByText("Demo · saved snapshot")).not.toBeInTheDocument();
});
it("copies exact identifiers and exposes a fallback when clipboard is denied", async () => {
  const { CopyHash } = await import("./Explorer");
  const writer = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Denied"));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writer },
  });
  render(<CopyHash hash="exact-demo-hash" />);
  await userEvent.click(
    screen.getByRole("button", { name: "Copy hash exact-demo-hash" }),
  );
  expect(writer).toHaveBeenCalledWith("exact-demo-hash");
  expect(screen.getByRole("status")).toHaveTextContent("Hash copied");
  await userEvent.click(
    screen.getByRole("button", { name: "Copy hash exact-demo-hash" }),
  );
  expect(screen.getByText("exact-demo-hash")).toBeInTheDocument();
});
