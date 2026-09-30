/**
 * Wallet area in other languages: the Settings language selector switches the whole page (and
 * persists the choice under apps/web's key), and the send validators speak the current language.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LanguageDetector from "i18next-browser-languagedetector";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n, { LANGUAGE_STORAGE_KEY } from "../i18n";
import SettingsPage from "./SettingsPage";
import { WalletProvider } from "./WalletProvider";
import { parseAmount } from "./send";
import { mockFetch, resetBrowserState, seedAppsWebWallet } from "./test-utils";

function renderSettings() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WalletProvider autoRegister={false}>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </WalletProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetBrowserState();
  mockFetch();
  // The browser build caches the choice through the language detector; tests init i18n without
  // one, so attach the same detector config (apps/web's key) for this file.
  const detector = new LanguageDetector(i18n.services, { order: ["localStorage"], lookupLocalStorage: LANGUAGE_STORAGE_KEY, caches: ["localStorage"] });
  i18n.services.languageDetector = detector;
});
afterEach(() => {
  Reflect.deleteProperty(i18n.services, "languageDetector");
});

describe("wallet i18n", () => {
  it("switches Settings to Japanese and Spanish from the language selector and remembers it", async () => {
    seedAppsWebWallet();
    renderSettings();
    const user = userEvent.setup();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "EN" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "日本語" }));
    expect(await screen.findByRole("heading", { level: 1, name: "設定" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "セキュリティとバックアップ" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "残高を隠す" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "メインネット" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "日本語" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("ja");

    await user.click(screen.getByRole("radio", { name: "ES" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Ajustes" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Seguridad y respaldo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mainnet" })).toBeInTheDocument(); // es keeps Mainnet
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("es");
  });

  it("validates XRGE sends in the current language (fee rule unchanged)", async () => {
    const balances = [{ symbol: "XRGE", name: "RougeCoin", balance: 5 }] as Parameters<typeof parseAmount>[2];
    expect(parseAmount("1.5", "XRGE", balances)).toEqual({ valid: false, error: "XRGE amounts must be whole numbers" });
    await i18n.changeLanguage("zh");
    expect(parseAmount("1.5", "XRGE", balances)).toEqual({ valid: false, error: "XRGE 数量必须为整数" });
    expect(parseAmount("5", "XRGE", balances)).toEqual({ valid: false, error: "XRGE 不足以支付手续费。发送需要 1 XRGE" });
    expect(parseAmount("4", "XRGE", balances)).toMatchObject({ valid: true, raw: 4 });
  });
});
