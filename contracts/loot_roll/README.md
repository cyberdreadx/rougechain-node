# Loot roll — example game contract

A player calls `roll`; the contract draws a random number 0–99 and pays a prize from its own
treasury. It uses the GAME_READY 2 host functions (`host_random`, `host_nft_create_collection`,
`host_nft_mint`, `host_token_transfer`) plus `host_transfer` for XRGE.

| Roll | Prize |
|---|---|
| 0–4 | Legendary Sword NFT from the contract's own `LOOT` collection |
| 5–29 | 10 GOLD (stock it by sending GOLD to the contract address) |
| 30–49 | 0.5 XRGE (stock it by sending XRGE to the contract address) |
| 50–99 | nothing |

Every roll emits a `roll` event `{"roll":N,"prize":"..."}` and returns the same JSON.

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
# → target/wasm32-unknown-unknown/release/rougechain_loot_roll.wasm (≈1.5 KB; a prebuilt copy is loot_roll.wasm)
```

With the SDK (1.9+):

```ts
const { address } = await rc.contracts.publish(wallet, wasmBytes);
await rc.contracts.execute(wallet, address, "setup");
const game = rc.contracts.game(address, wallet);
game.on("roll", (e) => console.log(JSON.parse(e.data)));
await game.call("roll");
```

`core/daemon/src/node.rs` → `loot_roll_example_pays_prizes_from_its_treasury` runs this exact
binary through 40 rolls and checks every prize against the treasury.
