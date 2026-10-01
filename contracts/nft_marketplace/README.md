# NFT marketplace — example escrow marketplace that pays royalties

Sellers list NFTs, escrow them with the contract, and buyers pay the exact price as an attached
XRGE payment. On a sale the contract pays the collection's **royalty** to its royalty recipient,
the rest to the seller, and moves the NFT to the buyer — all in one call, all in integer quanta
(1 XRGE = 10⁹ quanta).

Needs **CONTRACT_NFT_ROYALTY** (`host_nft_royalty_bps` / `host_nft_royalty_recipient`; built, activation
not scheduled yet), payable calls and the GAME_READY 2 NFT functions. Before CONTRACT_NFT_ROYALTY is
active the contract can be deployed but none of its calls run.

| Method | Args | What it does |
|---|---|---|
| `list` | `{"collection":"col:…","token_id":7,"price":2500000000}` | Caller must **own the NFT now** (raw key or its rouge1 address). Records listing `N`; emits/returns `listed` `{"listing":N,"seller":…,"collection":…,"token_id":…,"price":…}`. |
| *(wallet)* | `nft_transfer` the NFT to the contract address, **no** sale price | Escrow. Do this only **after** `list`. |
| `buy` | `{"listing":N}` + `attach: {"symbol":"XRGE","amount":price}` | `royalty = floor(price × bps / 10000)` to the royalty recipient, `price − royalty` to the seller, NFT to the buyer; emits `sold` `{"listing":N,"price":…,"royalty":…,"seller_proceeds":…}`. Wrong symbol/amount, unknown/stale listing, or NFT not escrowed yet: the call fails and the payment is refunded. |
| `cancel` | `{"listing":N}` | Seller only. Returns the NFT if it is escrowed **for this listing** (the NFT's current listing), deletes the listing; emits `cancelled` `{"listing":N,"returned":true|false}`. |
| `listing` *(read)* | `{"listing":N}` | Returns `{"listing":N,"exists":true,"seller":…,"collection":…,"token_id":…,"price":…,"active":true|false,"escrowed":true|false}`, or `{"listing":N,"exists":false}` for an unknown, sold or cancelled listing (no trap). No event, no storage write. |
| `listing_count` *(read)* | `{}` | Returns `{"next":N}` — the highest listing id issued so far (`0` = none). Ids run `1..=N`. |

**Seller form.** `seller` is the caller string exactly as the contract received and stored it — for a
wallet, the **raw ML-DSA-65 public key hex** (3,904 chars), not its `rouge1…` address. It is what
`cancel` compares the caller with and what `buy` pays (`host_transfer` credits the key's `rouge1`
ledger entry). To show or match an address, derive it client-side (`rouge1 = bech32m(sha256(pubkey))`,
`await pubkeyToAddress(seller)` from `@rougechain/sdk`) — or compare `seller` with your wallet's `publicKey`.

**`active` / `escrowed`.** Listing the same NFT again replaces the older listing: the old one stays
readable (and cancellable by its seller) but is `active:false` and can't be bought, and cancelling it
never returns the NFT — the escrow belongs to the current listing. `escrowed` is `true` when the
listing is active **and** `host_nft_owner` is this contract (the check `buy`'s `host_nft_transfer`
makes). A listing is buyable when `exists && escrowed`.

Prices and amounts are JSON integers in quanta — a fraction or exponent makes the call fail.

**Why list before escrow.** The contract can't tell who sent it an NFT. If it accepted listings for
NFTs it already holds, anyone could list a freshly deposited NFT in their own name and take the sale.
So `list` requires the caller to own the NFT at that moment. **Never send an NFT to the contract
without listing it first** — there is no admin, and nothing could return it.

**Why the contract pays the royalty.** `host_nft_transfer` moves an NFT without royalty. The royalty
recipient comes back in canonical ledger form (`rouge1…` for a wallet, a 40-hex address for a
contract such as a royalty splitter), so `host_transfer` credits the same balance a wallet sale's
royalty would.

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
# → target/wasm32-unknown-unknown/release/rougechain_nft_marketplace.wasm (a prebuilt copy is nft_marketplace.wasm)
```

With the SDK:

```ts
const { address: market } = await rc.contracts.publish(wallet, wasmBytes);
const m = rc.contracts.game(market, seller);
await m.call("list", { collection: colId, token_id: 7, price: 2_500_000_000 });   // 2.5 XRGE
await rc.nft.transfer(seller, { collectionId: colId, tokenId: 7, to: market });    // escrow
// buyer:
await rc.contracts.game(market, buyer).call("buy", { listing: 1 },
  { attach: { symbol: "XRGE", amount: xrgeToQuanta("2.5") } });

// UI reads — free, unsigned (POST /api/contract/:addr/query), no caller needed:
const { returnData: count } = await rc.contracts.query(market, "listing_count", {});  // { next: 2 }
for (let id = 1; id <= count.next; id++) {
  const { returnData: l } = await rc.contracts.query(market, "listing", { listing: id });
  if (l.exists && l.escrowed) { /* show: l.collection, l.token_id, l.price (quanta), l.seller */ }
}
```

The read methods link the same host functions as the rest of the contract, so like every other call
they only run once CONTRACT_NFT_ROYALTY is active on the node answering the query.

`core/daemon/src/node.rs` → `nft_marketplace_example_pays_royalty_and_seller_exactly_across_json_relay`
runs this binary end to end on two nodes (blocks relayed as JSON) — including `listing` /
`listing_count` through the query path before escrow, after escrow, after sale/cancel and for a
replaced listing — and
`nft_marketplace_royalty_to_a_splitter_contract_is_credited_and_split` pays the royalty to a splitter
contract.
