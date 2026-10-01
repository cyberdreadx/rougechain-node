import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import i18n from "./i18n";
import { Footer, AppHeader } from "./Shell";
import { NetworkProvider } from "./Network";
import { WalletProvider } from "./wallet/WalletProvider";
import { ExplorerRoutes } from "./ExplorerSite";

it("switches the footer from Spanish to Japanese through the language switcher", async () => {
  await act(() => i18n.changeLanguage("es"));
  render(
    <MemoryRouter>
      <Footer />
    </MemoryRouter>,
  );
  expect(screen.getByText("Post-cuántica desde el génesis.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sistema de diseño" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Idioma" }));
  await userEvent.click(screen.getByRole("option", { name: /日本語/ }));
  expect(i18n.language).toBe("ja");
  expect(await screen.findByText("ジェネシスからポスト量子。")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "デザインシステム" })).toBeInTheDocument();
  expect(screen.queryByText("Post-cuántica desde el génesis.")).not.toBeInTheDocument();
});

it("renders the app header, app switcher and local navigation in Chinese", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  await act(() => i18n.changeLanguage("zh"));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WalletProvider autoRegister={false}>
        <NetworkProvider>
          <MemoryRouter initialEntries={["/explorer/blocks"]}>
            <AppHeader product="Explorer" />
          </MemoryRouter>
        </NetworkProvider>
      </WalletProvider>
    </QueryClientProvider>,
  );
  expect(screen.getByRole("link", { name: "区块" })).toHaveAttribute("aria-current", "page");
  await userEvent.click(screen.getByRole("button", { name: "应用" }));
  const dialog = screen.getByRole("dialog", { name: "RougeChain 应用" });
  expect(within(dialog).getByRole("link", { name: /网页钱包/ })).toHaveAttribute("href", "/wallet");
  expect(within(dialog).getByRole("heading", { name: "持有" })).toBeInTheDocument();
});

it("shows the explorer 404 in Japanese", async () => {
  await act(() => i18n.changeLanguage("ja"));
  render(
    <MemoryRouter initialEntries={["/nowhere/at/all"]}>
      <ExplorerRoutes />
    </MemoryRouter>,
  );
  expect(screen.getByRole("heading", { name: "ページが見つかりません。" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "エクスプローラーのホーム" })).toHaveAttribute("href", "/");
});
