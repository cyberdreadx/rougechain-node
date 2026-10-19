/**
 * The TypeScript client loop against the adversary scenarios the Rust reference loop is tested
 * with (core/shield-v2-wallet/tests/review_wallet_5.rs, _6.rs, _6_resolution.rs, _6b*.rs, _6c.rs),
 * on the wallet vector chain served by mocked nodes in the node's real response shapes, with the
 * REAL WebAssembly package (the vendored bytes, in Node). No real node is called.
 *
 * Families:
 *   1. a consistent liar listing a chain of its own (rw5_demo_one_lying_listing_node…, rw6_sound_consistent_liars…)
 *   2. a liar that shifts a transaction one block and votes honestly: attribution (rw6r_f1_the_node_that_shifted…)
 *   3. "the pool is not active": majority idles, minority left, self-contradiction banned (rw6r_f3…, obligation 8)
 *   4. no answer and malformed pages: error objects, HTML, statuses, silence; a page without txs (rw6b_f2, rw6br_f2, obligation 9)
 *   5. state reports: malformed, outdated, oversized (rw6c, obligation 9 third check, RW4-12)
 *   6. lagging nodes and the first state check (rw6_c4 / obligation 2; rw5_demo_a_listing_node_that_never_reaches_its_tip)
 * plus the pure-Session ports of rw6r_f1_which_node_served_which_heights and rw6br_cap_two_blameless_rescans_in_a_row.
 */
import { describe, expect, it } from "vitest";
import { BLAMELESS_PER_TENURE, FIRST_CHECK_ROUNDS, STRIKES, Session, type ConfirmView, type StateView } from "./loop";
import { ORIGINS, Q, TestNet, makeClient, page, rounds, vectorChain } from "./testing/fixtures";
import { inactiveListing, inactiveStats } from "./testing/mock-chain.mjs";
import type { ShieldClient } from "./client";

const [A, B, C] = ORIGINS;
const isListing = (url: string) => url.includes("/api/shield-v2/notes");
const isStats = (url: string) => url.includes("/api/shield-v2/stats");
const confirmed = (c: ShieldClient) => c.summary().confirmed_height;
const scanned = (c: ShieldClient) => c.summary().scanned_height;
const bad = (c: ShieldClient) => c.session!.d.bad.map((i) => c.nodes[i]);
const listing = (c: ShieldClient) => c.nodes[c.session!.listing];
const WALLET1_FINAL = (Q / 2n).toString(); // 9 → 3 → 0.5 XRGE
const WALLET2_FINAL = (5n * Q).toString();

describe("family 1: a consistent liar listing a chain of its own", () => {
  it("hides the transfer, votes for its own listing: banned on the refutation, the honest node confirms the tip", async () => {
    const truth = await vectorChain(20);
    const lie = await vectorChain(20, { 3: [0], 5: [2] }); // block 4's transfer is not listed
    const net = new TestNet(truth);
    net.set(A, { chain: lie }); // A lists AND reports its own chain
    const { client } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
    expect(listing(client)).toBe(A);
    const v1 = await client.round();
    expect(bad(client)).toEqual([A]);
    expect(listing(client)).toBe(B);
    expect(v1.events[0]).toMatch(/^banned https:\/\/node-a\.example: listing_refuted/);
    const v = await rounds(client, 2);
    expect([confirmed(client), scanned(client), v.balances.confirmed, v.balances.unverified]).toEqual([20, 20, WALLET1_FINAL, "0"]);
    expect(bad(client)).toEqual([A]); // no honest node is ever banned
    expect(client.session!.d.stopped).toBeNull();
  });

  it("a liar that replaces a nullifier is refuted the same way; with the liar last in the order nobody is banned", async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    const forged = (url: string) => {
      if (!isListing(url)) return undefined;
      const u = new URL(url);
      const l = truth.listing(Number(u.searchParams.get("since")), Number(u.searchParams.get("blocks")));
      for (const t of l.txs) if (t.height === 4) t.nf2 = truth.listing(0, 64).txs[0].nf1.replace(/^.{2}/, "00");
      return page(l);
    };
    net.set(C, { behave: forged });
    const { client } = await makeClient({ wallet: "wallet-2", net, soleCopy: true });
    const v = await rounds(client, 3);
    expect([confirmed(client), v.balances.confirmed, bad(client)]).toEqual([20, WALLET2_FINAL, []]);
  });
});

