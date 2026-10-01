import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { verifyTransaction, type SignedTransaction } from "@rougechain/core/pqc-signer";
import { registerValidator, unstake } from "@rougechain/core/pqc-validators";
import { castVote } from "@rougechain/core/regen-votes";
import { getCoreApiBaseUrl } from "@rougechain/core/network";
import { ChainProvider } from "../explorer/chain";
import { WalletProvider } from "../wallet/WalletProvider";
import { Toaster } from "../wallet/toast";
import { TOUR_SEEN_KEY } from "../wallet/tour";
import { mockFetch, resetBrowserState, seedAppsWebLockedWallet, seedAppsWebWallet, type Handler } from "../wallet/test-utils";
import { featureHeaderProduct, featureRoutes } from "../features";
import { PAGES_PATHS } from "../features/pages";
import { checkStake, checkUnstake, maxStake } from "./validators-data";
import i18n from "../i18n";

const OTHER = "ab".repeat(1952);

function renderAt(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ChainProvider>
        <WalletProvider autoRegister={false}>
          <MemoryRouter initialEntries={[route]}>
            <Routes>{featureRoutes}</Routes>
            <Toaster />
          </MemoryRouter>
        </WalletProvider>
      </ChainProvider>
    </QueryClientProvider>,
  );
}

/** Node API for the validators page. Specific paths first: mockFetch matches by substring in order. */
function validatorRoutes(validators: { publicKey: string; stake: number; status?: string; slashCount?: number }[], extra: Record<string, Handler> = {}) {
  return mockFetch({
    ...extra,
    "/validators/stats": () => ({
      success: true,
      totalHeights: 100,
      validators: validators.map((v) => ({ publicKey: v.publicKey, prevoteParticipation: 90, precommitParticipation: 95, lastSeenHeight: 120 })),
    }),
    "/validators": () => ({ success: true, validators }),
    "/selection": () => ({
      success: true,
      height: 121,
      proposer: validators[0]?.publicKey ?? null,
      totalStake: validators.reduce((s, v) => s + v.stake, 0),
      selectionWeight: "0.75",
      entropySource: "qrng",
      entropyHex: "ff".repeat(32),
    }),
    "/finality": () => ({ success: true, finalizedHeight: 118, tipHeight: 121, totalStake: 1, quorumStake: 20000 }),
    "/votes": () => ({ success: true, height: 121, totalStake: 1, quorumStake: 1, prevote: [], precommit: [] }),
  });
}

beforeEach(() => {
  resetBrowserState();
  vi.stubGlobal("WebSocket", undefined);
  localStorage.setItem(TOUR_SEEN_KEY, "1");
});

describe("pages area wiring", () => {
  it("owns the apps/web paths and picks headers", () => {
    expect(PAGES_PATHS).toEqual(["/validators", "/genesis-validators", "/node", "/agents", "/status", "/regenerate", "/privacy"]);
    expect(featureHeaderProduct("/validators")).toBe("Validators");
    expect(featureHeaderProduct("/genesis-validators")).toBe("Validators");
    expect(featureHeaderProduct("/status")).toBe("Network");
    for (const p of ["/node", "/agents", "/regenerate", "/privacy"]) expect(featureHeaderProduct(p)).toBeNull();
  });
});

describe("stake amount rules", () => {
  it("needs the 10,000 minimum for a first stake, keeps the fee, and whole XRGE only", () => {
    expect(checkStake("9999", 50_000, 0)).toMatchObject({ ok: false });
    expect(checkStake("10000", 10_000, 0)).toMatchObject({ ok: false }); // no room for the 1 XRGE fee
    expect(checkStake("10000", 10_001, 0)).toEqual({ ok: true, amount: 10_000 });
    expect(checkStake("500", 1_000, 10_000)).toEqual({ ok: true, amount: 500 }); // top-up
    expect(checkStake("10.5", 50_000, 0)).toMatchObject({ ok: false });
    expect(checkUnstake("20000", 15_000, 10)).toMatchObject({ ok: false });
    expect(checkUnstake("5000", 15_000, 10)).toEqual({ ok: true, amount: 5_000 });
    expect(checkUnstake("5000", 15_000, 0)).toMatchObject({ ok: false });
    expect(maxStake(12_345.6)).toBe(12_344);
  });
});

