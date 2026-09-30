/**
 * Key parity with apps/web (the live rougechain.io on the same origin): values apps/web keeps
 * OUTSIDE @rougechain/core are pinned against apps/web's own source, so a visitor's settings,
 * hidden balances and "tour seen" flag carry over when rougechain.io switches to site-next.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { loadNotificationSettings } from "@rougechain/core/notifications";
import { getPrivacySettings } from "@rougechain/core/pqc-messenger";
import { getVaultSettings, lockUnifiedWallet, unlockUnifiedWallet } from "@rougechain/core/unified-wallet";
// apps/web's real hook (plain React, no aliases) — rendered with this app's React.
import { useHideBalances as useAppsWebHideBalances } from "../../../web/src/hooks/use-hide-balances";
import { HIDE_BALANCES_KEY, MASKED_AMOUNT, useHideBalances } from "./hooks";
import { OPEN_TOUR_EVENT, TOUR_SECTIONS, TOUR_SEEN_KEY, hasSeenTour, markTourSeen } from "./tour";
import { AUTO_LOCK_OPTIONS } from "./SettingsPage";
import { LANGUAGE_STORAGE_KEY } from "../i18n";
import enWallet from "../i18n/locales/en/wallet.json";
import SettingsPage from "./SettingsPage";
import { WalletProvider } from "./WalletProvider";
import { mockFetch, resetBrowserState, seedAppsWebWallet } from "./test-utils";

const WEB = path.resolve(__dirname, "../../../web/src");
const webSource = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");
const constant = (src: string, name: string) => src.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`))?.[1];

beforeEach(() => {
  resetBrowserState();
  mockFetch();
});

describe("hide balances", () => {
  it("uses apps/web's key, value and mask", () => {
    const src = webSource("hooks/use-hide-balances.ts");
    expect(constant(src, "STORAGE_KEY")).toBe(HIDE_BALANCES_KEY);
    expect(constant(src, "MASKED_AMOUNT")).toBe(MASKED_AMOUNT);
  });
  it("round-trips with apps/web's actual hook both ways", () => {
    const next = renderHook(() => useHideBalances());
    act(() => next.result.current.toggle());
    expect(localStorage.getItem(HIDE_BALANCES_KEY)).toBe("1");
    expect(renderHook(() => useAppsWebHideBalances()).result.current.hidden).toBe(true);

    const web = renderHook(() => useAppsWebHideBalances());
    act(() => web.result.current.toggle()); // apps/web un-hides
    expect(localStorage.getItem(HIDE_BALANCES_KEY)).toBeNull();
    expect(renderHook(() => useHideBalances()).result.current.hidden).toBe(false);
  });
});

describe("tour / onboarding flags", () => {
  it("uses apps/web's tour-seen key, value and open event", () => {
    const src = webSource("lib/tour.ts");
    expect(constant(src, "TOUR_SEEN_KEY")).toBe(TOUR_SEEN_KEY);
    expect(constant(src, "OPEN_TOUR_EVENT")).toBe(OPEN_TOUR_EVENT);
    expect(src).toContain('storage.getItem(TOUR_SEEN_KEY) === "1"');
    localStorage.setItem(TOUR_SEEN_KEY, "1"); // seen on apps/web
    expect(hasSeenTour()).toBe(true);
    localStorage.clear();
    markTourSeen();
    expect(localStorage.getItem(TOUR_SEEN_KEY)).toBe("1");
  });
  it("shows the same tour, in the same order, with apps/web's copy", () => {
    const src = webSource("lib/tour.ts");
    const ids = [...src.matchAll(/\{ id: "([a-z]+)"/g)].map((m) => m[1]);
    expect(TOUR_SECTIONS.map((s) => s.id)).toEqual(ids);
    // Tour copy lives in the `wallet` namespace and is apps/web's `tour` block, in every language.
    for (const lng of ["en", "es", "zh", "ja"]) {
      const web = JSON.parse(webSource(`i18n/locales/${lng}.json`)).tour;
      const ours = JSON.parse(readFileSync(path.resolve(__dirname, `../i18n/locales/${lng}/wallet.json`), "utf8")).tour;
      expect(ours).toEqual(web);
    }
    for (const s of TOUR_SECTIONS) expect(Object.keys(enWallet.tour.sections)).toContain(s.id);
  });
});

describe("settings persistence", () => {
  it("keeps apps/web's constants (auto-lock choices, language key)", () => {
    expect(webSource("pages/Settings.tsx")).toContain(`const AUTO_LOCK_OPTIONS = [${AUTO_LOCK_OPTIONS.join(", ")}];`);
    expect(constant(webSource("i18n/index.ts"), "LANGUAGE_STORAGE_KEY")).toBe(LANGUAGE_STORAGE_KEY);
  });

  it("reads and writes Settings through core, under the keys apps/web reads", async () => {
    seedAppsWebWallet();
    await lockUnifiedWallet("pw-settings");
    await unlockUnifiedWallet("pw-settings");
    // Values apps/web wrote earlier.
    localStorage.setItem("pqc_notification_settings", JSON.stringify({ enabled: true, sound: false, desktopEnabled: false }));
    localStorage.setItem("pqc_privacy_settings", JSON.stringify({ storeSentMessages: true, discoverable: false }));
    localStorage.setItem("pqc-unified-wallet-vault-settings:mainnet", JSON.stringify({ autoLockMinutes: 15 }));
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <WalletProvider autoRegister={false}>
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </WalletProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    expect(screen.getByRole("switch", { name: "Sound" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Discoverable" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "15 min" })).toHaveAttribute("aria-pressed", "true");
    // The language selector (EN / ES / 中文 / 日本語) writes the same key apps/web reads.
    expect(screen.getByRole("radio", { name: "ES" })).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Sound" }));
    await user.click(screen.getByRole("switch", { name: "Discoverable" }));
    await user.click(screen.getByRole("button", { name: "30 min" }));
    await user.click(screen.getByRole("switch", { name: "Hide balances" }));

    // apps/web reads these with the same core functions / keys.
    expect(loadNotificationSettings()).toEqual({ enabled: true, sound: true, desktopEnabled: false });
    expect(getPrivacySettings().discoverable).toBe(true);
    expect(getVaultSettings().autoLockMinutes).toBe(30);
    expect(JSON.parse(localStorage.getItem("pqc-unified-wallet-vault-settings:mainnet")!)).toEqual({ autoLockMinutes: 30 });
    expect(localStorage.getItem(HIDE_BALANCES_KEY)).toBe("1");
  });
});