describe("family 2: a liar that shifts a transaction and votes honestly", () => {
  it("the contradicted confirmation blames nobody; once the refuted heights are its own the liar is banned", async () => {
    const truth = await vectorChain(6);
    const shifted = await vectorChain(6, { 3: [0], 4: [1], 6: [2] }); // block 5's unshield listed in 6
    const net = new TestNet(truth);
    net.set(A, { behave: (url) => (isListing(url) ? page(shifted.listing(Number(new URL(url).searchParams.get("since")), 64)) : undefined) });
    const { client } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
    // round 1: confirmed at 6 by the liar (honest vote) and B; C is at 5
    net.set(C, { tip: 5 });
    await client.round();
    expect([confirmed(client), bad(client), client.session!.d.served]).toEqual([6, [], [{ node: 0, from: 3, to: 6 }]]);
    // round 2: B and C report 5 truthfully: the confirmed part is contradicted → rescan, nobody blamed
    net.set(B, { tip: 5 });
    const v2 = await client.round();
    expect([bad(client), listing(client), scanned(client), client.session!.d.from_empty, v2.rechecking]).toEqual([[], A, null, true, true]);
    // round 3: the liar lists the same way; the reports for 5 are still in R → its own heights: banned
    net.set(B, { tip: undefined });
    net.set(C, { tip: undefined });
    await client.round();
    expect([bad(client), listing(client)]).toEqual([[A], B]);
    // round 4: the honest node
    const v = await client.round();
    expect([confirmed(client), scanned(client), v.balances.confirmed, bad(client), v.stop]).toEqual([6, 6, WALLET1_FINAL, [A], null]);
  });

  it("Session: which node served which heights (rw6r_f1_which_node_served_which_heights)", () => {
    const pageOf = (from: number, next: number) => ({ active: true, from_height: from, next_height: next });
    const ok = { at_tip: true, leaf_mismatch: false, pool_active: true };
    const s = Session.create(3, 0);
    expect(s.listedByListingNode(0, 50)).toBe(true);
    s.afterScan(pageOf(51, 115), ok);
    s.afterScan(pageOf(115, 179), ok);
    expect(s.d.served).toEqual([{ node: 0, from: 51, to: 178 }]);
    expect(s.listedByListingNode(40, 178) && s.listedByListingNode(100, 120)).toBe(true);
    s.d.listing = 1;
    s.afterScan(pageOf(179, 243), ok);
    expect(s.listedByListingNode(179, 242) && s.listedByListingNode(200, 200)).toBe(true);
    expect(s.listedByListingNode(178, 242) || s.listedByListingNode(0, 10) || s.listedByListingNode(100, 200)).toBe(false);
    s.afterRescan();
    expect(s.listedByListingNode(0, 0)).toBe(false);
    s.afterScan(pageOf(3, 67), ok);
    expect(s.listedByListingNode(0, 66) && !s.listedByListingNode(0, 67)).toBe(true);
    s.afterScan(pageOf(3, 40), ok);
    expect(s.d.served).toEqual([{ node: 1, from: 0, to: 39 }]);
    const u = Session.createUnattributed(3, 2);
    expect(u.listedByListingNode(0, 50)).toBe(false);
    u.afterScan(pageOf(51, 115), ok);
    expect(u.listedByListingNode(51, 114) && !u.listedByListingNode(50, 114)).toBe(true);
  });

  it("Session: two blameless rescans in a row leave the listing node; the per-tenure cap (rw6br_cap_two_blameless_rescans_in_a_row)", () => {
    const st: StateView = { scanned_height: 20, confirmed_height: 20, awaiting_base: false, sole_copy_asserted: true, nodes: ORIGINS };
    const contradicted: ConfirmView = { listing_refuted: true, refuted: [{ from_height: 0, height: 10, confirmed: true }], quorum_tip: 20, matched_height: null, listing_ahead: false, embargo_base_set: false };
    const fine: ConfirmView = { listing_refuted: false, refuted: [], quorum_tip: 20, matched_height: 20, listing_ahead: false, embargo_base_set: false };
    let s = Session.create(3, 0);
    expect(s.afterConfirm(contradicted, true, st)).toEqual({ kind: "rescan" });
    expect(s.afterConfirm(contradicted, true, st)).toEqual({ kind: "leave", ban: false, why: "rescans that blamed nobody" });
    const plan = s.planLeave(false, st);
    expect([plan.rescan, plan.next, plan.ban]).toEqual([true, 1, false]);
    s.commitLeave(plan);
    expect([s.d.listing, s.d.blameless_in_a_row, s.d.blameless_on_l, s.d.bad.length]).toEqual([1, 0, 0, 0]);
    s = Session.create(3, 0);
    for (let i = 0; i < BLAMELESS_PER_TENURE - 1; i++) {
      expect(s.afterConfirm(contradicted, true, st)).toEqual({ kind: "rescan" });
      expect(s.afterConfirm(fine, true, st)).toEqual({ kind: "go" });
      expect(s.d.blameless_in_a_row).toBe(0);
    }
    expect(s.afterConfirm(contradicted, true, st)).toEqual({ kind: "leave", ban: false, why: "rescans that blamed nobody" });
    s = Session.create(3, 0);
    s.d.bad = [1, 2];
    s.afterConfirm(contradicted, true, st);
    s.afterConfirm(contradicted, true, st);
    const only = s.planLeave(false, st);
    expect([only.rescan, only.next]).toEqual([true, 0]);
  });
});

