/** BaseWalletCard rendering + `base` i18n parity. Fetch is stubbed — no network. */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import BaseWalletCard from "@/components/wallet/BaseWalletCard";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import zh from "@/i18n/locales/zh.json";
import ja from "@/i18n/locales/ja.json";

const M12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function keys(o: unknown, prefix = ""): string[] {
  if (o === null || typeof o !== "object") return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("BaseWalletCard", () => {
  it("explains (not errors) when the wallet has no recovery phrase", () => {
    render(<BaseWalletCard mnemonic={undefined} ethPriceUsd={null} xrgePriceUsd={null} />);
    expect(screen.getByText(en.base.noMnemonic.title)).toBeInTheDocument();
  });

  it("shows the phrase-derived address and balances", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const { id, method } = JSON.parse(String(init.body));
      const result = method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x" + (2_500_000n).toString(16);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
    }));
    render(<BaseWalletCard mnemonic={M12} ethPriceUsd={2000} xrgePriceUsd={null} />);
    expect(await screen.findByText("0x9858EfFD232B4033E47d90003D41EC34EcaEda94")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument()); // 1 ETH
    expect(screen.getByText("2.5")).toBeInTheDocument(); // 2.5 USDC (6 decimals)
  });

  it("degrades gracefully when Base is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    render(<BaseWalletCard mnemonic={M12} ethPriceUsd={null} xrgePriceUsd={null} />);
    expect(await screen.findByText(/Couldn't reach/)).toBeInTheDocument();
  });
});

describe("base i18n namespace", () => {
  it("has the same keys in en/es/zh/ja", () => {
    const want = keys(en.base).sort();
    for (const l of [es, zh, ja]) expect(keys(l.base).sort()).toEqual(want);
  });
});
