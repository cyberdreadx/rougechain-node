/**
 * The /shield page with the worker stubbed (the WebAssembly package itself is exercised by
 * loop.test.ts and payments.test.ts, and in the browser by scripts/shield-e2e.mjs):
 *   - flag off → the route renders nothing and nothing of the shield code / wasm is fetched;
 *   - wallets without a phrase / provider wallets get no shielded address, with the reason;
 *   - read-only below three nodes;
 *   - the restore screen: the sentences of UI_CONTRACT limits 5 and 7, the embargo in blocks with
 *     the observed rate beside it, and the confirmation gated exactly as obligation 1 says;
 *   - the copy contains none of the forbidden words in any locale;
 *   - code inspection: every call site of assert_sole_copy; no timer gates a payment.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ChainProvider } from "../explorer/chain";
import { WalletProvider } from "../wallet/WalletProvider";
import { resetBrowserState, seedAppsWebWallet } from "../wallet/test-utils";
import { saveUnifiedWallet } from "@rougechain/core/unified-wallet";
import type { ShieldViewModel } from "./client";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { repoRoot } from "./testing/fixtures";
import { saveNodes } from "./config";
import ShieldPage from "./ShieldPage";

const ADDRESS = "rshield1" + "q".repeat(1966);
const FP = "0123456789abcdef";

function makeView(o: Partial<ShieldViewModel> = {}): ShieldViewModel {
  return {
    address: ADDRESS,
    origin: "imported",
    nodes: ["https://node-a.example", "https://node-b.example", "https://node-c.example"].map((origin, i) => ({ origin, listing: i === 0, banned: false, inactive: false, outdated: false, dissents: false, answeredStats: true })),
    quorum: 2,
    balances: { confirmed: "5000000000", unverified: "0", locked: "0", spendable: "0", expected_change: "0", below_minimum: { count: 0, total: "0" }, over_capacity: { count: 0, total: "0" }, received_spend_unknown: "0", unverified_spends: false },
    scanned_height: 21,
    confirmed_height: 21,
    quorum_tip: 21,
    spend: { can_spend_now: false, reason: "embargo", confirmed_height: 21, confirmed_lag: 0, usable_window_blocks: 64, embargo_until: 149, embargo_blocks_left: 128, view_only_since: null, default_expiry_blocks: 64, max_expiry_blocks: 128, restore_embargo_blocks: 128, restore_lag_bound_blocks: 256 },
    awaiting_base: false,
    sole_copy_asserted: false,
    stop: null,
    waiting: null,
    rechecking: false,
    pending: [],
    history: [],
    offer: false,
    shield: { available: true, reason: null, pool_total: "9000000000", pool_cap: "1000000000000000" },
    rate: { blocks_per_day: 12, days: 7 },
    events: [],
    leaves: 0,
    ...o,
  };
}

/** A stub worker: answers every request from `view()`; records the requests. */
function stubWorker(view: () => ShieldViewModel) {
  const requests: WorkerRequest[] = [];
  const factory = vi.fn(() => {
    const w = {
      onmessage: null as ((e: MessageEvent<WorkerResponse>) => void) | null,
      onerror: null,
      terminate: vi.fn(),
      postMessage(msg: WorkerRequest) {
        requests.push(msg);
        const reply: WorkerResponse = { id: msg.id, ok: true, view: view(), address: ADDRESS, fingerprint: FP, done: true, session: null };
        queueMicrotask(() => w.onmessage?.({ data: reply } as MessageEvent<WorkerResponse>));
      },
    };
    return w as unknown as Worker;
  });
  return { factory, requests };
}

async function renderShield(factory?: () => Worker) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ChainProvider>
        <WalletProvider autoRegister={false}>
          <MemoryRouter initialEntries={["/shield"]}>
            <Routes>
              <Route path="/shield" element={<ShieldPage workerFactory={factory} />} />
            </Routes>
          </MemoryRouter>
        </WalletProvider>
      </ChainProvider>
    </QueryClientProvider>,
  );
}

