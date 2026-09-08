# Adding a Validator to a Live Chain

This note explains **how a new validator joins a chain that is already running**, and clears up a common misreading of the sync code. If you just want the step-by-step operator walkthrough, read [Becoming a Validator](becoming-validator.md) first — this page explains *why* those steps are ordered the way they are, and what happens at the network level when you get it wrong.

## The one invariant: stake before you propose

> A block is accepted by other nodes only if its **proposer is a staked validator** in the on-chain validator set. So a new validator must **stake first, confirm it is in the active set, and only then start proposing blocks.** Propose before you are staked-and-in-set, and every peer silently rejects your blocks.

That is the whole rule. Everything below is the mechanism behind it.

## Myth vs. reality: "the chain becomes unjoinable after block 100"

You may hear — often from a tool reading the source — that RougeChain "becomes unjoinable the moment it passes block 100." **This is false**, and it comes from misreading one line in the P2P import path (`core/daemon/src/node.rs`, `import_block`):

```rust
let validators = self.list_validators().unwrap_or_default();
if !validators.is_empty() && block.header.height > PROPOSER_AUTH_ACTIVATION_HEIGHT {
    // proposer must be a staked validator (stake > 0), else reject this block
}
```

`PROPOSER_AUTH_ACTIVATION_HEIGHT` is `100`. The rule this enforces is *"past height 100, an imported block's proposer must be a staked validator"* — **not** *"past height 100, imported blocks are rejected."* Whether it is a wall or a no-op depends entirely on **who is producing the blocks**:

- If blocks are produced by **staked validators** (genesis `initial_validators`, or anyone added later via a `stake` tx), then every syncing node **rebuilds that same validator set from history** as it replays the chain, recognizes the proposer, and accepts the block **at any height**. The chain stays fully joinable forever.
- The check only ever rejects a block whose proposer is **not** a staked validator — i.e. a genuine misconfiguration (a node mining with an unstaked key). That is the check doing its job.

So the "cliff" is really the [stake-before-propose invariant](#the-one-invariant-stake-before-you-propose) stated backwards. Growing the validator set is not blocked by this check — it is *governed* by it: stake correctly and joining works at height 100, 10,000, or 10,000,000.

## How proposer authorization actually works

Two things combine:

1. **The validator set is deterministic from history.** Genesis seeds `initial_validators` (each with a stake), and every later `stake` / `unstake` transaction updates the on-chain validator store. Because a syncing node replays the exact same blocks in the exact same order, it derives the exact same validator-set *membership* at every height. There is no out-of-band "validator list" a joiner can be missing — it is a function of the chain it is already downloading.

2. **A bootstrap grace window below height `PROPOSER_AUTH_ACTIVATION_HEIGHT` (100).** Blocks at or below height 100 skip **only the proposer-authorization check** — they are *not* otherwise unvalidated. A block below 100 must still pass its proposer signature, block hash, and `prev_hash`, **every** transaction signature (verified at all heights), and — past the v2 fork height (18) — the committed **state root** and the **contract-custody** apply. Skipping proposer authorization just lets a brand-new network get off the ground before staking transactions have populated the set. **Above height 100 the proposer check is enforced** (once the set is non-empty — see below), so on a mature chain there is no grace period: a new validator must already be staked and in the set before its blocks will be accepted by peers.

> **Two edge cases in that gate.** (a) The check is also short-circuited when the node's locally-derived validator set is *empty* (a defensive don't-brick fallback) — so it is meaningfully enforced only once the set is non-empty *and* height exceeds 100. (b) It gates **imported** blocks (the P2P sync path); a node's own freshly-produced block isn't self-rejected, which is exactly why an unstaked miner's height climbs locally while peers reject the same blocks.

> The grace window is a bootstrap aid, **not** something to rely on when adding a validator. On any chain past height 100 it does nothing for you. Always follow stake-before-propose regardless of current height.

## Adding a validator to a running chain — the correct sequence

This mirrors [Becoming a Validator](becoming-validator.md), with the reason each step is load-bearing. Follow that guide for exact commands.

