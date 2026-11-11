/* global crypto */
// A mocked RougeChain node for the shielded pool V2 — TESTS AND THE PLAYWRIGHT RUN ONLY (nothing
// in the site imports this file). Plain JavaScript so that both vitest and the Node server of
// scripts/shield-e2e.mjs load it as it is.
//
// It serves the node's REAL response shapes (core/daemon/src/node.rs `shield_v2_notes_since`,
// `shield_v2_stats`; main.rs `/api/health`, `/api/account/:pk/nonce`, `/api/shield-v2/submit`):
//
// * the listing: `{ active, tip_height, from_height, next_height, txs: [{ height, index, tx_hash,
//   tx_type, nf1, nf2, outputs: [{ cm_out, leaf, kem_ct, note_ct }, …] }], success: true }`,
//   `since` clamped to the activation height, at most `blocks` blocks, exactly as the node;
// * the stats: the pool record and the node-local `report` of its last accepted block.
//
// The pool's values (tree root, nullifier hash, counts, ciphertext hash) are not computed here:
// an OBSERVER wallet state of the real WebAssembly package scans the chain's own listing, block by
// block, and its `summary` gives them — every wallet computes the same pool values from the same
// listing (checked against core/shield-v2/vectors/wallet/state_root.json by the tests). So a liar
// that lists a chain of its own reports values consistent with its own lie.

export const KEM_OFF = [258, 1402];
export const NOTE_OFF = [1346, 2490];
const TX_TYPE = { 1: "shield_v2", 2: "shielded_transfer_v2", 3: "unshield_v2" };

export const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (s) => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const u64le = (b, off) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
};
export async function sha256hex(u8) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", u8)));
}

/** The listing entry of one V2 body (as `shield_v2_notes_since` writes it). */
export async function listingTx(bodyHex, height, index, firstLeaf) {
  const b = unhex(bodyHex);
  const outputs = [0, 1].map((j) => ({
    cm_out: hex(b.slice(138 + 32 * j, 170 + 32 * j)),
    leaf: firstLeaf + j,
    kem_ct: hex(b.slice(KEM_OFF[j], KEM_OFF[j] + 1088)),
    note_ct: hex(b.slice(NOTE_OFF[j], NOTE_OFF[j] + 56)),
  }));
  return { height, index, tx_hash: await sha256hex(b), tx_type: TX_TYPE[b[1]], nf1: hex(b.slice(74, 106)), nf2: hex(b.slice(106, 138)), outputs };
}

export function bodyFields(bodyHex) {
  const b = unhex(bodyHex);
  return { kind: b[1], expiry_height: Number(u64le(b, 34)), nf1: hex(b.slice(74, 106)), nf2: hex(b.slice(106, 138)), v_in: u64le(b, 202), v_out: u64le(b, 210), fee: u64le(b, 218) };
}

/**
 * A chain: blocks of V2 bodies from the activation height, the observer's pool values after every
 * block, and the node's answers for any tip at or below its own (`view(tip)`: a lagging node).
 */
export class MockChain {
  /**
   * @param {object} o
   * @param {object} o.api the WebAssembly package (summary, new_state, scan)
   * @param {string} o.observerAddress any shielded address
   * @param {string} o.observerKey its scan key
   * @param {number} o.activation the activation height
   * @param {string} [o.chainId]
   */
  constructor(o) {
    this.api = o.api;
    this.activation = o.activation;
    this.chainId = o.chainId ?? "rougechain-devnet-1";
    this.key = o.observerKey;
    this.state = o.api.new_state(o.observerAddress, "1", 0);
    this.blocks = new Map(); // height → [bodyHex]
    this.leaves = new Map(); // height → first leaf of the block
    this.txs = new Map(); // height → listing entries
    this.reports = new Map(); // height → report (without node_id)
    this.pool = new Map(); // height → { total, window }
    this.tip = o.activation - 1;
    this.nextLeaf = 0;
    this.poolTotal = 0n;
    this.window = [];
    this.nonces = new Map();
    const s = JSON.parse(o.api.summary(this.state));
    this.window.push(s.anchor);
    this.record(this.tip, s);
  }

  record(height, s) {
    this.reports.set(height, { height, tree_root: s.anchor, nullifier_acc: s.nullifier_acc, note_count: s.note_count, nullifier_count: s.nullifier_count, ciphertext_acc: s.ciphertext_acc });
    this.pool.set(height, { total: this.poolTotal, window: [...this.window] });
  }