describe("family 3: the pool is not active (obligation 8)", () => {
  it("every node inactive: idles in the first round, nobody marked, the stored state byte for byte the same, no listing request while idle", async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    const inactive = (url: string) =>
      isListing(url) ? page(inactiveListing(Number(new URL(url).searchParams.get("since")), 500)) : isStats(url) ? { status: 200, text: JSON.stringify(inactiveStats(500)) } : undefined;
    for (const o of ORIGINS) net.set(o, { behave: inactive });
    const { client, store, id } = await makeClient({ wallet: "wallet-1", net });
    const before = await store.get(id);
    const v = await client.round();
    expect(v.stop).toEqual({ kind: "pool_inactive" });
    expect([bad(client), v.nodes.some((n) => n.banned), v.balances.confirmed, confirmed(client)]).toEqual([[], false, "0", null]);
    expect(await store.get(id)).toEqual(before);
    const asked = net.listingCalls().length;
    await rounds(client, 5);
    expect(net.listingCalls().length).toBe(asked);
    expect(client.session!.d.round).toBe(1);
    client.session!.recheckPool(); // the long interval
    const again = await client.round();
    expect([again.stop, client.session!.d.round, bad(client)]).toEqual([{ kind: "pool_inactive" }, 2, []]);
    expect(await store.get(id)).toEqual(before);
  });

  it("one node inactive, two active: the balance is confirmed from the active ones, the inactive node is left — not banned", async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    net.set(A, {
      behave: (url) =>
        isListing(url) ? page(inactiveListing(Number(new URL(url).searchParams.get("since")), 20)) : isStats(url) ? { status: 200, text: JSON.stringify(inactiveStats(20)) } : undefined,
    });
    const { client } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
    const v1 = await client.round();
    expect([bad(client), listing(client), v1.stop]).toEqual([[], B, null]);
    expect(v1.nodes.find((n) => n.origin === A)).toMatchObject({ inactive: true, banned: false });
    const v = await rounds(client, 2);
    expect([confirmed(client), v.balances.confirmed, bad(client)]).toEqual([20, WALLET1_FINAL, []]);
  });

  it("a node that reported a pool holding notes and then says 'not active' contradicts itself: banned", async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    const { client } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
    await client.round();
    expect(confirmed(client)).toBe(20);
    net.set(A, { behave: (url) => (isListing(url) ? page(inactiveListing(Number(new URL(url).searchParams.get("since")), 20)) : undefined) });
    await client.round();
    expect([bad(client), listing(client)]).toEqual([[A], B]);
  });
});