1. **Generate the node identity and sync to the tip.** Your `node-keys.json` key is both your stake-holding key and your block-signing key — they must be the same key. Let the node fully sync first so your `stake` tx builds on the current tip.
2. **Fund the key, then stake ≥ `min_stake` (10,000 XRGE).** The freshly-generated key starts empty — first send **≥ 10,000 XRGE (+ ~0.1 XRGE fee)** to the validator address, *then* submit the `stake` tx from that key and wait for it to be **included in a block**. (Staking from an unfunded key fails on the fee/balance check.) This is the step that puts your key into the on-chain validator set that every peer derives.
3. **Confirm you are in the active set** before mining:
   ```bash
   rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json validator-status
   ```
   You want `✓ Staked` and `✓ In active set`. Do not skip this — it is the difference between "my blocks are accepted" and "my blocks are silently rejected by every peer."
4. **Only now start `--mine` — and make the node reachable.** Start with `--mine` *and* a public URL (`--public-url https://…`) with the P2P port open/forwarded, exactly as [Becoming a Validator Step 4](becoming-validator.md#step-4--start-mining) shows. Being staked makes your blocks *acceptable*; being dialable is what lets them *propagate* — peers must be able to reach you or your accepted blocks still won't spread.

Do these out of order — mine before the `stake` tx is confirmed and in the set — and past height 100 your blocks are rejected network-wide with no obvious error on your side. That failure mode, not a height cliff, is the real thing to avoid.

## Detecting the failure mode

Symptoms fall into two distinct buckets — don't conflate them:

**Your key isn't staked / not in the active set** (fix: stake it, or point the node at the staked key's `node-keys.json`):

- `validator-status` shows `✗` on **Staked** or **In active set** — the fix is printed next to it (usually: stake, top up, or wait for the `stake` tx to confirm).
- Peers log the rejection on the P2P import path — the inner error is `Block <h> rejected: proposer <pk> not in validator set with active stake` (where `<pk>` is the first 16 hex chars of the key), wrapped as `[peer] Failed to import block <h>: …`.

**You *are* staked and in the active set, but peers still don't adopt your blocks / you earn no fees.** This is a *reachability* problem, not a staking one — check it before re-staking anything:

- `--public-url` is not set, or points somewhere peers can't reach.
- The P2P port is firewalled / not forwarded, or you have no connected peers.
- You've been **jailed** after missed-block slashing (see [slashing](becoming-validator.md#security--slashing--read-before-you-go-live)) — jailed validators are out of the active set until the jail window passes.

The clue is signal 3 *in isolation*: block acceptance itself has no reachability component (it's purely proposer-auth + signatures + hash + state), so "height climbs locally but nothing propagates" with green `validator-status` checks points at the network, not the stake.

## Constraints worth knowing

- **`min_stake`: 10,000 XRGE**, enforced by the `stake` CLI/RPC submission path (top-ups must each be ≥ 10,000; totals accumulate). Note this is a submission-time guard, not a consensus-level rejection.
- **Active-set membership is `stake > 0` and not-jailed** — there is no minimum-stake threshold for *being in the set* or for block acceptance. The 10,000 figure is the minimum staking **tier**, not a membership cutoff; a validator with `0 < stake < 10,000` is still active and its blocks are still accepted.
- **`max_validators` (100 in genesis)** is a declared parameter but is **not currently enforced** in the selection/sync path — every `stake > 0`, non-jailed validator is in the active set and eligible to propose. Do not assume a top-100 cutoff exists today.
- **One node per key.** Two nodes signing with the same key is slashable equivocation.
- **Unbonding is ~500 blocks** after `unstake`; dropping to **0** stake (or being jailed) is what removes you from the active set.
- Slashing, key security, and public-node hardening are covered in [Becoming a Validator → Security & slashing](becoming-validator.md#security--slashing--read-before-you-go-live).

## A note for anyone reading the source

The proposer key and the staking key are the **same** key (enforced by the gate above). If you're spelunking the daemon, ignore the stale comment in `rebuild_proposer_counts` that says *"Block headers use node ephemeral keys as proposer, not validator staking keys"* — that's legacy accounting for a misconfigured node, not a supported "node key ≠ stake key" mode. `produce_block` sets `proposer_pub_key` to the node's own key, and `import_block` requires that key to be staked.

## Changing `PROPOSER_AUTH_ACTIVATION_HEIGHT`

The `100` is a protocol constant on the sync path, not a knob to tune per deployment. Changing its value changes which blocks a syncing node accepts, so a change must be rolled out like a coordinated fork — every node running the new value before any chain crosses the affected height — exactly as with `V2_FORK_HEIGHT`. Do not edit it casually.

## See also

- [Becoming a Validator](becoming-validator.md) — full operator walkthrough
- [Staking Overview](README.md)
- [Running a Node](../running-a-node/README.md)
- [Public-node security](../p2p-networking/public-node.md)
