# WASM Smart Contracts

RougeChain includes a built-in WASM smart contract engine powered by `wasmi` — the same pure-Rust WASM interpreter used by Parity/Substrate.

> **v2 update:** contracts can now custody and move XRGE. `host_transfer` /
> `host_get_balance` operate in **quanta** (`1 XRGE = 10^9 quanta`), transfers
> are **single-hop until block 160** (a contract moves only its own balance; from block 160
> moves made inside cross-contract calls are applied too), and moves are
> enforced conserving and overdraft-free. See
> [Contract XRGE Custody](contract-xrge-custody.md) for the rules and examples.

## Overview

Contracts are written in Rust (or any language that compiles to WASM), compiled to `.wasm`, and deployed on-chain. Execution is fuel-metered in a sandbox with host functions for chain interaction.

### Architecture

```
Your Contract (Rust) → cargo build --target wasm32-unknown-unknown
  → .wasm bytecode (must export its memory as "memory", max 1 MiB)
    → Publish: a transaction YOU sign (POST /api/v2/contract/publish)
      → Execute: calls YOU sign (POST /api/v2/contract/execute), run in the wasmi sandbox
        → Host functions bridge to chain state
```

Since block 150 on mainnet, every contract transaction is **player-signed**: the
wallet that signs a call is the caller the contract sees (`host_get_caller`) and pays
the fee; the wallet that signs a deployment is the deployer. The old node-signed
endpoints are retired — `POST /api/v2/contract/deploy` returns **410 Gone**, and
`POST /api/v2/contract/call` is only a dry run (it no longer submits anything).

## Host Functions

Contracts import these from the `env` module:

| Function | Description |
|----------|-------------|
| `host_log(ptr, len)` | Debug logging |
| `host_get_caller(buf, len)` | Caller's public key (the signer of the call) |
| `host_get_self_addr(buf, len)` | The contract's own address |
| `host_get_chain_id(buf, len) → i32` | **CONTRACT_CHAIN_ID** (available from the upgrade; not scheduled yet): writes the chain id (`rougechain-mainnet-1` / `rougechain-devnet-1`) and returns its length; `-1` if `len` is too small. See [Binding signed messages to the network](#chain-id) |
| `host_get_args_len() → i32` | Length in bytes of the call's JSON arguments (`{}` when none) |
| `host_read_args(buf, len) → i32` | Copy the JSON arguments into memory; bytes written, or `-1` if `buf` is too small |
| `host_get_block_height()` | Current block height |
| `host_get_block_time()` | Current block timestamp (seconds) |
| `host_get_balance(addr, len)` | XRGE balance in **quanta** (`1 XRGE = 10^9 quanta`) |
| `host_transfer(to, len, amount)` | Send XRGE (quanta) from the **contract's own** balance (single-hop until block 160) |
| `host_storage_read(key, klen, val, vlen)` | Read persistent storage |
| `host_storage_write(key, klen, val, vlen)` | Write persistent storage |
| `host_storage_delete(key, klen)` | Delete from storage |
| `host_emit_event(topic, tlen, data, dlen)` | Emit an indexed event (stored, and pushed over WebSocket) |
| `host_sha256(data, dlen, out)` | Compute SHA-256 |
| `host_set_return(data, dlen)` | Set the return value |
| `host_call_contract(addr, alen, method, mlen, args, argslen, gas)` | Cross-contract call (returns call_id) |
| `host_get_call_result(call_id, buf, len)` | Read a sub-call result |
| `host_pqc_verify(pk, pklen, msg, msglen, sig, siglen)` | ML-DSA-65 signature verify |
| `host_pqc_pubkey_to_address(pk, pklen, out, outlen)` | Derive a `rouge1...` address |
| `host_pqc_hash_pubkey(pk, pklen, out)` | SHA-256 of a public key |

### Game functions: tokens, NFTs, randomness (from block 160)

From mainnet block **160** (the GAME_READY 2 upgrade) contracts can also hold and move custom
tokens and NFTs, run their own NFT collection, and roll dice. A contract only ever moves **its
own** tokens and NFTs; players stock it by sending tokens/NFTs/XRGE to the contract address.

| Function | Result |
|----------|--------|
| `host_token_balance(sym, slen, addr, alen) → i64` | Token balance in the token's raw units (`-1` invalid symbol) |
| `host_token_transfer(sym, slen, to, tlen, amount) → i32` | Send the contract's tokens: `0` ok, `1` insufficient, `2` invalid |
| `host_nft_owner(col, clen, id, out, cap) → i32` | Owner written to `out`; `-1` not found, `-2` buffer too small |
| `host_nft_transfer(col, clen, id, to, tlen) → i32` | Send an NFT the contract owns: `0` ok, `1` not the contract's, `2` not found/locked |
| `host_nft_create_collection(sym, slen, name, nlen, max_supply, out, cap) → i32` | Create the contract's own collection (`max_supply` 0 = unlimited). Writes the id `col:<first 16 chars of the contract address>:<SYM>`; `-1` if it exists |
| `host_nft_mint(col, clen, to, tlen, name, nlen, meta, mlen) → i64` | Mint to a player (the contract must be the collection's creator). `meta` is optional JSON attributes. Returns the token id; `-1` not creator, `-2` sold out, `-3` missing/frozen, `-4` invalid |
| `host_random(out) → i32` | 32 pseudo-random bytes per call. **The sender can grind it** — see below |
| `host_block_hash(height, out) → i32` | From block **170**: the 32-byte hash of a finished block up to 256 back; `-1` otherwise. Use it to settle rolls |
| `host_get_attached_amount() → i64` | From block **190**: the payment attached to this call, in quanta for XRGE or raw units for a token; `0` if none (always `0` in a cross-contract sub-call). See [Payable calls](#payable-calls) |
| `host_get_attached_symbol(out, cap) → i32` | From block **190**: writes the attached symbol (`XRGE` or a token symbol, upper-case). Returns bytes written, `0` if nothing is attached, `-2` if `cap` is too small |
| `host_nft_royalty_bps(col, clen) → i32` | **CONTRACT_NFT_ROYALTY** (mainnet block 235, testnet 1360): the collection's royalty in basis points, `0`–`10000`; `-1` collection not found / invalid input. See [Selling NFTs from a contract](#nft-royalty) |
| `host_nft_royalty_recipient(col, clen, out, cap) → i32` | **CONTRACT_NFT_ROYALTY**: writes the royalty recipient in canonical ledger form (`rouge1…`, or a 40-hex contract address) and returns its length; `-1` not found / invalid input, `-2` `cap` too small |

Addresses a contract passes are normalised: paying the value `host_get_caller` returns (a public
key) credits the player's `rouge1…` wallet.

**Randomness — use commit-then-settle for anything of value.** `host_random` is fixed by the parent
block hash and the transaction hash. The parent hash is public before a player sends, and the player
controls their transaction's bytes, so a player can sign many variants of a one-step roll offline,
compute each result, and send only a winner. **Never let `host_random` alone decide a prize.**

From block **170**, `host_block_hash(height, out) → i32` returns the 32-byte hash of a finished block
up to 256 blocks back (`-1` for the current block, a future block, or anything older). Games commit in
one call (record the block height `H`) and settle in a later call from `host_block_hash(H + 1)` mixed
with the player and `H`. That block did not exist when the player committed, and its hash covers the
producer's signature and the validators' finality signatures, so the player can't choose it. The
single block producer could still bias a result by withholding a block — acceptable at game stakes;
validator VRF randomness is planned.

**Cross-contract calls and the state root (from block 160):** token/NFT/XRGE moves made inside
cross-contract calls **are** applied. Each sub-call sees the moves made before it; a failed
sub-call's moves are dropped and the caller continues. The block state root commits NFT
collections and ownership plus contract code and storage, so every node must agree on them.

A complete example — a loot box paying NFTs, tokens or XRGE — is in
[`contracts/loot_roll`](https://github.com/cyberdreadx/rougechain-node/tree/main/contracts/loot_roll).

<a id="nft-royalty"></a>

## Selling NFTs from a contract: royalties (CONTRACT_NFT_ROYALTY)

> **Status: LIVE on mainnet since block 235 and on testnet since block 1360** (`GET /api/stats` →
> `upgrade_schedule.contract_nft_royalty`). Below that height these two functions do not exist: a
> contract importing them can be published, but every call to it fails, exactly like a contract
> importing any unknown function.

`host_nft_transfer` moves an NFT **without** paying royalty, and the royalty a wallet `nft_transfer`
with a `salePrice` pays only applies to wallet sales. A contract that sells NFTs — an escrow
marketplace, an auction — reads the royalty and pays it itself:

| Function | Returns |
|---|---|
| `host_nft_royalty_bps(col, clen) → i32` | Basis points `0`–`10000` (`250` = 2.5%); `-1` if the collection doesn't exist. A stored value above 10000 is reported as 10000. |
| `host_nft_royalty_recipient(col, clen, out, cap) → i32` | Bytes of the recipient written to `out`; `-1` not found, `-2` `cap` too small. |

- **Recipient form.** The recipient is returned as the **canonical ledger key** the wallet royalty
  path credits: a creator's public key comes back as its `rouge1…` address, a `rouge1…` address or a
  contract address (40 hex) unchanged. `host_transfer(recipient, royalty)` therefore credits exactly
  the balance a wallet sale would — including a [royalty splitter](https://github.com/cyberdreadx/rougechain-node/tree/main/contracts/royalty_splitter)
  contract used as the recipient. A 128-byte buffer is ample for these forms.
- **Contract-created collections** (`host_nft_create_collection`) have no royalty: bps `0`,
  recipient = the creating contract's address. A collection created earlier in the same call (or by
  the caller of a cross-contract call) is visible immediately.
- Royalty is immutable: it is set once by `nft_create_collection` (`royaltyBps`, `royaltyRecipient`,
  defaulting to the creator). From CONTRACT_NFT_ROYALTY activation, creating a collection with
  `royaltyBps` above `10000` (more than 100%) — or one that is not an exact integer (negative,
  fractional, a string) — is rejected (`400 royaltyBps must be an integer between 0 and 10000`, and
  invalid in a block). Collections created before it keep their stored value; reads clamp it to 10000.
- **Integer math.** Compute `royalty = price × bps / 10000` in integer quanta (round down) and pay the
  seller `price − royalty`. Never use floats.

### Example: escrow marketplace

[`contracts/nft_marketplace`](https://github.com/cyberdreadx/rougechain-node/tree/main/contracts/nft_marketplace)
is a small, commented reference (prebuilt `nft_marketplace.wasm`):

1. **`list {"collection","token_id","price"}`** — the seller must **own** the NFT when listing (the
   contract can't tell who deposited an NFT, so listing after the deposit would let anyone claim it).
   Returns `listed {"listing":N,"seller":…,"collection":…,"token_id":…,"price":…}`. `seller` is the
   caller exactly as stored — for a wallet, its **raw public key hex**, not the `rouge1` address —
   and is what `cancel` compares and `buy` pays.
2. The seller escrows the NFT with a plain wallet `nft_transfer` to the contract address (no sale
   price).
3. **`buy {"listing":N}`** with `attach: {"symbol":"XRGE","amount":price}` — the contract checks the
   payment is exactly the price (otherwise it traps, so the payment is refunded), moves the NFT to
   the buyer with `host_nft_transfer`, then pays:

   ```rust
   let bps = unsafe { host_nft_royalty_bps(col.as_ptr(), col.len() as u32) };
   if bps < 0 { revert(); }
   let royalty = (price as u128 * bps as u128 / 10_000) as u64;        // floor, quanta
   if royalty > 0 {
       let n = unsafe { host_nft_royalty_recipient(col.as_ptr(), col.len() as u32, buf.as_mut_ptr(), buf.len() as u32) };
       if n <= 0 || unsafe { host_transfer(buf.as_ptr(), n as u32, royalty as i64) } != 0 { revert(); }
   }
   if unsafe { host_transfer(seller.as_ptr(), seller.len() as u32, (price - royalty) as i64) } != 0 { revert(); }
   ```

   and emits `sold {"listing":N,"price":…,"royalty":…,"seller_proceeds":…}`.
4. **`cancel {"listing":N}`** — seller only; returns the escrowed NFT (only for the NFT's current
   listing — a listing replaced by a newer listing of the same NFT never takes the escrow back).

A list/buy UI reads listings for free with the query endpoint (`POST /api/contract/{addr}/query`, no
signature, fee or caller). These methods only call `host_set_return` — no event, no storage write:

| Read method | Args | Returns |
|---|---|---|
| `listing` | `{"listing":N}` | `{"listing":N,"exists":true,"seller":…,"collection":…,"token_id":…,"price":…,"active":…,"escrowed":…}` or `{"listing":N,"exists":false}` (unknown, sold or cancelled — no trap) |
| `listing_count` | `{}` | `{"next":N}` — highest listing id issued (`0` = none) |

`active` is false for a listing replaced by a newer one of the same NFT; `escrowed` means active and
the contract owns the NFT. Buyable = `exists && escrowed`.

```ts
const { returnData: { next } } = await rc.contracts.query(market, "listing_count", {});
for (let id = 1; id <= next; id++) {
  const { returnData: l } = await rc.contracts.query(market, "listing", { listing: id });
  if (l.exists && l.escrowed) render(l); // l.price is in quanta; l.seller is the seller's public key
}
```

For a 1.234567891 XRGE sale (1,234,567,891 quanta) of a 3% collection, the artist gets 37,037,036
quanta and the seller 1,197,530,855 — the node test
`nft_marketplace_example_pays_royalty_and_seller_exactly_across_json_relay` checks those exact numbers
on two nodes.

<a id="chain-id"></a>

## Binding signed messages to the network (CONTRACT_CHAIN_ID)

> **Status: available from the CONTRACT_CHAIN_ID upgrade, which is not scheduled on any network yet**
> (`GET /api/stats` → `upgrade_schedule.contract_chain_id` is `null`). Until it activates the function
> does not exist: a contract importing it can be published, but every call to it fails, exactly like a
> contract importing any unknown function. The height will be announced in advance.

| Function | Returns |
|---|---|
| `host_get_chain_id(buf, len) → i32` | Writes the chain id (UTF-8) to `buf` and returns its length; `-1` if `len` is too small. 64 bytes is ample. |

A contract that checks a signature itself with `host_pqc_verify` — an allowlist admission, a voucher,
an off-chain order — should make the signed message name the network, the contract and an expiry, so
a signature made for one network, one contract or one time window is not accepted anywhere else.
Build the message with a fixed domain tag and length-prefixed fields:

```rust
extern "C" {
    fn host_get_chain_id(buf: *mut u8, len: u32) -> i32;
    fn host_get_self_addr(buf: *mut u8, len: u32) -> i32;
    fn host_get_block_height() -> i64;
    fn host_pqc_verify(pk: *const u8, pklen: u32, msg: *const u8, msglen: u32, sig: *const u8, siglen: u32) -> i32;
}

/// "myapp/admit/v1" ‖ len‖chain id ‖ len‖contract address ‖ len‖player ‖ expiry height (u64 BE)
fn admission_message(player: &[u8], expiry_height: u64) -> Vec<u8> {
    let (mut chain, mut me) = ([0u8; 64], [0u8; 64]);
    let c = unsafe { host_get_chain_id(chain.as_mut_ptr(), 64) };
    let a = unsafe { host_get_self_addr(me.as_mut_ptr(), 64) };
    if c <= 0 || a <= 0 { revert(); }
    let mut m = b"myapp/admit/v1".to_vec();
    for part in [&chain[..c as usize], &me[..a as usize], player] {
        m.extend_from_slice(&(part.len() as u32).to_be_bytes());
        m.extend_from_slice(part);
    }
    m.extend_from_slice(&expiry_height.to_be_bytes());
    m
}

fn admit(player: &[u8], expiry_height: u64, issuer_pk: &[u8], sig: &[u8]) {
    if unsafe { host_get_block_height() } as u64 > expiry_height { revert(); } // expired
    let msg = admission_message(player, expiry_height);
    let ok = unsafe { host_pqc_verify(issuer_pk.as_ptr(), issuer_pk.len() as u32,
        msg.as_ptr(), msg.len() as u32, sig.as_ptr(), sig.len() as u32) };
    if ok != 1 { revert(); }
    // …and record that this admission was used, if it must be single-use.
}
```

The issuer signs the same bytes off-chain, with the chain id of the network it means
(`GET /api/health` → `chain_id`).

<a id="payable-calls"></a>

## Payable calls (from block 190)

From the payable-calls upgrade (block 190), a player can pay a contract in the same signed
call, for example an entry fee, a shop purchase or a stake. The signed `contract_call` payload
carries an optional `attach`:

```json
"attach": { "symbol": "XRGE", "amount": 500000000 }
```

- **`symbol`**: `"XRGE"` or a token symbol. The node upper-cases it. Allowed characters are 1–32
  letters, digits, `_` and `-`.
- **`amount`** is a **positive JSON integer**: **quanta** for XRGE (1 XRGE = 1,000,000,000 quanta,
  so the example above is 0.5 XRGE) and **raw units** for a token (token decimals are not applied).
  Decimals, strings, zero and negative numbers are rejected. The SDK, extension and site keep it
  ≤ 2^53 − 1 so it round-trips exactly through JavaScript.
- `attach` is **inside the signed payload**, so nobody can change it after you sign.

**Pay on success.** While the call runs, the payment is already in the contract's balance
(`host_get_balance` of the contract's own address, or `host_token_balance`), so the contract can use
it. The payment becomes final **only if the call succeeds**. If the call fails or traps, all of its
effects are discarded and the payment **stays with the player**. The gas fee is still charged, as
for any failed call. A cross-contract sub-call sees no attachment.

**Balance check.** `POST /api/v2/contract/execute` refuses the call before it is broadcast if the
player can't cover `gas fee + XRGE payment`, or the token amount for a token payment. It also
refuses the call if the dry run with the payment would fail. In a block, a call whose attachment
the player can't cover is not executed. Before block 190, a call with `attach` is
invalid.

**Refuse a payment by failing the call.** A contract that doesn't want a payment should trap: wrong
symbol, too little, too much, or a method that isn't payable. Trapping returns the payment. A
method that ignores the attachment keeps whatever was sent, so non-payable methods should check
that `host_get_attached_amount()` is `0`.

```rust
extern "C" {
    fn host_get_attached_amount() -> i64;
    fn host_get_attached_symbol(out_ptr: *mut u8, out_cap: u32) -> i32;
}

const ENTRY_FEE: i64 = 500_000_000; // 0.5 XRGE in quanta

fn revert() -> ! { core::arch::wasm32::unreachable() } // fail the call: the payment goes back

#[no_mangle]
pub extern "C" fn roll() {
    let mut sym = [0u8; 8];
    let n = unsafe { host_get_attached_symbol(sym.as_mut_ptr(), sym.len() as u32) };
    if n != 4 || &sym[..4] != b"XRGE" || unsafe { host_get_attached_amount() } < ENTRY_FEE {
        revert(); // unpaid, underpaid or paid in the wrong token
    }
    // ... the fee is in the contract's balance; do the paid work ...
}
```

Players attach payments with the SDK
(`rc.contracts.execute(wallet, addr, 'roll', {}, { attach: { symbol: 'XRGE', amount: xrgeToQuanta('0.5') } })`),
the browser extension (v1.5.0+, which shows "Pays 0.5 XRGE to the contract (only if the call
succeeds)"), the explorer's contract page ("Attach payment"), or the MCP server
(`attach: { symbol: "XRGE", amount_xrge: "0.5" }`). `loot_roll`'s `roll` requires a 0.5 XRGE entry
fee this way.

## Gas Metering & Fees

Every WASM instruction costs 1 fuel unit. A call may use at most **10,000,000 fuel**
(≈10M instructions). If a contract runs out of fuel, execution halts and all state
changes are reverted.

### Fee Schedule

| Operation | Fee |
|-----------|-----|
| Publish (deploy) | **10 XRGE** flat |
| Call | `gasLimit × 0.000001` XRGE — the **signed gas limit**, charged up front |
| Payable call | The call fee, plus the attached payment, which is paid only if the call succeeds (see [Payable calls](#payable-calls)) |
| Query | Free (read-only, nothing is signed or committed) |

Because the fee is the signed `gasLimit`, not the gas used, pick a limit close to what
the call needs: query the call first and add headroom (the SDK does this for you:
`ceil(gasUsed × 1.5) + 1000`). The node dry-runs every call before accepting it and
refuses calls that would fail or that need more gas than the limit, so a failing call
costs nothing.

## API

All write endpoints take the standard signed envelope used by every `/api/v2/*`
transaction: `{ payload, signature, public_key }`, where `signature` is ML-DSA-65
over the JSON of `payload` with keys sorted. `payload.from` must be the signing key and
`payload.timestamp` (ms) must be within 5 minutes of the node's clock.

### Publish a Contract

```bash
POST /api/v2/contract/publish
{
  "payload": {
    "type": "contract_deploy",
    "from": "<your signing public key hex>",
    "wasm": "<base64 WASM bytecode>",
    "nonce": "<random string, at least 8 chars>",
    "timestamp": 1790000000000
  },
  "signature": "<ML-DSA-65 signature hex>",
  "public_key": "<your signing public key hex>"
}
→ { "success": true, "txId": "…", "address": "<40 hex chars>", "fee": 10 }
```

The contract is installed when the transaction is mined. Its address is fixed by what
you signed, so you know it before the block and nobody else can take it:

```
address = hex( sha256( "rougechain/contract/v2" ‖ from ‖ 0x00 ‖ nonce ‖ 0x00 ‖ sha256(wasm) )[0..20] )
```

Signing the same code again needs a new `nonce`.

### Call a Contract Method

```bash
POST /api/v2/contract/execute
{
  "payload": {
    "type": "contract_call",
    "from": "<your signing public key hex>",
    "contractAddr": "<contract address>",
    "method": "my_method",
    "args": { "key": "value" },
    "gasLimit": 50000,
    "attach": { "symbol": "XRGE", "amount": 500000000 },   // optional, from block 190
    "timestamp": 1790000000000,
    "nonce": "<random string>"
  },
  "signature": "…",
  "public_key": "…"
}
→ { "success": true, "txId": "…", "fee": 0.05,
    "preview": { "returnData": …, "gasUsed": 31234, "events": [ … ] } }
```

`gasLimit` must be an integer from 1 to 10,000,000. The `preview` is the node's dry run;
the authoritative execution happens when the transaction is mined. Its receipt
(`GET /api/tx/{txId}/receipt`) reports `"status": "Success"` when the call ran to completion,
or `"status": {"Failed": "<error>"}` when it reverted in the block (possible if the state
changed between the dry run and the block). A reverted call is still included and its fee is
charged; its state changes and events are discarded.

`attach` is optional (see [Payable calls](#payable-calls)). `amount` is an
integer: quanta for XRGE, raw units for a token. The node refuses the call if you can't cover the
fee plus an XRGE payment, or the token amount. A reverted call keeps the payment with you.

### Query (read-only, free)

```bash
POST /api/contract/{addr}/query
{ "method": "get_score", "args": { "player": "…" }, "caller": "<optional pubkey>" }
→ { "success": true, "returnData": …, "gasUsed": 812, "events": [], "error": null }
```

To preview a paid call, add the same `attach` plus the paying `caller` (required with `attach`):
`{ "method": "roll", "args": {}, "caller": "<pubkey>", "attach": { "symbol": "XRGE", "amount": 500000000 } }`.
The contract sees the payment exactly as it would in a block.

### Read Contract Data

```bash
GET /api/contract/{addr}                        # metadata
GET /api/contract/{addr}/state                  # full state dump (all keys)
GET /api/contract/{addr}/state?key=x            # one key (hex, or UTF-8 if not valid hex)
GET /api/contract/{addr}/events?limit=50        # event log
GET /api/contract/{addr}/events?before=12345    # older page: events below that block height
GET /api/contract/{addr}/events?tx=<txhash>     # events emitted by one transaction
GET /api/contracts                              # list all contracts
```

### Live Events (WebSocket)

Connect to `wss://<node>/api/ws` and send:

```json
{ "subscribe": ["contract:<addr>"] }
```

After each block is accepted you receive one frame per event:

```json
{ "type": "contract_event", "contract_addr": "…", "topic": "move",
  "data": "…", "block_height": 1234, "tx_hash": "…" }
```

## ERC-20 Token Standard

RougeChain includes a reference ERC-20 token contract at `contracts/erc20_template/`. This implements the standard fungible token interface:

| Method | Args | Description |
|--------|------|-------------|
| `init` | `{name, symbol, decimals, total_supply, owner}` | Initialize token, mint supply to owner |
| `name` / `symbol` / `decimals` / `total_supply` | `{}` | Token metadata queries |
| `balance_of` | `{account}` | Get account balance |
| `transfer` | `{to, amount}` | Transfer tokens (caller → to) |
| `approve` | `{spender, amount}` | Set allowance |
| `allowance` | `{owner, spender}` | Get allowance |
| `transfer_from` | `{from, to, amount}` | Transfer using allowance |

### Storage Layout

- `meta:name` / `meta:symbol` / `meta:decimals` / `meta:total_supply` — Token metadata
- `bal:{account}` — Account balances
- `allow:{owner}:{spender}` — Allowances

### Build & Deploy

```bash
cd contracts/erc20_template
cargo build --release --target wasm32-unknown-unknown
# Publish target/wasm32-unknown-unknown/release/*.wasm with rc.contracts.publish (see SDK below)
```

## Explorer Integration

Deployed contracts are visible in the RougeChain explorer:

- **Contracts Explorer** (`/contracts`) — List all deployed contracts with search/sort
- **Contract Detail** (`/contract/{addr}`) — Contract info, state viewer, free queries, wallet-signed calls (gas/fee preview, tx id, receipt Success/Failed) and a live events feed
- **Transaction Detail** — Contract txs show: contract address, method, gas used, WASM size

## SDK

`@rougechain/sdk` 1.9.0+ has a `contracts` namespace that signs, submits, queries and
subscribes. The constructor takes the API base URL (note the trailing `/api`):

```typescript
import { RougeChain, Wallet } from '@rougechain/sdk';
import { readFileSync } from 'node:fs';

const rc = new RougeChain('https://api.rougechain.io/api');
const wallet = Wallet.fromMnemonic(process.env.MNEMONIC!);

// Publish (10 XRGE). The address is known before the block.
const wasm = readFileSync('target/wasm32-unknown-unknown/release/game.wasm');
const pub = await rc.contracts.publish(wallet, wasm);
console.log(pub.predictedAddress, pub.txId);
await rc.contracts.waitForReceipt(pub.txId!);

// Free read-only call
const q = await rc.contracts.query(pub.predictedAddress, 'get_score', { player: wallet.publicKey });

// Signed call. Without gasLimit the SDK queries first and signs ceil(gasUsed × 1.5) + 1000.
const r = await rc.contracts.execute(wallet, pub.predictedAddress, 'move', { x: 1, y: 2 });
if (!r.success) console.error(r.error);        // e.g. "call would fail: not your turn"
const receipt = await rc.contracts.waitForReceipt(r.txId!);
if (receipt.status !== 'Success') console.error('reverted in block:', receipt.status.Failed);

// Live events (one shared socket, reconnects automatically)
const stop = rc.contracts.subscribe(pub.predictedAddress, (e) => console.log(e.topic, e.data));

// State, events, metadata
const all = await rc.contracts.state(pub.predictedAddress);
const one = await rc.contracts.state(pub.predictedAddress, new TextEncoder().encode('score'));
const older = await rc.contracts.events(pub.predictedAddress, { limit: 50, before: 12_000 });
```

For games there is a smaller handle:

```typescript
const game = rc.contracts.game(address, wallet);
const off = game.on('move', (e) => render(JSON.parse(e.data)));   // or '*' for every topic
await game.call('move', { x: 1, y: 2 });
const board = await game.query('board');

// Payable call (SDK 1.10.0+): 0.5 XRGE entry fee, paid only if the call succeeds
import { xrgeToQuanta } from '@rougechain/sdk';
await game.call('roll', {}, { attach: { symbol: 'XRGE', amount: xrgeToQuanta('0.5') } });
```

In the browser, dApps can have the RougeChain extension sign `contract_call` and
`contract_deploy` payloads via `window.rougechain.signTransaction(payload)`. The
extension (v1.4.0+) shows the method, arguments, gas limit and maximum fee (or the
WASM size, predicted address and 10 XRGE fee) before signing. v1.5.0+ also shows any
attached payment and the max total cost.

## MCP Server (AI Agents)

The RougeChain MCP server exposes smart contract operations as tools for AI agents:

| Tool | Description |
|------|-------------|
| `list_contracts` | List all deployed contracts |
| `get_contract` | Get contract metadata |
| `get_contract_state` | Read state (single key or full dump) |
| `get_contract_events` | Stored events (`limit`, `before`, `tx`) |
| `query_contract` | Free read-only call (`POST /api/contract/:addr/query`); optional `attach` previews a paid call |
| `publish_contract` | Write mode: sign and publish WASM with the server's wallet (10 XRGE) |
| `execute_contract` | Write mode: sign a state-changing call with the server's wallet; optional `attach` (`amount_xrge` decimal for XRGE, integer `amount` for tokens) |
| `get_tx_receipt` | Receipt of a transaction (`Success` or `Failed`) |

## Security

WASM smart contracts maintain RougeChain's post-quantum security guarantees:
- All contract transactions are ML-DSA-65 signed by the player: the signer is the caller and pays the fee
- WASM execution is pure computation — no classical crypto involved
- Contract addresses are derived from the signed deployment via SHA-256, so they cannot be front-run
- Execution is sandboxed with no host OS access

## Cross-Contract Calls

Contracts can call other contracts using host functions. Calls are queued during execution and processed recursively by the runtime after the primary call completes.

### Host Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `host_call_contract(addr, alen, method, mlen, args, argslen, gas)` | `call_id (i32)` | Queue a call to another contract |
| `host_get_call_result(call_id, buf, len)` | `bytes written` | Read the result of a sub-call |

### Behavior

- **Max depth**: 8 nested calls (prevents infinite recursion)
- **State merging**: storage writes and events from sub-calls are merged atomically
- **XRGE moves**: a contract moves only *its own* balance. Until block 160 moves were single-hop — `host_transfer` calls made by a *sub*-contract were **not** applied on-chain. From block 160 token/NFT/XRGE moves inside sub-calls are applied: each sub-call sees the moves made before it, and a failed sub-call's moves are dropped while the caller continues. See [Contract XRGE Custody](contract-xrge-custody.md)
- **Gas**: sub-calls consume gas from the parent's remaining budget
- **Failure**: if a sub-call fails, it returns `-2` from `host_get_call_result`; the parent can handle it gracefully

### Example (Rust)

```rust
extern "C" {
    fn host_call_contract(
        addr: *const u8, alen: u32,
        method: *const u8, mlen: u32,
        args: *const u8, argslen: u32,
        gas: u64,
    ) -> i32;
    fn host_get_call_result(call_id: i32, buf: *mut u8, len: u32) -> i32;
}

#[no_mangle]
pub extern "C" fn call_other() {
    let addr = b"contract_abc123...";
    let method = b"get_value";
    let args = b"{}";
    let call_id = unsafe {
        host_call_contract(
            addr.as_ptr(), addr.len() as u32,
            method.as_ptr(), method.len() as u32,
            args.as_ptr(), args.len() as u32,
            1_000_000,
        )
    };
    // Result is available after host processes the call queue
    let mut buf = [0u8; 1024];
    let n = unsafe { host_get_call_result(call_id, buf.as_mut_ptr(), buf.len() as u32) };
    // n > 0: success, n bytes of return data
    // n == -2: sub-call failed
}
```

## PQC Precompiles

Native post-quantum cryptographic operations available as host functions — no need to implement ML-DSA in WASM.

| Function | Returns | Description |
|----------|---------|-------------|
| `host_pqc_verify(pk, pklen, msg, msglen, sig, siglen)` | `1` valid, `0` invalid, `-1` error | ML-DSA-65 signature verification |
| `host_pqc_pubkey_to_address(pk, pklen, out, outlen)` | bytes written | Derive `rouge1...` bech32m address from raw pubkey |
| `host_pqc_hash_pubkey(pk, pklen, out)` | `32` on success | SHA-256 hash of public key |

### Key Sizes

- **Public Key**: 1,952 bytes (ML-DSA-65)
- **Signature**: 3,309 bytes (ML-DSA-65)
- **Address**: ~63 bytes (`rouge1...` bech32m string)
- **Pubkey Hash**: 32 bytes (SHA-256)

### Use Cases

- **On-chain auth**: Verify a user's PQC signature inside a contract
- **Address derivation**: Convert a pubkey to a `rouge1...` address for permission checks
- **Identity checks**: Compare pubkey hashes for compact storage

## EIP-1559 Dynamic Fees

RougeChain uses an EIP-1559-like fee model with base fee adjustment and fee burning:

### How It Works

1. **Base fee** adjusts ±12.5% per block based on block fullness (target: 10 txs/block)
2. **Floor**: minimum base fee of 0.001 XRGE
3. **Fee burning**: half of the base-fee portion (base fee × tx count ÷ 2, capped at the block's total fees) is burned (deflationary); everything else goes to the tip pool
4. **Priority fee (tip)**: 20% to block proposer, 70% to validators (stake-weighted), 10% to treasury

### API

```bash
GET /api/fee-info
```

```json
{
  "baseFee": 0.0377,
  "suggestedPriorityFee": 0.0038,
  "suggestedTotalFee": 0.0415,
  "totalBurned": 68.16,
  "targetTxsPerBlock": 10,
  "maxChangePercent": 12.5,
  "blockHeight": 618
}
```