describe("family 4: no answer, and pages that are invalid (obligation 9)", () => {
  const noAnswers: [string, { status: number; text: string } | null][] = [
    ['{"success": false, "error": "…"} with status 200', { status: 200, text: JSON.stringify({ success: false, error: "store unavailable" }) }],
    ["a proxy's HTML error page", { status: 200, text: "<html><body>502 Bad Gateway</body></html>" }],
    ["status 500", { status: 500, text: "" }],
    ["an empty body", { status: 200, text: "" }],
    ["JSON that is not an object", { status: 200, text: "[1,2,3]" }],
    ["no response at all", null],
  ];
  for (const [what, answer] of noAnswers) {
    it(`${what}: a strike; after K rounds the next node lists; nobody is marked; the stored state unchanged until then`, async () => {
      const truth = await vectorChain(20);
      const net = new TestNet(truth);
      net.set(A, { behave: (url) => (isListing(url) ? answer : undefined) });
      const { client, store, id } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
      const before = await store.get(id);
      for (let r = 1; r <= STRIKES; r++) {
        expect([listing(client), client.session!.d.strikes]).toEqual([A, r - 1]);
        await client.round();
      }
      expect([listing(client), bad(client)]).toEqual([B, []]);
      // nothing was read from A: the stored state is what it was (the LEAVE moved listed_from only)
      const after = await store.get(id);
      expect(after!.revision_id).toBe(before!.revision_id);
      expect(client.summary().scanned_height).toBeNull();
      const v = await client.round();
      expect([confirmed(client), v.balances.confirmed, bad(client), v.nodes.some((n) => n.banned)]).toEqual([20, WALLET1_FINAL, [], false]);
    });
  }

  it("a page that is a page and is invalid (the second page of a round lacks txs): the node is banned, nothing of it stays stored", async () => {
    const truth = await vectorChain(100); // two pages of 64 blocks
    const net = new TestNet(truth);
    net.set(A, {
      behave: (url) => {
        if (!isListing(url)) return undefined;
        const since = Number(new URL(url).searchParams.get("since"));
        const l = truth.listing(since, 64) as unknown as Record<string, unknown>;
        if (since > 3) delete l.txs;
        return page(l as never);
      },
    });
    const { client, store, id } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
    await client.round();
    expect([bad(client), listing(client)]).toEqual([[A], B]);
    expect(client.summary().scanned_height).toBeNull(); // rescanned on the ban: nothing of A's pages
    const stored = await store.get(id);
    expect(stored!.revision_id).toBe(client.loaded!.record.revision_id);
    const v = await rounds(client, 2);
    expect([confirmed(client), v.balances.confirmed]).toEqual([100, WALLET1_FINAL]);
  });

  it("a short page (neither the blocks asked for nor the node's tip) is evidence: banned", async () => {
    const truth = await vectorChain(100);
    const net = new TestNet(truth);
    net.set(A, {
      behave: (url) => {
        if (!isListing(url)) return undefined;
        const since = Number(new URL(url).searchParams.get("since"));
        return page(truth.listing(since, 10)); // 10 blocks, tip 100
      },
    });
    const { client } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
    await client.round();
    expect(bad(client)).toEqual([A]);
  });
});