describe("/validators", () => {
  it("lists validators, stats, proposer and finality; asks to connect a wallet", async () => {
    validatorRoutes([
      { publicKey: OTHER, stake: 150_000 },
      { publicKey: "cd".repeat(1952), stake: 10_000, status: "jailed", slashCount: 2 },
    ]);
    renderAt("/validators");
    expect(await screen.findByRole("heading", { name: "Validators", level: 1 })).toBeInTheDocument();
    const board = await screen.findByRole("region", { name: "Validator leaderboard" });
    expect(within(board).getByText("150.0K XRGE")).toBeInTheDocument();
    expect(within(board).getByText("Slashed 2×")).toBeInTheDocument();
    expect(within(board).getByText("Jailed")).toBeInTheDocument();
    expect(await screen.findByText("#121")).toBeInTheDocument(); // proposer height
    expect(screen.getByText("Connect a wallet to see your stake and to stake XRGE.")).toBeInTheDocument();
    expect(screen.getByText(/The key that stakes is the key that validates/)).toBeInTheDocument(); // node-keys.json
  });

  it("shows the unavailable state when the node can't be read", async () => {
    mockFetch();
    renderAt("/validators");
    expect(await screen.findByText(/API could not be read/)).toBeInTheDocument();
  });

  it("locked wallet: offers unlock instead of staking", async () => {
    await seedAppsWebLockedWallet();
    validatorRoutes([]);
    renderAt("/validators");
    expect(await screen.findByText("Your wallet is locked. Unlock it to stake or unstake.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stake XRGE" })).not.toBeInTheDocument();
    expect(await screen.findByText("No validators yet")).toBeInTheDocument();
  });

  it("stake: form → review → sign (core registerValidator) → POST /v2/stake, same request as apps/web", async () => {
    const w = seedAppsWebWallet();
    const { calls } = validatorRoutes([{ publicKey: OTHER, stake: 150_000 }], {
      [`/balance/${w.signingPublicKey}`]: () => ({ success: true, balance: 25_000 }),
      "/v2/stake": () => ({ success: true, txHash: "abc" }),
    });
    renderAt("/validators");
    const user = userEvent.setup();
    const mine = await screen.findByRole("region", { name: "Your stake" });
    await within(mine).findByText("25,000 XRGE");
    await user.click(within(mine).getByRole("button", { name: "Stake XRGE" }));
    const dialog = screen.getByRole("dialog", { name: "Stake XRGE" });
    await user.type(within(dialog).getByRole("textbox"), "5000");
    expect(within(dialog).getByText(/Minimum stake for the standard tier/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Review" })).toBeDisabled();
    await user.clear(within(dialog).getByRole("textbox"));
    await user.type(within(dialog).getByRole("textbox"), "12000");
    await user.click(within(dialog).getByRole("button", { name: "Review" }));
    const review = screen.getByRole("dialog", { name: "Review and sign" });
    expect(within(review).getByText("12,000 XRGE")).toBeInTheDocument();
    expect(within(review).getByText("Standard")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/v2/stake"))).toBe(false); // nothing signed before confirming
    await user.click(within(review).getByRole("button", { name: "Sign and stake" }));
    await screen.findByText("Staked 12,000 XRGE");

    const post = calls.find((c) => c.url.endsWith("/v2/stake"))!;
    expect(post.url).toBe(`${getCoreApiBaseUrl()}/v2/stake`);
    expect(post.init?.method).toBe("POST");
    const signed = JSON.parse(String(post.init?.body)) as SignedTransaction;
    expect(signed.payload).toMatchObject({ type: "stake", from: w.signingPublicKey, amount: 12_000, fee: 1 });
    expect(signed.public_key).toBe(w.signingPublicKey);
    expect(verifyTransaction(signed)).toBe(true);

    // apps/web's StakingDialog calls registerValidator(walletId, pub, priv, amount, tier) (apps/web lib = core shim).
    await registerValidator(w.id, w.signingPublicKey, w.signingPrivateKey, 12_000, "standard");
    const web = calls.filter((c) => c.url.endsWith("/v2/stake")).at(-1)!;
    const webSigned = JSON.parse(String(web.init?.body)) as SignedTransaction;
    expect(web.url).toBe(post.url);
    expect(web.init?.headers).toEqual(post.init?.headers);
    expect(Object.keys(webSigned).sort()).toEqual(Object.keys(signed).sort());
    const strip = (p: Record<string, unknown>) => {
      const rest = { ...p };
      delete rest.nonce;
      delete rest.timestamp;
      return rest;
    };
    expect(strip(webSigned.payload as unknown as Record<string, unknown>)).toEqual(strip(signed.payload as unknown as Record<string, unknown>));
  });

  it("unstake: shows the remaining stake in review → POST /v2/unstake, same request as core unstake", async () => {
    const w = seedAppsWebWallet();
    const { calls } = validatorRoutes([{ publicKey: w.signingPublicKey, stake: 15_000 }], {
      [`/balance/${w.signingPublicKey}`]: () => ({ success: true, balance: 50 }),
      "/v2/unstake": () => ({ success: true }),
    });
    renderAt("/validators");
    const user = userEvent.setup();
    const mine = await screen.findByRole("region", { name: "Your stake" });
    await within(mine).findByText("15,000 XRGE");
    expect(within(mine).getByText("You're a standard validator")).toBeInTheDocument();
    await user.click(within(mine).getByRole("button", { name: "Unstake" }));
    const dialog = screen.getByRole("dialog", { name: "Unstake XRGE" });
    await user.type(within(dialog).getByRole("textbox"), "6000");
    await user.click(within(dialog).getByRole("button", { name: "Review" }));
    const review = screen.getByRole("dialog", { name: "Review and sign" });
    expect(within(review).getByText("9,000 XRGE")).toBeInTheDocument();
    expect(within(review).getByText(/removes this key from the validator set/)).toBeInTheDocument();
    await user.click(within(review).getByRole("button", { name: "Sign and unstake" }));
    await screen.findByText("Unstaked 6,000 XRGE");
    const post = calls.find((c) => c.url.endsWith("/v2/unstake"))!;
    expect(post.url).toBe(`${getCoreApiBaseUrl()}/v2/unstake`);
    const signed = JSON.parse(String(post.init?.body)) as SignedTransaction;
    expect(signed.payload).toMatchObject({ type: "unstake", from: w.signingPublicKey, amount: 6_000, fee: 1 });
    expect(verifyTransaction(signed)).toBe(true);

    await unstake(w.id, w.signingPublicKey, w.signingPrivateKey, 6_000);
    const direct = calls.filter((c) => c.url.endsWith("/v2/unstake")).at(-1)!;
    expect(direct.url).toBe(post.url);
    const d = JSON.parse(String(direct.init?.body)) as SignedTransaction;
    expect(Object.keys(d.payload).sort()).toEqual(Object.keys(signed.payload).sort());
  });

  it("labels testnet", async () => {
    localStorage.setItem("rougechain-network", "testnet");
    validatorRoutes([]);
    renderAt("/validators");
    expect(await screen.findByText(/You are viewing testnet/)).toBeInTheDocument();
  });
});

const PROPOSAL = {
  proposal: {
    id: "rg-1",
    title: "Mangrove corridor",
    summary: "Replant mangroves.",
    territory: "Tulum",
    recipient: null,
    requestedXrge: 5000,
    creator: "x",
    createdAtMs: Date.now() - 1000,
    endsAtMs: Date.now() + 5 * 86_400_000,
    snapshotHeight: 100,
    capBps: 500,
    turnoutBps: 1000,
    eligibleVoters: 10,
    cancelled: false,
  },
  status: "open",
  tally: { voters: 2 },
  summaryXrge: { eligibleTotal: 1000, cap: 50, turnoutNeeded: 100, yes: 60, no: 10, abstain: 0, turnout: 70 },
};
const VOTE_CONFIG = { treasury: null, capBps: 500, turnoutBps: 1000, defaultDays: 7, minCreatorXrge: 10000, excluded: [], curators: [] };

describe("/regenerate", () => {
  it("renders the mission, treasury (mainnet) and says so when votes aren't served", async () => {
    mockFetch({ "/balance/": () => ({ success: false }) });
    renderAt("/regenerate");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Fund the future where you live.");
    expect(screen.getByText("TULUM")).toBeInTheDocument();
    expect(await screen.findByText("Community votes are not available from this node right now.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
    expect(document.querySelector('form[name="regenerate-proposal"]')).not.toBeNull();
  });

  it("vote: review → sign (core castVote) → POST /v2/regen/votes, same request as apps/web", async () => {
    const w = seedAppsWebWallet();
    const { calls } = mockFetch({
      "/regen/config": () => VOTE_CONFIG,
      "/regen/proposals/rg-1/weight/": () => ({ address: "rouge1x", eligible: true, excluded: false, weightXrge: 42, vote: null }),
      "/regen/proposals": () => ({ proposals: [PROPOSAL] }),
      "/v2/regen/votes": () => ({ success: true }),
    });
    renderAt("/regenerate");
    const user = userEvent.setup();
    expect(await screen.findByText("Mangrove corridor")).toBeInTheDocument();
    await screen.findByText(/Your weight 42 XRGE/);
    await user.click(screen.getByRole("button", { name: "Yes" }));
    const review = screen.getByRole("dialog", { name: "Review and sign your vote" });
    expect(within(review).getByText("42 XRGE")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/v2/regen/votes"))).toBe(false);
    await user.click(within(review).getByRole("button", { name: "Sign vote" }));
    await screen.findByText("Vote recorded: yes");
    const post = calls.find((c) => c.url.endsWith("/v2/regen/votes"))!;
    expect(post.url).toBe(`${getCoreApiBaseUrl()}/v2/regen/votes`);
    const signed = JSON.parse(String(post.init?.body)) as SignedTransaction;
    expect(signed.payload).toMatchObject({ type: "regen_vote", proposalId: "rg-1", choice: "yes", from: w.signingPublicKey });
    expect(verifyTransaction(signed)).toBe(true);
    // apps/web's CommunityVotes calls castVote(p.id, choice) (apps/web lib = core shim).
    await castVote("rg-1", "yes");
    const web = calls.filter((c) => c.url.endsWith("/v2/regen/votes")).at(-1)!;
    expect(web.url).toBe(post.url);
    expect(Object.keys(JSON.parse(String(web.init?.body)).payload).sort()).toEqual(Object.keys(signed.payload).sort());
  });

  it("vote: connect / ineligible states", async () => {
    mockFetch({ "/regen/config": () => VOTE_CONFIG, "/regen/proposals": () => ({ proposals: [PROPOSAL] }) });
    renderAt("/regenerate");
    expect(await screen.findByText("Connect a wallet to vote.")).toBeInTheDocument();
  });

  it("testnet: hides the mainnet treasury figures and says why", async () => {
    localStorage.setItem("rougechain-network", "testnet");
    const { calls } = mockFetch();
    renderAt("/regenerate");
    expect(await screen.findByText(/You're on testnet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy address" })).not.toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/regen/"))).toBe(true));
    expect(calls.some((c) => c.url.includes("/address/"))).toBe(false);
  });
});

describe("other pages", () => {
  it("/genesis-validators renders the honest program page", async () => {
    mockFetch();
    renderAt("/genesis-validators");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Become a Genesis Validator of the first post-quantum L1.");
    expect(screen.getByText(/Don't join for yield/)).toBeInTheDocument();
    expect(screen.getByText("rougechain --node-keys <path> stake 10000")).toBeInTheDocument();
  });

  it("/node shows live nodes from the API and the commands", async () => {
    mockFetch({
      "localhost:5101/api/stats": () => ({ connected_peers: 3, network_height: 500, is_mining: true, node_id: "node-aaaaaaaa", total_fees_collected: 12, fees_in_last_block: 0.1, chain_id: "rougechain-mainnet-1", finalized_height: 498 }),
      "localhost:5101/api/health": () => ({ status: "ok", chain_id: "rougechain-mainnet-1", height: 500 }),
      "localhost:5101/api/peers": () => ({ peers: [] }),
      "localhost:5101/api/validators": () => ({ validators: [{}, {}] }),
    });
    renderAt("/node");
    expect(await screen.findByText("Network online · 2 validators")).toBeInTheDocument();
    expect(screen.getByText("Node 1")).toBeInTheDocument();
    expect(screen.getAllByText(/--chain-id rougechain-mainnet-1/).length).toBeGreaterThan(0);
  });

  it("/node empty state when nothing answers", async () => {
    mockFetch();
    renderAt("/node");
    expect((await screen.findAllByText("No nodes detected")).length).toBeGreaterThan(0);
  });

  it("/agents lists MCP tools with write markers", async () => {
    mockFetch();
    const user = userEvent.setup();
    renderAt("/agents");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("AI agents on RougeChain");
    await user.click(screen.getByRole("button", { name: /Staking & faucet/ }));
    expect(screen.getByText("unstake")).toBeInTheDocument();
    expect(screen.getAllByText("signs tx").length).toBeGreaterThan(0);
  });

  it("/status reads stats, validators and release facts", async () => {
    mockFetch({
      "/api/stats": () => ({ network_height: 200, finalized_height: 198, connected_peers: 2, state_root: "ab".repeat(32), base_fee: 0.1, total_fees_burned: 1.5, chain_id: "rougechain-mainnet-1" }),
      "/api/validators": () => ({ validators: [{ publicKey: OTHER, stake: 100_000, jailedUntil: 0 }] }),
      "/api/peers": () => ({ peers: ["a", "b", "c"] }),
      "/status/releases.json": () => JSON.parse(readFileSync(path.join(__dirname, "../../public/status/releases.json"), "utf8")),
    });
    renderAt("/status");
    expect(await screen.findByText("200")).toBeInTheDocument();
    expect(screen.getByText("198 (−2)")).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(await screen.findByText(/Deterministic proposer selection/)).toBeInTheDocument();
  });

  it("/status shows the API error state", async () => {
    mockFetch();
    renderAt("/status");
    expect(await screen.findByText("Could not reach the API")).toBeInTheDocument();
  });

  it("/privacy carries apps/web's policy text verbatim", async () => {
    mockFetch();
    const { container } = renderAt("/privacy");
    expect(await screen.findByRole("heading", { level: 1, name: "Privacy Policy" })).toBeInTheDocument();
    const words = (s: string) => s.replace(/\s+/g, " ").trim();
    const web = readFileSync(path.join(__dirname, "../../../web/src/pages/Privacy.tsx"), "utf8");
    // apps/web's text nodes, JSX stripped: every sentence must appear in the rendered page.
    const text = words(
      web
        .replace(/[\s\S]*?return \(/, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\{" "\}/g, " ")
        .replace(/\{lastUpdated\}/g, "March 9, 2026")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/[();]\s*\}?\s*$/g, ""),
    );
    const rendered = words(container.textContent ?? "");
    const sentences = text.split(/(?<=\.)\s+/).filter((x) => x.length > 30);
    expect(sentences.length).toBeGreaterThan(20);
    // Block elements concatenate without spaces in textContent: compare with whitespace and brackets removed.
    const squash = (x: string) => x.replace(/[\s(){}]/g, "");
    const flat = squash(rendered);
    for (const x of sentences) expect(flat).toContain(squash(x));
  });
});

describe("pages i18n", () => {
  it("renders /status in Spanish (heading, labels and route title)", async () => {
    mockFetch({
      "/api/stats": () => ({ network_height: 1200, finalized_height: 1198, connected_peers: 2, state_root: "ab".repeat(32), base_fee: 0.1, total_fees_burned: 1.5, chain_id: "rougechain-mainnet-1" }),
      "/api/validators": () => ({ validators: [{ publicKey: OTHER, stake: 100_000, jailedUntil: 0 }] }),
      "/api/peers": () => ({ peers: [] }),
    });
    await i18n.changeLanguage("es");
    renderAt("/status");
    expect(await screen.findByRole("heading", { level: 1, name: "Estado de la red" })).toBeInTheDocument();
    expect(screen.getByText("Validadores (activos / total)")).toBeInTheDocument();
    expect(await screen.findByText("1200")).toBeInTheDocument(); // es-ES groups from 5 digits: fmtInt
    await waitFor(() => expect(document.title).toBe("Estado de la red — RougeChain"));
  });

  it("renders /validators in Chinese, with localized staking errors", async () => {
    validatorRoutes([{ publicKey: OTHER, stake: 150_000 }]);
    await i18n.changeLanguage("zh");
    renderAt("/validators");
    expect(await screen.findByRole("heading", { level: 1, name: "验证者" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "验证者排行榜" })).toBeInTheDocument();
    expect(checkStake("10.5", 50_000, 0)).toEqual({ ok: false, error: "请输入整数数量的 XRGE。" });
  });

  it("keeps the privacy policy body in English with a translated notice", async () => {
    mockFetch();
    await i18n.changeLanguage("ja");
    renderAt("/privacy");
    expect(await screen.findByRole("heading", { level: 1, name: "プライバシーポリシー" })).toBeInTheDocument();
    expect(screen.getByText(/このポリシーは英語で提供されています/)).toBeInTheDocument();
    expect(screen.getByText(/is committed to/)).toBeInTheDocument();
  });
});
