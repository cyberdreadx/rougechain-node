import { describe, expect, it } from "vitest";
import { vectorChain, vectors, TestNet, makeClient, rounds, Q } from "./testing/fixtures";

describe("mocked node: the vector chain", () => {
  it("mock chain values match state_root.json", async () => {
    const chain = await vectorChain(8);
    for (const [i, h] of [2, 3, 4, 5].entries()) {
      const want = vectors.roots.states[i].state;
      const got = chain.reports.get(h)!;
      expect([got.tree_root, got.nullifier_acc, got.note_count, got.nullifier_count]).toEqual([want.tree_root, want.nullifier_acc, want.note_count, want.nullifier_count]);
    }
  });
  it("honest nodes: wallet-2 confirms 5 XRGE", async () => {
    const chain = await vectorChain(20);
    const net = new TestNet(chain);
    const { client } = await makeClient({ wallet: "wallet-2", net, soleCopy: true });
    const v = await rounds(client, 3);
    expect(v.balances.confirmed).toBe((5n * Q).toString());
  });
});
