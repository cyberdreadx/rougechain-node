import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExplorerSite, {
  MAIN_SITE_URL,
  activeExplorerItem,
} from "./ExplorerSite";
import { appById } from "./ecosystem/apps";

// Every node read fails: these tests cover the standalone shell, not data (explorer.test.tsx does that).
function offlineNode() {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    return { ok: false, status: 503, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSiteAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<ExplorerSite />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("explorer.rougechain.io (standalone Explorer)", () => {
  it("serves the Explorer overview at /", async () => {
    offlineNode();
    renderSiteAt("/");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Explorer" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("has no wallet, signing or marketing chrome — only a way back to rougechain.io", async () => {
    offlineNode();
    renderSiteAt("/");
    await screen.findByRole("heading", { level: 1, name: "Explorer" });
    expect(
      screen.queryByRole("button", { name: /connect/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet/i)).not.toBeInTheDocument();
    const back = screen.getAllByRole("link", { name: /rougechain\.io/ });
    expect(back.length).toBeGreaterThan(0);
    for (const a of back) expect(a).toHaveAttribute("href", MAIN_SITE_URL);
  });

  it("keeps the Explorer's paths and shows a not-found page for anything else", async () => {
    offlineNode();
    renderSiteAt("/swap");
    expect(
      await screen.findByRole("heading", { name: "Page not found." }),
    ).toBeInTheDocument();
  });

  it("lights up the right section on detail pages", () => {
    const items = appById("explorer")!.localNavigation ?? [];
    expect(activeExplorerItem("/", items)).toBe("/explorer");
    expect(activeExplorerItem("/block/200", items)).toBe("/explorer/blocks");
    expect(activeExplorerItem("/token/QTEK", items)).toBe(
      items.find((i) => i.match?.includes("/token"))?.path,
    );
  });
});