  /** Appends one block (possibly empty) at tip + 1. */
  async addBlock(bodies = []) {
    const h = this.tip + 1;
    const entries = [];
    for (const [i, body] of bodies.entries()) {
      entries.push(await listingTx(body, h, i, this.nextLeaf));
      this.nextLeaf += 2;
      const f = bodyFields(body);
      this.poolTotal += f.v_in - f.v_out - f.fee;
    }
    this.blocks.set(h, bodies);
    this.txs.set(h, entries);
    this.tip = h;
    if (entries.length) {
      const from = Math.max(JSON.parse(this.api.summary(this.state)).next_height, this.activation);
      const page = JSON.stringify({ active: true, tip_height: h, from_height: from, next_height: h + 1, txs: entries });
      const rev = JSON.parse(this.api.summary(this.state)).revision;
      const r = JSON.parse(this.api.scan(this.state, page, this.key, rev));
      this.state = JSON.stringify(r.state);
      const s = JSON.parse(this.api.summary(this.state));
      this.window.push(s.anchor);
      if (this.window.length > 128) this.window.shift();
      this.record(h, s);
    } else {
      const prev = this.reports.get(h - 1);
      this.reports.set(h, { ...prev, height: h });
      this.pool.set(h, { total: this.poolTotal, window: [...this.window] });
    }
    return h;
  }

  async advanceTo(h) {
    while (this.tip < h) await this.addBlock([]);
  }

  /** `GET /api/shield-v2/notes?since&blocks` as the node answers it at tip `tip`. */
  listing(since, blocks = 64, tip = this.tip) {
    blocks = Math.min(Math.max(blocks, 1), 256);
    const start = Math.max(since, this.activation);
    const end = Math.min(tip, start + blocks - 1);
    const txs = [];
    let h = start;
    while (h <= end) {
      for (const t of this.txs.get(h) ?? []) txs.push(t);
      h += 1;
    }
    return { active: true, tip_height: tip, from_height: start, next_height: Math.max(h, start), txs, success: true };
  }

  /** `GET /api/shield-v2/stats` at tip `tip`. */
  stats(tip = this.tip) {
    const report = this.reports.get(tip) ?? null;
    const pool = this.pool.get(tip);
    const last = this.reports.get(tip);
    return {
      activation_height: this.activation,
      active: true,
      tip_height: tip,
      min_fee_quanta: 1000000000,
      pool_cap_quanta: "1000000000000000",
      max_tx_per_block: 8,
      anchor_window: 128,
      verified_proof_cache: 0,
      refused_proof_cache: 0,
      report,
      pool: pool && last
        ? { next_height: tip + 1, pool_total_quanta: pool.total.toString(), note_count: last.note_count, nullifier_count: last.nullifier_count, tree_root: last.tree_root, nullifier_acc: last.nullifier_acc, anchor_window_len: pool.window.length, anchor_window: pool.window, latest_anchor: pool.window[pool.window.length - 1] }
        : null,
      success: true,
    };
  }
}

/** A node whose chain has no activation height (`active: false`). */
export function inactiveListing(since, tip) {
  return { active: false, tip_height: tip, from_height: since, next_height: since, txs: [], success: true };
}
export function inactiveStats(tip) {
  return { activation_height: null, active: false, tip_height: tip, min_fee_quanta: 1000000000, pool_cap_quanta: "1000000000000000", max_tx_per_block: 8, anchor_window: 128, verified_proof_cache: 0, refused_proof_cache: 0, report: null, pool: null, success: true };
}

/**
 * The HTTP answers of one node: `{ status, text }`, or null for no response. `behave` may
 * override any route: `behave(kind, url, honest)` returns an answer or undefined for the honest one.
 */
export function nodeAnswer(chain, url, init, opts = {}) {
  const u = new URL(url);
  const tip = opts.tip ?? chain.tip;
  const json = (v, status = 200) => ({ status, text: JSON.stringify(v) });
  if (u.pathname === "/api/shield-v2/notes") {
    const since = Number(u.searchParams.get("since") ?? 0);
    const blocks = Number(u.searchParams.get("blocks") ?? 64);
    return json(chain.listing(since, blocks, tip));
  }
  if (u.pathname === "/api/shield-v2/stats") return json(chain.stats(tip));
  if (u.pathname === "/api/health") return json({ status: "ok", chain_id: chain.chainId, height: tip });
  const nonce = /^\/api\/account\/([0-9a-f]+)\/nonce$/.exec(u.pathname);
  if (nonce) {
    const n = chain.nonces.get(nonce[1]) ?? 0;
    return json({ success: true, nonce: n, next_nonce: n + 1 });
  }
  if (u.pathname === "/api/shield-v2/submit" && init?.method === "POST") return { status: 200, text: JSON.stringify({ success: true, error: null }), submitted: init.body };
  return { status: 404, text: "" };
}
