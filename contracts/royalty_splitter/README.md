# RougeChain Royalty Splitter

A RougeChain **v2** WASM contract that custodies XRGE and fans it to a fixed set
of collaborators by weighted share — in integer **quanta**, single-hop,
conserving. Built for qRougee NFT royalty splitting: point an NFT's
`royaltyRecipient` at a deployed splitter, and royalties fan to collaborators
on-chain.

## How it works

- Royalties (XRGE) are paid to the splitter contract's address, which it holds.
- Calling `split` pays each recipient `floor(balance × share / totalShares)`
  quanta via `host_transfer` (the contract moving its *own* balance — single-hop).
- Any floor-division dust stays in the contract for the next round. Value is
  conserved: a contract can never mint or burn XRGE.

## Per-collection generation

The VM has no call-args ABI, so recipients are **baked in at build time** — each
collection gets its own splitter. Edit the two constants at the top of
`src/lib.rs`:

```rust
const RECIPIENTS: &[&str] = &[ "<addr1>", "<addr2>", "<addr3>" ]; // 40-hex addresses
const SHARES:     &[u64]  = &[ 5000, 3000, 2000 ];                 // relative weights
```

`RECIPIENTS.len()` must equal `SHARES.len()`. Shares are relative weights (any
positive integers — basis points are convenient) and need not sum to a round
number.

## Build

```sh
rustup target add wasm32-unknown-unknown   # once
cargo build --release --target wasm32-unknown-unknown
# → target/wasm32-unknown-unknown/release/rougechain_royalty_splitter.wasm (~2 KB)
```

## Deploy

Base64-encode the wasm and deploy via the node API (`/api/contract/deploy` with
`{ wasm, deployer, nonce }`); the response returns the contract **address**.
Use that address as the NFT `royaltyRecipient`. To pay out, call `split` on the
contract (`/api/contract/call` with `{ contractAddr, method: "split", caller }`).

> **v2 required.** XRGE custody activates at the v2 fork height; on a pre-v2
> node the transfers are inert. See `docs/advanced/contract-xrge-custody.md`.

## Verify

An integration test runs the compiled wasm through the VM and checks the
proportional split + conservation:

```sh
# build the wasm first (above), then:
cargo test -p quantum-vault-vm --test determinism royalty_splitter
```
