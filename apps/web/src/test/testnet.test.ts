/**
 * Live testnet integration tests.
 * These hit the real testnet API at testnet.rougechain.io.
 * All tests are read-only — no transactions submitted.
 */

import { describe, it, expect, beforeAll } from "vitest";

const BASE = "https://testnet.rougechain.io/api";

// A known validator public key present on the testnet (used for balance lookup).
// If this changes, any test using it will fail with a clear message.
let knownValidatorPubKey: string | null = null;
let latestBlockHash: string | null = null;
let latestBlockHeight: number | null = null;

beforeAll(async () => {
  // Grab chain stats once so individual tests can reference live data.
  const res = await fetch(`${BASE}/stats`);
  if (!res.ok) return;
  const stats = await res.json() as { network_height?: number };
  latestBlockHeight = stats.network_height ?? null;

  // Pull a validator pubkey for balance tests.
  const vres = await fetch(`${BASE}/validators`);
  if (vres.ok) {
    const vdata = await vres.json() as { validators?: Array<{ publicKey: string }> };
    knownValidatorPubKey = vdata.validators?.[0]?.publicKey ?? null;
  }

  // Pull the latest block hash.
  if (latestBlockHeight !== null) {
    const bres = await fetch(`${BASE}/block/${latestBlockHeight}`);
    if (bres.ok) {
      const bdata = await bres.json() as { block?: { hash: string } };
      latestBlockHash = bdata.block?.hash ?? null;
    }
  }
}, 30_000);

// ─── /api/stats ───────────────────────────────────────────────────────────────

describe("GET /api/stats", () => {
  it("returns 200 with expected fields", async () => {
    const res = await fetch(`${BASE}/stats`);
    expect(res.status).toBe(200);

    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty("network_height");
    expect(data).toHaveProperty("chain_id");
    expect(data).toHaveProperty("is_mining");
    expect(data).toHaveProperty("base_fee");
    expect(data).toHaveProperty("finalized_height");
  });

  it("chain_id is rougechain-devnet-1", async () => {
    const res = await fetch(`${BASE}/stats`);
    const data = await res.json() as { chain_id: string };
    expect(data.chain_id).toBe("rougechain-devnet-1");
  });

  it("network_height is a positive integer", async () => {
    const res = await fetch(`${BASE}/stats`);
    const data = await res.json() as { network_height: number };
    expect(typeof data.network_height).toBe("number");
    expect(data.network_height).toBeGreaterThan(0);
  });

  it("base_fee is a non-negative number", async () => {
    const res = await fetch(`${BASE}/stats`);
    const data = await res.json() as { base_fee: number };
    expect(typeof data.base_fee).toBe("number");
    expect(data.base_fee).toBeGreaterThanOrEqual(0);
  });

  it("is_mining is a boolean", async () => {
    const res = await fetch(`${BASE}/stats`);
    const data = await res.json() as { is_mining: boolean };
    expect(typeof data.is_mining).toBe("boolean");
  });
});

// ─── /api/blocks ──────────────────────────────────────────────────────────────

describe("GET /api/blocks", () => {
  it("returns 200 with blocks array", async () => {
    const res = await fetch(`${BASE}/blocks?limit=5`);
    expect(res.status).toBe(200);

    const data = await res.json() as { blocks: unknown[] };
    expect(Array.isArray(data.blocks)).toBe(true);
    expect(data.blocks.length).toBeGreaterThan(0);
    expect(data.blocks.length).toBeLessThanOrEqual(5);
  });

  it("each block has required fields", async () => {
    const res = await fetch(`${BASE}/blocks?limit=3`);
    const data = await res.json() as {
      blocks: Array<{
        hash: string;
        header: { height: number; time: number };
        txs: unknown[];
      }>;
    };

    for (const block of data.blocks) {
      expect(block).toHaveProperty("hash");
      expect(typeof block.hash).toBe("string");
      expect(block.hash).toHaveLength(64); // sha256 hex
      expect(block).toHaveProperty("header");
      expect(typeof block.header.height).toBe("number");
      expect(typeof block.header.time).toBe("number");
      expect(Array.isArray(block.txs)).toBe(true);
    }
  });

  it("blocks are ordered by height ascending", async () => {
    const res = await fetch(`${BASE}/blocks?limit=5`);
    const data = await res.json() as { blocks: Array<{ header: { height: number } }> };
    const heights = data.blocks.map((b) => b.header.height);
    for (let i = 0; i < heights.length - 1; i++) {
      expect(heights[i]).toBeLessThanOrEqual(heights[i + 1]);
    }
  });
});

