/**
 * Payments against the mocked node with the REAL WebAssembly package (proofs are built in Node:
 * seconds each). UI_CONTRACT obligations 3 and 4:
 *   - persist { state, envelope } durably BEFORE the submit;
 *   - a lost or unanswered submit is answered with the SAME stored envelope (never a rebuild);
 *   - fault injection: killed between the write and the submit → the restart resubmits the
 *     stored envelope; killed between the build and the write → no lock, nothing in flight;
 *   - two tabs build from one stored state: one write wins, the other gets nothing and submits nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { signShieldV2Bytes } from "@rougechain/core/pqc-signer";
import { ShieldClient, dropUnconfirmedGeneratedState } from "./client";
import { open as openRecord, MemoryStore, type Store } from "./store";
import { ORIGINS, Q, TestNet, makeClient, vectorChain, wallet } from "./testing/fixtures";

const TO = () => wallet("wallet-1");
const AMOUNT = (2n * Q).toString();
const FEE = Q.toString();

async function ready(store?: Store) {
  const truth = await vectorChain(20);
  const net = new TestNet(truth);
  const made = await makeClient({ wallet: "wallet-2", net, store, soleCopy: true });
  const v = await made.client.round();
  expect([v.offer, v.balances.spendable]).toEqual([true, (5n * Q).toString()]);
  return { ...made, net, truth };
}

const isSubmit = (url: string) => url.endsWith("/api/shield-v2/submit");

describe("payments", () => {
  it("the state and the envelope are stored durably before the envelope is submitted", async () => {
    const { client, net, store, key, id } = await ready();
    const seenAtSubmit: boolean[] = [];
    const inner = net.request.bind(net);
    net.request = async (url, init) => {
      if (isSubmit(url)) {
        const rec = await store.get(id);
        const p = await openRecord(key, rec!);
        seenAtSubmit.push(p.envelopes.some((e) => e.envelope === init?.body) && p.history.length === 1);
      }
      return inner(url, init);
    };
    const r = await client.buildTransfer(new Uint8Array(await seedOf()), TO().address, AMOUNT, FEE, TO().address_fingerprint);
    expect(r).toMatchObject({ status: "submitted", submit: "accepted" });
    expect(seenAtSubmit).toEqual([true]);
    const v = client.viewModel();
    expect(v.pending).toHaveLength(1);
    expect(v.pending[0]).toMatchObject({ kind: "transfer", status: "pending", submit: "accepted", amount: AMOUNT });
    expect(v.balances.locked).toBe((5n * Q).toString());
  }, 120_000);

  it("an unanswered submit is answered with the SAME stored envelope in the next round; nothing is built again", async () => {
    const { client, net, api } = await ready();
    const build = vi.spyOn(api, "build_transfer");
    for (const o of ORIGINS) net.set(o, { behave: (url) => (isSubmit(url) ? null : undefined) });
    const r = await client.buildTransfer(new Uint8Array(await seedOf()), TO().address, AMOUNT, FEE, TO().address_fingerprint);
    expect(r).toMatchObject({ status: "submitted", submit: "unanswered" });
    const firstBody = client.loaded!.payload.envelopes[0].envelope;
    for (const o of ORIGINS) net.set(o, { behave: undefined });
    const v = await client.round();
    expect(net.submitted.map((s) => s.body)).toEqual([firstBody]);
    expect(v.pending[0].submit).toBe("accepted");
    expect(build).toHaveBeenCalledTimes(1);
    build.mockRestore();
  }, 120_000);

  it("killed between the write and the submit: after a restart the stored envelope is submitted", async () => {
    const store = new MemoryStore();
    const { client, net, key, id, api, seed, w } = await ready(store);
    (client.o as { hooks?: unknown }).hooks = {
      afterPaymentWrite: () => {
        throw new Error("killed");
      },
    };
    await expect(client.buildTransfer(new Uint8Array(seed), TO().address, AMOUNT, FEE, TO().address_fingerprint)).rejects.toThrow("killed");
    expect(net.submitted).toHaveLength(0);
    // restart: a new client (a new session) on the same storage
    const again = new ShieldClient({ api, store, net, key, id, address: w.address, scanKey: api.export_scan_key(seed, true), origins: ORIGINS });
    await again.open();
    const stored = again.loaded!.payload.envelopes[0].envelope;
    await again.round();
    expect(net.submitted.map((s) => s.body)).toEqual([stored]);
    expect(again.summary().pending).toHaveLength(1);
  }, 120_000);

  it("killed between the build and the write: no lock and no transaction in flight", async () => {
    const store = new MemoryStore();
    const { client, net, key, id, api, seed, w } = await ready(store);
    const crashing: Store = {
      get: (i) => store.get(i),
      cas: async () => {
        throw new Error("killed");
      },
    };
    (client.o as { store: Store }).store = crashing;
    await expect(client.buildTransfer(new Uint8Array(seed), TO().address, AMOUNT, FEE, TO().address_fingerprint)).rejects.toThrow("killed");
    const again = new ShieldClient({ api, store, net, key, id, address: w.address, scanKey: api.export_scan_key(seed, true), origins: ORIGINS });
    await again.open();
    await again.round();
    expect([again.summary().pending.length, again.loaded!.payload.envelopes.length, net.submitted.length]).toEqual([0, 0, 0]);
    expect(again.viewModel().balances.spendable).toBe((5n * Q).toString());
  }, 120_000);

  it("two tabs build from one stored state: one write wins, the other is discarded and submits nothing", async () => {
    const store = new MemoryStore();
    const { client: tab1, net, key, id, api, seed, w } = await ready(store);
    const tab2 = new ShieldClient({ api, store, net, key, id, address: w.address, scanKey: api.export_scan_key(seed, true), origins: ORIGINS });
    await tab2.open();
    // Both tabs hold the same stored revision and both were offered a payment on it. (Every round
    // writes — confirm_state and resolve_pending move the revision — so two real tabs reach this
    // only when their rounds interleave; the offer gate alone already refuses a stale tab. Here
    // tab 2's offer is set as its own round would have set it, to exercise the compare-and-swap.)
    await tab1.load();
    expect(tab1.loaded!.record.revision_id).toBe(tab2.loaded!.record.revision_id);
    (tab2 as unknown as { offer: { ok: boolean; revision_id: string } }).offer = { ok: true, revision_id: tab2.loaded!.record.revision_id };
    expect(tab1.viewModel().offer && tab2.viewModel().offer).toBe(true);
    const results = await Promise.all([
      tab1.buildTransfer(new Uint8Array(seed), TO().address, AMOUNT, FEE, TO().address_fingerprint),
      tab2.buildTransfer(new Uint8Array(seed), TO().address, (3n * Q).toString(), FEE, TO().address_fingerprint),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["not_written", "submitted"]);
    expect(net.submitted).toHaveLength(1);
    const p = await openRecord(key, (await store.get(id))!);
    expect(p.envelopes).toHaveLength(1);
    expect(p.envelopes[0].envelope).toBe(net.submitted[0].body);
  }, 180_000);

  it("a restored wallet (embargo) is offered no transfer; the build is refused by the core too", async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    const { client, seed } = await makeClient({ wallet: "wallet-2", net });
    for (let i = 0; i < 2; i++) await client.round();
    expect(client.viewModel().offer).toBe(false);
    const r = await client.buildTransfer(new Uint8Array(seed), TO().address, AMOUNT, FEE, TO().address_fingerprint);
    expect(r).toEqual({ status: "not_offered" });
    expect(net.submitted).toHaveLength(0);
  });
});

async function seedOf(): Promise<Uint8Array> {
  const h = wallet("wallet-2").bip39_seed;
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
}

describe("shield signing", () => {
  it("the wallet core's real shield signing_bytes pass the site's shield-only signer", async () => {
    const { client } = await ready();
    const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
    const kp = ml_dsa65.keygen(new Uint8Array(32).fill(9));
    const pub = hex(kp.publicKey);
    const p = await client.prepareShield(pub, (3n * Q).toString(), FEE);
    expect(p.status).toBe("sign");
    const bytes = (p as { signing_bytes: string }).signing_bytes;
    const sig = signShieldV2Bytes(bytes, hex(kp.secretKey), pub);
    // ...and the same bytes are refused for a different key
    expect(() => signShieldV2Bytes(bytes, hex(kp.secretKey), "00".repeat(1952))).toThrow();
    const done = await client.completeShield(sig);
    expect(done.status).toBe("submitted");
  }, 120_000);
});

describe("an imported phrase and an earlier create()", () => {
  it("an unconfirmed 'generated' state loses its sole-copy statement; the next session is under the embargo", async () => {
    const truth = await vectorChain(20);
    const net = new TestNet(truth);
    const made = await makeClient({ wallet: "wallet-2", net, soleCopy: true, open: false });
    expect(await dropUnconfirmedGeneratedState(made.api, made.store, made.key, made.id, made.w.address)).toBe(true);
    const rec = await made.store.get(made.id);
    const p = await openRecord(made.key, rec!);
    expect(p.origin).toBe("imported");
    expect(JSON.parse(made.api.summary(p.state)).sole_copy_asserted).toBe(false);
    // a second call finds nothing to drop
    expect(await dropUnconfirmedGeneratedState(made.api, made.store, made.key, made.id, made.w.address)).toBe(false);
  }, 120_000);

  it("a state with a confirmed check is this device's own record and is kept", async () => {
    const { store, key, id, api, w } = await ready();
    const before = await store.get(id);
    expect(await dropUnconfirmedGeneratedState(api, store, key, id, w.address)).toBe(false);
    expect(await store.get(id)).toEqual(before);
  }, 120_000);
});

describe("privacy from the listing node", () => {
  it("a payment is submitted first to a node other than the one the wallet scanned from", async () => {
    const { client, net } = await ready();
    const listing = client.nodes[client.session!.listing];
    const firstSubmit: string[] = [];
    const inner = net.request.bind(net);
    net.request = async (url, init) => {
      if (isSubmit(url) && firstSubmit.length === 0) firstSubmit.push(url);
      return inner(url, init);
    };
    const r = await client.buildTransfer(new Uint8Array(await seedOf()), TO().address, AMOUNT, FEE, TO().address_fingerprint);
    expect(r).toMatchObject({ status: "submitted", submit: "accepted" });
    expect(firstSubmit).toHaveLength(1);
    expect(firstSubmit[0].startsWith(listing)).toBe(false);
  }, 120_000);
});