describe("family 5: state reports", () => {
  it('one node\'s stats answer carries "report": "x": the state check runs on the others, counted malformed', async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    net.set(C, { behave: (url) => (isStats(url) ? { status: 200, text: JSON.stringify({ ...truth.stats(), report: "x" }) } : undefined) });
    const { client } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
    const v = await client.round();
    expect([confirmed(client), v.balances.confirmed, bad(client)]).toEqual([20, WALLET1_FINAL, []]);
  });

  it("a report without ciphertext_acc is an outdated node: no vote, shown as 'must be updated', not as dissent", async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    net.set(B, {
      behave: (url) => {
        if (!isStats(url)) return undefined;
        const s = truth.stats();
        const { ciphertext_acc: _drop, ...report } = s.report!;
        void _drop;
        return { status: 200, text: JSON.stringify({ ...s, report }) };
      },
    });
    const { client } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
    const v = await client.round();
    expect(v.nodes.find((n) => n.origin === B)).toMatchObject({ outdated: true, dissents: false, banned: false });
    expect(confirmed(client)).toBe(20); // A and C
  });

  it("an answer above 4 KiB is handed in as its report object; a report above 4 KiB is dropped", async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    const padded = (url: string) => {
      if (!isStats(url)) return undefined;
      const s = truth.stats() as Record<string, unknown>;
      return { status: 200, text: JSON.stringify({ ...s, pool: { ...(s.pool as object), anchor_window: Array(128).fill("ab".repeat(32)) } }) };
    };
    for (const o of ORIGINS) net.set(o, { behave: padded });
    const { client } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
    await client.round();
    expect(confirmed(client)).toBe(20);
    net.set(A, { behave: (url) => (isStats(url) ? { status: 200, text: JSON.stringify({ ...truth.stats(), report: { ...truth.stats().report!, junk: "x".repeat(5000) } }) } : undefined) });
    net.set(B, { behave: (url) => (isStats(url) ? { status: 200, text: JSON.stringify({ ...truth.stats(), report: { ...truth.stats().report!, junk: "x".repeat(5000) } }) } : undefined) });
    await truth.advanceTo(21);
    await client.round();
    expect(confirmed(client)).toBe(20); // only C's report reached the core: no quorum at 21
  });
});

describe("family 6: lagging nodes and the first state check (obligation 2)", () => {
  it("(a) one node a block ahead: no state check in that round; the next round all three at one height → embargo_until = height + 128", async () => {
    const truth = await vectorChain(21);
    const net = new TestNet(truth);
    for (const o of [A, B]) net.set(o, { tip: 20 });
    const { client } = await makeClient({ wallet: "wallet-1", net }); // imported: no statement
    const v1 = await client.round();
    expect([confirmed(client), client.summary().spend_embargo.kind]).toEqual([null, "awaiting_base"]);
    expect(v1.waiting).toMatchObject({ waited: 1, of: FIRST_CHECK_ROUNDS });
    for (const o of [A, B]) net.set(o, { tip: undefined });
    const v2 = await client.round();
    expect([confirmed(client), v2.spend.embargo_until, v2.spend.reason, v2.sole_copy_asserted]).toEqual([21, 21 + 128, "embargo", false]);
  });

  it("(b) one node silent for good: waits exactly W rounds and says so, then proceeds → embargo_until = height + 384", async () => {
    const truth = await vectorChain(21);
    const net = new TestNet(truth);
    net.set(C, { behave: (url) => (isStats(url) ? null : undefined) });
    const { client } = await makeClient({ wallet: "wallet-1", net });
    for (let r = 1; r <= FIRST_CHECK_ROUNDS; r++) {
      const v = await client.round();
      expect([confirmed(client), v.waiting?.waited, v.waiting?.missing]).toEqual([null, r, [C]]);
    }
    const v = await client.round();
    expect([confirmed(client), v.spend.embargo_until, v.spend.embargo_blocks_left]).toEqual([21, 21 + 256 + 128, 384]);
  });

  it("a listing node that lags behind the quorum's tip is left after K rounds (no ban) and the tip is confirmed", async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    net.set(A, { tip: 10 });
    const { client } = await makeClient({ wallet: "wallet-1", net, soleCopy: true });
    for (let r = 0; r < STRIKES; r++) await client.round();
    expect([listing(client), bad(client)]).toEqual([B, []]);
    const v = await client.round();
    expect([confirmed(client), v.balances.confirmed]).toEqual([20, WALLET1_FINAL]);
  });

  it("restored wallet: no statement is made without the user, and the reason is the embargo", async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    const { client } = await makeClient({ wallet: "wallet-2", net });
    const v = await rounds(client, 2);
    expect([v.sole_copy_asserted, v.spend.reason, v.spend.can_spend_now, v.offer, v.origin]).toEqual([false, "embargo", false, false, "imported"]);
    expect(v.spend.embargo_blocks_left).toBe(128);
  });
});