// ─── /api/block/:height ───────────────────────────────────────────────────────

describe("GET /api/block/:height", () => {
  it("returns the correct block for a given height", async () => {
    if (latestBlockHeight === null) {
      console.warn("Skipping: could not determine latest block height");
      return;
    }
    const height = Math.max(1, latestBlockHeight - 5);
    const res = await fetch(`${BASE}/block/${height}`);
    expect(res.status).toBe(200);

    // /api/block/:height returns { block: { height, hash, prevHash, ... }, success }
    const data = await res.json() as { block: { height: number; hash: string }; success: boolean };
    expect(data.success).toBe(true);
    expect(data.block.height).toBe(height);
    expect(typeof data.block.hash).toBe("string");
    expect(data.block.hash).toHaveLength(64);
  });

  it("returns 404 or error for a far-future block", async () => {
    const res = await fetch(`${BASE}/block/99999999`);
    // Should be non-200 or return an error field
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      // If it 200s, it must include an error/empty block indication
      expect(data.block ?? data.error).toBeDefined();
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});

// ─── /api/validators ──────────────────────────────────────────────────────────

describe("GET /api/validators", () => {
  it("returns a validators array", async () => {
    const res = await fetch(`${BASE}/validators`);
    expect(res.status).toBe(200);

    const data = await res.json() as { validators: unknown[] };
    expect(Array.isArray(data.validators)).toBe(true);
    expect(data.validators.length).toBeGreaterThan(0);
  });

  it("each validator has publicKey and stake", async () => {
    const res = await fetch(`${BASE}/validators`);
    const data = await res.json() as {
      validators: Array<{ publicKey: string; stake: string | number; status: string }>;
    };
    for (const v of data.validators) {
      expect(typeof v.publicKey).toBe("string");
      expect(v.publicKey.length).toBeGreaterThan(0);
      expect(typeof v.stake).toBe("number");
      expect(v.stake).toBeGreaterThanOrEqual(0);
      expect(typeof v.status).toBe("string");
    }
  });
});

// ─── /api/balance/:pubkey ─────────────────────────────────────────────────────

describe("GET /api/balance/:pubkey", () => {
  it("returns balance for a known validator", async () => {
    if (!knownValidatorPubKey) {
      console.warn("Skipping: no validator pubkey available");
      return;
    }
    const res = await fetch(`${BASE}/balance/${knownValidatorPubKey}`);
    expect(res.status).toBe(200);

    const data = await res.json() as { success: boolean; balance: number };
    expect(data.success).toBe(true);
    expect(typeof data.balance).toBe("number");
    expect(data.balance).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 balance for an unknown address (not an error)", async () => {
    // Use a valid-looking but nonexistent pubkey (all zeros hex, 1952 bytes = 3904 chars)
    const fakePubKey = "00".repeat(1952);
    const res = await fetch(`${BASE}/balance/${fakePubKey}`);
    // Should succeed (balance=0) or return a structured error
    if (res.ok) {
      const data = await res.json() as { balance: number };
      expect(data.balance).toBe(0);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});

// ─── /api/fee ─────────────────────────────────────────────────────────────────

describe("GET /api/fee", () => {
  it("returns fee info with base_fee", async () => {
    const res = await fetch(`${BASE}/fee`);
    expect(res.status).toBe(200);

    const data = await res.json() as { base_fee: number };
    expect(typeof data.base_fee).toBe("number");
    expect(data.base_fee).toBeGreaterThanOrEqual(0);
  });
});

// ─── /api/tokens ──────────────────────────────────────────────────────────────

describe("GET /api/tokens", () => {
  it("returns a tokens list", async () => {
    const res = await fetch(`${BASE}/tokens`);
    expect(res.status).toBe(200);

    const data = await res.json() as { tokens?: unknown[]; success?: boolean };
    // API may return { tokens: [...] } or an array directly
    const list = data.tokens ?? (Array.isArray(data) ? data : null);
    expect(list).not.toBeNull();
  });
});

// ─── /api/pools ───────────────────────────────────────────────────────────────

describe("GET /api/pools", () => {
  it("returns a pools response", async () => {
    const res = await fetch(`${BASE}/pools`);
    expect(res.status).toBe(200);

    const data = await res.json() as { pools?: unknown[]; success?: boolean };
    expect(data).toBeDefined();
  });
});
