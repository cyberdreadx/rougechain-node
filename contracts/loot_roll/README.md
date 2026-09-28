# Loot roll — example game contract (commit, then settle)

A player calls `roll` to commit, then `settle` a couple of blocks later; the contract decides the
roll from the hash of a block that did not exist when the player committed, and pays a prize from its
own treasury. Needs mainnet block **170+** (`host_block_hash`, GAME_READY 3) plus the GAME_READY 2
token/NFT functions.

| Method | What it does |
|---|---|
| `setup` | Creates the contract's own `LOOT` NFT collection (max 1,000). Call once. |
| `roll` | Records the current block height `H` for the caller; emits `committed` `{"height":H}`. One open roll per player. |
| `settle` | From block `H+2`: roll = `sha256(hash of block H+1 ‖ caller ‖ H)`; pays the prize; emits `roll` `{"roll":N,"prize":"..."}`. Earlier: `{"error":"too_early"}`. After 250 blocks: `{"error":"expired"}` (cleared). |

| Roll | Prize |
|---|---|
| 0–4 | Legendary Sword NFT from the contract's own `LOOT` collection |
| 5–29 | 10 GOLD (stock it by sending GOLD to the contract address) |
| 30–49 | 0.5 XRGE (stock it by sending XRGE to the contract address) |
| 50–99 | nothing |

**Why two steps:** a one-step roll with `host_random` can be ground — the player signs many variants
of the transaction offline, computes each result, and sends only a winner. Committing first removes
that choice. The single block producer could still bias a result by withholding a block.

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
# → target/wasm32-unknown-unknown/release/rougechain_loot_roll.wasm (a prebuilt copy is loot_roll.wasm)
```

With the SDK (1.9+):

```ts
const { address } = await rc.contracts.publish(wallet, wasmBytes);
await rc.contracts.execute(wallet, address, "setup");
const game = rc.contracts.game(address, wallet);
game.on("roll", (e) => console.log(JSON.parse(e.data)));
await game.call("roll");      // commit
// …wait two blocks…
await game.call("settle");    // prize
```

`core/daemon/src/node.rs` → `loot_roll_example_commits_then_settles_from_a_later_block` runs this
binary for 20 rounds and recomputes every roll from block H+1's hash, the caller and H.