const THREE = [
  { origin: "https://node-a.example", operator: "operator A" },
  { origin: "https://node-b.example", operator: "operator B" },
  { origin: "https://node-c.example", operator: "operator C" },
];

beforeEach(() => {
  resetBrowserState();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("flag", () => {
  it("off: /shield renders nothing, no worker is started and nothing of the shield or the wasm is fetched", async () => {
    vi.stubEnv("VITE_SHIELD_V2_ENABLED", "");
    vi.resetModules();
    const workerCtor = vi.fn();
    vi.stubGlobal("Worker", workerCtor);
    seedAppsWebWallet();
    const { shieldArea } = await import("../features/shield");
    const { WalletProvider: FreshProvider } = await import("../wallet/WalletProvider");
    const { container } = render(
      <FreshProvider autoRegister={false}>
        <MemoryRouter initialEntries={["/shield"]}>
          <Routes>{shieldArea.routes}</Routes>
        </MemoryRouter>
      </FreshProvider>,
    );
    await act(async () => {});
    expect(container.innerHTML).toBe("");
    expect(shieldArea.headerProduct("/shield")).toBeNull();
    expect(workerCtor).not.toHaveBeenCalled();
    const fetched = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(fetched.filter((u) => /wasm|shield/.test(u))).toEqual([]);
  });

  it("off: the wallet's create() and import do not touch the shield code", async () => {
    vi.stubEnv("VITE_SHIELD_V2_ENABLED", "");
    const src = readFileSync(path.join(repoRoot(), "apps/site-next/src/wallet/WalletProvider.tsx"), "utf8");
    // the only references are dynamic imports inside the build-time flag tests (create, import)
    expect(src.match(/import\("\.\.\/shield\/host"\)/g)).toHaveLength(2);
    expect(src).toMatch(/if \(import\.meta\.env\.VITE_SHIELD_V2_ENABLED === "true" && wallet\.mnemonic\) \{\s+const phrase = wallet\.mnemonic;\s+void import\("\.\.\/shield\/host"\)/);
    expect(src).toMatch(/if \(import\.meta\.env\.VITE_SHIELD_V2_ENABLED === "true"\) \{\s+const network = getActiveNetwork\(\);\s+void import\("\.\.\/shield\/host"\)/);
  });
});

describe("the page (flag on, worker stubbed)", () => {
  beforeEach(() => vi.stubEnv("VITE_SHIELD_V2_ENABLED", "true"));

  it("a wallet without a recovery phrase gets no shielded address, and is told why", async () => {
    const w = seedAppsWebWallet();
    saveUnifiedWallet({ ...w, mnemonic: undefined });
    const { factory } = stubWorker(() => makeView());
    await renderShield(factory);
    expect(await screen.findByTestId("gate-raw")).toHaveTextContent(/created from a private key/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("a provider (extension / Qwalla) wallet: says it cannot derive shielded keys and asks for nothing", async () => {
    saveUnifiedWallet({ id: "ext-1", displayName: "Ext", createdAt: 1, signingPublicKey: "ab".repeat(1952), signingPrivateKey: "", encryptionPublicKey: "", encryptionPrivateKey: "", version: 2 });
    const { factory } = stubWorker(() => makeView());
    await renderShield(factory);
    expect(await screen.findByTestId("gate-provider")).toHaveTextContent(/never ask for your recovery phrase/);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it("the required statement is near the top; with the default nodes the page is read-only and says three nodes are needed", async () => {
    seedAppsWebWallet();
    const { factory } = stubWorker(() => makeView({ nodes: [] }));
    await renderShield(factory);
    const statement = screen.getByLabelText(/What shielded payments do and do not do/);
    expect(statement).toHaveTextContent("hide the amounts and who paid whom inside the pool");
    expect(statement).toHaveTextContent("are public");
    expect(statement).toHaveTextContent("1,000,000 XRGE");
    expect(statement).toHaveTextContent("has not had an external audit yet");
    expect(await screen.findByTestId("need-three")).toHaveTextContent("at least three independent nodes");
    await screen.findByText(/Read-only until at least 3/);
    expect(screen.queryByRole("button", { name: "Send privately" })).toBeNull();
    // the address, its QR code and its whole fingerprint are shown even read-only
    expect(await screen.findByTestId("fingerprint")).toHaveTextContent("0123 4567 89ab cdef");
  });

  it("restored wallet: the in-flight sentence, the embargo in blocks with the observed rate beside it, no countdown", async () => {
    saveNodes("mainnet", THREE);
    seedAppsWebWallet();
    const { factory } = stubWorker(() => makeView());
    await renderShield(factory);
    const panel = await screen.findByTestId("restore-panel");
    expect(panel).toHaveTextContent("Payments made from another copy of this wallet may still be in flight and are not shown here.");
    expect(panel).toHaveTextContent("Two devices with the same phrase do not see each other's pending payments.");
    expect(screen.getByTestId("embargo")).toHaveTextContent("until block 149: 128 blocks — at the rate of the last 7 days, about 11 days; an idle chain makes no blocks.");
    expect(panel.textContent).not.toMatch(/\d+:\d\d|hours? left|minutes? left/);
    expect(await screen.findByTestId("spend-blocked").catch(() => null)).toBeNull(); // shield tab first
  });

  it("the confirmation exists only before the first confirmed check, is never suggested by default, defaults to Wait, and needs the explicit tick", async () => {
    saveNodes("mainnet", THREE);
    seedAppsWebWallet();
    const view = makeView({ awaiting_base: true, spend: { ...makeView().spend, embargo_until: null, embargo_blocks_left: null }, confirmed_height: null });
    const { factory, requests } = stubWorker(() => view);
    await renderShield(factory);
    await screen.findByTestId("restore-panel");
    expect(screen.queryByTestId("sole-copy-sentence")).toBeNull();
    expect(requests.some((r) => r.cmd === "soleCopy")).toBe(false);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /I am certain no other copy/ }));
    expect(screen.getByTestId("sole-copy-sentence")).toHaveTextContent(
      "No other device, old backup or lost device holds this wallet with a payment that has not been confirmed or expired. If that is wrong, a payment can be made twice.",
    );
    expect(screen.getByRole("button", { name: "Wait (recommended)" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Confirm and skip the wait" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Wait (recommended)" }));
    expect(requests.some((r) => r.cmd === "soleCopy")).toBe(false);
    await user.click(screen.getByRole("button", { name: /I am certain no other copy/ }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Confirm and skip the wait" }));
    await waitFor(() => expect(requests.filter((r) => r.cmd === "soleCopy")).toHaveLength(1));
  });

  it("after the first confirmed check the statement is no longer offered; a device-generated wallet shows no restore panel", async () => {
    saveNodes("mainnet", THREE);
    seedAppsWebWallet();
    let view = makeView();
    const { factory } = stubWorker(() => view);
    const r = await renderShield(factory);
    await screen.findByTestId("restore-panel");
    expect(screen.queryByRole("button", { name: /I am certain no other copy/ })).toBeNull();
    r.unmount();
    view = makeView({ origin: "generated", spend: { ...makeView().spend, reason: null, can_spend_now: true, embargo_until: 21, embargo_blocks_left: 0 }, offer: true });
    await renderShield(factory);
    await screen.findByTestId("balance-confirmed");
    expect(screen.queryByTestId("restore-panel")).toBeNull();
  });

  it("states: pool not active, no honest listing node, waiting for every node", async () => {
    saveNodes("mainnet", THREE);
    seedAppsWebWallet();
    let view = makeView({ stop: { kind: "pool_inactive" } });
    const { factory } = stubWorker(() => view);
    let r = await renderShield(factory);
    expect(await screen.findByTestId("state-inactive")).toHaveTextContent("The shielded pool is not active on this network (yet).");
    expect(screen.queryByTestId("balance-confirmed")).toBeNull(); // never shown as a balance of zero
    r.unmount();
    view = makeView({ stop: { kind: "no_honest_listing_node" }, nodes: makeView().nodes.map((n) => ({ ...n, banned: true })) });
    r = await renderShield(factory);
    expect(await screen.findByTestId("state-no-honest")).toHaveTextContent("No honest listing node reachable");
    r.unmount();
    view = makeView({ waiting: { waited: 3, of: 5, missing: ["https://node-c.example"] }, awaiting_base: true });
    await renderShield(factory);
    expect(await screen.findByTestId("state-waiting")).toHaveTextContent("Waiting for https://node-c.example, round 3 of 5. Going ahead without a node makes the restore wait 256 blocks longer.");
  });

  it("a second tab: when another tab holds the shielded wallet, this one says so and starts no worker", async () => {
    saveNodes("mainnet", THREE);
    seedAppsWebWallet();
    const request = vi.fn(async (_name: string, _opts: unknown, cb: (lock: unknown) => unknown) => cb(null));
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { locks: { request } }));
    const { factory } = stubWorker(() => makeView());
    await renderShield(factory);
    expect(await screen.findByTestId("other-tab")).toHaveTextContent("already open in another tab");
    expect(request.mock.calls[0][0]).toBe("rougechain-shield-v2:mainnet");
    expect(factory).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("leaving the page terminates the worker", async () => {
    saveNodes("mainnet", THREE);
    seedAppsWebWallet();
    const { factory } = stubWorker(() => makeView());
    const r = await renderShield(factory);
    await screen.findByTestId("balance-confirmed");
    const w = factory.mock.results[0].value as unknown as { terminate: ReturnType<typeof vi.fn> };
    r.unmount();
    expect(w.terminate).toHaveBeenCalled();
  });
});

describe("copy and code inspection", () => {
  const FORBIDDEN: Record<string, RegExp> = {
    en: /audited|untraceable|anonymous/i,
    es: /auditad[oa]s?\b|anónim|imposible de rastrear|irrastreable/i,
    zh: /已审计|经过审计的|匿名|无法追踪|不可追踪/,
    ja: /監査済み|匿名|追跡不可能|追跡できない/,
  };
  for (const lang of ["en", "es", "zh", "ja"]) {
    it(`${lang}: the shield copy contains none of the forbidden words, and says the cryptography is not audited yet`, () => {
      const text = readFileSync(path.join(repoRoot(), `apps/site-next/src/i18n/locales/${lang}/shield.json`), "utf8");
      expect(text).not.toMatch(FORBIDDEN[lang]);
      expect(text).not.toMatch(FORBIDDEN.en);
      expect(text).toMatch(/1[,.]000[,.]000 XRGE/);
    });
  }

  it("assert_sole_copy is called from exactly two places: the new-phrase helper and the confirmation", () => {
    const dir = path.join(repoRoot(), "apps/site-next/src/shield");
    const sites: string[] = [];
    for (const f of readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test."))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      for (const m of src.matchAll(/api\.assert_sole_copy\(/g)) {
        const before = src.slice(0, m.index);
        const def = [...before.matchAll(/(?:function\s+(\w+)\(|^\s+async\s+(\w+)\()/gm)].pop();
        const fn = def?.[1] ?? def?.[2];
        sites.push(`${f}:${fn}`);
      }
    }
    expect(sites.sort()).toEqual(["client.ts:confirmSoleCopyAfterExplicitStatement", "client.ts:stateForNewlyGeneratedPhrase"]);
  });

  it("no timer gates a payment, a retry or the end of an embargo: the only timer is the round cadence", () => {
    const dir = path.join(repoRoot(), "apps/site-next/src/shield");
    const timers = readdirSync(dir)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test."))
      .flatMap((f) => [...readFileSync(path.join(dir, f), "utf8").matchAll(/set(?:Timeout|Interval)\(/g)].map(() => f));
    expect(timers).toEqual(["useShield.ts"]);
    const src = readFileSync(path.join(dir, "useShield.ts"), "utf8");
    expect(src.match(/setTimeout\(\(\) => void runRef\.current\(recheckPool\), ms\)/g)).toHaveLength(1);
  });
});
