import { describe, expect, it } from "vitest";
import { canCollect, computeLpEarnings, type LpPoolEvent } from "@/lib/lp-earnings";
import mainnetEvents from "./fixtures-xrge-qusdc-events.json";

/** Minimal constant-product pool mirroring core/daemon/src/amm.rs (integer maths, 0.3% fee). */
class Pool {
  a = 0;
  b = 0;
  supply = 0;
  events: LpPoolEvent[] = [];
  private n = 0;
  private log(type: string, user: string, lp?: number) {
    this.n += 1;
    this.events.push({
      id: `e${this.n}`, event_type: type, user_pub_key: user, timestamp: 1000 + this.n,
      block_height: this.n, lp_amount: lp, reserve_a_after: this.a, reserve_b_after: this.b,
    });
  }
  add(user: string, a: number, b: number) {
    const lp = this.supply === 0
      ? Math.floor(Math.sqrt(a * b)) - 1000
      : Math.min(Math.floor((a * this.supply) / this.a), Math.floor((b * this.supply) / this.b));
    this.a += a; this.b += b; this.supply += lp;
    this.log(this.n === 0 ? "CreatePool" : "AddLiquidity", user, lp);
    return lp;
  }
  remove(user: string, lp: number) {
    const outA = Math.floor((lp * this.a) / this.supply);
    const outB = Math.floor((lp * this.b) / this.supply);
    this.a -= outA; this.b -= outB; this.supply -= lp;
    this.log("RemoveLiquidity", user, lp);
    return [outA, outB];
  }
  swapAforB(amountIn: number) {
    const inFee = amountIn * 997;
    const out = Math.floor((inFee * this.b) / (this.a * 1000 + inFee));
    this.a += amountIn; this.b -= out;
    this.log("Swap", "trader");
  }
  swapBforA(amountIn: number) {
    const inFee = amountIn * 997;
    const out = Math.floor((inFee * this.a) / (this.b * 1000 + inFee));
    this.b += amountIn; this.a -= out;
    this.log("Swap", "trader");
  }
  state() {
    return { reserve_a: this.a, reserve_b: this.b, total_lp_supply: this.supply };
  }
}

describe("computeLpEarnings", () => {
  it("is zero right after depositing", () => {
    const p = new Pool();
    const lp = p.add("alice", 1_000_000, 2_000_000);
    const e = computeLpEarnings(p.events, p.state(), ["alice"], lp);
    expect(e?.lpToCollect).toBe(0);
    expect(canCollect(e)).toBe(false);
  });

  it("collects the fees from round-trip trading and leaves the deposit", () => {
    const p = new Pool();
    const lp = p.add("alice", 10_000_000, 10_000_000);
    // Trade back and forth so the price ends near where it started: all growth is fees.
    for (let i = 0; i < 20; i++) { p.swapAforB(500_000); p.swapBforA(500_000); }
    const e = computeLpEarnings(p.events, p.state(), ["alice"], lp)!;
    expect(canCollect(e)).toBe(true);
    // 40 swaps × 500k × 0.3% ≈ 60k of fees split across both sides → ~30k each.
    expect(e.earnedA + e.earnedB).toBeGreaterThan(50_000);
    expect(e.earnedA + e.earnedB).toBeLessThan(70_000);
    const [outA, outB] = p.remove("alice", e.lpToCollect);
    expect([outA, outB]).toEqual([e.earnedA, e.earnedB]);
    // What remains is worth the original deposit (in √k terms).
    const after = computeLpEarnings(p.events, p.state(), ["alice"], lp - e.lpToCollect)!;
    expect(after.lpToCollect).toBeLessThanOrEqual(1);
  });

  it("gives a late LP only the fees earned after they joined", () => {
    const p = new Pool();
    const aliceLp = p.add("alice", 10_000_000, 10_000_000);
    for (let i = 0; i < 10; i++) { p.swapAforB(400_000); p.swapBforA(400_000); }
    const bobLp = p.add("bob", 10_000_000, 10_000_000);
    const bobBefore = computeLpEarnings(p.events, p.state(), ["bob"], bobLp)!;
    expect(bobBefore.lpToCollect).toBeLessThanOrEqual(1);
    for (let i = 0; i < 10; i++) { p.swapAforB(400_000); p.swapBforA(400_000); }
    const alice = computeLpEarnings(p.events, p.state(), ["alice"], aliceLp)!;
    const bob = computeLpEarnings(p.events, p.state(), ["bob"], bobLp)!;
    // Alice earned alone for the first round and half of the second.
    expect(alice.earnedA + alice.earnedB).toBeGreaterThan(2.5 * (bob.earnedA + bob.earnedB));
  });

  it("takes a withdrawal from earnings first, then the deposit", () => {
    const p = new Pool();
    const lp = p.add("alice", 10_000_000, 10_000_000);
    for (let i = 0; i < 10; i++) { p.swapAforB(400_000); p.swapBforA(400_000); }
    const before = computeLpEarnings(p.events, p.state(), ["alice"], lp)!;
    p.remove("alice", Math.floor(lp / 2));
    const after = computeLpEarnings(p.events, p.state(), ["alice"], lp - Math.floor(lp / 2))!;
    // Half the position is far more than the earnings, so nothing is left to collect.
    expect(after.lpToCollect).toBeLessThanOrEqual(1);
    for (let i = 0; i < 10; i++) { p.swapAforB(400_000); p.swapBforA(400_000); }
    const later = computeLpEarnings(p.events, p.state(), ["alice"], lp - Math.floor(lp / 2))!;
    expect(later.lpToCollect).toBeGreaterThan(before.lpToCollect / 4);
  });

  it("returns null when history doesn't explain the balance", () => {
    const p = new Pool();
    const lp = p.add("alice", 1_000_000, 1_000_000);
    p.swapAforB(10_000);
    expect(computeLpEarnings(p.events.slice(1), p.state(), ["alice"], lp)).toBeNull();
    expect(computeLpEarnings(p.events, p.state(), ["alice"], lp + 5)).toBeNull();
  });

  it("reads mainnet XRGE-qUSDC history", () => {
    const pool = { reserve_a: 54_896_113, reserve_b: 100_189_818, total_lp_supply: 74_160_984 };
    const e = computeLpEarnings(mainnetEvents as LpPoolEvent[], pool, ["owner"], 74_160_984)!;
    expect(e).not.toBeNull();
    expect(e.lpToCollect).toBeGreaterThan(0);
    expect(e.growth).toBeGreaterThan(0);
    expect(e.growth).toBeLessThan(0.01);
  });
});
