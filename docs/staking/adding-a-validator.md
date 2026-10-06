# Adding a Validator to a Live Chain

This note explains **how a new validator joins a chain that is already running**, and clears up a common misreading of the sync code. If you just want the step-by-step operator walkthrough, read [Becoming a Validator](becoming-validator.md) first — this page explains *why* those steps are ordered the way they are, and what happens at the network level when you get it wrong.

## The one invariant: stake before you propose

> A block is accepted by other nodes only if its **proposer is a staked validator** in the on-chain validator set. So a new validator must **stake first, confirm it is in the active set, and only then run `--mine`.** Before you are staked-and-in-set, your node never holds a proposer slot.

Being staked is necessary but **not sufficient** to propose. Since mainnet height 100 (proposer selection, Release 1) exactly one validator may propose each block: the **designated proposer**, which is the eligible validator (stake > 0, not jailed) with the **most stake**, ties going to the lowest raw public-key bytes. The rule is deterministic: there is no randomness, no rotation and no fallback. A correctly signed block from any other validator is rejected, and a node that is not the designated proposer does not seal blocks at all. Since height 150 (FINALITY_V2) a block must also carry a commit certificate for its parent signed by validators holding ⅔ of the stake. See [Finality](finality.md).

Everything below is the mechanism behind these rules.

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
- The check only ever rejects a block whose proposer is **not** a staked validator — i.e. a genuine misconfiguration (a node mining with an unstaked key). That is the check doing its job. (From height 100 the stricter designated-proposer rule above applies as well.)

So the "cliff" is really the [stake-before-propose invariant](#the-one-invariant-stake-before-you-propose) stated backwards. Growing the validator set is not blocked by this check — it is *governed* by it: stake correctly and joining works at height 100, 10,000, or 10,000,000.

## How proposer authorization actually works

Two things combine:

1. **The validator set is deterministic from history.** Genesis seeds `initial_validators` (each with a stake), and every later `stake` / `unstake` transaction updates the on-chain validator store. Because a syncing node replays the exact same blocks in the exact same order, it derives the exact same validator-set *membership* at every height. There is no out-of-band "validator list" a joiner can be missing — it is a function of the chain it is already downloading.

2. **A bootstrap grace window below height `PROPOSER_AUTH_ACTIVATION_HEIGHT` (100).** Blocks at or below height 100 skip **only the proposer-authorization check** — they are *not* otherwise unvalidated. A block below 100 must still pass its proposer signature, block hash, and `prev_hash`, **every** transaction signature (verified at all heights), and — past the v2 fork height (18) — the committed **state root** and the **contract-custody** apply. Skipping proposer authorization just lets a brand-new network get off the ground before staking transactions have populated the set. **Above height 100 the proposer check is enforced** (once the set is non-empty — see below), so on a mature chain there is no grace period: a new validator must already be staked and in the set before its blocks will be accepted by peers.

> **Two edge cases in that gate.** (a) The check is also short-circuited when the node's locally-derived validator set is *empty* (a defensive don't-brick fallback) — so it is meaningfully enforced only once the set is non-empty *and* height exceeds 100. (b) It gates **imported** blocks (the P2P sync path). Before proposer selection was active, a node's own freshly-produced block wasn't self-rejected, so an unstaked miner's height could climb locally while peers rejected the same blocks. Since height 100 that no longer happens: the miner refuses to seal any slot it is not the designated proposer for, so a misconfigured node simply stays at the network's height.

> The grace window is a bootstrap aid, **not** something to rely on when adding a validator. On any chain past height 100 it does nothing for you. Always follow stake-before-propose regardless of current height.

## Adding a validator to a running chain — the correct sequence

This mirrors [Becoming a Validator](becoming-validator.md), with the reason each step is load-bearing. Follow that guide for exact commands.

1. **Generate the node identity and sync to the tip.** Your `node-keys.json` key is both your stake-holding key and your block-signing key — they must be the same key. Let the node fully sync first so your `stake` tx builds on the current tip.
2. **Fund the key, then stake ≥ `min_stake` (10,000 XRGE).** The freshly-generated key starts empty — first send **≥ 10,000 XRGE (+ 1 XRGE fee)** to the validator address, *then* submit the `stake` tx from that key and wait for it to be **included in a block**. (Staking from an unfunded key fails on the fee/balance check.) This is the step that puts your key into the on-chain validator set that every peer derives.
3. **Confirm you are in the active set** before mining:
   ```bash
   rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json validator-status
   ```
   You want `✓ Staked` and `✓ In active set`. Do not skip this — it is the difference between "my blocks are accepted" and "my blocks are silently rejected by every peer."
