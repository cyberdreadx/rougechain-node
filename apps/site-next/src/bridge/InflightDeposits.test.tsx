/** The in-flight deposits card: waiting → credited from the wallet's history, one-to-one matching, the slow state, dismiss. */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InflightDeposits, inflightTiming } from "./InflightDeposits";
import { addInflight, INFLIGHT_SLOW_MS, listInflight, type InflightDeposit } from "./inflight";
import { mockApi } from "./test-helpers";

const PUB = "ab".repeat(1952);
const NET = "testnet";
const defaults = { ...inflightTiming };

function rec(n: number, over: Partial<InflightDeposit> = {}): InflightDeposit {
  return { baseTxHash: `0x${String(n).padStart(64, "0")}`, asset: "USDC", l1Symbol: "qUSDC", amountLabel: "2.5", expectedL1Units: "2500000", recipientPubkey: PUB, startedAt: Date.now() - 5_000 + n, state: "sent", ...over };
}
const mint = (txId: string, payload: object, blockTime = Date.now()) => ({ txId, blockHeight: 9, blockTime, direction: "in", tx: { tx_type: "bridge_mint", payload: { to_pub_key_hex: PUB, ...payload } } });

function history(initial: object[] = []) {
  const state = { transactions: initial };
  const api = mockApi({ [`GET /address/${PUB}/transactions`]: () => ({ transactions: state.transactions }) });
  return { state, api };
}

function renderCard(onCredited?: () => void, pubkey = PUB) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <InflightDeposits pubkey={pubkey} network={NET} onCredited={onCredited} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  inflightTiming.pollMs = 20;
});
afterEach(() => {
  Object.assign(inflightTiming, defaults);
  vi.useRealTimers();
});

