import { WalletProvider } from "./wallet/WalletProvider";
import { MemoryRouter } from "react-router-dom";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, it, expect } from "vitest";
import i18n from "./i18n";
import Home from "./Home";
import Architecture from "./Architecture";
import { NetworkProvider } from "./Network";

function wrap(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unavailable")));
  return render(
    <QueryClientProvider client={client}>
      <WalletProvider autoRegister={false}>
        <NetworkProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </NetworkProvider>
      </WalletProvider>
    </QueryClientProvider>,
  );
}

it("renders the homepage in Japanese and switches to Chinese", async () => {
  await act(() => i18n.changeLanguage("ja"));
  wrap(<Home />);
  const h1 = screen.getByRole("heading", { level: 1 });
  expect(h1).toHaveTextContent("ポスト量子を、ジェネシスから。");
  expect(h1.querySelector(".gradient-text")).toHaveTextContent("ジェネシスから。");
  expect(screen.getByRole("heading", { name: "次の章を築く。" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "あなたの資産を、 次の時代へ。" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /通信/ })).toBeInTheDocument();
  // Team roles are translated; names are not.
  expect(screen.getByText("創業者 / リード開発者")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Brandon Menard" })).toBeInTheDocument();
  expect(screen.queryByText("Start building")).not.toBeInTheDocument();

  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("后量子自创世起。");
  expect(screen.getByRole("heading", { name: "书写下一篇章。" })).toBeInTheDocument();
});

it("renders the architecture page in Spanish", async () => {
  await act(() => i18n.changeLanguage("es"));
  wrap(<Architecture />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Una identidad.Aplicaciones independientes.",
  );
  expect(screen.getByText("Avanza con intención.")).toBeInTheDocument();
});