4. **Only now start `--mine` — and make the node reachable.** Start with `--mine` *and* a public URL (`--public-url https://…`) that peers can reach over HTTPS, exactly as [Becoming a Validator Step 4](becoming-validator.md#step-4--start-mining) shows. Peers talk to each other over the REST API; there is no separate P2P port. Being staked makes you *eligible*: your node votes toward each block's commit certificate, and it proposes only while it is the designated proposer (the largest stake). Being reachable is what lets your votes and blocks *propagate*.

Do these out of order — mine with a key that is not staked, or not the designated proposer — and your node produces nothing: it logs `not the designated proposer for height <h> … — not sealing` and peers would reject any such block anyway. That, not a height cliff, is the real thing to understand.

## Detecting the failure mode

Symptoms fall into two distinct buckets — don't conflate them:

**Your key isn't staked / not in the active set** (fix: stake it, or point the node at the staked key's `node-keys.json`):

- `validator-status` shows `✗` on **Staked** or **In active set** — the fix is printed next to it (usually: stake, top up, or wait for the `stake` tx to confirm).
- Peers log the rejection on the P2P import path — the inner error is `Block <h> rejected: proposer <pk> not in validator set with active stake` (where `<pk>` is the first 16 hex chars of the key), wrapped as `[peer] Failed to import block <h>: …`.

**You *are* staked and in the active set, but your node never proposes.** This is expected unless you hold the most stake. Your miner logs `not the designated proposer for height <h> (designated: <pk>) — not sealing`, and `GET /api/stats` shows `designated_proposer_next`. If a block from you does reach peers while another validator is designated, they reject it with `proposer <pk> is not the designated proposer (<pk>)`. Staked validators still earn their stake-weighted share of fees in every block (see [Rewards](rewards.md)).

> `designated_proposer_next` in `/api/stats` and `proposer` in `GET /api/selection` both name the designated proposer for the next height.

**You *are* the designated proposer but blocks don't appear, or your node falls behind.** Check reachability and finality:

- `--public-url` is not set, or points somewhere peers can't reach.
- The API port behind your proxy is firewalled, or you have no connected peers.
- Your miner logs `waiting for the commit certificate of block <h> before sealing …`: validators holding ⅔ of the stake have not voted for the tip yet, so no node can extend it.
- You've been **jailed** — jailed validators are out of the active set until the jail window passes. (Automatic missed-block slashing and jailing are frozen from height 100.)

Block acceptance itself has no reachability component (it's proposer-auth, the designated-proposer rule, the parent commit certificate, signatures, hash and state), so with green `validator-status` checks a node that is designated but not propagating points at the network, not the stake.

## Constraints worth knowing

- **`min_stake`: 10,000 XRGE**, enforced by the `stake` CLI/RPC submission path (top-ups must each be ≥ 10,000; totals accumulate). Note this is a submission-time guard, not a consensus-level rejection.
- **Active-set membership is `stake > 0` and not-jailed** — there is no minimum-stake threshold for *being in the set*. The 10,000 figure is an API-side minimum, not a membership cutoff; a validator with `0 < stake < 10,000` is still in the set. Which member proposes is decided by the designated-proposer rule (most stake), not by membership alone.
- **`max_validators` (100 in genesis)** is a declared parameter but is **not currently enforced** in the selection/sync path — every `stake > 0`, non-jailed validator is in the active set. Do not assume a top-100 cutoff exists today.
- **One node per key.** Two nodes signing with the same key is equivocation; slashing on equivocation evidence is planned, not active (see [Becoming a Validator → Security & slashing](becoming-validator.md#security--slashing--read-before-you-go-live)).
- **Unbonding is 500 blocks** after `unstake` (blocks are only produced when there are transactions, so the wall-clock time depends on network activity); dropping to **0** stake (or being jailed) is what removes you from the active set.
- Slashing, key security, and public-node hardening are covered in [Becoming a Validator → Security & slashing](becoming-validator.md#security--slashing--read-before-you-go-live).

## A note for anyone reading the source

The proposer key and the staking key are the **same** key (enforced by the gate above). If you're spelunking the daemon, ignore the stale comment in `rebuild_proposer_counts` that says *"Block headers use node ephemeral keys as proposer, not validator staking keys"* — that's legacy accounting for a misconfigured node, not a supported "node key ≠ stake key" mode. `produce_block` sets `proposer_pub_key` to the node's own key, and `import_block` requires that key to be staked (and, from height 100, to be the designated proposer).

## Changing `PROPOSER_AUTH_ACTIVATION_HEIGHT`

The `100` is a protocol constant on the sync path, not a knob to tune per deployment. Changing its value changes which blocks a syncing node accepts, so a change must be rolled out like a coordinated fork — every node running the new value before any chain crosses the affected height — exactly as with `V2_FORK_HEIGHT`. Do not edit it casually.

## See also

- [Becoming a Validator](becoming-validator.md) — full operator walkthrough
- [Staking Overview](README.md)
- [Running a Node](../running-a-node/README.md)
- [Public-node security](../p2p-networking/public-node.md)