describe("in-flight deposits card", () => {
  it("renders nothing, and reads nothing from the node, without records for this wallet", async () => {
    const { api } = history();
    addInflight(NET, rec(1, { recipientPubkey: "someone-else" }));
    addInflight("mainnet", rec(2));
    const { container } = renderCard();
    await act(() => new Promise((r) => setTimeout(r, 60)));
    expect(container).toBeEmptyDOMElement();
    expect(api.calls).toEqual([]);
  });

  it("waiting → Credited when the history gains the matching bridge_mint; then polling stops", async () => {
    const { state, api } = history([mint("old", { amount: 2_500_000, token_symbol: "qUSDC" }, Date.now() - 3_600_000)]);
    addInflight(NET, rec(1));
    const onCredited = vi.fn();
    renderCard(onCredited);
    const card = within(screen.getByRole("region", { name: "Your deposits" }));
    expect(card.getByText("2.5 USDC")).toBeInTheDocument();
    expect(card.getByText("Sent — waiting for Base confirmations")).toBeInTheDocument();
    expect(card.getByText(/You can leave this page/)).toBeInTheDocument();
    expect(card.queryByRole("button", { name: "Dismiss" })).toBeNull();
    // an hour-old credit of the same amount, a different amount and a different token don't count
    state.transactions = [mint("n1", { amount: 3_500_000, token_symbol: "qUSDC" }), mint("n2", { amount: 2_500_000, token_symbol: "qETH" }), ...state.transactions];
    await vi.waitFor(() => expect(api.calls.length).toBeGreaterThan(3));
    expect(card.getByText("Sent — waiting for Base confirmations")).toBeInTheDocument();
    expect(onCredited).not.toHaveBeenCalled();

    state.transactions = [mint("n3", { amount: 2_500_000, token_symbol: "qUSDC" }), ...state.transactions];
    expect(await card.findByText("Credited ✓ (+2.5 qUSDC)")).toBeInTheDocument();
    expect(card.queryByText(/waiting for Base/)).toBeNull();
    expect(card.queryByText(/You can leave this page/)).toBeNull();
    expect(onCredited).toHaveBeenCalledTimes(1);
    expect(listInflight(NET)[0]).toMatchObject({ state: "credited", creditTxId: "n3" });
    const polls = api.calls.length;
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(api.calls.length).toBe(polls);
  });

  it("a deposit added while the card is mounted shows up at once (ETH, credited in qETH)", async () => {
    const { state } = history();
    renderCard();
    expect(screen.queryByRole("region", { name: "Your deposits" })).toBeNull();
    act(() => addInflight(NET, rec(1, { asset: "ETH", l1Symbol: "qETH", amountLabel: "0.25", expectedL1Units: "250000" })));
    expect(screen.getByText("0.25 ETH")).toBeInTheDocument();
    state.transactions = [mint("e1", { amount: 250_000, token_symbol: "qETH" })];
    expect(await screen.findByText("Credited ✓ (+0.25 qETH)")).toBeInTheDocument();
  });

  it("two identical deposits are matched one-to-one: one credit settles only the older one", async () => {
    const { state } = history();
    addInflight(NET, rec(1));
    addInflight(NET, rec(2));
    renderCard();
    expect(screen.getAllByText("Sent — waiting for Base confirmations")).toHaveLength(2);
    state.transactions = [mint("c1", { amount: 2_500_000, token_symbol: "qUSDC" })];
    expect(await screen.findByText("Credited ✓ (+2.5 qUSDC)")).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 120))); // several more polls of the same history
    expect(screen.getAllByText("Credited ✓ (+2.5 qUSDC)")).toHaveLength(1);
    expect(screen.getAllByText("Sent — waiting for Base confirmations")).toHaveLength(1);
    expect(listInflight(NET).map((r) => [r.baseTxHash, r.state])).toEqual([
      [rec(1).baseTxHash, "credited"],
      [rec(2).baseTxHash, "sent"],
    ]);
    state.transactions = [mint("c2", { amount: 2_500_000, token_symbol: "qUSDC" }), ...state.transactions];
    await vi.waitFor(() => expect(screen.getAllByText("Credited ✓ (+2.5 qUSDC)")).toHaveLength(2));
    expect(listInflight(NET).map((r) => r.creditTxId)).toEqual(["c1", "c2"]);
  });

  it("after 20 minutes without a credit: 'Taking longer than expected' with the Base hash — no error — and it can be dismissed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.assign(inflightTiming, defaults);
    const { api } = history();
    const r = rec(1, { startedAt: Date.now() });
    addInflight(NET, r);
    renderCard();
    expect(screen.getByText("Sent — waiting for Base confirmations")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(INFLIGHT_SLOW_MS - 30_000));
    expect(screen.getByText("Sent — waiting for Base confirmations")).toBeInTheDocument();
    expect(screen.queryByText("Taking longer than expected")).toBeNull();
    expect(api.calls.length).toBeGreaterThan(100); // polled every 8 s meanwhile

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText("Taking longer than expected")).toBeInTheDocument();
    expect(screen.getByText(r.baseTxHash)).toBeInTheDocument();
    expect(screen.getByText(/contact support and quote this Base transaction/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/fail|error|lost/i)).toBeNull();
    expect(listInflight(NET)[0].state).toBe("sent"); // still watched: a late credit still lands

    vi.useRealTimers();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Your deposits" })).toBeNull();
    expect(listInflight(NET)[0]).toMatchObject({ dismissed: true });
  });

  it("a slow deposit that is finally credited turns Credited", async () => {
    const { state } = history();
    addInflight(NET, rec(1, { startedAt: Date.now() - INFLIGHT_SLOW_MS - 60_000 }));
    inflightTiming.slowPollMs = 20;
    renderCard();
    expect(screen.getByText("Taking longer than expected")).toBeInTheDocument();
    state.transactions = [mint("late", { amount: 2_500_000, token_symbol: "qUSDC" })];
    expect(await screen.findByText("Credited ✓ (+2.5 qUSDC)")).toBeInTheDocument();
    expect(screen.queryByText("Taking longer than expected")).toBeNull();
  });

  it("dismiss removes a credited record from the card", async () => {
    history();
    addInflight(NET, rec(1, { state: "credited", finishedAt: Date.now(), creditTxId: "c" }));
    addInflight(NET, rec(2, { asset: "XRGE", l1Symbol: "XRGE", amountLabel: "5", expectedL1Units: "5", state: "credited", finishedAt: Date.now() }));
    renderCard();
    expect(screen.getByText("Credited ✓ (+5 XRGE)")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(screen.queryByText("Credited ✓ (+2.5 qUSDC)")).toBeNull();
    expect(screen.getByText("Credited ✓ (+5 XRGE)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Your deposits" })).toBeNull();
  });

  it("an unreachable node is not an error: the deposit just keeps waiting", async () => {
    mockApi({});
    addInflight(NET, rec(1));
    renderCard();
    await act(() => new Promise((r) => setTimeout(r, 80)));
    expect(screen.getByText("Sent — waiting for Base confirmations")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
